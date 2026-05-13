// Farad Reject Metrics — daily log scraper
//
// Post-processes /home/bot/trading-bot/data/pm2-out.log into a markdown
// dump at data/metrics/reject-YYYY-MM-DD.md for human review. Designed for
// observability without behavioral change: the script reads the log and
// writes markdown; it never touches the live trading path, never calls
// the broker, never writes to the DB.
//
// Spec: docs/superpowers/specs/2026-04-23-reject-metrics-design.md
// Plan: docs/superpowers/plans/2026-04-23-reject-metrics.md

// ==================== TYPES ====================

export type SkipCategory =
  | 'analyst_reject'       // priority 1
  | 'news_opposing'        // priority 2
  | 'no_trigger'           // priority 3
  | 'rr_fail'              // priority 4
  | 'bias_unclear'         // priority 5
  | 'score_too_low'        // priority 6
  | 'outside_kill_zone';   // priority 7

export type ExecuteCategory =
  | 'place_order_executed'
  | 'log_trade_attempted'
  | 'log_trade_failed'
  | 'ict_cycle_complete'
  | 'displacement_fired'; // NEW — Phase 1 DC monitoring

export type Category = SkipCategory | ExecuteCategory;

// ==================== CLASSIFICATION ====================

// Priority-ordered list. First match wins when a line matches multiple
// skip patterns. Execute categories come after — they're non-exclusive
// with skip categories (a line can only match one anyway).
const PATTERNS: Array<{ cat: Category; re: RegExp }> = [
  // Skip categories, priority 1 (highest) → 7 (lowest)
  { cat: 'analyst_reject',    re: /Analyst Decision: REJECT|Analyst.*REJECTED|REJECTED.*Score \d+\/100/ },
  { cat: 'news_opposing',     re: /opposing news|NEWS RISK OVERRIDE|news-opposing|disqualifier.*news|news-blind|PMI risk is a disqualifier/ },
  { cat: 'no_trigger',        re: /NO ENTRY TRIGGER|No trigger|NO VALID ENTRY LOCATION|not printed the confirmation trigger/i },
  { cat: 'rr_fail',           re: /R:R.*below.*minimum|R:R.*0\.\d+:1.*❌|R:R to TP2.*non-negotiable|fails.*Tier \d gate/ },
  { cat: 'bias_unclear',      re: /1H Bias NEUTRAL|1H Bias CONFLICTED|bias unclear|bias contradiction/ },
  { cat: 'score_too_low',     re: /Below.*Tier 3 threshold|Below.*Tier 3|Score \d+ \(Below/ },
  { cat: 'outside_kill_zone', re: /skipping ICT cycle.*outside kill zone|outside kill zone: outside/ },

  // Execute categories
  { cat: 'place_order_executed', re: /\[ICT Agent\] Calling tool: place_order/ },
  { cat: 'log_trade_failed',     re: /\[ICT Agent\] Tool log_trade failed/ },
  { cat: 'log_trade_attempted',  re: /\[ICT Agent\] Calling tool: log_trade/ },
  { cat: 'ict_cycle_complete',   re: /ICT Trading Agent[^.]*complete|\[Scheduler\][^I]*ICT Trading Agent complete/ },
  // Displacement Continuation firing — matches setup_type:"Displacement_Continuation" in place_split_trade tool calls
  { cat: 'displacement_fired',   re: /setup_type['"\s:=]+['"](Displacement_Continuation)['"]/i },
];

/**
 * Classify a single log line. Returns the first matching Category in
 * priority order (skip cats highest priority first), or null if nothing
 * matches.
 */
export function classifyLine(line: string): Category | null {
  for (const { cat, re } of PATTERNS) {
    if (re.test(line)) return cat;
  }
  return null;
}

// ==================== EXTRACTORS ====================

export const UNIVERSE = [
  'GOLD', 'SILVER', 'OIL_CRUDE',
  'EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD',
] as const;

export type Instrument = (typeof UNIVERSE)[number] | '_unknown';

export type KillZone = 'London Open' | 'NY Open' | 'London Close' | 'outside';

/**
 * Find a universe ticker in the window, scanning NEWEST line first (the
 * event line itself) and walking backward through context. The newest
 * matching ticker wins — this avoids stale context from prior cycles
 * bleeding into the current event's instrument attribution.
 *
 * Case-sensitive match against uppercase tickers (matches the log format).
 * Returns '_unknown' if no ticker is found.
 */
export function extractInstrument(windowLines: string[]): Instrument {
  // Longer ticker names first (OIL_CRUDE before OIL) to avoid substring
  // collisions — though no such collision exists in the current universe,
  // this guards against future additions like OILBRENT.
  const sortedByLen = [...UNIVERSE].sort((a, b) => b.length - a.length);
  // Walk newest-first (reverse) — the event-of-interest is at the end
  // of windowLines, and its own line is the most relevant context.
  for (let i = windowLines.length - 1; i >= 0; i--) {
    const line = windowLines[i];
    for (const ticker of sortedByLen) {
      // Word-boundary-anchored match. Tickers are always uppercase in logs.
      if (new RegExp(`\\b${ticker}\\b`).test(line)) {
        return ticker;
      }
    }
  }
  return '_unknown';
}

/**
 * Find the kill-zone marker closest to the event line (newest-first walk).
 * The live ICT agent renders kill zones in a variety of formats in the
 * log (with emoji, variable spacing, different capitalizations):
 *   - "Kill Zone: LONDON OPEN ACTIVE ✅"
 *   - "Kill Zone: 🟢 LONDON OPEN ACTIVE (07:00–10:00 UTC)"
 *   - "Kill Zone: London Open (07:00–10:00 UTC) ✅ ACTIVE"
 *   - "Kill Zone: INACTIVE (21:00 UTC — all sessions closed)"
 *   - "Next kill zone: London Open at 07:00 UTC" (looking FORWARD, not current)
 *
 * The scheduler renders the skipped-cycle case distinctly:
 *   - "[Scheduler] Candle close at ... (outside kill zone: outside)"
 *
 * Strategy (walks newest-first so the most recent marker wins):
 *   1. "outside kill zone" anywhere on the line → outside.
 *   2. Line mentions "kill zone" AND "INACTIVE" → outside.
 *   3. Line mentions "Next kill zone" → skip (not current state).
 *   4. Line mentions "kill zone" AND "ACTIVE" AND a zone name → that zone.
 *   5. Otherwise keep looking.
 * Returns 'outside' if no matching marker is found in the window.
 */
export function extractKillZone(windowLines: string[]): KillZone {
  for (let i = windowLines.length - 1; i >= 0; i--) {
    const line = windowLines[i];

    // 1. Explicit outside marker (scheduler-emitted when skipping a cycle).
    if (/outside kill zone/i.test(line)) return 'outside';

    // Line must mention "kill zone" to continue.
    if (!/kill[ _]zone/i.test(line)) continue;

    // 2. Inactive marker.
    if (/INACTIVE/i.test(line)) return 'outside';

    // 3. "Next kill zone" is forward-looking — ignore this line.
    if (/next kill[ _]zone/i.test(line)) continue;

    // 4. Active marker + zone name. Order matters: London Close before
    //    London Open since both contain "London".
    if (/ACTIVE/i.test(line)) {
      if (/london[ _]close/i.test(line)) return 'London Close';
      if (/london[ _]open/i.test(line))  return 'London Open';
      if (/ny[ _]open/i.test(line))      return 'NY Open';
    }

    // Kill zone is mentioned but no resolvable state — continue walking
    // older lines rather than guessing.
  }
  return 'outside';
}

// ==================== AGGREGATION ====================

type SkipCounts = Record<SkipCategory, number>;
type KillZoneStats = { cycles: number; executed: number; skipped: number };

export interface ExecutedTrade {
  timestamp: string;   // "YYYY-MM-DD HH:MM:SS" (UTC)
  instrument: Instrument;
  note: string;        // free-text (direction if visible, outcome if visible)
}

export interface MetricsReport {
  date: string;                                    // "YYYY-MM-DD" UTC
  totalCycles: number;
  placeOrderCount: number;
  logTradeAttempted: number;
  logTradeSucceeded: number;
  logTradeFailed: number;
  skipsByCategory: SkipCounts;
  skipsByInstrumentAndCategory: Partial<Record<Instrument, Partial<SkipCounts>>>;
  cyclesByKillZone: Record<KillZone, KillZoneStats>;
  executedTrades: ExecutedTrade[];
  dcFirings: number;          // Phase 1 — count of Displacement_Continuation firings
}

const SKIP_CATS: SkipCategory[] = [
  'analyst_reject', 'news_opposing', 'no_trigger', 'rr_fail',
  'bias_unclear', 'score_too_low', 'outside_kill_zone',
];

function emptySkipCounts(): SkipCounts {
  return {
    analyst_reject: 0, news_opposing: 0, no_trigger: 0, rr_fail: 0,
    bias_unclear: 0, score_too_low: 0, outside_kill_zone: 0,
  };
}

function emptyKillZoneStats(): Record<KillZone, KillZoneStats> {
  return {
    'London Open':  { cycles: 0, executed: 0, skipped: 0 },
    'NY Open':      { cycles: 0, executed: 0, skipped: 0 },
    'London Close': { cycles: 0, executed: 0, skipped: 0 },
    'outside':      { cycles: 0, executed: 0, skipped: 0 },
  };
}

/**
 * Aggregate a list of pm2-out.log lines into a MetricsReport for the
 * target UTC date. Lines whose timestamp doesn't match the target date
 * are filtered out.
 *
 * Window size for instrument/kill-zone attribution: 10 lines ABOVE the
 * classified event (inclusive of the event line itself).
 */
export function aggregateLog(logLines: string[], targetDateUtc: string): MetricsReport {
  const WINDOW_SIZE = 10;
  const report: MetricsReport = {
    date: targetDateUtc,
    totalCycles: 0,
    placeOrderCount: 0,
    logTradeAttempted: 0,
    logTradeSucceeded: 0,
    logTradeFailed: 0,
    skipsByCategory: emptySkipCounts(),
    skipsByInstrumentAndCategory: {},
    cyclesByKillZone: emptyKillZoneStats(),
    executedTrades: [],
    dcFirings: 0,
  };

  // Filter once: only lines starting with the target date.
  // pm2-out.log format: "YYYY-MM-DD HH:MM:SS +00:00: ..."
  const prefixedLines = logLines.filter((l) => l.startsWith(targetDateUtc));

  for (let i = 0; i < prefixedLines.length; i++) {
    const line = prefixedLines[i];
    const cat = classifyLine(line);
    if (!cat) continue;

    // Window: the WINDOW_SIZE lines up to and including this one.
    const window = prefixedLines.slice(Math.max(0, i - WINDOW_SIZE + 1), i + 1);
    const instrument = extractInstrument(window);
    const kz = extractKillZone(window);

    switch (cat) {
      case 'ict_cycle_complete':
        report.totalCycles += 1;
        report.cyclesByKillZone[kz].cycles += 1;
        break;
      case 'place_order_executed':
        report.placeOrderCount += 1;
        report.cyclesByKillZone[kz].executed += 1;
        if (report.executedTrades.length < 20) {
          // pm2 log line format: "2026-04-23 07:00:01 +00:00: [ICT Agent]..."
          const timestamp = line.slice(0, 19); // "YYYY-MM-DD HH:MM:SS"
          report.executedTrades.push({ timestamp, instrument, note: 'place_order' });
        }
        break;
      case 'log_trade_attempted':
        report.logTradeAttempted += 1;
        break;
      case 'log_trade_failed':
        report.logTradeFailed += 1;
        break;
      case 'displacement_fired':
        report.dcFirings += 1;
        break;
      default: {
        // It's a skip category.
        report.skipsByCategory[cat] += 1;
        report.cyclesByKillZone[kz].skipped += 1;
        const bucket = report.skipsByInstrumentAndCategory[instrument] ?? {};
        bucket[cat] = (bucket[cat] ?? 0) + 1;
        report.skipsByInstrumentAndCategory[instrument] = bucket;
        break;
      }
    }
  }

  report.logTradeSucceeded = Math.max(0, report.logTradeAttempted - report.logTradeFailed);
  return report;
}

// ==================== MARKDOWN RENDERING ====================

export function renderMarkdown(report: MetricsReport, generatedAt: string): string {
  const executeRate =
    report.totalCycles > 0
      ? `${((report.placeOrderCount / report.totalCycles) * 100).toFixed(2)}%`
      : 'n/a';

  const pct = (n: number): string =>
    report.totalCycles > 0 ? `${((n / report.totalCycles) * 100).toFixed(1)}%` : 'n/a';

  const skipRows = SKIP_CATS
    .map((c) => ({ c, n: report.skipsByCategory[c] }))
    .sort((a, b) => b.n - a.n)
    .map((r) => `| ${r.c} | ${r.n} | ${pct(r.n)} |`)
    .join('\n');

  const kzRows: KillZone[] = ['London Open', 'NY Open', 'London Close', 'outside'];
  const kzBody = kzRows
    .map((k) => {
      const s = report.cyclesByKillZone[k];
      return `| ${k} | ${s.cycles} | ${s.executed} | ${s.skipped} |`;
    })
    .join('\n');

  const instrRows = [...UNIVERSE, '_unknown' as const]
    .map((inst) => {
      const cells = SKIP_CATS.map((c) => report.skipsByInstrumentAndCategory[inst]?.[c] ?? 0);
      const total = cells.reduce((a, b) => a + b, 0);
      if (total === 0) return null; // suppress all-zero rows for noise control
      return `| ${inst} | ${cells.join(' | ')} | ${total} |`;
    })
    .filter((r): r is string => r !== null)
    .join('\n');

  const execList = report.executedTrades.length === 0
    ? '_No executed trades on this date._'
    : report.executedTrades
        .map((t, i) => `${i + 1}. ${t.timestamp} UTC — ${t.instrument} — ${t.note}`)
        .join('\n');

  return `# Farad Reject Metrics — ${report.date} (UTC)

Generated: ${generatedAt} · Source: data/pm2-out.log

## Summary
- ICT decision cycles completed: **${report.totalCycles}**
- Place_order calls (ICT agent): **${report.placeOrderCount}**
- log_trade calls attempted: **${report.logTradeAttempted}** (succeeded: ${report.logTradeSucceeded}, failed: ${report.logTradeFailed})
- **Execute rate: ${executeRate}** (${report.placeOrderCount}/${report.totalCycles})

## Skip breakdown
| Category | Count | % of cycles |
|---|---|---|
${skipRows}

## Per-instrument skip matrix
| Instrument | ${SKIP_CATS.join(' | ')} | total |
|---|${SKIP_CATS.map(() => '---').join('|')}|---|
${instrRows || '_No skips captured in any category._'}

## Per-kill-zone
| Kill zone | Cycles | Executed | Skipped |
|---|---|---|---|
${kzBody}

## Executed trades (max 20)
${execList}

## Displacement Continuation (Phase 1)

- Firings today: **${report.dcFirings}**

_Outcome tracking (WR / mean R) reads from the trades DB; see daily DC dashboard in measure-loosening-impact (Task 17)._
`;
}

// ==================== CLI ENTRY POINT ====================
//
// Invocation:
//   tsx scripts/dump-reject-metrics.ts              → yesterday UTC
//   tsx scripts/dump-reject-metrics.ts 2026-04-23   → explicit date
//
// Behavior:
//   1. Resolve target date (arg or yesterday-UTC default).
//   2. Read /home/bot/trading-bot/data/pm2-out.log (configurable via
//      env var REJECT_METRICS_LOG for local testing).
//   3. Aggregate.
//   4. Write data/metrics/reject-<date>.md (creates parent dir if missing).
//
// Failure semantics:
//   - If the log file is missing, log an error and exit(1). The scheduler
//     spawn path catches this via stdio:'ignore' — bot is unaffected.
//   - All pure-function exports above are tested; this main block is
//     glue code and not unit-tested. Manual VPS verification in Task 6
//     exercises it end-to-end.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

function yesterdayUtc(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function defaultLogPath(): string {
  return process.env.REJECT_METRICS_LOG
    ?? '/home/bot/trading-bot/data/pm2-out.log';
}

function defaultOutputDir(): string {
  // Script lives at scripts/dump-reject-metrics.ts; output goes to
  // ../data/metrics/ relative to the script, which resolves to the
  // repo root's data/metrics/ dir regardless of cwd.
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', 'data', 'metrics');
}

// Only run main if invoked directly (not when imported by tests).
// Windows-safe: compare resolved absolute paths rather than string-comparing
// import.meta.url (URL-encoded) against process.argv[1] (native path).
const scriptPath = resolve(fileURLToPath(import.meta.url));
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
const isMain = scriptPath === invokedPath;

if (isMain) {
  const targetDate = process.argv[2] || yesterdayUtc();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
    console.error(`Invalid date: "${targetDate}". Expected YYYY-MM-DD.`);
    process.exit(1);
  }

  const logPath = defaultLogPath();
  if (!existsSync(logPath)) {
    console.error(`Log file not found: ${logPath}`);
    process.exit(1);
  }

  const raw = readFileSync(logPath, 'utf-8');
  const lines = raw.split('\n');
  // pm2 prefixes each line with e.g. "0|trading-bot  | YYYY-MM-DD HH:MM..."
  // Strip the pm2 prefix so our classifiers see clean timestamps.
  const cleaned = lines.map((l) => l.replace(/^0\|trading-?\s*\|\s*/, ''));

  const report = aggregateLog(cleaned, targetDate);

  const outputDir = defaultOutputDir();
  mkdirSync(outputDir, { recursive: true });

  const outputPath = join(outputDir, `reject-${targetDate}.md`);
  const generatedAt = new Date().toISOString();
  writeFileSync(outputPath, renderMarkdown(report, generatedAt), 'utf-8');

  console.log(`[reject-metrics] Wrote ${outputPath}`);
  const totalSkips = Object.values(report.skipsByCategory).reduce((a, b) => a + b, 0);
  console.log(`[reject-metrics] ${report.totalCycles} cycles, ${report.placeOrderCount} place_orders, ${totalSkips} skips`);
}

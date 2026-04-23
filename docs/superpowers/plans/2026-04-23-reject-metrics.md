# Reject Metrics (P4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a daily log-scraping script that post-processes `pm2-out.log` into `data/metrics/reject-YYYY-MM-DD.md`, and wire it into the scheduler to run at 00:05 UTC. Zero changes to the live trading decision path.

**Architecture:** Pure-function library (classifiers + extractors + aggregator + markdown renderer) with an I/O wrapper CLI entry point. Scheduler spawns the CLI detached so live-loop isn't blocked. All logic unit-tested against real log-line fixtures captured from the 2026-04-21 → 2026-04-23 demo window.

**Tech Stack:** TypeScript (strict), Vitest (existing test framework), `tsx` for execution, `child_process.spawn` for detached scheduler invocation. No new runtime dependencies.

---

## File Structure

**Created by this plan:**
- `scripts/dump-reject-metrics.ts` — CLI script (~200 lines including pure-function exports)
- `tests/dump-reject-metrics.test.ts` — unit tests covering classification, extraction, aggregation, markdown rendering (~250 lines)
- `data/metrics/` directory — created lazily by the script on first run
- `data/metrics/.gitkeep` — empty placeholder so the directory exists in the repo (optional — spec says `data/` is probably already gitignored; verify during execution)

**Modified by this plan:**
- `src/scheduler/index.ts` — import `spawn` from `child_process` (if not already imported) + add one cron block + update the cron-list console.log (~12 line diff total)

**NOT touched:**
- Any agent file, any prompt, any scanner logic, any trading-tools.ts
- The live ICT decision path
- The Capital.com client
- The database
- The backtest engine

**Testing framework:** Vitest. Run `npm test -- --run` from the repo root. Current passing count: **204** (after P3 cycle, commit `49a7fce`).

---

### Task 1: Types + `classifyLine` via TDD

**Files:**
- Create: `C:\Users\user\Desktop\Trade Bot\Trade Bot\scripts\dump-reject-metrics.ts`
- Create: `C:\Users\user\Desktop\Trade Bot\Trade Bot\tests\dump-reject-metrics.test.ts`

- [ ] **Step 1: Write the first failing test file**

Create `C:\Users\user\Desktop\Trade Bot\Trade Bot\tests\dump-reject-metrics.test.ts` with this initial content (this version only exercises `classifyLine` — later tasks add more tests to the same file):

```ts
// Unit tests for scripts/dump-reject-metrics.ts — pure-function tests only.
// Real log lines captured from pm2-out.log on 2026-04-21 → 2026-04-23 drive
// every classification fixture below. If the LLM's phrasing drifts and one
// of these starts missing its category, a test fails and we learn about it.

import { describe, it, expect } from 'vitest';
import {
  classifyLine,
} from '../scripts/dump-reject-metrics.js';

describe('classifyLine — skip categories (priority-ordered, first match wins)', () => {
  it('classifies analyst_reject (priority 1) from Analyst output', () => {
    expect(classifyLine('Analyst Decision: REJECT — TIMING. Do not enter 15 minutes ahead...')).toBe('analyst_reject');
    expect(classifyLine('GBPUSD REJECTED — Score 15/100. Bias contradiction.')).toBe('analyst_reject');
  });

  it('classifies news_opposing (priority 2)', () => {
    expect(classifyLine('Expected PMI contraction = potential bearish catalyst. NEWS RISK OVERRIDE.')).toBe('news_opposing');
    expect(classifyLine('opposing news detected for EURUSD; skip entirely per Step 3E')).toBe('news_opposing');
    expect(classifyLine('the opposing PMI risk is a disqualifier. GBPUSD: SKIP')).toBe('news_opposing');
  });

  it('classifies no_trigger (priority 3)', () => {
    expect(classifyLine('NO ENTRY TRIGGER CONFIRMED ON 15M — GOLD')).toBe('no_trigger');
    expect(classifyLine('No trigger. WATCHING. Moving on.')).toBe('no_trigger');
    expect(classifyLine('NO VALID ENTRY LOCATION ON USDJPY — PREMIUM TERRITORY, NO TRIGGER')).toBe('no_trigger');
  });

  it('classifies rr_fail (priority 4)', () => {
    expect(classifyLine('R:R to TP2 = 0.50:1 — minimum is 1.5:1 (non-negotiable)')).toBe('rr_fail');
    expect(classifyLine('R:R to TP1 0.35:1 ❌ — fails Tier 2 gate')).toBe('rr_fail');
  });

  it('classifies bias_unclear (priority 5)', () => {
    expect(classifyLine('1H Bias NEUTRAL → SKIPPED')).toBe('bias_unclear');
    expect(classifyLine('1H Bias CONFLICTED → SKIPPED')).toBe('bias_unclear');
    expect(classifyLine('bias unclear — too much noise in recent swings')).toBe('bias_unclear');
  });

  it('classifies score_too_low (priority 6)', () => {
    expect(classifyLine('Score 47 — Below even Tier 3 threshold (50). No trigger. SKIP GBPUSD.')).toBe('score_too_low');
    expect(classifyLine('Below Tier 3 threshold')).toBe('score_too_low');
  });

  it('classifies outside_kill_zone (priority 7 — lowest)', () => {
    expect(classifyLine('[Scheduler] Candle close at 2026-04-23T10:00:00.415Z — skipping ICT cycle (outside kill zone: outside)')).toBe('outside_kill_zone');
  });

  it('priority order: a line that matches news_opposing AND bias_unclear classifies as news_opposing', () => {
    // Craft a line matching both priority-2 and priority-5 patterns.
    const bothMatch = 'opposing news detected AND 1H Bias NEUTRAL → SKIPPED';
    expect(classifyLine(bothMatch)).toBe('news_opposing');
  });
});

describe('classifyLine — execute categories', () => {
  it('classifies place_order_executed', () => {
    expect(classifyLine('[ICT Agent] Calling tool: place_order')).toBe('place_order_executed');
  });

  it('classifies log_trade_attempted', () => {
    expect(classifyLine('[ICT Agent] Calling tool: log_trade')).toBe('log_trade_attempted');
  });

  it('classifies log_trade_failed', () => {
    expect(classifyLine('[ICT Agent] Tool log_trade failed: insertTrade: required field(s) missing')).toBe('log_trade_failed');
    expect(classifyLine('[ICT Agent] Tool log_trade failed: CHECK constraint failed: status IN...')).toBe('log_trade_failed');
  });

  it('classifies ict_cycle_complete', () => {
    expect(classifyLine('ICT Trading Agent decision cycle complete.')).toBe('ict_cycle_complete');
    expect(classifyLine('[Scheduler] ICT Trading Agent complete.')).toBe('ict_cycle_complete');
  });
});

describe('classifyLine — no match', () => {
  it('returns null for lines that match nothing', () => {
    expect(classifyLine('some random log line')).toBeNull();
    expect(classifyLine('')).toBeNull();
    expect(classifyLine('[Fetcher] AAPL candles loaded from cache')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `cd "/c/Users/user/Desktop/Trade Bot/Trade Bot" && npm test -- --run tests/dump-reject-metrics.test.ts 2>&1 | tail -10`
Expected: FAIL — `Cannot find module '../scripts/dump-reject-metrics.js'`.

- [ ] **Step 3: Create the initial script with types + classifyLine**

Create `C:\Users\user\Desktop\Trade Bot\Trade Bot\scripts\dump-reject-metrics.ts` with this initial content (later tasks expand the file):

```ts
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
  | 'ict_cycle_complete';

export type Category = SkipCategory | ExecuteCategory;

// ==================== CLASSIFICATION ====================

// Priority-ordered list. First match wins when a line matches multiple
// skip patterns. Execute categories come after — they're non-exclusive
// with skip categories (a line can only match one anyway).
const PATTERNS: Array<{ cat: Category; re: RegExp }> = [
  // Skip categories, priority 1 (highest) → 7 (lowest)
  { cat: 'analyst_reject',    re: /Analyst Decision: REJECT|Analyst[^:]*REJECTED|REJECTED[^—]*Score \d+\/100/ },
  { cat: 'news_opposing',     re: /opposing news|NEWS RISK OVERRIDE|news-opposing|disqualifier[^.]*news|news-blind|PMI risk is a disqualifier/ },
  { cat: 'no_trigger',        re: /NO ENTRY TRIGGER|No trigger|NO VALID ENTRY LOCATION|not printed the confirmation trigger/i },
  { cat: 'rr_fail',           re: /R:R[^.]*below[^.]*minimum|R:R[^.]*0\.\d+:1[^❌]*❌|R:R to TP2[^.]*non-negotiable|fails[^.]*Tier \d gate/ },
  { cat: 'bias_unclear',      re: /1H Bias NEUTRAL|1H Bias CONFLICTED|bias unclear|bias contradiction/ },
  { cat: 'score_too_low',     re: /Below[^T]*Tier 3 threshold|Below.*Tier 3|Score \d+ \(Below/ },
  { cat: 'outside_kill_zone', re: /skipping ICT cycle[^k]*outside kill zone|outside kill zone: outside/ },

  // Execute categories
  { cat: 'place_order_executed', re: /\[ICT Agent\] Calling tool: place_order/ },
  { cat: 'log_trade_failed',     re: /\[ICT Agent\] Tool log_trade failed/ },
  { cat: 'log_trade_attempted',  re: /\[ICT Agent\] Calling tool: log_trade/ },
  { cat: 'ict_cycle_complete',   re: /ICT Trading Agent[^.]*complete|\[Scheduler\][^I]*ICT Trading Agent complete/ },
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd "/c/Users/user/Desktop/Trade Bot/Trade Bot" && npm test -- --run tests/dump-reject-metrics.test.ts 2>&1 | tail -10`
Expected: all classifyLine tests pass (~15 cases).

If a test fails, re-read the specific line the test expects and adjust the corresponding regex in `PATTERNS`. Do not skip to Step 5 with failing tests.

- [ ] **Step 5: Run the full test suite to confirm no regressions**

Run: `cd "/c/Users/user/Desktop/Trade Bot/Trade Bot" && npm test -- --run 2>&1 | tail -8`
Expected: 219 passed (204 pre-existing + ~15 new classifyLine tests).

- [ ] **Step 6: Commit**

```bash
cd "/c/Users/user/Desktop/Trade Bot/Trade Bot" && git add scripts/dump-reject-metrics.ts tests/dump-reject-metrics.test.ts && git commit -m "$(cat <<'EOF'
feat(metrics): add classifyLine for reject-metrics log scraper (P4 Task 1)

Initial scaffold of scripts/dump-reject-metrics.ts with the pure-function
classifyLine + SkipCategory/ExecuteCategory type system. Priority-ordered
regex patterns (7 skip + 4 execute) match real pm2-out.log lines captured
from the 2026-04-21 to 2026-04-23 demo window.

Unit tests in tests/dump-reject-metrics.test.ts lock each category to
specific real-log-line fixtures — if the LLM's phrasing drifts and a
pattern goes stale, tests fail on the next release.

Extractors (instrument, kill zone), aggregation, markdown render, and
CLI entry point follow in subsequent P4 tasks.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `extractInstrument` + `extractKillZone`

**Files:**
- Modify: `C:\Users\user\Desktop\Trade Bot\Trade Bot\scripts\dump-reject-metrics.ts` (append new exports)
- Modify: `C:\Users\user\Desktop\Trade Bot\Trade Bot\tests\dump-reject-metrics.test.ts` (append new describe block)

- [ ] **Step 1: Append new tests**

Append to `tests/dump-reject-metrics.test.ts`:

```ts
import {
  classifyLine,
  extractInstrument,
  extractKillZone,
  UNIVERSE,
} from '../scripts/dump-reject-metrics.js';

describe('extractInstrument', () => {
  it('finds a universe ticker in the window', () => {
    const window = [
      'some context line',
      'Now processing GBPUSD for setup scoring',
      'another line',
    ];
    expect(extractInstrument(window)).toBe('GBPUSD');
  });

  it('finds the FIRST universe ticker when multiple appear', () => {
    const window = [
      'comparing EURUSD vs GBPUSD',
      'other',
    ];
    expect(extractInstrument(window)).toBe('EURUSD');
  });

  it('returns _unknown when no universe ticker in window', () => {
    const window = [
      'some unrelated context',
      'AAPL is not in the ICT universe',
      'other',
    ];
    expect(extractInstrument(window)).toBe('_unknown');
  });

  it('handles case-sensitive match (tickers are uppercase in logs)', () => {
    expect(extractInstrument(['processing eurusd lowercase'])).toBe('_unknown');
    expect(extractInstrument(['processing EURUSD uppercase'])).toBe('EURUSD');
  });

  it('UNIVERSE has exactly 7 tickers', () => {
    expect(UNIVERSE).toEqual(['GOLD', 'SILVER', 'OIL_CRUDE', 'EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD']);
  });
});

describe('extractKillZone', () => {
  it('finds London Open from explicit marker', () => {
    const window = ['current kill zone: London Open', 'other'];
    expect(extractKillZone(window)).toBe('London Open');
  });

  it('finds NY Open', () => {
    expect(extractKillZone(['current kill zone: NY Open'])).toBe('NY Open');
  });

  it('finds London Close', () => {
    expect(extractKillZone(['current kill zone: London Close'])).toBe('London Close');
  });

  it('returns outside when no kill zone marker appears', () => {
    expect(extractKillZone(['random lines', 'no marker'])).toBe('outside');
  });

  it('returns outside when marker explicitly says outside', () => {
    expect(extractKillZone(['[Scheduler] ... kill zone: outside'])).toBe('outside');
  });

  it('matches KZ_ABBREV format too (e.g., NY_Open as it appears in some logs)', () => {
    // Some lines write "NY_Open" with underscore — common in trade records
    expect(extractKillZone(['"kill_zone":"NY_Open"'])).toBe('NY Open');
    expect(extractKillZone(['kill_zone=London_Open'])).toBe('London Open');
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `cd "/c/Users/user/Desktop/Trade Bot/Trade Bot" && npm test -- --run tests/dump-reject-metrics.test.ts 2>&1 | tail -10`
Expected: new tests fail with "extractInstrument is not a function" or import errors.

- [ ] **Step 3: Append the implementations to the script**

Append to `scripts/dump-reject-metrics.ts`:

```ts
// ==================== EXTRACTORS ====================

export const UNIVERSE = [
  'GOLD', 'SILVER', 'OIL_CRUDE',
  'EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD',
] as const;

export type Instrument = (typeof UNIVERSE)[number] | '_unknown';

export type KillZone = 'London Open' | 'NY Open' | 'London Close' | 'outside';

/**
 * Find the first universe ticker that appears in any line of the window.
 * Case-sensitive match against uppercase tickers (matches the log format).
 * Returns '_unknown' if no ticker is found.
 */
export function extractInstrument(windowLines: string[]): Instrument {
  // Longer ticker names first (OIL_CRUDE before OIL) to avoid substring
  // collisions — though no such collision exists in the current universe,
  // this guards against future additions like OILBRENT.
  const sortedByLen = [...UNIVERSE].sort((a, b) => b.length - a.length);
  for (const line of windowLines) {
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
 * Find the explicit kill-zone marker in the window. Supports both the
 * prose format ("kill zone: London Open") and the trade-record
 * underscore format ("kill_zone":"NY_Open"). Returns 'outside' if no
 * marker is found or if the marker explicitly says outside.
 */
export function extractKillZone(windowLines: string[]): KillZone {
  const prosePatterns: Array<{ re: RegExp; kz: KillZone }> = [
    { re: /kill[ _]zone["=: ]+["']?London[ _]Close/i, kz: 'London Close' },
    { re: /kill[ _]zone["=: ]+["']?London[ _]Open/i,  kz: 'London Open'  },
    { re: /kill[ _]zone["=: ]+["']?NY[ _]Open/i,      kz: 'NY Open'      },
  ];
  for (const line of windowLines) {
    for (const { re, kz } of prosePatterns) {
      if (re.test(line)) return kz;
    }
  }
  return 'outside';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd "/c/Users/user/Desktop/Trade Bot/Trade Bot" && npm test -- --run tests/dump-reject-metrics.test.ts 2>&1 | tail -10`
Expected: all tests pass (~26 total now: 15 classifyLine + 5 extractInstrument + 6 extractKillZone).

- [ ] **Step 5: Full suite**

Run: `cd "/c/Users/user/Desktop/Trade Bot/Trade Bot" && npm test -- --run 2>&1 | tail -8`
Expected: 230 passed (204 + 26).

- [ ] **Step 6: Commit**

```bash
cd "/c/Users/user/Desktop/Trade Bot/Trade Bot" && git add scripts/dump-reject-metrics.ts tests/dump-reject-metrics.test.ts && git commit -m "$(cat <<'EOF'
feat(metrics): extractInstrument + extractKillZone (P4 Task 2)

Pure-function extractors that scan a 10-line window around a classified
skip/execute event and return the instrument + kill-zone attribution.

UNIVERSE constant is the 7-ticker source-of-truth list for the matcher.
Both extractors are case-sensitive (matches log format) and handle the
two in-log kill-zone formats (prose "kill zone: NY Open" and record
"kill_zone":"NY_Open").

11 new unit tests. Full suite: 230/230 passing.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `aggregateLog` + `renderMarkdown`

**Files:**
- Modify: `C:\Users\user\Desktop\Trade Bot\Trade Bot\scripts\dump-reject-metrics.ts` (append)
- Modify: `C:\Users\user\Desktop\Trade Bot\Trade Bot\tests\dump-reject-metrics.test.ts` (append)

- [ ] **Step 1: Append new tests**

Append to `tests/dump-reject-metrics.test.ts`:

```ts
import {
  classifyLine,
  extractInstrument,
  extractKillZone,
  UNIVERSE,
  aggregateLog,
  renderMarkdown,
  type MetricsReport,
} from '../scripts/dump-reject-metrics.js';

describe('aggregateLog', () => {
  it('filters to the target UTC date and counts events', () => {
    const logLines = [
      '2026-04-22 23:59:00 +00:00: [Scheduler] kill zone: NY Open',
      '2026-04-22 23:59:00 +00:00: ICT Trading Agent decision cycle complete.',
      '2026-04-23 07:00:00 +00:00: current kill zone: London Open',
      '2026-04-23 07:00:00 +00:00: Processing GBPUSD for setup',
      '2026-04-23 07:00:01 +00:00: NO ENTRY TRIGGER CONFIRMED ON 15M — GOLD',
      '2026-04-23 07:00:02 +00:00: ICT Trading Agent decision cycle complete.',
      '2026-04-23 08:00:00 +00:00: [ICT Agent] Calling tool: place_order',
      '2026-04-23 23:59:59 +00:00: ICT Trading Agent decision cycle complete.',
      '2026-04-24 00:00:01 +00:00: ICT Trading Agent decision cycle complete.', // next day
    ];
    const report = aggregateLog(logLines, '2026-04-23');

    expect(report.date).toBe('2026-04-23');
    expect(report.totalCycles).toBe(3); // 3 complete markers on 2026-04-23
    expect(report.placeOrderCount).toBe(1);
    expect(report.skipsByCategory.no_trigger).toBe(1);
    // Other categories should be 0
    expect(report.skipsByCategory.analyst_reject).toBe(0);
    expect(report.skipsByCategory.news_opposing).toBe(0);
  });

  it('attributes skips to instrument via 10-line window', () => {
    const logLines = [
      '2026-04-23 07:00:00 +00:00: current kill zone: London Open',
      '2026-04-23 07:00:00 +00:00: Processing GBPUSD for setup',
      '2026-04-23 07:00:01 +00:00: NO ENTRY TRIGGER CONFIRMED ON 15M — GBPUSD',
      '2026-04-23 07:00:02 +00:00: ICT Trading Agent decision cycle complete.',
    ];
    const report = aggregateLog(logLines, '2026-04-23');

    expect(report.skipsByInstrumentAndCategory.GBPUSD?.no_trigger).toBe(1);
  });

  it('attributes cycles to kill zones from the window', () => {
    const logLines = [
      '2026-04-23 07:00:00 +00:00: current kill zone: London Open',
      '2026-04-23 07:00:01 +00:00: ICT Trading Agent decision cycle complete.',
      '2026-04-23 13:00:00 +00:00: current kill zone: NY Open',
      '2026-04-23 13:00:01 +00:00: ICT Trading Agent decision cycle complete.',
      '2026-04-23 20:00:00 +00:00: skipping ICT cycle (outside kill zone: outside)',
      '2026-04-23 20:00:01 +00:00: ICT Trading Agent decision cycle complete.',
    ];
    const report = aggregateLog(logLines, '2026-04-23');

    expect(report.cyclesByKillZone['London Open'].cycles).toBe(1);
    expect(report.cyclesByKillZone['NY Open'].cycles).toBe(1);
    expect(report.cyclesByKillZone['outside'].cycles).toBe(1);
  });

  it('counts log_trade success vs failure separately', () => {
    const logLines = [
      '2026-04-23 14:00:00 +00:00: [ICT Agent] Calling tool: log_trade',
      '2026-04-23 14:00:01 +00:00: [ICT Agent] Tool log_trade failed: insertTrade: required fields missing',
      '2026-04-23 14:00:02 +00:00: [ICT Agent] Calling tool: log_trade',
      '2026-04-23 14:00:03 +00:00: ICT Trading Agent decision cycle complete.',
    ];
    const report = aggregateLog(logLines, '2026-04-23');

    // log_trade_attempted is 2 (both calls), log_trade_failed is 1 (one explicitly failed).
    // Note: we count SUCCESSES as attempted minus failed (no explicit success marker in logs).
    expect(report.logTradeAttempted).toBe(2);
    expect(report.logTradeFailed).toBe(1);
    expect(report.logTradeSucceeded).toBe(1); // 2 attempted - 1 failed = 1 presumed succeeded
  });

  it('captures executed-trade detail (capped at 20)', () => {
    const logLines: string[] = [
      '2026-04-23 07:00:00 +00:00: current kill zone: London Open',
      '2026-04-23 07:00:00 +00:00: Processing USDJPY',
      '2026-04-23 07:00:01 +00:00: [ICT Agent] Calling tool: place_order',
    ];
    const report = aggregateLog(logLines, '2026-04-23');

    expect(report.executedTrades).toHaveLength(1);
    expect(report.executedTrades[0].timestamp).toBe('2026-04-23 07:00:01');
    expect(report.executedTrades[0].instrument).toBe('USDJPY');
  });
});

describe('renderMarkdown', () => {
  it('produces a well-formed markdown file from a MetricsReport', () => {
    const report: MetricsReport = {
      date: '2026-04-23',
      totalCycles: 664,
      placeOrderCount: 5,
      logTradeAttempted: 3,
      logTradeFailed: 3,
      logTradeSucceeded: 0,
      skipsByCategory: {
        outside_kill_zone: 181,
        bias_unclear: 52,
        no_trigger: 47,
        rr_fail: 8,
        news_opposing: 3,
        score_too_low: 2,
        analyst_reject: 1,
      },
      skipsByInstrumentAndCategory: {},
      cyclesByKillZone: {
        'London Open': { cycles: 120, executed: 2, skipped: 118 },
        'NY Open':     { cycles: 90,  executed: 3, skipped: 87  },
        'London Close':{ cycles: 40,  executed: 0, skipped: 40  },
        'outside':     { cycles: 414, executed: 0, skipped: 414 },
      },
      executedTrades: [],
    };
    const md = renderMarkdown(report, '2026-04-24T00:05:00Z');

    expect(md).toContain('# Farad Reject Metrics — 2026-04-23 (UTC)');
    expect(md).toContain('Generated: 2026-04-24T00:05:00Z');
    expect(md).toContain('**664**'); // total cycles
    expect(md).toContain('**5**');   // place_order count
    expect(md).toContain('Execute rate: 0.75%'); // 5/664 = 0.75%
    expect(md).toContain('outside_kill_zone');
    expect(md).toContain('181');
    expect(md).toContain('London Open');
  });

  it('handles zero cycles gracefully (no divide-by-zero)', () => {
    const report: MetricsReport = {
      date: '2026-04-23',
      totalCycles: 0,
      placeOrderCount: 0,
      logTradeAttempted: 0,
      logTradeFailed: 0,
      logTradeSucceeded: 0,
      skipsByCategory: {
        outside_kill_zone: 0, bias_unclear: 0, no_trigger: 0, rr_fail: 0,
        news_opposing: 0, score_too_low: 0, analyst_reject: 0,
      },
      skipsByInstrumentAndCategory: {},
      cyclesByKillZone: {
        'London Open': { cycles: 0, executed: 0, skipped: 0 },
        'NY Open':     { cycles: 0, executed: 0, skipped: 0 },
        'London Close':{ cycles: 0, executed: 0, skipped: 0 },
        'outside':     { cycles: 0, executed: 0, skipped: 0 },
      },
      executedTrades: [],
    };
    const md = renderMarkdown(report, '2026-04-24T00:05:00Z');
    expect(md).toContain('Execute rate: n/a'); // no cycles → n/a rather than NaN
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `cd "/c/Users/user/Desktop/Trade Bot/Trade Bot" && npm test -- --run tests/dump-reject-metrics.test.ts 2>&1 | tail -10`
Expected: FAIL on imports for `aggregateLog`, `renderMarkdown`, `MetricsReport`.

- [ ] **Step 3: Append the implementations**

Append to `scripts/dump-reject-metrics.ts`:

```ts
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
`;
}
```

- [ ] **Step 4: Run tests**

Run: `cd "/c/Users/user/Desktop/Trade Bot/Trade Bot" && npm test -- --run tests/dump-reject-metrics.test.ts 2>&1 | tail -10`
Expected: all tests pass (~33 total: 26 prior + 5 aggregateLog + 2 renderMarkdown).

- [ ] **Step 5: Full suite**

Run: `cd "/c/Users/user/Desktop/Trade Bot/Trade Bot" && npm test -- --run 2>&1 | tail -8`
Expected: 237 passed (204 + 33).

- [ ] **Step 6: Commit**

```bash
cd "/c/Users/user/Desktop/Trade Bot/Trade Bot" && git add scripts/dump-reject-metrics.ts tests/dump-reject-metrics.test.ts && git commit -m "$(cat <<'EOF'
feat(metrics): aggregateLog + renderMarkdown (P4 Task 3)

Pure-function aggregator walks classified log lines in order, computes
totals, per-category counts, per-instrument × per-category matrix, and
per-kill-zone cycle/execute/skip stats. A 10-line sliding window (event
line + 9 prior) drives instrument + kill-zone attribution. Executed-
trades detail section captures the first 20 place_order events with
timestamps and instrument attribution.

renderMarkdown produces the self-contained daily report per spec §4.
Guards against divide-by-zero when totalCycles is 0 (shows "n/a" for
rate fields). Per-instrument rows suppress when all-zero to reduce
matrix noise.

7 new unit tests (5 aggregation + 2 markdown). Full suite: 237/237.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: CLI entry point (file I/O wrapper)

**Files:**
- Modify: `C:\Users\user\Desktop\Trade Bot\Trade Bot\scripts\dump-reject-metrics.ts` (append main block)

- [ ] **Step 1: Append CLI entry point**

Append to the end of `scripts/dump-reject-metrics.ts`:

```ts
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
import { join, dirname } from 'path';
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
// Uses the "is-this-the-entry-module" pattern compatible with tsx/ESM.
const isMain = import.meta.url === `file://${process.argv[1]}`
  || import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));

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
  console.log(`[reject-metrics] ${report.totalCycles} cycles, ${report.placeOrderCount} place_orders, ${Object.values(report.skipsByCategory).reduce((a, b) => a + b, 0)} skips`);
}
```

- [ ] **Step 2: Build to verify**

Run: `cd "/c/Users/user/Desktop/Trade Bot/Trade Bot" && npm run build 2>&1 | tail -5`
Expected: no TypeScript errors.

(Note: the `scripts/` directory isn't normally part of the tsc build, but running build still catches type errors in any .ts file depending on tsconfig includes. If the build doesn't reach scripts/, Task 5 will catch issues.)

- [ ] **Step 3: Manual local test with a tiny fixture log**

Create a temp fixture and run the script against it locally (Windows-friendly command):

```bash
cd "/c/Users/user/Desktop/Trade Bot/Trade Bot" && \
  printf '2026-04-23 07:00:00 +00:00: current kill zone: London Open\n2026-04-23 07:00:00 +00:00: Processing GBPUSD\n2026-04-23 07:00:01 +00:00: NO ENTRY TRIGGER CONFIRMED ON 15M — GBPUSD\n2026-04-23 07:00:02 +00:00: ICT Trading Agent decision cycle complete.\n' > /tmp/fixture.log && \
  REJECT_METRICS_LOG=/tmp/fixture.log npx tsx scripts/dump-reject-metrics.ts 2026-04-23 && \
  cat data/metrics/reject-2026-04-23.md
```

Expected output shows:
- Total cycles: 1
- no_trigger count: 1
- GBPUSD in the per-instrument matrix
- London Open row with 1 cycle / 0 executed / 1 skipped

- [ ] **Step 4: Clean up the generated local test output**

Run: `cd "/c/Users/user/Desktop/Trade Bot/Trade Bot" && rm -f data/metrics/reject-2026-04-23.md && ls data/metrics/ 2>&1`
Expected: `data/metrics/` exists but empty (or non-existent if tests never created it).

- [ ] **Step 5: Commit**

```bash
cd "/c/Users/user/Desktop/Trade Bot/Trade Bot" && git add scripts/dump-reject-metrics.ts && git commit -m "$(cat <<'EOF'
feat(metrics): CLI entry point for dump-reject-metrics (P4 Task 4)

Glue code for the pure-function library built in Tasks 1-3. Resolves
target date (arg or yesterday-UTC default), reads pm2-out.log (path
configurable via REJECT_METRICS_LOG env var for local testing), strips
pm2's line prefix, aggregates, writes data/metrics/reject-<date>.md.

Missing-log-file handling: logs an error and exits 1. Scheduler will
spawn this detached with stdio:'ignore' so exit-1 doesn't bubble.

Verified via local fixture run — produced the expected markdown dump.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Wire the cron into the scheduler

**Files:**
- Modify: `C:\Users\user\Desktop\Trade Bot\Trade Bot\src\scheduler\index.ts`

- [ ] **Step 1: Read the current scheduler file to find the insertion point**

Run: Use Read tool on `src/scheduler/index.ts`, looking for the "Sunday at 00:00 UTC: Weekly Review Agent" cron block (around line 554 as of commit `8914b00` — the Swing-removal commit). Insert the new cron AFTER the Weekly Review block, BEFORE the `console.log('Scheduler started...')` section.

- [ ] **Step 2: Add the `spawn` import if not present**

At the top of `src/scheduler/index.ts`, find the existing imports. Add (or verify exists):

```ts
import { spawn } from 'child_process';
```

(If already imported for another purpose, skip.)

- [ ] **Step 3: Add the new cron block**

In the scheduler startup block, immediately after the Weekly Review cron (`cron.schedule('0 0 * * 0', ...)`) and before the console.log, add:

```ts
  // Daily at 00:05 UTC: dump previous day's reject metrics.
  // Added 2026-04-23 (P4). Spawned as a detached process so the scheduler
  // event loop isn't blocked by the ~10s log scrape. Failures swallowed
  // via stdio:'ignore' + on('error') — observability must NEVER take
  // down the live trading loop.
  cron.schedule('5 0 * * *', () => {
    const proc = spawn('npx', ['tsx', 'scripts/dump-reject-metrics.ts'], {
      cwd: process.cwd(),
      detached: true,
      stdio: 'ignore',
    });
    proc.unref();
    proc.on('error', (err: Error) => {
      console.error(`[Scheduler] Reject-metrics dump failed to spawn: ${err.message}`);
    });
  });
```

- [ ] **Step 4: Update the console.log listing cron jobs**

Find the `console.log('  0 0 * * 0             — Weekly Review Agent');` line and add one line after it:

```ts
  console.log('  5 0 * * *             — Reject metrics dump (previous UTC day)');
```

- [ ] **Step 5: Build**

Run: `cd "/c/Users/user/Desktop/Trade Bot/Trade Bot" && npm run build 2>&1 | tail -5`
Expected: no TypeScript errors.

- [ ] **Step 6: Full test suite**

Run: `cd "/c/Users/user/Desktop/Trade Bot/Trade Bot" && npm test -- --run 2>&1 | tail -8`
Expected: 237/237 passing (no change — the cron block is scheduler runtime config, not tested).

- [ ] **Step 7: Commit**

```bash
cd "/c/Users/user/Desktop/Trade Bot/Trade Bot" && git add src/scheduler/index.ts && git commit -m "$(cat <<'EOF'
feat(scheduler): wire reject-metrics daily cron (P4 Task 5)

Adds a 00:05 UTC cron to spawn scripts/dump-reject-metrics.ts detached.
Previous UTC day's log gets aggregated into data/metrics/reject-<date>.md
for human review. Spawned with stdio:'ignore' + on('error') handler so
a script failure cannot take down the scheduler.

Deploy: requires one pm2 restart to activate the new cron. No other
behavior change.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Deploy + manual VPS verification

**Files:**
- No files created. Deploy + manual verification only.

- [ ] **Step 1: Push all P4 commits**

Run: `cd "/c/Users/user/Desktop/Trade Bot/Trade Bot" && git push origin master 2>&1 | tail -5`
Expected: `master -> master` success (with the "Bypassed rule violations" warning — standard Farad demo workflow).

- [ ] **Step 2: VPS pull + build + pm2 restart**

Run:
```bash
ssh -o ConnectTimeout=15 bot@162.55.212.198 "cd /home/bot/trading-bot && git pull --ff-only 2>&1 | tail -6 && npm run build 2>&1 | tail -3 && pm2 restart trading-bot 2>&1 | tail -3"
```
Expected: pull fast-forwards, build clean, pm2 restart increments the restart counter with no errors.

- [ ] **Step 3: Verify scheduler lists the new cron on startup**

Run: `ssh -o ConnectTimeout=10 bot@162.55.212.198 "pm2 logs trading-bot --lines 30 --nostream 2>&1 | grep -A 8 'Scheduler started' | tail -12"`
Expected: the cron-list block now includes a line like:
```
  5 0 * * *             — Reject metrics dump (previous UTC day)
```

- [ ] **Step 4: Manual one-shot run against today's log (skip-ahead check)**

Don't wait for 00:05 UTC — manually invoke the script on the VPS to validate it works on real log data. Pick yesterday's date (2026-04-22) since we have a full day of data for it:

Run:
```bash
ssh -o ConnectTimeout=20 bot@162.55.212.198 "cd /home/bot/trading-bot && npx tsx scripts/dump-reject-metrics.ts 2026-04-22 2>&1 | tail -5 && echo '---' && cat data/metrics/reject-2026-04-22.md | head -60"
```

Expected output (approximate):
- Script prints "[reject-metrics] Wrote /home/bot/trading-bot/data/metrics/reject-2026-04-22.md"
- Summary line: cycle count, place_order count, skip count
- The markdown file contains the Summary, Skip breakdown, Per-instrument matrix, Per-kill-zone, and Executed trades sections
- For 2026-04-22: at least 1 executed trade (USDJPY at 14:18:49) should appear in the Executed trades section
- Per-kill-zone should show cycles in London Open, NY Open, London Close, outside buckets

- [ ] **Step 5: Run for 2026-04-23 (today) as well to validate multi-day**

```bash
ssh -o ConnectTimeout=20 bot@162.55.212.198 "cd /home/bot/trading-bot && npx tsx scripts/dump-reject-metrics.ts 2026-04-23 2>&1 | tail -5"
```

Expected: writes `data/metrics/reject-2026-04-23.md` without error.

- [ ] **Step 6: Spot-check the numbers against the diagnostic**

The 2026-04-23 diagnostic recorded (earlier in this session):
- 664 ICT decision cycles
- 181 "outside kill zone" skips
- 52 "no trigger" skips
- 5 ICT place_order calls

Check if the generated `reject-2026-04-23.md` summary numbers roughly match:

```bash
ssh -o ConnectTimeout=10 bot@162.55.212.198 "grep -E 'decision cycles|Place_order calls|outside_kill_zone|no_trigger' /home/bot/trading-bot/data/metrics/reject-2026-04-23.md"
```

Expected: the markdown numbers are within ±20 of the diagnostic numbers. Exact match isn't required — the diagnostic used slightly different grep patterns. But if cycles is 664 ± 20, place_order is 5 ± 1, and the top skip categories are present with sensible counts, the scraper is working.

If the numbers are WILDLY off (e.g., cycles=0 or place_order=100), stop and investigate the patterns — likely a regex is wrong or the date filter isn't catching the pm2 prefix correctly.

- [ ] **Step 7: Done — no commit needed for Task 6**

Task 6 is verification only. No artifacts to commit. Report the verification result to Giuseppe in the chat.

---

## Self-Review

Spec coverage check against `docs/superpowers/specs/2026-04-23-reject-metrics-design.md`:

- Spec §1 Problem statement — **Task 1 Step 3** comment block references the diagnostic and the purpose. ✓
- Spec §2 Architecture — **Task 1** creates the module, **Task 5** wires the cron. ✓
- Spec §3 Skip categories (priority-ordered) — **Task 1 Step 3** implementation has `PATTERNS` array in priority order, **Task 1 Step 1** tests verify priority-order enforcement. ✓
- Spec §3 Execute categories — **Task 1 Step 3** PATTERNS includes all 4, tests cover all 4. ✓
- Spec §3 Per-instrument attribution — **Task 2 Step 3** implements `extractInstrument` with window + case-sensitive match + universe list. ✓
- Spec §3 Per-kill-zone attribution — **Task 2 Step 3** implements `extractKillZone` with both prose and record formats. ✓
- Spec §4 Output format — **Task 3 Step 3** `renderMarkdown` produces the format; **Task 3 Step 1** test asserts key sections. ✓
- Spec §5 Testing — **Tasks 1, 2, 3** all have unit tests covering each pure-function export. Integration test is in **Task 6 Steps 4-6**. ✓
- Spec §6 Scheduler wiring — **Task 5 Steps 2-4** add import, cron, console log. ✓
- Spec §7 File layout — plan creates `scripts/dump-reject-metrics.ts` and `tests/dump-reject-metrics.test.ts`, modifies `src/scheduler/index.ts`. `.gitignore` check deferred to Task 4 local verification since `data/` is already excluded. ✓
- Spec §8 Out of scope — plan does not add Grafana, HTTP endpoints, hourly breakdown, anomaly detection, Telegram, or weekly rollups. ✓
- Spec §9 Success criteria — each of the 6 criteria maps to a Task step (criterion 1 → every task's test run, criterion 2 → Tasks 1-3 test counts, criterion 3 → Task 6 Step 6, criterion 4 → Task 5 Step 4, criterion 5 → Task 6 Steps 2-3, criterion 6 → file-layout discipline in each task). ✓
- Spec §10 Demo-safety — plan explicitly avoids all live-path files, uses detached spawn, and catches spawn errors. ✓
- Spec §11 Timeline — plan fits the ~90-min estimate (Task 1 ~25 min, Task 2 ~15 min, Task 3 ~20 min, Task 4 ~10 min, Task 5 ~5 min, Task 6 ~10 min). ✓

Placeholder scan: no "TBD", "TODO", or vague-error phrases. Every code step shows actual code. Every command shows expected output.

Type consistency: `SkipCategory`, `ExecuteCategory`, `Category`, `Instrument`, `KillZone`, `MetricsReport`, `ExecutedTrade`, `classifyLine`, `extractInstrument`, `extractKillZone`, `aggregateLog`, `renderMarkdown`, `UNIVERSE` — all used consistently across Tasks 1-4.

---

## Execution notes

- **No worktree:** continuing on master, consistent with today's pattern. Observability-only work; no live-path risk.
- **Atomic commits:** Tasks 1, 2, 3, 4, 5 each produce one commit (5 total). Task 6 produces no commit (verification-only).
- **Stop conditions:** if any pattern regex repeatedly fails against real log lines (Task 6 Step 6), stop and investigate — it means the log format has drifted from the diagnostic-session captures.
- **Single pm2 restart at Task 6 Step 2** — the only deploy event in P4.

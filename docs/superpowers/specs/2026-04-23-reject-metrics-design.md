# Reject Metrics (P4) — Design Spec

**Date:** 2026-04-23
**Author:** Giuseppe Portelli + Claude Code (Opus 4.7)
**Status:** approved by Giuseppe (brainstorming gate), pending spec review
**Context:** follow-up to the 2026-04-23 backtest-vs-live diagnostic
([docs/superpowers/reviews/2026-04-23-backtest-vs-live-diagnostic.md](../reviews/2026-04-23-backtest-vs-live-diagnostic.md))
**Priority:** P4 — observability-only, no changes to live trading decisions

---

## 1. Problem statement

Diagnosing "is the bot underperforming?" today requires a 3-agent forensic
investigation that takes ~20 minutes (see the 2026-04-23 diagnostic). The
raw data to answer the question sits in `/home/bot/trading-bot/data/pm2-out.log`
— every skip reason, every kill-zone decision, every `place_order` attempt
— but it's unstructured prose the LLM writes. There's no summary view
that says "today the bot ran 664 cycles, skipped 52 for missing 15M
trigger, and executed 2 trades."

**Goal:** a daily markdown dump at `data/metrics/reject-YYYY-MM-DD.md`
that answers "what did the bot do today and why did it skip everything
else" in ≤30 seconds of reading, produced automatically by a cron job
at 00:05 UTC each day for the previous UTC day's data.

**Non-goal:** changing any live decision. This is pure observability.

**Non-goal:** real-time metrics dashboard, Prometheus/Grafana integration,
or any in-process state. Post-hoc log analysis only.

## 2. Architecture

```
scripts/dump-reject-metrics.ts      (NEW, ~150 lines)
  │
  │  CLI: tsx scripts/dump-reject-metrics.ts [YYYY-MM-DD]
  │  Default date = yesterday (UTC)
  │
  │  1. Read /home/bot/trading-bot/data/pm2-out.log
  │  2. Filter to lines matching the target UTC date prefix
  │  3. Sliding-window pattern match to categorize each cycle
  │  4. Aggregate counts + per-instrument matrix + per-kill-zone view
  │  5. Write data/metrics/reject-YYYY-MM-DD.md (creates dir if missing)
  │
  ▼
data/metrics/reject-YYYY-MM-DD.md   (NEW per day, ~60 lines each)

src/scheduler/index.ts              (MODIFIED, +~8 lines)
  │
  │  New cron '5 0 * * *' (00:05 UTC daily):
  │    child_process.spawn('npx', ['tsx', 'scripts/dump-reject-metrics.ts'], ...)
  │    Swallows errors — dump failure must NOT take down the live bot.
```

### Why log-scrape not in-process counters

1. **Zero touch on the live decision path.** The ICT agent, Analyst,
   scanner, and news filter all keep behaving identically. If the scraper
   is broken, nothing breaks with the bot.
2. **Retroactive.** Can re-run for any past date; backfills are trivial
   since the log is append-only.
3. **Captures LLM-internal decisions.** Counters in code can't see "I'll
   skip this because the location is premium territory" — but that phrase
   lands in the log, so the scraper catches it.

### Tradeoff acknowledged

Grep patterns are brittle — if the LLM's phrasing drifts, we miss events.
Mitigation: unit tests exercise each pattern against historical log lines
that have already appeared in `pm2-out.log`. If phrasing drift breaks a
pattern, a test fails on the next release.

## 3. Skip + execute categories

### Skip categories (mutually exclusive — priority order)

> Note on the regex column: the `\|` alternation is markdown-cell-escape
> syntax. In actual TypeScript regex literals, write `|` (unescaped).
> The character classes and anchors are stock JavaScript regex syntax.

| Priority | Category | Regex pattern (multiline=true) | Meaning |
|---|---|---|---|
| 1 | `analyst_reject` | `Analyst Decision: REJECT\|Analyst.*REJECTED` | Pre-trade Analyst veto (highest priority marker) |
| 2 | `news_opposing` | `opposing news\|NEWS RISK OVERRIDE\|news-opposing\|disqualifier.*news\|news-blind` | News filter blocked the trade |
| 3 | `no_trigger` | `NO ENTRY TRIGGER\|no trigger\|NO VALID ENTRY LOCATION\|not printed the confirmation trigger` | Setup present, no 15M confirmation candle |
| 4 | `rr_fail` | `R:R.*below.*minimum\|R:R.*0\.\d+:1.*[❌]\|R:R to TP2.*non-negotiable` | R:R gate failed (live or post-fill) |
| 5 | `bias_unclear` | `1H Bias NEUTRAL\|1H Bias CONFLICTED\|bias unclear\|bias contradiction` | Scanner or LLM found no clean 1H bias |
| 6 | `score_too_low` | `Below Tier 3 threshold \(50\|Below.*Tier 3\|Score \d+ \(Below` | Composite < 45 even in kill zone |
| 7 | `outside_kill_zone` | `skipping ICT cycle.*outside kill zone\|outside kill zone: outside` | Scheduler gate — no ICT call made |

**First match wins.** A cycle that fired both a news-opposing skip AND a
bias-unclear skip would count as `news_opposing` (priority 2).

### Execute categories (not mutually exclusive with each other)

| Category | Regex pattern | Meaning |
|---|---|---|
| `place_order_executed` | `\[ICT Agent\] Calling tool: place_order` | LLM issued a market order |
| `log_trade_attempted` | `\[ICT Agent\] Calling tool: log_trade` | LLM tried to log the trade |
| `log_trade_failed` | `\[ICT Agent\] Tool log_trade failed` | DB insert failed |
| `ict_cycle_complete` | `ICT Trading Agent .*complete\|Scheduler. ICT Trading Agent complete` | End-of-cycle marker (counts total cycles processed) |

### Per-instrument attribution

For each skip event, scan the 10 lines above the skip marker for an
instrument-name match against the scanner universe
(`GOLD|SILVER|OIL_CRUDE|EURUSD|GBPUSD|USDJPY|AUDUSD`). If no instrument
appears in that window, attribute to the `_unknown` bucket.

### Per-kill-zone attribution

For each cycle, identify which kill zone the cycle happened in by looking
at the scheduler marker line (`Candle close at <ISO>.*kill zone: <name>`
or the ICT-Agent header line which names the current kill zone). Buckets:
`London Open`, `NY Open`, `London Close`, `outside`.

## 4. Output format

See spec §3 (identical — reproduced here for self-contained reference):

```markdown
# Farad Reject Metrics — 2026-04-23 (UTC)

Generated: 2026-04-24T00:05:00Z · Source: data/pm2-out.log

## Summary
- ICT decision cycles completed: **664**
- Place_order calls (ICT agent): **5**
- Successful log_trade inserts: **0**
- Failed log_trade inserts: **3**
- Total skips captured: **294** (of 664 cycles)
- **Execute rate: 0.75%** (5/664)

## Skip breakdown
| Category | Count | % of cycles |
|---|---|---|
| outside_kill_zone | 181 | 27.3% |
| bias_unclear | 52 | 7.8% |
| no_trigger | 47 | 7.1% |
| rr_fail | 8 | 1.2% |
| news_opposing | 3 | 0.5% |
| score_too_low | 2 | 0.3% |
| analyst_reject | 1 | 0.2% |

## Per-instrument skip matrix
| Instrument | outside_kz | bias | trigger | rr | analyst | news | score_low | total |
|---|---|---|---|---|---|---|---|---|
| EURUSD | 10 | 8 | 7 | 1 | 0 | 1 | 0 | 27 |
| GBPUSD | ...

## Per-kill-zone
| Kill zone | Cycles | Executed | Skipped |
|---|---|---|---|
| London Open | 120 | 2 | 118 |
| NY Open | 90 | 3 | 87 |
| London Close | 40 | 0 | 40 |
| outside | 414 | 0 | 414 |

## Executed trades (max 20)
1. 2026-04-21 12:58:41 UTC — GBPUSD SHORT — log_trade FAILED (schema bug, pre-fix 5ea2214)
2. 2026-04-22 14:18:49 UTC — USDJPY SHORT — closed_early (slippage R:R violation)
```

## 5. Testing

### Unit tests (new `tests/dump-reject-metrics.test.ts`)

Test the pattern-matching + aggregation logic in isolation. The script
exports pure functions for pattern classification so tests don't need
to touch the filesystem.

Required exports from the script (for testability):

```ts
export function classifyLine(line: string): SkipCategory | ExecuteCategory | null;
export function extractInstrument(windowLines: string[]): Instrument | '_unknown';
export function extractKillZone(windowLines: string[]): KillZone | 'outside';
export function aggregateLog(logLines: string[], targetDateUtc: string): MetricsReport;
export function renderMarkdown(report: MetricsReport, generatedAt: string): string;
```

Test cases:

1. **Each category's regex matches its expected live-log lines.** For each
   of the 11 categories (7 skip + 4 execute), provide 2-3 real or
   realistic log lines from `pm2-out.log` and assert classification.
2. **Priority order enforced for mutually-exclusive skip cats.** A line
   that matches both `news_opposing` (priority 2) and `bias_unclear`
   (priority 5) classifies as `news_opposing`.
3. **Instrument extraction.** Given a 10-line window with "GBPUSD" in
   line 3, returns `GBPUSD`. Given a window with no universe ticker,
   returns `_unknown`.
4. **Kill-zone extraction.** Similar logic, returns correct bucket.
5. **aggregateLog end-to-end.** Given 50 curated log lines spanning a full
   day, produces the expected `MetricsReport` (counts per category, per
   instrument, per kill zone).
6. **renderMarkdown snapshot.** Given a known `MetricsReport`, produces
   expected markdown (exact string match).

### Integration test (manual, not CI)

Run `tsx scripts/dump-reject-metrics.ts 2026-04-23` against the actual
VPS log. Verify:
- The summary "ICT decision cycles completed" matches the `grep -c 'ICT
  Trading Agent .*complete'` count from the real log.
- "Place_order calls" = 5 (known from earlier diagnostic).
- At least one row in each of the 7 skip categories has count > 0 (since
  β's audit found examples of all of them).

## 6. Scheduler wiring

Add one cron to `src/scheduler/index.ts` after the Weekly Review cron:

```ts
// Add at the top of src/scheduler/index.ts (if not already imported):
import { spawn } from 'child_process';

// Daily at 00:05 UTC: dump previous day's reject metrics.
// Spawned as a detached process so the scheduler's event loop isn't held
// up by the ~10s log-scrape. Script failures are swallowed — the live
// bot must never lose a cron tick because observability crashed.
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

And the console.log listing cron jobs gets one new line:

```ts
console.log('  5 0 * * *             — Reject metrics dump (previous UTC day)');
```

## 7. File layout

**Created:**
- `scripts/dump-reject-metrics.ts` — the CLI script (~150 lines)
- `tests/dump-reject-metrics.test.ts` — unit tests (~200 lines with fixtures)
- `data/metrics/` directory — created by the script on first run
- `data/metrics/reject-YYYY-MM-DD.md` — one per day

**Modified:**
- `src/scheduler/index.ts` — +~8 lines for the new cron
- `.gitignore` — add `data/metrics/` if not already covered by `data/*`
  (verify during implementation — `data/` may already be gitignored)

**Not touched:**
- Any agent file, any prompt, any scanner logic, any trading-tools.ts
- The live ICT decision path
- The Capital.com client
- The database

## 8. Out of scope

- Real-time dashboards (Grafana, Prometheus, etc.)
- In-process counters exposed via HTTP
- Per-hour breakdown (kill-zone granularity is sufficient)
- Anomaly detection (manual review of the daily file is enough for now)
- Historical backfill beyond what's already in `pm2-out.log`
- Any changes to the LLM's phrasing to make patterns more reliable
- Telegram/Slack notification of the daily report
- Long-term aggregation (weekly/monthly rollups)

## 9. Success criteria (definition of "done")

1. All existing tests still pass (204/204 after the P3 cycle).
2. New `dump-reject-metrics.test.ts` passes (≥15 test cases covering
   classification, priority order, instrument/kill-zone extraction,
   aggregation, markdown rendering).
3. Manual run against the VPS's 2026-04-23 log produces a markdown file
   where `Place_order calls = 5`, at least one skip category has count
   > 0, and the total `ICT decision cycles completed` matches the
   diagnostic's observed 664.
4. Cron is added to `src/scheduler/index.ts`, and scheduler's
   "Cron jobs active" console output lists the new schedule.
5. Deploy verification: pm2 restart on VPS, bot starts cleanly, new
   cron line appears in startup log.
6. Changes are limited to `scripts/`, `src/scheduler/index.ts`, `tests/`,
   and (possibly) `.gitignore`.

## 10. Demo-safety

- **Zero touches on the live decision path.** Agent, prompts, news, scanner,
  analyst all behave identically.
- **Dump-script failure is non-fatal.** The scheduler spawns with
  `detached: true, stdio: 'ignore'` and catches `error` events. Bot
  continues running even if the script crashes, throws, or never starts.
- **One pm2 restart.** To deploy the scheduler change. Same
  measured-in-seconds downtime as today's other restarts.
- **No DB writes.** Pure filesystem read + markdown write.
- **Runs at 00:05 UTC.** Outside active kill zones (London opens 07:00,
  NY opens 13:00). No chance of stealing CPU from trading decisions.

## 11. Timeline

- Script + tests: ~60 min
- Scheduler wiring + tests: ~15 min
- Manual VPS verification: ~10 min
- Commit + push + deploy: ~10 min
- **Total: ~90 min**

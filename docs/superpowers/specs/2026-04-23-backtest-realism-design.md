# Backtest Realism (Spread + Slippage) — Design Spec

**Date:** 2026-04-23
**Author:** Giuseppe Portelli + Claude Code (Opus 4.7)
**Status:** approved by Giuseppe (brainstorming gate), pending spec review
**Context:** follow-up to the 2026-04-23 backtest-vs-live diagnostic
([docs/superpowers/reviews/2026-04-23-backtest-vs-live-diagnostic.md](../reviews/2026-04-23-backtest-vs-live-diagnostic.md))
**Priority:** P3 — safest of the 4 recommendations because it only modifies
offline backtest code. No production impact. No pm2 restart needed.

---

## 1. Problem statement

The current backtest engine (`src/backtest/engine.ts`) assumes zero spread
and zero slippage on every trade. Agent γ's math quantified that this
overstates strategy PnL by −3072 R over 14,918 trades (spread −897 R +
slippage −2175 R), reducing the headline +1671 R to approximately −1401 R
before news-filter effects. The 2026-04-22 USDJPY fill (14.6 pips of entry
slippage, gutting R:R from 1.7:1 to 0.5:1) is the live-grounded anchor for
the slippage number.

**Goal:** patch the backtest engine so its output reflects realistic
execution costs, so future backtest runs produce numbers Giuseppe can trust
as an honest upper bound on live strategy performance.

**Non-goal:** news-filter proxy (γ's Delta 3, credibility C). Deferred to
post-demo — requires a 2019-2025 high-impact economic event calendar we'd
have to build from scratch for a small credibility-C delta.

## 2. Architecture

```
src/backtest/
├── engine.ts        (270 lines, existing — minor ~10-line diff)
│   └── resolveOutcome() subtracts computeExecutionCost(ticker, stopDistance)
│       from the returned pnl_r. No changes to scoring, bias, entry, or
│       tier-assignment logic.
│
└── realism.ts       (NEW, ~80 lines)
    ├── ExecutionCostConstants interface
    ├── EXECUTION_COSTS: 7-entry Record keyed by ticker
    ├── computeExecutionCost(ticker, stopDistance) → R-cost number
    ├── First-time-unknown warning state
    └── _internalsForTest (sanity checks exposed for unit tests)
```

**Data flow:**
```
engine.runBacktest
  → candle loop
    → scoring / tier / R:R checks (unchanged)
    → resolveOutcome walks forward to TP or SL hit
      → returns gross pnl_r (as before, e.g. +2.5 for tp2)
    → NEW: subtract computeExecutionCost(ticker, stopDistance) from pnl_r
    → push to trades[] with net pnl_r
  → aggregate stats (now reflect net R)
```

All downstream fields (`total_r`, `win_rate`, `profit_factor`, `avg_r_per_trade`,
`max_drawdown_r`, `tier_breakdown`) recompute off the new net R values.

## 3. Module API

### `realism.ts`

```ts
export interface ExecutionCostConstants {
  /** Spread in instrument's native price units. Pips*pip_size for FX,
   *  dollars for commodities. */
  spread: number;
  /** Entry slippage in native price units. Anchored to 2026-04-22
   *  USDJPY 14.6-pip live observation for USDJPY; other instruments
   *  scaled proportionally. */
  slippage_entry: number;
  /** Exit slippage in native price units. ~30-40% of entry slippage
   *  (stop hunts and TP fill noise both tend to be net-adverse). */
  slippage_exit: number;
}

export const EXECUTION_COSTS: Record<string, ExecutionCostConstants>;

/**
 * Compute the R-unit execution cost for a trade on the given ticker
 * with the given stop distance (in the instrument's native price units).
 *
 * Formula:
 *   total_cost = spread + slippage_entry + slippage_exit
 *   r_cost = total_cost / stopDistance
 *
 * Unknown ticker or stopDistance <= 0 → returns 0. First unknown ticker
 * per process logs a console.warn (suppressed on repeat for the same
 * ticker to avoid flooding logs).
 */
export function computeExecutionCost(ticker: string, stopDistance: number): number;

/** Test-only exposure of the unknown-ticker-warned set + a sanity map
 *  of (ticker → expected R-cost at γ's typical-stop assumption) used by
 *  tests/realism.test.ts for regression assertions. */
export const _internalsForTest: {
  warnedTickers: Set<string>;
  expectedRCostAtTypicalStop: Record<string, number>;
  resetWarnings: () => void;
};
```

### Constants (live-grounded, derived from γ's math)

| Ticker | `spread` | `slippage_entry` | `slippage_exit` | Expected R¹ |
|---|---|---|---|---|
| EURUSD | 0.00008 | 0.00007 | 0.00004 | 0.15 |
| GBPUSD | 0.00012 | 0.00010 | 0.00005 | 0.22 |
| USDJPY | 0.010 | 0.146 | 0.050 | 0.29 |
| AUDUSD | 0.00010 | 0.00009 | 0.00005 | 0.20 |
| GOLD | 0.40 | 0.60 | 0.45 | 0.20 |
| SILVER | 0.025 | 0.040 | 0.020 | 0.18 |
| OIL_CRUDE | 0.04 | 0.07 | 0.04 | 0.18 |

¹ *Expected R at γ's typical-stop assumption (1.5×ATR per the engine's SL formula). Sanity-checked by `_internalsForTest.expectedRCostAtTypicalStop` in the unit tests.*

### `engine.ts` integration

Exactly one location modified — `resolveOutcome()` at lines 85-142. Add at the
return sites:

```ts
import { computeExecutionCost } from './realism.js';

// inside resolveOutcome, before each return:
const stopDistance = direction === 'long' ? entry - sl : sl - entry;
const executionCost = computeExecutionCost(ticker, stopDistance);
return {
  outcome,
  exit_time,
  pnl_r: pnl_r - executionCost,
};
```

Ticker needs to flow into `resolveOutcome()` from `runBacktest()` — add it as
a parameter (type: `string`). Existing callers in `runBacktest()` pass it
from the `ticker` variable already in scope.

## 4. Testing

### Unit tests (new `tests/realism.test.ts`)

- `computeExecutionCost('EURUSD', 0.002)` returns expected R (≈0.095 given 19 pips cost / 200 pips stop)
- `computeExecutionCost('UNKNOWN', 0.001)` returns 0 and logs warning once; second call for same ticker does NOT log (verify via spy on console.warn)
- `computeExecutionCost('EURUSD', 0)` returns 0 (guards against divide-by-zero)
- `computeExecutionCost('EURUSD', -0.001)` returns 0 (guards against nonsense input)
- For each of the 7 known tickers, verify the R-cost at γ's typical stop (from `_internalsForTest.expectedRCostAtTypicalStop`) falls within ±0.02 R of the expected value

### Regression tests (existing engine tests — MUST still pass)

The existing engine logic (bias detection, scoring, tier assignment, entry,
TP/SL walk, cooldown) is untouched. All currently passing tests must continue
to pass.

### Integration sanity check (manual, not CI-enforced)

Run `npm run backtest` with the patched engine and confirm aggregates fall
within ±15% of γ's predictions:

| Check | Target | Acceptable range |
|---|---|---|
| Total R across 7 instruments | ≈ −1401 | [−1612, −1190] |
| USDJPY total R | +285 → ≈ −402 | [−462, −342] |
| EURUSD total R | +188 → ≈ −157 | [−181, −133] |
| GOLD total R | +298.5 → ≈ −90 | [−103, −76] |
| Win rate | ~34% (unchanged) | ±1% |

The win rate must stay approximately unchanged — wins still win, losses still
lose; only the R-amount each trade earns/costs changes.

## 5. Out of scope

- News-filter proxy (γ's Delta 3) — deferred to post-demo per spec §1 non-goal
- Changes to any file outside `src/backtest/` or `tests/`
- Adding new fields to `BacktestResult` (keep the interface identical —
  only the numeric values change)
- Rerunning and committing a new backtest output file (that's a separate
  follow-up if Giuseppe wants it)
- Any live-bot behavior change — this is offline simulator only
- Any `pm2 restart` — no deploy needed

## 6. Success criteria (definition of "done")

1. All 193 existing tests still pass.
2. New realism unit tests pass.
3. `npm run backtest` completes without error and produces a `total_r` in
   the range [−1612, −1190].
4. Per-instrument totals for all 7 tickers fall within ±15% of γ's
   predicted deltas.
5. Changes are limited to `src/backtest/engine.ts`, `src/backtest/realism.ts`
   (new), and `tests/realism.test.ts` (new). No other files touched.
6. Single atomic commit: `feat(backtest): model spread + slippage (γ's
   realism check)`.

## 7. Demo-safety

This change touches offline backtest code only. The production trading
path does not import `src/backtest/`. No pm2 restart, no VPS deploy, no
DB write, no Capital.com interaction. 100% safe to merge and ship mid-demo.

## 8. Timeline

- Plan write: ~15 min
- Implementation: ~30-45 min (small module + integration point + tests)
- Integration sanity run: ~2 min
- Commit + push: ~5 min
- **Total: ~1 hour** from plan start to committed change

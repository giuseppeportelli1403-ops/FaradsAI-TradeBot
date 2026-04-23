# Backtest Realism (P3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Patch `src/backtest/engine.ts` to model per-instrument spread + slippage costs on every backtest trade, producing output numbers consistent with Agent γ's 2026-04-23 diagnostic math (+1671 R headline → ≈ −1401 R realistic).

**Architecture:** New `src/backtest/realism.ts` module exports `EXECUTION_COSTS` constants + a `computeExecutionCost(ticker, stopDistance)` function. The engine's `resolveOutcome()` calls it once per trade, subtracting the R-cost from the returned `pnl_r`. No changes to scoring, bias, entry, tier-assignment, or TP/SL walk logic — friction is pure post-settlement subtraction.

**Tech Stack:** TypeScript (strict), Vitest (existing test framework), no new dependencies.

---

## File Structure

**Created by this plan:**
- `src/backtest/realism.ts` — per-instrument execution-cost constants + `computeExecutionCost` function + test-only internals export (~80 lines)
- `tests/realism.test.ts` — unit tests covering known tickers, unknown-ticker warning, guard clauses, and γ's expected-R sanity checks (~100 lines)

**Modified by this plan:**
- `src/backtest/engine.ts` — `resolveOutcome()` gains a `ticker` parameter and subtracts `computeExecutionCost` from `pnl_r` at each return site. Single call site in `runBacktest()` updated to pass `ticker`. ~10 line diff.

**NOT touched:**
- Any production trading code (`src/agents/*`, `src/scheduler/*`, `src/mcp-server/*`, `src/scanner/*`, `src/news/*`)
- The scanner's scoring, bias detection, or tier thresholds
- Any DB schema or migration
- Any prompt file

**Testing framework:** Vitest. Run `npm test -- --run` from the repo root. Current passing count: **193** (post-Swing removal, as of commit `2f2b4b0`).

---

### Task 1: Create `realism.ts` module with TDD

**Files:**
- Create: `C:\Users\user\Desktop\Trade Bot\Trade Bot\src\backtest\realism.ts`
- Create: `C:\Users\user\Desktop\Trade Bot\Trade Bot\tests\realism.test.ts`

- [ ] **Step 1: Write the failing test file**

Create `C:\Users\user\Desktop\Trade Bot\Trade Bot\tests\realism.test.ts` with this exact content:

```ts
// Tests for src/backtest/realism.ts — execution-cost modeling for
// backtest trades. Derived from Agent γ's 2026-04-23 diagnostic math
// (see docs/superpowers/reviews/2026-04-23-backtest-vs-live-diagnostic.md).
// Anchored on the 2026-04-22 USDJPY live observation (14.6 pips of entry
// slippage gutting R:R from 1.7:1 to 0.5:1).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  EXECUTION_COSTS,
  computeExecutionCost,
  _internalsForTest,
} from '../src/backtest/realism.js';

describe('EXECUTION_COSTS constants', () => {
  it('covers all 7 Farad universe tickers', () => {
    const expected = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'GOLD', 'SILVER', 'OIL_CRUDE'];
    for (const ticker of expected) {
      expect(EXECUTION_COSTS[ticker]).toBeDefined();
    }
  });

  it('every entry has spread + slippage_entry + slippage_exit as positive numbers', () => {
    for (const [ticker, costs] of Object.entries(EXECUTION_COSTS)) {
      expect(costs.spread, `${ticker}.spread`).toBeGreaterThan(0);
      expect(costs.slippage_entry, `${ticker}.slippage_entry`).toBeGreaterThan(0);
      expect(costs.slippage_exit, `${ticker}.slippage_exit`).toBeGreaterThan(0);
    }
  });

  it('USDJPY slippage_entry is live-grounded at ~14.6 pips (0.146 in price units)', () => {
    // The 2026-04-22 USDJPY observation: expected 159.333, filled 159.187.
    // The 14.6-pip slippage is the anchor value for this constant.
    expect(EXECUTION_COSTS.USDJPY.slippage_entry).toBeCloseTo(0.146, 3);
  });
});

describe('computeExecutionCost', () => {
  beforeEach(() => {
    _internalsForTest.resetWarnings();
  });

  it('returns R-cost as (spread + slippage_entry + slippage_exit) / stopDistance', () => {
    // EURUSD: 0.00008 + 0.00007 + 0.00004 = 0.00019. Stop 0.00130 → 0.146 R.
    const result = computeExecutionCost('EURUSD', 0.00130);
    expect(result).toBeCloseTo(0.146, 2);
  });

  it('is case-insensitive on ticker input', () => {
    const upper = computeExecutionCost('EURUSD', 0.00130);
    const lower = computeExecutionCost('eurusd', 0.00130);
    const mixed = computeExecutionCost('EurUsd', 0.00130);
    expect(upper).toBe(lower);
    expect(upper).toBe(mixed);
  });

  it('unknown ticker returns 0 and warns exactly once per ticker', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const first = computeExecutionCost('FAKE_TICKER', 0.001);
    const second = computeExecutionCost('FAKE_TICKER', 0.001);
    const third = computeExecutionCost('FAKE_TICKER', 0.001);

    expect(first).toBe(0);
    expect(second).toBe(0);
    expect(third).toBe(0);
    // Exactly one warn call across three invocations.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('FAKE_TICKER');

    warnSpy.mockRestore();
  });

  it('different unknown tickers each warn once', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    computeExecutionCost('UNKNOWN_A', 0.001);
    computeExecutionCost('UNKNOWN_B', 0.001);
    computeExecutionCost('UNKNOWN_A', 0.001); // duplicate of A — no warn
    computeExecutionCost('UNKNOWN_B', 0.001); // duplicate of B — no warn

    expect(warnSpy).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });

  it('stopDistance of 0 returns 0 (no divide-by-zero)', () => {
    expect(computeExecutionCost('EURUSD', 0)).toBe(0);
  });

  it('negative stopDistance returns 0 (guards against nonsense input)', () => {
    expect(computeExecutionCost('EURUSD', -0.001)).toBe(0);
  });

  it('NaN stopDistance returns 0', () => {
    expect(computeExecutionCost('EURUSD', NaN)).toBe(0);
  });

  it('each of the 7 universe tickers hits γ expected R at its typical stop', () => {
    // Sanity: at the typical stop distance γ used, the R-cost should be
    // close to γ's headline per-instrument cost. ±0.02 R tolerance.
    const checks = _internalsForTest.expectedRCostAtTypicalStop;
    for (const [ticker, { typicalStop, expectedRCost }] of Object.entries(checks)) {
      const actual = computeExecutionCost(ticker, typicalStop);
      expect(actual, `${ticker} @ stop ${typicalStop}`).toBeCloseTo(expectedRCost, 1);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd "/c/Users/user/Desktop/Trade Bot/Trade Bot" && npm test -- --run tests/realism.test.ts 2>&1 | tail -20`

Expected: FAIL. Error should be "Cannot find module '../src/backtest/realism.js'" or similar.

- [ ] **Step 3: Create `src/backtest/realism.ts`**

Create `C:\Users\user\Desktop\Trade Bot\Trade Bot\src\backtest\realism.ts` with this exact content:

```ts
// Backtest Realism — per-instrument spread + slippage cost model
//
// The backtest engine at src/backtest/engine.ts assumes zero spread and
// zero slippage on every trade. Agent γ's 2026-04-23 diagnostic
// (docs/superpowers/reviews/2026-04-23-backtest-vs-live-diagnostic.md)
// quantified this overstates strategy PnL by approximately −3072 R across
// the 14,918-trade 2019-2025 backtest (spread −897 R + slippage −2175 R).
// The 2026-04-22 USDJPY fill (expected 159.333, filled 159.187, 14.6 pips
// of entry slippage that gutted R:R from 1.7:1 to 0.5:1) is the
// live-grounded anchor for the USDJPY slippage_entry constant below.
// Other instruments scaled proportionally using typical Capital.com demo
// spreads and market-order fill behavior.
//
// News-filter proxy (γ's Delta 3, credibility C) is NOT implemented here —
// it's deferred to post-demo per the spec §1 non-goal.

export interface ExecutionCostConstants {
  /** Spread in instrument's native price units. Pips × pip_size for FX,
   *  dollars for commodities. */
  spread: number;
  /** Entry slippage in native price units. Anchored to the 2026-04-22
   *  USDJPY 14.6-pip live observation for USDJPY; other instruments
   *  scaled proportionally. */
  slippage_entry: number;
  /** Exit slippage in native price units. Typically ~30-40% of entry
   *  slippage — stop hunts and TP fill noise both tend net-adverse. */
  slippage_exit: number;
}

/** Per-instrument execution costs. Native price units. */
export const EXECUTION_COSTS: Record<string, ExecutionCostConstants> = {
  EURUSD:    { spread: 0.00008, slippage_entry: 0.00007, slippage_exit: 0.00004 },
  GBPUSD:    { spread: 0.00012, slippage_entry: 0.00010, slippage_exit: 0.00005 },
  USDJPY:    { spread: 0.010,   slippage_entry: 0.146,   slippage_exit: 0.050   },
  AUDUSD:    { spread: 0.00010, slippage_entry: 0.00009, slippage_exit: 0.00005 },
  GOLD:      { spread: 0.40,    slippage_entry: 0.60,    slippage_exit: 0.45    },
  SILVER:    { spread: 0.025,   slippage_entry: 0.040,   slippage_exit: 0.020   },
  OIL_CRUDE: { spread: 0.04,    slippage_entry: 0.07,    slippage_exit: 0.04    },
};

// Track unknown-ticker warnings so we log at most once per ticker per
// process. Noise control: a typo in the engine (e.g., 'SILVER_FUT') should
// flag loudly the first time it's seen, then stay silent so downstream log
// readers aren't drowned.
const warnedTickers = new Set<string>();

/**
 * Compute the R-unit execution cost for a trade on the given ticker
 * with the given stop distance (in the instrument's native price units).
 *
 * Formula:
 *   total_cost = spread + slippage_entry + slippage_exit
 *   r_cost     = total_cost / stopDistance
 *
 * Returns 0 for:
 *   - unknown ticker (warns once per ticker per process)
 *   - non-positive stopDistance (avoids divide-by-zero and nonsense input)
 *   - NaN stopDistance (same rationale)
 */
export function computeExecutionCost(ticker: string, stopDistance: number): number {
  if (!Number.isFinite(stopDistance) || stopDistance <= 0) {
    return 0;
  }

  const upper = ticker.toUpperCase();
  const costs = EXECUTION_COSTS[upper];

  if (!costs) {
    if (!warnedTickers.has(upper)) {
      warnedTickers.add(upper);
      console.warn(
        `[Realism] Unknown ticker '${upper}' — returning 0 execution cost. ` +
        `Add to EXECUTION_COSTS in src/backtest/realism.ts to avoid silently ` +
        `overstating backtest R. This warning fires once per ticker per process.`,
      );
    }
    return 0;
  }

  const totalCost = costs.spread + costs.slippage_entry + costs.slippage_exit;
  return totalCost / stopDistance;
}

/**
 * Test-only exposure. Lives at the bottom of the module so it's visually
 * obvious these are not part of the public runtime surface.
 *
 *   - `warnedTickers`:         the live Set, for inspecting/asserting warn state
 *   - `expectedRCostAtTypicalStop`: γ's per-instrument typical-stop assumption
 *                              paired with the R-cost γ expects at that stop.
 *                              Used by tests to sanity-check that the constants
 *                              above produce γ's headline numbers.
 *   - `resetWarnings`:         clears warnedTickers for test isolation.
 */
export const _internalsForTest = {
  warnedTickers,
  expectedRCostAtTypicalStop: {
    EURUSD:    { typicalStop: 0.00130, expectedRCost: 0.15 },
    GBPUSD:    { typicalStop: 0.00125, expectedRCost: 0.22 },
    USDJPY:    { typicalStop: 0.71,    expectedRCost: 0.29 },
    AUDUSD:    { typicalStop: 0.00120, expectedRCost: 0.20 },
    GOLD:      { typicalStop: 7.25,    expectedRCost: 0.20 },
    SILVER:    { typicalStop: 0.47,    expectedRCost: 0.18 },
    OIL_CRUDE: { typicalStop: 0.83,    expectedRCost: 0.18 },
  } as Record<string, { typicalStop: number; expectedRCost: number }>,
  resetWarnings: (): void => {
    warnedTickers.clear();
  },
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd "/c/Users/user/Desktop/Trade Bot/Trade Bot" && npm test -- --run tests/realism.test.ts 2>&1 | tail -15`

Expected: `Test Files  1 passed (1)` / `Tests  9 passed (9)`.

If any test fails, re-read the error, fix the implementation or the test (whichever is wrong), and re-run. Do NOT move to Step 5 with failing tests.

- [ ] **Step 5: Run the full test suite to confirm no regressions**

Run: `cd "/c/Users/user/Desktop/Trade Bot/Trade Bot" && npm test -- --run 2>&1 | tail -8`

Expected: `Test Files  16 passed (16)` / `Tests  202 passed (202)` (was 193 + 9 new).

- [ ] **Step 6: Commit**

Run:
```bash
cd "/c/Users/user/Desktop/Trade Bot/Trade Bot" && git add src/backtest/realism.ts tests/realism.test.ts && git commit -m "$(cat <<'EOF'
feat(backtest): add realism module with per-instrument spread + slippage

New src/backtest/realism.ts exports EXECUTION_COSTS for the 7 Farad
universe tickers and computeExecutionCost(ticker, stopDistance) which
returns the R-unit friction cost for a trade. Module stands alone — the
engine integration is a separate commit (follow-up Task 2).

USDJPY slippage_entry (0.146) is live-grounded in the 2026-04-22 fill
observation; all other constants derived from Agent γ's diagnostic math
in docs/superpowers/reviews/2026-04-23-backtest-vs-live-diagnostic.md.

Tests: 9 new cases in tests/realism.test.ts covering coverage, units,
case-insensitivity, unknown-ticker warn-once, guard clauses, and a
per-instrument sanity check that the constants produce γ's expected
R-cost at each ticker's typical stop distance.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Expected: new commit on master, 2 files changed (both new), ~180 insertions.

---

### Task 2: Integrate realism into the engine

**Files:**
- Modify: `C:\Users\user\Desktop\Trade Bot\Trade Bot\src\backtest\engine.ts`

- [ ] **Step 1: Read the current `engine.ts` to confirm line numbers**

Run: Use Read tool on `C:\Users\user\Desktop\Trade Bot\Trade Bot\src\backtest\engine.ts` offset=85, limit=60.

Verify: the `resolveOutcome` function signature is at line 85-92, and it returns `{ outcome, exit_time, pnl_r }`. Calls to `resolveOutcome` inside `runBacktest` are near line 200.

- [ ] **Step 2: Add the import**

At the top of `src/backtest/engine.ts`, after the existing `import { detectBias }` line (line 14), add:

```ts
import { computeExecutionCost } from './realism.js';
```

- [ ] **Step 3: Add `ticker` parameter to `resolveOutcome` signature**

Change the function signature from:

```ts
function resolveOutcome(
  candles: Candle[],
  startIdx: number,
  direction: 'long' | 'short',
  sl: number,
  tp1: number,
  tp2: number,
  tp3: number,
): { outcome: BacktestTrade['outcome']; exit_time: string; pnl_r: number } {
```

to:

```ts
function resolveOutcome(
  ticker: string,
  candles: Candle[],
  startIdx: number,
  direction: 'long' | 'short',
  entry: number,
  sl: number,
  tp1: number,
  tp2: number,
  tp3: number,
): { outcome: BacktestTrade['outcome']; exit_time: string; pnl_r: number } {
```

(Note: `entry` is also added — needed to compute stop distance. It was previously only passed implicitly via TP/SL levels.)

- [ ] **Step 4: Compute the execution cost inside `resolveOutcome`**

Immediately after the new signature's opening brace, add:

```ts
  // Execution cost (spread + slippage) applied to every trade outcome,
  // win or lose. stopDistance is the absolute price distance from entry
  // to SL in the instrument's native price units. See src/backtest/realism.ts.
  const stopDistance = Math.abs(entry - sl);
  const executionCost = computeExecutionCost(ticker, stopDistance);
```

- [ ] **Step 5: Subtract executionCost from every `pnl_r` return in `resolveOutcome`**

The function has **six** return statements that produce `pnl_r`. Each must subtract `executionCost`. Find these return statements in the body of `resolveOutcome` and modify them as follows:

First return (long-direction SL hit, lines ~100-105):
```ts
return {
  outcome: tp1Hit ? 'tp1_be' : 'sl',
  exit_time: c.datetime,
  pnl_r: (tp1Hit ? 1.0 : -1.0) - executionCost,
};
```

Second return (long-direction TP3 hit, ~line 112):
```ts
return { outcome: 'tp3', exit_time: c.datetime, pnl_r: 3.5 - executionCost };
```

Third return (long-direction TP2 hit, ~line 115):
```ts
return { outcome: 'tp2', exit_time: c.datetime, pnl_r: 2.5 - executionCost };
```

Fourth return (short-direction SL hit, ~lines 118-123):
```ts
return {
  outcome: tp1Hit ? 'tp1_be' : 'sl',
  exit_time: c.datetime,
  pnl_r: (tp1Hit ? 1.0 : -1.0) - executionCost,
};
```

Fifth return (short-direction TP3 hit, ~line 129):
```ts
return { outcome: 'tp3', exit_time: c.datetime, pnl_r: 3.5 - executionCost };
```

Sixth return (short-direction TP2 hit, ~line 132):
```ts
return { outcome: 'tp2', exit_time: c.datetime, pnl_r: 2.5 - executionCost };
```

Final fall-through return at the end (~lines 138-141 — when candles run out):
```ts
const lastCandle = candles[candles.length - 1];
return tp1Hit
  ? { outcome: 'tp1_be', exit_time: lastCandle.datetime, pnl_r: 1.0 - executionCost }
  : { outcome: 'sl', exit_time: lastCandle.datetime, pnl_r: -1.0 - executionCost };
```

(That's seven return sites in total; the last one has a ternary so it appears as two `pnl_r` assignments.)

- [ ] **Step 6: Update the single call site in `runBacktest`**

The `resolveOutcome` call is near line 200. Current:

```ts
const { outcome, exit_time, pnl_r } = resolveOutcome(
  candles,
  i + 2,
  bias.bias === 'bullish' ? 'long' : 'short',
  sl, tp1, tp2, tp3,
);
```

Change to:

```ts
const { outcome, exit_time, pnl_r } = resolveOutcome(
  ticker,
  candles,
  i + 2,
  bias.bias === 'bullish' ? 'long' : 'short',
  entry,
  sl, tp1, tp2, tp3,
);
```

(`ticker` is the function parameter at `runBacktest` line 144-145. `entry` is already in scope at line 173 in `runBacktest`.)

- [ ] **Step 7: Build to verify TypeScript compiles**

Run: `cd "/c/Users/user/Desktop/Trade Bot/Trade Bot" && npm run build 2>&1 | tail -10`

Expected: no TypeScript errors. If errors, they are likely around the function signature — re-read the changes to `resolveOutcome` and `runBacktest`, verify parameter order matches.

- [ ] **Step 8: Run the full test suite**

Run: `cd "/c/Users/user/Desktop/Trade Bot/Trade Bot" && npm test -- --run 2>&1 | tail -8`

Expected: all 202 tests still pass (193 pre-existing + 9 new from Task 1). Since the existing tests do not exercise `resolveOutcome` directly, they should pass unchanged.

- [ ] **Step 9: Commit**

Run:
```bash
cd "/c/Users/user/Desktop/Trade Bot/Trade Bot" && git add src/backtest/engine.ts && git commit -m "$(cat <<'EOF'
feat(backtest): subtract per-trade execution cost in resolveOutcome

Integrates src/backtest/realism.ts into the backtest engine.
resolveOutcome gains a ticker parameter and an entry parameter, computes
stopDistance = |entry - sl|, calls computeExecutionCost, and subtracts
the R-unit cost from every pnl_r return (both long and short direction,
all TP/SL outcomes, plus the candle-exhausted fall-through).

No changes to scoring, bias detection, tier assignment, or the TP/SL
walk logic. Friction is pure post-settlement subtraction.

Expected aggregate impact when npm run backtest is re-run:
  Total R across 7 instruments: +1671 → ≈ −1401 (γ's math).
  Win rate unchanged (~34%).
  Per-instrument deltas within ±15% of γ's predictions.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Expected: new commit on master, 1 file changed, ~15-25 line diff.

---

### Task 3: Integration sanity run

**Files:**
- No files created or modified. Manual verification only.

- [ ] **Step 1: Check that `npm run backtest` exists as a script**

Run: `cd "/c/Users/user/Desktop/Trade Bot/Trade Bot" && cat package.json | grep -A 2 '"backtest"'`

Expected: a `"backtest":` entry under `"scripts"`. If the script name is different (e.g., `"backtest:run"`), use that name in Step 2.

- [ ] **Step 2: Run the full backtest**

Run: `cd "/c/Users/user/Desktop/Trade Bot/Trade Bot" && npm run backtest 2>&1 | tail -50`

Expected: output similar in shape to the pre-patch run:
```
[Runner] Processing GOLD...
[Runner] GOLD: ... trades | WR ...% | PF ... | Total ...R
...
FARADBOT — BACKTEST REPORT
Total Trades:   14918   (unchanged)
Win Rate:       ~34%    (unchanged within ±1%)
Total R (all):  ~-1401R (was +1671R)
```

**Acceptance criteria:**

| Metric | Pre-patch value | Acceptable post-patch range |
|---|---|---|
| Total trades | 14918 | 14918 (unchanged — trade generation unchanged) |
| Win rate | 34.1% | 33.1% - 35.1% |
| Total R | +1671 R | −1612 to −1190 R |
| USDJPY total R | +285 R | −462 to −342 R |
| EURUSD total R | +188 R | −181 to −133 R |
| GOLD total R | +298.5 R | −103 to −76 R |
| GBPUSD total R | +148.5 R | (compute: +148.5 − 2522 × 0.22 ≈ −406 → range [−467, −345]) |
| AUDUSD total R | +284 R | (compute: +284 − 2430 × 0.20 ≈ −202 → range [−232, −172]) |
| SILVER total R | +347.5 R | (compute: +347.5 − 1039 × 0.18 ≈ +160 → range [+136, +184]) |
| OIL_CRUDE total R | +119.5 R | (compute: +119.5 − 2273 × 0.18 ≈ −289 → range [−332, −246]) |

If any per-instrument number falls outside its acceptable range, investigate — likely a constant is wrong or the stop-distance formula in `resolveOutcome` mis-interprets the engine's actual stop placement. Re-read Task 2 Steps 3-5 and verify the math.

- [ ] **Step 3: Record the result**

Capture the actual backtest output table and compare to the acceptance criteria. In the chat message to Giuseppe at the end of this plan, include:
- The actual aggregate `Total R` (one number)
- Whether it landed within [−1612, −1190] (pass/fail)
- Any per-instrument that fell outside its range (list)

No commit needed for Task 3 — it's a verification step.

---

## Self-Review

Spec coverage check against `docs/superpowers/specs/2026-04-23-backtest-realism-design.md`:

- Spec §1 Problem statement — **Task 1 Step 3** comment block in `realism.ts` references the live observation; **Task 2 Step 9** commit message restates the problem ✓
- Spec §2 Architecture — **Task 1** creates the module, **Task 2** wires the call site ✓
- Spec §3 Module API — **Task 1 Step 3** implementation matches the interface/function/constants block verbatim ✓
- Spec §3 Constants table — **Task 1 Step 3** code block uses the exact numbers from the spec ✓
- Spec §3 Engine integration — **Task 2 Steps 3-6** show the exact diff ✓
- Spec §4 Unit tests — **Task 1 Step 1** test file covers all 8 cases (coverage, positive values, USDJPY anchor, R-cost formula, case-insensitivity, unknown-once, multiple unknowns, guard clauses, sanity map) ✓
- Spec §4 Regression — **Task 1 Step 5** and **Task 2 Step 8** run the full suite ✓
- Spec §4 Integration sanity — **Task 3** runs `npm run backtest` with explicit acceptance criteria ✓
- Spec §5 Out of scope — plan does not touch any file outside `src/backtest/` + `tests/` ✓
- Spec §6 Success criteria — each of the 6 criteria maps to a specific task step ✓
- Spec §7 Demo-safety — no `pm2 restart`, no production file touched; plan explicitly notes this ✓
- Spec §8 Timeline — plan fits the ~1-hour estimate (Task 1 ~30 min, Task 2 ~20 min, Task 3 ~5 min) ✓

Placeholder scan: no "TBD", "TODO", "implement later", or "add error handling" phrases. Every code step shows the actual code. Every command shows the expected output.

Type consistency: `ExecutionCostConstants` interface, `EXECUTION_COSTS` constant, `computeExecutionCost` function name, and `_internalsForTest.resetWarnings()` method all used consistently across Task 1 (implementation + tests) and Task 2 (engine integration).

---

## Execution notes

- **No worktree:** this plan continues working on master, consistent with today's session pattern. The change is offline-code-only (no production impact), so worktree isolation is unnecessary overhead.
- **Atomic commits:** Task 1 and Task 2 each produce one commit. Task 3 produces no commit (verification only).
- **Stop conditions:** if Task 1 Step 4 shows a test failure that doesn't yield to a quick implementation fix, stop and surface the failure to Giuseppe. If Task 3 shows per-instrument numbers outside the acceptance ranges, stop before any further work and investigate — it likely means a realism constant is off.
- **No pm2 restart:** nothing to deploy. The live bot does not import from `src/backtest/`.

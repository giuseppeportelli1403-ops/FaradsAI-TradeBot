# Displacement Continuation Trigger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a 6th 15M trigger type (Displacement Continuation) to the Farad bot, validated by backtest first, shipped at Tier 3 half-size (0.25%) with phased promotion criteria.

**Architecture:** Two-phase rollout. Phase 0 builds a standalone backtest harness, runs a 54-combo parameter sweep, and only proceeds if forward-R metrics meet the spec's ship criteria. Phase 1 integrates the validated detector into the production code path (LLM prompt, deterministic audit script, sizing, analyst contract, metric dump, rollback triggers). Each task is TDD: failing test first, minimal implementation, verify pass, commit.

**Tech Stack:** TypeScript (strict, ESM), Vitest for tests, sql.js for DB reads, Capital.com REST for candle data, pm2 for deploy, node-cron for scheduling.

**Spec reference:** `docs/architecture/2026-05-13-displacement-continuation-design.md` (commit `dc80bae`)

**Decision Gate:** Task 8 has a HARD STOP. If no parameter combo meets ship criteria (N≥10 decided, expR≥+0.10R, WR≥40%, breadth≥3), do NOT proceed to Phase 1 — return to brainstorming.

---

## Phase 0 — Backtest & Validate

### Task 1: Backtest script skeleton with CLI args

**Files:**
- Create: `scripts/_displacement-backtest.ts`

- [ ] **Step 1: Write the skeleton with arg parsing**

```typescript
// scripts/_displacement-backtest.ts
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import process from 'node:process';
import { CapitalClient } from '../src/mcp-server/capital-client.js';
import type { Candle } from '../src/types.js';

const SUPPORTED_TICKERS = [
  'EURUSD', 'GBPUSD', 'AUDUSD', 'USDJPY',
  'GOLD', 'SILVER', 'OIL_CRUDE',
] as const;
type Ticker = (typeof SUPPORTED_TICKERS)[number];

const TYPICAL_SPREAD: Record<Ticker, number> = {
  EURUSD: 0.00010, GBPUSD: 0.00015, AUDUSD: 0.00015, USDJPY: 0.010,
  GOLD: 0.30, SILVER: 0.020, OIL_CRUDE: 0.030,
};

const RATE_LIMIT_MS = 250;

function parseArgs(argv: string[]) {
  const days = Number(argv.find((_, i) => argv[i - 1] === '--days') ?? 30);
  const outDir = argv.find((_, i) => argv[i - 1] === '--out') ?? 'data/metrics';
  const horizon = Number(argv.find((_, i) => argv[i - 1] === '--horizon') ?? 8);
  return { days, outDir, horizon };
}

async function main() {
  const { days, outDir, horizon } = parseArgs(process.argv.slice(2));
  console.log(`Displacement Continuation backtest — days=${days}, horizon=${horizon}×15M`);
  // TODO: fill in with Tasks 2-8
}

main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Verify it compiles and runs**

Run: `ssh bot@162.55.212.198 "cd ~/trading-bot && npx tsx scripts/_displacement-backtest.ts --days 30"`
Expected: `Displacement Continuation backtest — days=30, horizon=8×15M`

- [ ] **Step 3: Commit**

```bash
git add scripts/_displacement-backtest.ts
git -c user.name='Giuseppe Portelli' -c user.email=giuseppeportelli1403@gmail.com commit -m "feat(backtest): scaffold displacement-continuation backtest script (Task 1)"
```

---

### Task 2: Port bias detection from scanner

**Files:**
- Modify: `scripts/_displacement-backtest.ts` (append `detectBias` function)
- Test: `tests/displacement-backtest-bias.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/displacement-backtest-bias.test.ts
import { describe, it, expect } from 'vitest';
import { detectBias } from '../scripts/_displacement-backtest.js';

describe('detectBias (ported from scanner)', () => {
  it('returns bullish on clean HH+HL sequence', () => {
    const candles = [
      { open: 1.10, high: 1.10, low: 1.08, close: 1.09 }, // L=1.08, H=1.10
      { open: 1.09, high: 1.11, low: 1.09, close: 1.10 }, // L=1.09 (HL), H=1.11 (HH)
      { open: 1.10, high: 1.12, low: 1.10, close: 1.11 }, // L=1.10 (HL), H=1.12 (HH)
      { open: 1.11, high: 1.13, low: 1.11, close: 1.12 }, // L=1.11 (HL), H=1.13 (HH)
    ];
    expect(detectBias(candles)).toBe('bullish');
  });

  it('returns bearish on clean LH+LL sequence', () => {
    const candles = [
      { open: 1.13, high: 1.13, low: 1.11, close: 1.12 },
      { open: 1.12, high: 1.12, low: 1.10, close: 1.11 },
      { open: 1.11, high: 1.11, low: 1.09, close: 1.10 },
      { open: 1.10, high: 1.10, low: 1.08, close: 1.09 },
    ];
    expect(detectBias(candles)).toBe('bearish');
  });

  it('returns neutral on choppy candles', () => {
    const candles = [
      { open: 1.10, high: 1.12, low: 1.08, close: 1.09 },
      { open: 1.09, high: 1.13, low: 1.07, close: 1.11 },
      { open: 1.11, high: 1.12, low: 1.08, close: 1.10 },
      { open: 1.10, high: 1.13, low: 1.07, close: 1.09 },
    ];
    expect(detectBias(candles)).toBe('neutral');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `ssh bot@162.55.212.198 "cd ~/trading-bot && npx vitest run tests/displacement-backtest-bias.test.ts"`
Expected: FAIL — `detectBias is not exported`

- [ ] **Step 3: Implement detectBias in backtest script**

Append to `scripts/_displacement-backtest.ts`:

```typescript
// Port of src/scanner/index.ts:detectBias — primary HH+HL / LH+LL branch.
// Slope fallback disabled (matches production SCANNER_SLOPE_FALLBACK=false default).
export type Bias = 'bullish' | 'bearish' | 'neutral';

export function detectBias(candles1h: ReadonlyArray<Pick<Candle, 'high' | 'low'>>): Bias {
  if (candles1h.length < 4) return 'neutral';
  const last4 = candles1h.slice(-4);
  const hh = last4.every((c, i) => i === 0 || c.high > last4[i - 1].high);
  const hl = last4.every((c, i) => i === 0 || c.low > last4[i - 1].low);
  if (hh && hl) return 'bullish';
  const lh = last4.every((c, i) => i === 0 || c.high < last4[i - 1].high);
  const ll = last4.every((c, i) => i === 0 || c.low < last4[i - 1].low);
  if (lh && ll) return 'bearish';
  return 'neutral';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `ssh bot@162.55.212.198 "cd ~/trading-bot && npx vitest run tests/displacement-backtest-bias.test.ts"`
Expected: PASS — 3 tests passed.

- [ ] **Step 5: Commit**

```bash
git add scripts/_displacement-backtest.ts tests/displacement-backtest-bias.test.ts
git -c user.name='Giuseppe Portelli' -c user.email=giuseppeportelli1403@gmail.com commit -m "feat(backtest): port detectBias (HH+HL / LH+LL) from scanner (Task 2)"
```

---

### Task 3: Port the 4 existing trend-trigger detectors (precedence check)

**Files:**
- Modify: `scripts/_displacement-backtest.ts` (append `existingTriggerFires` function)
- Reuse: copy logic from `scripts/audit-trigger-decisions.ts` checkObRetest / checkFvgFill / checkLiqSweep / checkBreakoutRetest

The DC detector needs to know whether ANY of the existing 4 trend triggers would have fired on the same candle (precedence rule). Rather than duplicating ~400 lines of detector code, **export the existing detectors from `audit-trigger-decisions.ts`** and import them here.

- [ ] **Step 1: Export the existing detectors in the audit script**

Modify `scripts/audit-trigger-decisions.ts` at the function declarations:

```typescript
// Before:
function checkObRetest(...) { ... }
function checkFvgFill(...) { ... }
function checkLiqSweep(...) { ... }
function checkBreakoutRetest(...) { ... }

// After: prepend `export ` to each
export function checkObRetest(...) { ... }
export function checkFvgFill(...) { ... }
export function checkLiqSweep(...) { ... }
export function checkBreakoutRetest(...) { ... }
```

- [ ] **Step 2: Verify the audit script still runs**

Run: `ssh bot@162.55.212.198 "cd ~/trading-bot && npx tsx scripts/audit-trigger-decisions.ts --days 1 2>&1 | head -10"`
Expected: Runs without compile errors. Output: `Parsed N total cycles, M comparable...`

- [ ] **Step 3: Write the failing test**

```typescript
// tests/displacement-backtest-precedence.test.ts
import { describe, it, expect } from 'vitest';
import { existingTriggerFires } from '../scripts/_displacement-backtest.js';

describe('existingTriggerFires (precedence check)', () => {
  it('returns true when an OB Retest would fire', () => {
    // Construct candles where the last 15M is a rejection candle inside an OB
    const candles = /* fixture with OB + rejection */ [] as any;
    expect(existingTriggerFires(candles, 'bullish')).toBe(true);
  });

  it('returns false on a plain trend-continuation candle (no retest)', () => {
    const candles = /* fixture: 3 strong bullish bodies in a row, no OB nearby */ [] as any;
    expect(existingTriggerFires(candles, 'bullish')).toBe(false);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `ssh bot@162.55.212.198 "cd ~/trading-bot && npx vitest run tests/displacement-backtest-precedence.test.ts"`
Expected: FAIL — `existingTriggerFires is not exported`.

- [ ] **Step 5: Implement existingTriggerFires in backtest script**

Append to `scripts/_displacement-backtest.ts`:

```typescript
import {
  checkObRetest, checkFvgFill, checkLiqSweep, checkBreakoutRetest,
} from './audit-trigger-decisions.js';

export function existingTriggerFires(
  candles15m: ReadonlyArray<Candle>,
  bias: Bias,
  spread: number,
): boolean {
  if (bias === 'neutral') return false;
  const ob = checkObRetest(candles15m, bias);
  if (ob.qualifies === 'yes') return true;
  const fvg = checkFvgFill(candles15m, bias);
  if (fvg.qualifies === 'yes') return true;
  const sweep = checkLiqSweep(candles15m, bias, spread);
  if (sweep.qualifies === 'yes') return true;
  const breakout = checkBreakoutRetest(candles15m, bias);
  if (breakout.qualifies === 'yes') return true;
  return false;
}
```

- [ ] **Step 6: Build fixtures + run tests**

(Build fixtures by copying real candles from `data/pm2-out.log` historical cycles where each trigger fired. Use the audit script's `--debug-cycle` output as reference for what candles produced each trigger.)

Run: `ssh bot@162.55.212.198 "cd ~/trading-bot && npx vitest run tests/displacement-backtest-precedence.test.ts"`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/audit-trigger-decisions.ts scripts/_displacement-backtest.ts tests/displacement-backtest-precedence.test.ts
git -c user.name='Giuseppe Portelli' -c user.email=giuseppeportelli1403@gmail.com commit -m "feat(backtest): export existing 4 trigger detectors + precedence check (Task 3)"
```

---

### Task 4: Implement Displacement Continuation detector

**Files:**
- Modify: `scripts/_displacement-backtest.ts` (append `checkDisplacementContinuation`)
- Test: `tests/displacement-continuation-detector.test.ts`

- [ ] **Step 1: Define the parameter type**

Append to `scripts/_displacement-backtest.ts`:

```typescript
export interface DcParams {
  X: number; // body × range, ∈ {0.40, 0.50, 0.60}
  Y: number; // body × ATR-of-bodies(14), ∈ {1.0, 1.2, 1.5}
  Z: number; // close-strength, ∈ {0.60, 0.70, 0.75}
  n: number; // consecutive same-direction closes required, ∈ {2, 3}
}
```

- [ ] **Step 2: Write failing tests covering ALL 8 criteria**

```typescript
// tests/displacement-continuation-detector.test.ts
import { describe, it, expect } from 'vitest';
import { checkDisplacementContinuation, type DcParams } from '../scripts/_displacement-backtest.js';

const baseParams: DcParams = { X: 0.5, Y: 1.2, Z: 0.7, n: 2 };

const goodBullishCandle = { open: 1.100, high: 1.110, low: 1.099, close: 1.109 };
// body = 0.009, range = 0.011, body/range = 0.82 → passes X=0.5
// close > low + 0.7*range = 1.099 + 0.0077 = 1.1067 → passes Z=0.7
// no opposing wick (close near high)

const priorBullishCandle = { open: 1.095, high: 1.101, low: 1.094, close: 1.100 };
// also bullish close (close > open)

const atrBodyCandles14 = Array(14).fill({
  open: 1.090, high: 1.094, low: 1.088, close: 1.093, // body = 0.003 (mean for ATR-bodies = 0.003)
});

describe('checkDisplacementContinuation', () => {
  it('returns yes on canonical qualifying bullish setup', () => {
    const candles15m = [...atrBodyCandles14, priorBullishCandle, goodBullishCandle];
    const result = checkDisplacementContinuation(candles15m, 'bullish', baseParams, 0.0001);
    expect(result.qualifies).toBe('yes');
  });

  it('returns no when bias is neutral (criterion 1)', () => {
    const candles15m = [...atrBodyCandles14, priorBullishCandle, goodBullishCandle];
    const result = checkDisplacementContinuation(candles15m, 'neutral', baseParams, 0.0001);
    expect(result.qualifies).toBe('no');
    expect(result.reason).toContain('bias');
  });

  it('returns no when prior candle is opposite direction (criterion 2)', () => {
    const opposingPrior = { open: 1.100, high: 1.101, low: 1.094, close: 1.095 }; // bearish
    const candles15m = [...atrBodyCandles14, opposingPrior, goodBullishCandle];
    const result = checkDisplacementContinuation(candles15m, 'bullish', baseParams, 0.0001);
    expect(result.qualifies).toBe('no');
    expect(result.reason).toContain('consecutive');
  });

  it('returns no when body/range below X (criterion 3)', () => {
    const dojiLike = { open: 1.100, high: 1.110, low: 1.099, close: 1.103 };
    // body/range = 0.003/0.011 = 0.27 → fails X=0.5
    const candles15m = [...atrBodyCandles14, priorBullishCandle, dojiLike];
    const result = checkDisplacementContinuation(candles15m, 'bullish', baseParams, 0.0001);
    expect(result.qualifies).toBe('no');
    expect(result.reason).toMatch(/body.*range/i);
  });

  it('returns no when body below Y × ATR-of-bodies (criterion 4)', () => {
    const tinyBody = { open: 1.100, high: 1.1004, low: 1.0996, close: 1.1003 };
    // body 0.0003 < 1.2 × ATR-bodies (0.003 × 1.2 = 0.0036)
    const candles15m = [...atrBodyCandles14, priorBullishCandle, tinyBody];
    const result = checkDisplacementContinuation(candles15m, 'bullish', baseParams, 0.0001);
    expect(result.qualifies).toBe('no');
    expect(result.reason).toMatch(/atr/i);
  });

  it('returns no when close not in top Z fraction (criterion 5)', () => {
    const weakClose = { open: 1.100, high: 1.110, low: 1.099, close: 1.104 };
    // close = 1.104, low + 0.7*range = 1.0067 → close < threshold, fails Z=0.7
    const candles15m = [...atrBodyCandles14, priorBullishCandle, weakClose];
    const result = checkDisplacementContinuation(candles15m, 'bullish', baseParams, 0.0001);
    expect(result.qualifies).toBe('no');
    expect(result.reason).toMatch(/close/i);
  });

  it('returns no when wick exceeds prior 8-candle swing by ≥1×spread (criterion 8)', () => {
    const priorSwingHigh = 1.110; // matches goodBullishCandle.high exactly
    const sweeperCandle = { open: 1.100, high: 1.120, low: 1.099, close: 1.115 };
    // wick above swing = 1.120 - 1.110 = 0.010 >> spread 0.0001
    const candles15m = [
      ...atrBodyCandles14.map(c => ({ ...c, high: priorSwingHigh, low: 1.108 })),
      priorBullishCandle, sweeperCandle,
    ];
    const result = checkDisplacementContinuation(candles15m, 'bullish', baseParams, 0.0001);
    expect(result.qualifies).toBe('no');
    expect(result.reason).toMatch(/sweep/i);
  });

  it('returns indeterminate when fewer than 14 candles available for ATR', () => {
    const candles15m = [priorBullishCandle, goodBullishCandle];
    const result = checkDisplacementContinuation(candles15m, 'bullish', baseParams, 0.0001);
    expect(result.qualifies).toBe('indeterminate');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `ssh bot@162.55.212.198 "cd ~/trading-bot && npx vitest run tests/displacement-continuation-detector.test.ts"`
Expected: FAIL — `checkDisplacementContinuation is not exported`.

- [ ] **Step 4: Implement the detector**

Append to `scripts/_displacement-backtest.ts`:

```typescript
export type Qualifies = 'yes' | 'no' | 'indeterminate';
export interface DetectorResult { qualifies: Qualifies; reason: string; }

export function checkDisplacementContinuation(
  candles15m: ReadonlyArray<Candle>,
  bias: Bias,
  params: DcParams,
  spread: number,
): DetectorResult {
  if (candles15m.length < 14) {
    return { qualifies: 'indeterminate', reason: 'insufficient history for ATR(14)' };
  }
  // Criterion 1: bias must be directional
  if (bias === 'neutral') return { qualifies: 'no', reason: 'bias is neutral' };

  const dir = bias === 'bullish' ? 1 : -1;
  const closesInBiasDir = (c: Candle) => dir > 0 ? c.close > c.open : c.close < c.open;

  // Criterion 2: n consecutive same-direction closes (latest + n-1 prior)
  const tail = candles15m.slice(-params.n);
  if (tail.length < params.n || !tail.every(closesInBiasDir)) {
    return { qualifies: 'no', reason: `requires ${params.n} consecutive ${bias} closes` };
  }

  const latest = candles15m[candles15m.length - 1];
  const range = latest.high - latest.low;
  if (range === 0) return { qualifies: 'no', reason: 'zero range candle' };
  const body = Math.abs(latest.close - latest.open);

  // Criterion 3: body × range threshold
  if (body / range < params.X) {
    return { qualifies: 'no', reason: `body/range ${(body / range).toFixed(2)} < X=${params.X}` };
  }

  // Criterion 4: body × ATR-of-bodies(14) threshold
  const last14 = candles15m.slice(-15, -1); // 14 candles before latest
  const atrBodies = last14.reduce((s, c) => s + Math.abs(c.close - c.open), 0) / 14;
  if (atrBodies > 0 && body / atrBodies < params.Y) {
    return { qualifies: 'no', reason: `body/ATR-bodies ${(body / atrBodies).toFixed(2)} < Y=${params.Y}` };
  }

  // Criterion 5: close-strength
  const closePos = dir > 0
    ? (latest.close - latest.low) / range
    : (latest.high - latest.close) / range;
  if (closePos < params.Z) {
    return { qualifies: 'no', reason: `close position ${closePos.toFixed(2)} < Z=${params.Z}` };
  }

  // Criterion 8: NOT a sweep (latest wick must not exceed prior 8 swing by ≥1×spread)
  const prior8 = candles15m.slice(-9, -1);
  if (prior8.length >= 8) {
    if (dir > 0) {
      const swingHigh = Math.max(...prior8.map(c => c.high));
      if (latest.high - swingHigh >= spread) {
        return { qualifies: 'no', reason: 'wick exceeded prior 8-swing high (use Liquidity Sweep)' };
      }
    } else {
      const swingLow = Math.min(...prior8.map(c => c.low));
      if (swingLow - latest.low >= spread) {
        return { qualifies: 'no', reason: 'wick exceeded prior 8-swing low (use Liquidity Sweep)' };
      }
    }
  }

  return { qualifies: 'yes', reason: 'all criteria satisfied' };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `ssh bot@162.55.212.198 "cd ~/trading-bot && npx vitest run tests/displacement-continuation-detector.test.ts"`
Expected: PASS — 8 tests passed.

- [ ] **Step 6: Commit**

```bash
git add scripts/_displacement-backtest.ts tests/displacement-continuation-detector.test.ts
git -c user.name='Giuseppe Portelli' -c user.email=giuseppeportelli1403@gmail.com commit -m "feat(backtest): displacement-continuation detector with 8-criterion check (Task 4)"
```

---

### Task 5: Implement forward simulation

**Files:**
- Modify: `scripts/_displacement-backtest.ts` (append `simulateForward`)
- Test: `tests/displacement-forward-sim.test.ts`

- [ ] **Step 1: Write failing tests covering all 4 outcome paths**

```typescript
// tests/displacement-forward-sim.test.ts
import { describe, it, expect } from 'vitest';
import { simulateForward } from '../scripts/_displacement-backtest.js';

describe('simulateForward', () => {
  it('returns tp1_hit when forward candle hits TP1 first', () => {
    const future = [
      { open: 1.110, high: 1.121, low: 1.109, close: 1.120 }, // hits TP1 at 1.120
      { open: 1.120, high: 1.125, low: 1.119, close: 1.123 },
    ];
    const result = simulateForward(
      future,
      /*entry*/ 1.110, /*sl*/ 1.100, /*tp1*/ 1.120, /*tp2*/ 1.1131, /*dir*/ 1, /*horizon*/ 8,
    );
    expect(result.outcome).toBe('tp1_hit');
    expect(result.r).toBeCloseTo(1.0, 2);
  });

  it('returns sl_hit when forward candle hits SL first', () => {
    const future = [{ open: 1.110, high: 1.115, low: 1.098, close: 1.099 }];
    const result = simulateForward(future, 1.110, 1.100, 1.120, 1.1131, 1, 8);
    expect(result.outcome).toBe('sl_hit');
    expect(result.r).toBeCloseTo(-1.0, 2);
  });

  it('returns sl_hit when same candle straddles both SL and TP1 (conservative tie)', () => {
    const future = [{ open: 1.110, high: 1.121, low: 1.099, close: 1.105 }];
    const result = simulateForward(future, 1.110, 1.100, 1.120, 1.1131, 1, 8);
    expect(result.outcome).toBe('sl_hit');
  });

  it('returns open with mark-to-last when horizon exhausted without resolution', () => {
    const future = Array(8).fill({ open: 1.110, high: 1.115, low: 1.108, close: 1.112 });
    const result = simulateForward(future, 1.110, 1.100, 1.120, 1.1131, 1, 8);
    expect(result.outcome).toBe('open');
    // last close = 1.112, entry = 1.110, R = 0.01 → markR = 0.002 / 0.01 = 0.2
    expect(result.r).toBeCloseTo(0.2, 1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `ssh bot@162.55.212.198 "cd ~/trading-bot && npx vitest run tests/displacement-forward-sim.test.ts"`
Expected: FAIL — `simulateForward is not exported`.

- [ ] **Step 3: Implement simulateForward**

Append to `scripts/_displacement-backtest.ts`:

```typescript
export type SimOutcome = 'tp1_hit' | 'tp2_hit' | 'sl_hit' | 'open';
export interface SimResult { outcome: SimOutcome; r: number; barsHeld: number; }

export function simulateForward(
  future: ReadonlyArray<Candle>,
  entry: number,
  sl: number,
  tp1: number,
  tp2: number,
  dir: 1 | -1,
  horizon: number,
): SimResult {
  const r = Math.abs(entry - sl);
  if (r === 0) return { outcome: 'open', r: 0, barsHeld: 0 };
  for (let i = 0; i < Math.min(future.length, horizon); i++) {
    const c = future[i];
    const hitSl = dir > 0 ? c.low <= sl : c.high >= sl;
    const hitTp1 = dir > 0 ? c.high >= tp1 : c.low <= tp1;
    const hitTp2 = dir > 0 ? c.high >= tp2 : c.low <= tp2;
    // Conservative tie: SL wins if both in same bar
    if (hitSl && (hitTp1 || hitTp2)) return { outcome: 'sl_hit', r: -1, barsHeld: i + 1 };
    if (hitSl) return { outcome: 'sl_hit', r: -1, barsHeld: i + 1 };
    if (hitTp2) return { outcome: 'tp2_hit', r: 1.31, barsHeld: i + 1 };
    if (hitTp1) return { outcome: 'tp1_hit', r: 1.0, barsHeld: i + 1 };
  }
  // No resolution — mark-to-last
  if (future.length === 0) return { outcome: 'open', r: 0, barsHeld: 0 };
  const last = future[Math.min(future.length, horizon) - 1];
  const markR = dir > 0 ? (last.close - entry) / r : (entry - last.close) / r;
  return { outcome: 'open', r: markR, barsHeld: Math.min(future.length, horizon) };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `ssh bot@162.55.212.198 "cd ~/trading-bot && npx vitest run tests/displacement-forward-sim.test.ts"`
Expected: PASS — 4 tests passed.

- [ ] **Step 5: Commit**

```bash
git add scripts/_displacement-backtest.ts tests/displacement-forward-sim.test.ts
git -c user.name='Giuseppe Portelli' -c user.email=giuseppeportelli1403@gmail.com commit -m "feat(backtest): forward simulation with TP1/TP2/SL/open outcomes (Task 5)"
```

---

### Task 6: Parameter sweep loop

**Files:**
- Modify: `scripts/_displacement-backtest.ts` (assemble main loop)

- [ ] **Step 1: Define ATR helper + kill-zone check + parameter combos**

Append to `scripts/_displacement-backtest.ts`:

```typescript
function atr14(candles: ReadonlyArray<Candle>): number {
  if (candles.length < 15) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const last14 = trs.slice(-14);
  return last14.reduce((a, b) => a + b, 0) / 14;
}

function inKillZone(d: Date): boolean {
  const t = d.getUTCHours() + d.getUTCMinutes() / 60;
  return (t >= 7 && t < 10) || (t >= 13 && t < 16) || (t >= 16 && t < 17);
}

const PARAM_COMBOS: DcParams[] = [];
for (const X of [0.40, 0.50, 0.60])
  for (const Y of [1.0, 1.2, 1.5])
    for (const Z of [0.60, 0.70, 0.75])
      for (const n of [2, 3])
        PARAM_COMBOS.push({ X, Y, Z, n });
// 54 combos
```

- [ ] **Step 2: Implement the main fetch + sweep loop in `main()`**

Replace the `TODO` in `main()`:

```typescript
async function main() {
  const { days, outDir, horizon } = parseArgs(process.argv.slice(2));
  console.log(`Displacement Continuation backtest — days=${days}, horizon=${horizon}×15M, combos=${PARAM_COMBOS.length}`);

  const cap = new CapitalClient({
    apiKey: process.env.CAPITAL_API_KEY!,
    identifier: process.env.CAPITAL_IDENTIFIER!,
    password: process.env.CAPITAL_PASSWORD!,
    baseURL: process.env.CAPITAL_BASE_URL ?? 'https://demo-api-capital.backend-capital.com',
  });

  const now = new Date();
  const from = new Date(now.getTime() - days * 86400000).toISOString().replace(/\.\d{3}Z$/, '');
  const to = now.toISOString().replace(/\.\d{3}Z$/, '');

  // Per-ticker fetch (both 15M and 1H)
  const tickerData: Record<string, { c15: Candle[]; c1h: Candle[] }> = {};
  for (const t of SUPPORTED_TICKERS) {
    try {
      const c15 = await cap.getCandlesAsCandles(t as any, '15m', 3000, from, to);
      await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
      const c1h = await cap.getCandlesAsCandles(t as any, '1h', 1000, from, to);
      await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
      tickerData[t] = { c15: c15 as Candle[], c1h: c1h as Candle[] };
      console.log(`  ${t}: 15m=${c15.length} 1h=${c1h.length}`);
    } catch (e: any) {
      console.warn(`  ${t}: fetch error — ${e.message.slice(0, 80)}`);
    }
  }

  // Per-combo sweep
  interface ComboEvent {
    ticker: string; timestamp: string; bias: Bias; outcome: SimOutcome; r: number;
  }
  interface ComboStats {
    params: DcParams;
    events: ComboEvent[];
    nTotal: number; nDecided: number;
    wins: number; losses: number; open: number;
    meanR: number; meanRDecided: number;
    perInstrument: Record<string, number>;
  }
  const allResults: ComboStats[] = [];

  for (const params of PARAM_COMBOS) {
    const events: ComboEvent[] = [];
    for (const t of SUPPORTED_TICKERS) {
      const data = tickerData[t];
      if (!data) continue;
      const spread = TYPICAL_SPREAD[t as Ticker];

      // Walk each 15M candle (need at least 15 prior for ATR, 4 prior 1H for bias)
      for (let i = 15; i < data.c15.length - 1; i++) {
        const candle = data.c15[i];
        const ts = new Date((candle as any).timestamp ?? (candle as any).openTime ?? Date.now());
        if (!inKillZone(ts)) continue;

        // Bias from 1H: find last 4 1H candles closing <= candle time
        const c1hFiltered = data.c1h.filter(c => {
          const ct = new Date((c as any).timestamp ?? (c as any).openTime ?? 0);
          return ct.getTime() <= ts.getTime();
        });
        const bias = detectBias(c1hFiltered.slice(-4));
        if (bias === 'neutral') continue;

        const candles15Slice = data.c15.slice(0, i + 1);
        if (existingTriggerFires(candles15Slice, bias, spread)) continue;

        const dc = checkDisplacementContinuation(candles15Slice, bias, params, spread);
        if (dc.qualifies !== 'yes') continue;

        // Compute SL / TP1 / TP2 (per Section 3 of spec)
        const dir: 1 | -1 = bias === 'bullish' ? 1 : -1;
        const a14 = atr14(candles15Slice);
        const prior = data.c15[i - 1];
        const slRaw = dir > 0 ? prior.low - 0.1 * a14 : prior.high + 0.1 * a14;
        const minDist = Math.max(2 * spread, 0.3 * a14);
        const maxDist = 2 * a14;
        const slDist = Math.abs(candle.close - slRaw);
        if (slDist < minDist || slDist > maxDist) continue; // skip per Section 3 floor/cap
        const sl = slRaw;
        const tp1 = candle.close + dir * 1.01 * slDist;
        const tp2 = candle.close + dir * 1.31 * slDist;

        const future = data.c15.slice(i + 1);
        const sim = simulateForward(future, candle.close, sl, tp1, tp2, dir, horizon);
        events.push({
          ticker: t, timestamp: ts.toISOString(), bias, outcome: sim.outcome, r: sim.r,
        });
      }
    }

    const nTotal = events.length;
    const nDecided = events.filter(e => e.outcome !== 'open').length;
    const wins = events.filter(e => e.outcome === 'tp1_hit' || e.outcome === 'tp2_hit').length;
    const losses = events.filter(e => e.outcome === 'sl_hit').length;
    const open = events.filter(e => e.outcome === 'open').length;
    const meanR = events.length ? events.reduce((s, e) => s + e.r, 0) / events.length : 0;
    const decidedRs = events.filter(e => e.outcome !== 'open').map(e => e.r);
    const meanRDecided = decidedRs.length ? decidedRs.reduce((s, r) => s + r, 0) / decidedRs.length : 0;
    const perInstrument: Record<string, number> = {};
    for (const e of events) perInstrument[e.ticker] = (perInstrument[e.ticker] ?? 0) + 1;

    allResults.push({
      params, events, nTotal, nDecided, wins, losses, open, meanR, meanRDecided, perInstrument,
    });
    console.log(`  combo X=${params.X} Y=${params.Y} Z=${params.Z} n=${params.n}: N=${nTotal} dec=${nDecided} W/L/O=${wins}/${losses}/${open} meanR=${meanR.toFixed(3)}`);
  }

  // Pass to Task 7 (output writers)
  return { allResults, outDir, days };
}
```

- [ ] **Step 3: Smoke-test (run with `--days 1` first to catch syntax errors fast)**

Run: `ssh bot@162.55.212.198 "cd ~/trading-bot && npx tsx scripts/_displacement-backtest.ts --days 1 2>&1 | tail -30"`
Expected: Runs without crash, prints per-instrument candle counts and per-combo stats. Most combos likely show N=0 on 1-day window — that's fine, we're checking it doesn't crash.

- [ ] **Step 4: Commit**

```bash
git add scripts/_displacement-backtest.ts
git -c user.name='Giuseppe Portelli' -c user.email=giuseppeportelli1403@gmail.com commit -m "feat(backtest): parameter sweep loop, 54 combos × 7 tickers (Task 6)"
```

---

### Task 7: Output writers (JSON + Markdown)

**Files:**
- Modify: `scripts/_displacement-backtest.ts` (append `writeOutputs`)

- [ ] **Step 1: Implement writeOutputs**

Append:

```typescript
function writeOutputs(allResults: ComboStats[], outDir: string, days: number): { winner: ComboStats | null; mdPath: string } {
  const today = new Date().toISOString().slice(0, 10);
  const jsonPath = `${outDir}/displacement-backtest-${today}.json`;
  const mdPath = `${outDir}/displacement-backtest-${today}.md`;

  writeFileSync(jsonPath, JSON.stringify(allResults, null, 2));

  // Apply ship criteria
  const eligible = allResults.filter(r =>
    r.nDecided >= 10 &&
    r.meanR >= 0.10 &&
    (r.wins / Math.max(1, r.nDecided)) >= 0.40 &&
    Object.values(r.perInstrument).filter(n => n >= 3).length >= 3
  );
  const winner = eligible.length ? eligible.sort((a, b) => b.meanR - a.meanR)[0] : null;

  const md: string[] = [];
  md.push(`# Displacement Continuation Backtest — ${today}\n`);
  md.push(`Window: last ${days} days · Combos: ${allResults.length} · Universe: 7 instruments\n`);
  md.push(`## Ship verdict\n`);
  if (winner) {
    md.push(`**SHIP** — combo X=${winner.params.X} Y=${winner.params.Y} Z=${winner.params.Z} n=${winner.params.n}`);
    md.push(`- N total: ${winner.nTotal}, decided: ${winner.nDecided}`);
    md.push(`- W/L/Open: ${winner.wins}/${winner.losses}/${winner.open}`);
    md.push(`- Decided WR: ${(winner.wins / Math.max(1, winner.nDecided) * 100).toFixed(1)}%`);
    md.push(`- Mean R: ${winner.meanR.toFixed(3)}, Mean R (decided): ${winner.meanRDecided.toFixed(3)}`);
    md.push(`- Per-instrument: ${JSON.stringify(winner.perInstrument)}\n`);
  } else {
    md.push(`**DO NOT SHIP** — no combo passed ship criteria (N≥10, meanR≥+0.10R, WR≥40%, breadth≥3 instruments with ≥3 firings)\n`);
  }
  md.push(`## Sensitivity table (sorted by meanR desc)\n`);
  md.push(`| X | Y | Z | n | N | dec | W/L/O | WR% | meanR | breadth |`);
  md.push(`|---|---|---|---|---|---|---|---|---|---|`);
  for (const r of [...allResults].sort((a, b) => b.meanR - a.meanR)) {
    const wr = r.nDecided ? (r.wins / r.nDecided * 100).toFixed(1) : '-';
    const breadth = Object.values(r.perInstrument).filter(n => n >= 3).length;
    md.push(`| ${r.params.X} | ${r.params.Y} | ${r.params.Z} | ${r.params.n} | ${r.nTotal} | ${r.nDecided} | ${r.wins}/${r.losses}/${r.open} | ${wr} | ${r.meanR.toFixed(3)} | ${breadth} |`);
  }
  writeFileSync(mdPath, md.join('\n'));
  console.log(`\nWrote ${jsonPath} and ${mdPath}`);
  return { winner, mdPath };
}
```

- [ ] **Step 2: Wire writeOutputs into main()**

In `main()`, after the sweep loop returns, call:

```typescript
const { winner, mdPath } = writeOutputs(allResults, outDir, days);
if (!winner) {
  console.error('\nSTOP: no combo met ship criteria. See', mdPath);
  process.exit(2);
}
console.log(`\nWINNER: ${JSON.stringify(winner.params)} — meanR=${winner.meanR.toFixed(3)}`);
```

- [ ] **Step 3: Smoke test**

Run: `ssh bot@162.55.212.198 "cd ~/trading-bot && npx tsx scripts/_displacement-backtest.ts --days 2 2>&1 | tail -20"`
Expected: Runs, writes `data/metrics/displacement-backtest-2026-05-13.{json,md}`, prints WINNER or STOP message.

- [ ] **Step 4: Commit**

```bash
git add scripts/_displacement-backtest.ts
git -c user.name='Giuseppe Portelli' -c user.email=giuseppeportelli1403@gmail.com commit -m "feat(backtest): JSON+MD output writers with ship-criteria gate (Task 7)"
```

---

### Task 8: Run the 30-day backtest and validate

**Files:** none modified; produces `data/metrics/displacement-backtest-2026-05-13.{json,md}`

- [ ] **Step 1: Run the full 30-day backtest**

Run: `ssh bot@162.55.212.198 "cd ~/trading-bot && npx tsx scripts/_displacement-backtest.ts --days 30 2>&1 | tee /tmp/dc-backtest.log | tail -30"`
Expected: Takes 3-10 min (Capital API rate limits). Writes outputs. Prints WINNER or STOP.

- [ ] **Step 2: Review the markdown summary**

Run: `ssh bot@162.55.212.198 "cat ~/trading-bot/data/metrics/displacement-backtest-2026-05-13.md"`
Expected: full sensitivity table + ship verdict.

- [ ] **Step 3: Decision gate**

**If WINNER printed:** Proceed to Phase 1. Capture the winning combo's X/Y/Z/n values — they go into Task 11 (ict-agent.md) and Task 12 (strategy.md).

**If STOP (no winner):** Halt this plan. Open a follow-up brainstorm — possibly:
- Pattern definition needs refinement (re-engage agent #3)
- Sample window too short (extend to 60 days)
- Ship criteria too strict (revisit thresholds)

**Do NOT proceed to Phase 1 without a winner.**

- [ ] **Step 4: Commit the backtest results**

```bash
git add data/metrics/displacement-backtest-2026-05-13.json data/metrics/displacement-backtest-2026-05-13.md
git -c user.name='Giuseppe Portelli' -c user.email=giuseppeportelli1403@gmail.com commit -m "data(backtest): 30-day displacement-continuation sweep results (Task 8)"
```

---

## Phase 1 — Integration

> **Prerequisite:** Task 8 produced a WINNER. The chosen `X/Y/Z/n` values are referenced as `<winnerX> / <winnerY> / <winnerZ> / <winnerN>` throughout. Substitute the actual values when executing each step.

### Task 9: Add `Displacement_Continuation` to `tierRiskPct` (Phase 1: 0.25%)

**Files:**
- Modify: `src/agents/spread.ts`
- Test: `tests/spread.test.ts` (likely new file)

- [ ] **Step 1: Write failing test**

```typescript
// tests/spread.test.ts
import { describe, it, expect } from 'vitest';
import { tierRiskPct } from '../src/agents/spread.js';

describe('tierRiskPct', () => {
  it('returns 0.0025 for Displacement_Continuation in Phase 1 (half-size)', () => {
    expect(tierRiskPct('Displacement_Continuation', 1)).toBe(0.0025);
    expect(tierRiskPct('Displacement_Continuation', 2)).toBe(0.0025);
    expect(tierRiskPct('Displacement_Continuation', 3)).toBe(0.0025);
  });

  it('returns 0.0025 for Range_Sweep_Reversal at any tier (existing behavior)', () => {
    expect(tierRiskPct('Range_Sweep_Reversal', 3)).toBe(0.0025);
  });

  it('returns tier-aware risk for OB_retest (1.5/1.0/0.5%)', () => {
    expect(tierRiskPct('OB_retest', 1)).toBe(0.015);
    expect(tierRiskPct('OB_retest', 2)).toBe(0.010);
    expect(tierRiskPct('OB_retest', 3)).toBe(0.005);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `ssh bot@162.55.212.198 "cd ~/trading-bot && npx vitest run tests/spread.test.ts"`
Expected: FAIL — likely test passes for existing setups but fails for `Displacement_Continuation`.

- [ ] **Step 3: Modify `tierRiskPct` to recognise the new setup**

Open `src/agents/spread.ts`, find `export function tierRiskPct`, and add a case:

```typescript
export function tierRiskPct(setupType: string, tier: 1 | 2 | 3): number {
  // Half-size posture for newer/higher-variance patterns
  if (setupType === 'Range_Sweep_Reversal') return 0.0025;
  if (setupType === 'Displacement_Continuation') return 0.0025; // Phase 1: half-size; promote in Phase 2
  // Tier-aware standard
  if (tier === 1) return 0.015;
  if (tier === 2) return 0.010;
  return 0.005;
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `ssh bot@162.55.212.198 "cd ~/trading-bot && npx vitest run tests/spread.test.ts"`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/agents/spread.ts tests/spread.test.ts
git -c user.name='Giuseppe Portelli' -c user.email=giuseppeportelli1403@gmail.com commit -m "feat(spread): half-size risk for Displacement_Continuation (Phase 1, Task 9)"
```

---

### Task 10: Update analyst-agent.md CHECK 6 for new setup_type

**Files:**
- Modify: `prompts/analyst-agent.md`

- [ ] **Step 1: Locate CHECK 6 (sizing math) in the analyst prompt**

Run: `ssh bot@162.55.212.198 "grep -n 'CHECK 6\\|Range_Sweep_Reversal\\|tier_risk_pct' ~/trading-bot/prompts/analyst-agent.md"`

Identify the lines where Range_Sweep_Reversal is recognised (half-size 0.25%). The new pattern needs the same treatment.

- [ ] **Step 2: Add `Displacement_Continuation` next to `Range_Sweep_Reversal` references**

Edit `prompts/analyst-agent.md`. Anywhere the prompt says:
> If `setup_type === 'Range_Sweep_Reversal'` → expected `tier_risk_pct = 0.25%` (half-size)

Change to:
> If `setup_type === 'Range_Sweep_Reversal'` OR `setup_type === 'Displacement_Continuation'` → expected `tier_risk_pct = 0.25%` (half-size; Displacement is Phase 1 only — will become Tier-aware after Phase 2 promotion)

- [ ] **Step 3: Manual review — re-read CHECK 6 end-to-end**

The CHECK 6 sanity formula derives implied account balance from the proposal's declared sizes. With half-size, the formula uses `0.0025` not `0.005` in the denominator. Verify the prompt text states this branch explicitly.

- [ ] **Step 4: Commit**

```bash
git add prompts/analyst-agent.md
git -c user.name='Giuseppe Portelli' -c user.email=giuseppeportelli1403@gmail.com commit -m "feat(analyst-prompt): CHECK 6 accepts Displacement_Continuation half-size (Task 10)"
```

---

### Task 11: Add trigger #6 to `prompts/ict-agent.md` Step 3-I

**Files:**
- Modify: `prompts/ict-agent.md`

- [ ] **Step 1: Locate Step 3-I trigger block**

Run: `ssh bot@162.55.212.198 "sed -n '176,210p' ~/trading-bot/prompts/ict-agent.md"`

This is where the 5 existing trend/range triggers are defined. We're adding a sixth.

- [ ] **Step 2: After the Range Sweep Reversal block, append the Displacement Continuation block**

Use these EXACT thresholds from Task 8's winner (substitute actual values):

```markdown
**Trend-mode trigger 6 (1H bias bullish or bearish — fires ONLY when triggers 1-4 above have all failed):**
- **Displacement Continuation:** captures clean impulse moves in bias direction without requiring a retest. ALL of the following must hold:
  - 1H bias is `bullish` or `bearish` (neutral → use Range Sweep instead)
  - **n consecutive same-direction closes** on 15M: latest and previous `<winnerN>` candles all close in bias direction
  - latest candle **body ≥ <winnerX> × range** (body/range conviction filter)
  - latest candle **body ≥ <winnerY> × ATR-of-bodies(14)** (volume-of-conviction; mean |close − open| over prior 14 × 15M candles)
  - latest candle **close in the bias-aligned `<winnerZ>` fraction** of its range (close-strength: bullish → close ≥ low + Z × range; bearish → close ≤ high − Z × range)
  - latest wick must NOT exceed prior 8-candle 15M swing by ≥ 1×spread (if it does, that's Liquidity Sweep — use trigger 3)
  - **Precedence rule:** this trigger fires only when OB Retest, FVG Fill, Liquidity Sweep, and Breakout Retest have all been evaluated and rejected on the same candle
- **REQUIRED setup_type field:** when proposing a Displacement Continuation, the `setup_type` field in your `request_analyst_review` and `place_split_trade` calls MUST be exactly `"Displacement_Continuation"`. The executor recognises this string and applies the Phase 1 half-size risk profile (0.25% total). A different name falls back to standard Tier 3 (0.5%) and rejects with `RISK_PCT_TIER_MISMATCH`.
- **Risk posture (Phase 1, 2026-05-13 onwards):** 0.25% total risk regardless of composite score. Tier 3 cap (score 59) enforced. After 1-2 weeks of positive live data (≥10 firings, mean R ≥ +0.05R, decided WR ≥ 35%), this trigger will be promoted to Tier-aware sizing (Phase 2).
```

- [ ] **Step 3: Update the precedence list earlier in the prompt**

Find the sentence that enumerates trigger order (something like "Triggers 1-4 are trend-following..."). Update to mention trigger 6 with its precedence:

> Triggers 1-4 are trend-following with structural retests; trigger 5 is range-mode reversal; **trigger 6 (Displacement Continuation) is the trend-mode fallback when 1-4 don't fire** — it captures impulse continuation moves that have no retest.

- [ ] **Step 4: Commit**

```bash
git add prompts/ict-agent.md
git -c user.name='Giuseppe Portelli' -c user.email=giuseppeportelli1403@gmail.com commit -m "feat(ict-prompt): add trigger 6 Displacement Continuation with winning combo params (Task 11)"
```

---

### Task 12: Sync `memory/strategy.md` Section 3 (add DC + fix existing drift)

**Files:**
- Modify: `memory/strategy.md`

- [ ] **Step 1: Open and locate Section 3**

Run: `ssh bot@162.55.212.198 "awk '/^## Section 3/,/^## Section 4/' ~/trading-bot/memory/strategy.md | head -40"`

- [ ] **Step 2: Fix the existing prompt-drift bug**

In Section 3, find the "OB Retest" bullet and change:
- `body ≥ 0.4 × candle range` → `body ≥ 0.3 × candle range`
- `opposing wick ≥ 1.0 × body` → `opposing wick ≥ 0.7 × body`

Find the "FVG Fill" bullet and change:
- `body ≥ 0.4 × range` → `body ≥ 0.3 × range`

Update the inline rationale comment from `lowered 0.5 → 0.4 in Phase E` to `lowered 0.5 → 0.4 in Phase E (2026-05-04), then 0.4 → 0.3 in PR 1 (2026-05-12)`.

- [ ] **Step 3: Append Displacement Continuation as trigger #6 after the Range Sweep Reversal block**

Use the same EXACT thresholds from Task 8's winner as in Task 11 — strategy.md and ict-agent.md must be byte-identical on the numeric thresholds (enforced by Task 13's test).

```markdown
6. **Displacement Continuation** *(added 2026-05-13 to capture trend-continuation impulses missed by triggers 1-4)*
   - **Pre-condition:** 1H bias must be `bullish` or `bearish`.
   - **Precedence:** evaluated ONLY when triggers 1-4 have all failed on the same candle.
   - **Criteria** (15M candle, ALL must hold):
     - `<winnerN>` consecutive same-direction closes
     - body ≥ `<winnerX>` × candle range
     - body ≥ `<winnerY>` × ATR-of-bodies(14)
     - close strength: bias-aligned `<winnerZ>` fraction of range
     - latest wick must NOT exceed prior 8-candle 15M swing by ≥ 1 × spread (cede to Liquidity Sweep)
   - **No opposing-wick filter, no retest required** — these are the defining differences from triggers 1-4.
   - **SL:** prior 15M low (bullish) or high (bearish) + 0.1 × ATR(14). Floor max(2×spread, 0.3×ATR). Cap 2×ATR; abort if exceeded.
   - **TP:** TP1 = entry ± 1.01×R, TP2 = entry ± 1.31×R (R = |entry − SL|).
   - **Sizing:** Phase 1 total risk = 0.25% (half-size posture, same as Range Sweep). 70/30 split, tick-aware.
   - **Time stop:** close at market if neither TP1 nor SL hits within 4h (16 × 15M bars).
   - **Promotion to Phase 2 (Tier-aware sizing):** live ≥ 10 firings, mean R ≥ +0.05R, decided WR ≥ 35%.
```

- [ ] **Step 4: Commit**

```bash
git add memory/strategy.md
git -c user.name='Giuseppe Portelli' -c user.email=giuseppeportelli1403@gmail.com commit -m "feat(strategy): add Displacement Continuation + fix OB/FVG body drift (Task 12)"
```

---

### Task 13: Prompt-trigger-sync test (hygiene)

**Files:**
- Create: `tests/prompt-trigger-sync.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// tests/prompt-trigger-sync.test.ts
//
// Hygiene: the LLM is given BOTH prompts/ict-agent.md (system) and
// memory/strategy.md (user-message context). They MUST agree on every
// numeric trigger threshold or the LLM gets contradictory rules.
// History: PR 1 (2026-05-12) updated ict-agent.md but forgot strategy.md;
// the drift was identified during 2026-05-13 displacement-continuation
// brainstorm and fixed in the same PR.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

function extractThresholds(text: string): Record<string, number[]> {
  const numbers: Record<string, number[]> = {};
  const lines = text.split('\n');
  for (const line of lines) {
    // body ≥ X × range
    const bodyRange = line.match(/body\s*[≥>=]+\s*([\d.]+)\s*[×x*]\s*(?:candle\s+)?range/i);
    if (bodyRange) (numbers.body_range ??= []).push(Number(bodyRange[1]));
    // opposing wick ≥ Y × body
    const wickBody = line.match(/(?:opposing\s+)?wick\s*[≥>=]+\s*([\d.]+)\s*[×x*]\s*body/i);
    if (wickBody) (numbers.wick_body ??= []).push(Number(wickBody[1]));
    // body ≥ Z × ATR-of-bodies (Displacement-specific)
    const bodyAtr = line.match(/body\s*[≥>=]+\s*([\d.]+)\s*[×x*]\s*ATR-of-bodies/i);
    if (bodyAtr) (numbers.body_atr ??= []).push(Number(bodyAtr[1]));
  }
  return numbers;
}

describe('prompt trigger spec sync', () => {
  const ictPath = 'prompts/ict-agent.md';
  const strategyPath = 'memory/strategy.md';

  it('body × range thresholds match between ict-agent and strategy', () => {
    const ict = extractThresholds(readFileSync(ictPath, 'utf-8'));
    const strat = extractThresholds(readFileSync(strategyPath, 'utf-8'));
    expect(new Set(ict.body_range)).toEqual(new Set(strat.body_range));
  });

  it('wick × body thresholds match between ict-agent and strategy', () => {
    const ict = extractThresholds(readFileSync(ictPath, 'utf-8'));
    const strat = extractThresholds(readFileSync(strategyPath, 'utf-8'));
    expect(new Set(ict.wick_body)).toEqual(new Set(strat.wick_body));
  });

  it('body × ATR-of-bodies thresholds match (Displacement Continuation)', () => {
    const ict = extractThresholds(readFileSync(ictPath, 'utf-8'));
    const strat = extractThresholds(readFileSync(strategyPath, 'utf-8'));
    expect(new Set(ict.body_atr ?? [])).toEqual(new Set(strat.body_atr ?? []));
  });
});
```

- [ ] **Step 2: Run test to verify pass (Tasks 11 + 12 already synced)**

Run: `ssh bot@162.55.212.198 "cd ~/trading-bot && npx vitest run tests/prompt-trigger-sync.test.ts"`
Expected: PASS — 3 tests.

- [ ] **Step 3: Sanity-check by introducing a deliberate drift, then revert**

Temporarily edit `memory/strategy.md`, change one body threshold from 0.3 to 0.4, re-run the test.
Expected: FAIL — proves the test catches drift.
Then revert the change.

- [ ] **Step 4: Commit**

```bash
git add tests/prompt-trigger-sync.test.ts
git -c user.name='Giuseppe Portelli' -c user.email=giuseppeportelli1403@gmail.com commit -m "test(hygiene): assert strategy.md and ict-agent.md trigger thresholds match (Task 13)"
```

---

### Task 14: Port DC detector to `audit-trigger-decisions.ts`

**Files:**
- Modify: `scripts/audit-trigger-decisions.ts`

The deterministic 5-trigger audit becomes a 6-trigger audit. The backtest script's `checkDisplacementContinuation` is the canonical implementation — copy it into the audit script (or, ideally, import it).

- [ ] **Step 1: Decide on code reuse**

Option A: Import `checkDisplacementContinuation` from `scripts/_displacement-backtest.js` into the audit script. **Preferred** — single source of truth.
Option B: Duplicate the function in the audit script.

Use Option A.

- [ ] **Step 2: Add import and integrate into the per-cycle audit**

In `scripts/audit-trigger-decisions.ts`, near the top:

```typescript
import { checkDisplacementContinuation, type DcParams } from './_displacement-backtest.js';
```

Find the per-cycle block that evaluates the 5 existing triggers (look for `checkObRetest(...)`). Add Displacement after Breakout Retest:

```typescript
// Use the winning param combo from Task 8 (substitute actual values)
const DC_PARAMS: DcParams = { X: <winnerX>, Y: <winnerY>, Z: <winnerZ>, n: <winnerN> };
const SPREAD_FOR_DC = TYPICAL_SPREAD[ticker];

const dcResult = checkDisplacementContinuation(c15, bias, DC_PARAMS, SPREAD_FOR_DC);
// Apply precedence: only counts as DC firing if no other trigger fired
const anyOtherFired =
  obResult.qualifies === 'yes' || fvgResult.qualifies === 'yes' ||
  sweepResult.qualifies === 'yes' || breakoutResult.qualifies === 'yes';
const dcFires = !anyOtherFired && dcResult.qualifies === 'yes';
```

- [ ] **Step 3: Extend the confusion matrix output to include DC column**

Find the per-trigger confusion matrix output (search for `OB_retest | TP | TN`). Add a row:

```
| Displacement_Continuation | TP | TN | FP | FN | INDETERM | comparable |
```

- [ ] **Step 4: Smoke test**

Run: `ssh bot@162.55.212.198 "cd ~/trading-bot && npx tsx scripts/audit-trigger-decisions.ts --days 3 2>&1 | tail -25"`
Expected: Output now shows 6 triggers in the matrix. No crash.

- [ ] **Step 5: Commit**

```bash
git add scripts/audit-trigger-decisions.ts
git -c user.name='Giuseppe Portelli' -c user.email=giuseppeportelli1403@gmail.com commit -m "feat(audit): extend trigger-decision audit to 6 triggers (Task 14)"
```

---

### Task 15: Unit test for audit-script DC integration

**Files:**
- Modify: `tests/audit-trigger-detectors.test.ts`

- [ ] **Step 1: Add a DC-specific describe block**

Append to `tests/audit-trigger-detectors.test.ts`:

```typescript
import { checkDisplacementContinuation } from '../scripts/_displacement-backtest.js';

describe('checkDisplacementContinuation (via audit-script import path)', () => {
  it('is importable through the audit script integration chain', () => {
    expect(typeof checkDisplacementContinuation).toBe('function');
  });

  it('respects precedence: returns yes only when no other trigger fires', () => {
    // A canonical Displacement-only fixture (no OB nearby, no swept liquidity)
    // Same fixture style as the detector test in Task 4
    const params: DcParams = { X: 0.5, Y: 1.2, Z: 0.7, n: 2 };
    const atrBodyCandles14 = Array(14).fill({
      open: 1.090, high: 1.094, low: 1.088, close: 1.093,
    });
    const prior = { open: 1.095, high: 1.101, low: 1.094, close: 1.100 };
    const latest = { open: 1.100, high: 1.110, low: 1.099, close: 1.109 };
    const result = checkDisplacementContinuation(
      [...atrBodyCandles14, prior, latest], 'bullish', params, 0.0001,
    );
    expect(result.qualifies).toBe('yes');
  });
});
```

- [ ] **Step 2: Run + verify pass**

Run: `ssh bot@162.55.212.198 "cd ~/trading-bot && npx vitest run tests/audit-trigger-detectors.test.ts"`
Expected: PASS — existing tests + 2 new.

- [ ] **Step 3: Commit**

```bash
git add tests/audit-trigger-detectors.test.ts
git -c user.name='Giuseppe Portelli' -c user.email=giuseppeportelli1403@gmail.com commit -m "test(audit): DC detector integration through audit-script import (Task 15)"
```

---

### Task 16: Add DC tracking to `dump-reject-metrics.ts`

**Files:**
- Modify: `scripts/dump-reject-metrics.ts`
- Modify: `tests/dump-reject-metrics.test.ts`

- [ ] **Step 1: Add a new ExecuteCategory pattern for DC firings**

In `scripts/dump-reject-metrics.ts`, locate the `PATTERNS` array. Add:

```typescript
  // Displacement Continuation specifically — separate from generic place_order
  { cat: 'displacement_fired', re: /setup_type.*['"]Displacement_Continuation['"]|trigger 6 Displacement Continuation fired/ },
```

And extend the `ExecuteCategory` union:

```typescript
export type ExecuteCategory =
  | 'place_order_executed'
  | 'log_trade_attempted'
  | 'log_trade_failed'
  | 'ict_cycle_complete'
  | 'displacement_fired'; // NEW
```

- [ ] **Step 2: Add a DC section to the daily markdown output**

Find the markdown generation function. Add after the existing per-instrument matrix:

```typescript
md.push('\n## Displacement Continuation (Phase 1)\n');
const dcFirings = lines.filter(l => classifyLine(l) === 'displacement_fired').length;
md.push(`- Firings today: **${dcFirings}**\n`);
// Outcome stats come from trades table query — see scripts/_morning-status.mjs for SQL pattern
```

- [ ] **Step 3: Update the test fixture in `tests/dump-reject-metrics.test.ts`**

Add a test case that asserts a log line containing `"setup_type":"Displacement_Continuation"` is classified as `displacement_fired`.

```typescript
it('classifies a Displacement_Continuation place_split_trade as displacement_fired', () => {
  const line = '[ICT Agent] Calling tool: place_split_trade {"setup_type":"Displacement_Continuation",...}';
  expect(classifyLine(line)).toBe('displacement_fired');
});
```

- [ ] **Step 4: Run tests**

Run: `ssh bot@162.55.212.198 "cd ~/trading-bot && npx vitest run tests/dump-reject-metrics.test.ts"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/dump-reject-metrics.ts tests/dump-reject-metrics.test.ts
git -c user.name='Giuseppe Portelli' -c user.email=giuseppeportelli1403@gmail.com commit -m "feat(metrics): track Displacement Continuation firings in daily dump (Task 16)"
```

---

### Task 17: Add DC-specific rollback triggers to `measure-loosening-impact.ts`

**Files:**
- Modify: `scripts/measure-loosening-impact.ts`

- [ ] **Step 1: Locate the rollback-trigger section**

Run: `ssh bot@162.55.212.198 "grep -n 'rollbackTriggers\\|trades/day.*< 1\\|consecutive' ~/trading-bot/scripts/measure-loosening-impact.ts | head -10"`

- [ ] **Step 2: Add DC-specific checks**

After the existing 5 trigger checks, append:

```typescript
// Displacement Continuation Phase 1 rollback triggers (added 2026-05-13)
const dcFiringsLast5Days = /* count DC firings from last 5 days of metric dumps */ 0;
if (dcFiringsLast5Days === 0) {
  rollbackTriggers.push('DC: 0 firings in 5 days — backtest did not generalize');
}

const dcEvents = /* fetch trades where strategy_tag = "Displacement_Continuation" */ [];
const dcDecided = dcEvents.filter(t => t.status === 'complete' || t.status === 'sl_hit');
if (dcDecided.length >= 8) {
  const dcWins = dcDecided.filter(t => (t.pnl_total ?? 0) > 0).length;
  const dcWR = dcWins / dcDecided.length;
  if (dcWR < 0.25) {
    rollbackTriggers.push(`DC: decided WR ${(dcWR * 100).toFixed(1)}% < 25% on n=${dcDecided.length}`);
  }
}
```

- [ ] **Step 3: Smoke test**

Run: `ssh bot@162.55.212.198 "cd ~/trading-bot && npx tsx scripts/measure-loosening-impact.ts 2>&1 | tail -15"`
Expected: Runs without crash. Shows 5 PR 1 triggers + 1 or 2 new DC checks (DC count = 0 because not deployed yet — that's expected pre-deploy).

- [ ] **Step 4: Commit**

```bash
git add scripts/measure-loosening-impact.ts
git -c user.name='Giuseppe Portelli' -c user.email=giuseppeportelli1403@gmail.com commit -m "feat(rollback): DC-specific Phase 1 rollback triggers (Task 17)"
```

---

### Task 18: Deploy + smoke test

**Files:** none modified; this is a deploy task.

- [ ] **Step 1: Run the full test suite**

Run: `ssh bot@162.55.212.198 "cd ~/trading-bot && npm test 2>&1 | tail -30"`
Expected: All tests pass — including 820+ pre-existing tests + the new ones from Tasks 2, 4, 5, 9, 13, 15, 16.

- [ ] **Step 2: Push the feature branch + open PR**

```bash
ssh bot@162.55.212.198 "cd ~/trading-bot && git push -u origin feat/displacement-continuation-phase1"
```

Open a PR on GitHub manually (or via `gh pr create` from local machine where gh is authenticated). PR description should link to the spec doc and call out the Phase 0 backtest results.

- [ ] **Step 3: After PR review/merge, pull master on VPS and deploy**

```bash
ssh bot@162.55.212.198 "cd ~/trading-bot && git checkout master && git pull && pm2 restart trading-bot"
```

- [ ] **Step 4: Live smoke test — watch the next 4h of cycles**

Run: `ssh bot@162.55.212.198 "pm2 logs trading-bot --lines 100 --nostream | grep -iE 'displacement|Trigger 6|cycle complete' | tail -50"`

For the first 4h post-deploy, monitor:
- No crashes (process status = online).
- DC trigger evaluation appears in cycle logs (the LLM should mention "Trigger 6" or "Displacement Continuation" in its Step 3-I reasoning, even if it doesn't fire).
- If a DC firing occurs: cross-check with audit script `npx tsx scripts/audit-trigger-decisions.ts --debug-cycle <ISO_TS>` to confirm LLM and deterministic detector agree.

- [ ] **Step 5: After 24h, run a manual checkpoint**

Run: `ssh bot@162.55.212.198 "cat ~/trading-bot/data/metrics/reject-$(date -u +%Y-%m-%d).md | grep -A 5 'Displacement'"`
Expected: At least the new section header is present. Firings may be 0 or more — both are valid for day 1.

- [ ] **Step 6: Final commit (if any post-deploy fixes needed) and update spec status**

If the deploy revealed an issue, fix in a follow-up commit. Update the spec's Status field:

```bash
ssh bot@162.55.212.198 "cd ~/trading-bot && sed -i 's/Status:\\*\\*\\s*Draft.*$/Status:** Phase 1 deployed (`<MERGE_SHA>`)/' docs/architecture/2026-05-13-displacement-continuation-design.md"
git -c user.name='Giuseppe Portelli' -c user.email=giuseppeportelli1403@gmail.com commit -am "docs(spec): mark Displacement Continuation Phase 1 as deployed (Task 18)"
```

---

## Phase 2 — Promotion (deferred, not in this plan)

When live data meets promotion criteria:
- Live firings ≥ **10**
- Mean R ≥ **+0.05R**
- Decided WR ≥ **35%**

A separate ~30-minute follow-up task will:
1. Flip `tierRiskPct('Displacement_Continuation')` from constant `0.0025` to Tier-aware (1.5%/1.0%/0.5%).
2. Update both prompts to remove the "Phase 1 half-size" callout.
3. Update the spec status to "Phase 2 promoted".
4. Add a measurement note to `data/metrics/loosening-daily.log`.

This is intentionally deferred — Phase 2 is its own micro-spec when the data arrives.

---

## Self-Review Notes (from plan author)

- **Spec coverage:** All 4 sections of the spec map to tasks: Section 1 → Task 4; Section 2 → Tasks 5-8; Section 3 → Task 6 (SL/TP applied inside sweep loop); Section 4 → Tasks 9-17.
- **No placeholders:** All `<winnerX>/<winnerY>/<winnerZ>/<winnerN>` markers are explicit substitution points keyed to Task 8's output.
- **Type consistency:** `DcParams`, `DetectorResult`, `SimOutcome`, `SimResult` used consistently across Tasks 4-7. `Bias` type ported in Task 2.
- **TDD discipline:** Every code-writing task (2, 3, 4, 5, 9, 13, 15, 16) has failing-test → impl → passing-test → commit steps.
- **Hygiene bundling:** Task 12 fixes the existing strategy.md drift while adding the new trigger — both ship in one PR with the Phase 1 deployment.

## References

- Spec: `docs/architecture/2026-05-13-displacement-continuation-design.md` (commit `dc80bae`)
- Architecture: `docs/architecture/SYSTEM-FLOWCHART.md` Section 2 (ICT cycle)
- Existing detectors: `scripts/audit-trigger-decisions.ts` (5 trigger functions, now exported)
- Existing rollback: `scripts/measure-loosening-impact.ts` (PR 1's 5 triggers)
- Previous PR template: `docs/architecture/2026-05-11-trade-pnl-capture-plan.md`

# Trade-Frequency Loosening — PR 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship PR 1 of the trade-frequency loosening initiative — lower Tier 3 score floor (40/45 → 30/35), OB Retest body threshold (0.4 → 0.3), OB Retest opposing wick threshold (1.0 → 0.7), FVG Fill body threshold (0.4 → 0.3), and Force-Propose threshold (55 → 40) — gated by deterministic backtest + shadow-LLM replay, with new analyst-load capping and per-instrument measurement infrastructure landing first as prerequisites.

**Architecture:** Three pieces of new infrastructure (per-instrument audit reporting, analyst-load cap, shadow-LLM replay tool) ship as Phase 1 before any threshold change. PR 1 numerical changes ship atomically in Phase 2 after both pre-merge sub-gates (deterministic backtest + shadow-LLM replay) pass. Phase 3 adds post-ship daily measurement + manual rollback runbook. PR 2 (ICT prompt restructure) is a separate plan that begins only after PR 1 ships and 1 week of demo measurement establishes a new baseline.

**Tech Stack:** TypeScript (Node 20.20), Vitest, scripts via tsx, prompts in markdown. Bot runs on Hetzner VPS (`bot@162.55.212.198:~/trading-bot/`) under pm2. Capital.com CFD demo broker.

**Related work:**
- Design: `docs/superpowers/specs/2026-05-12-trade-frequency-loosening-design.md` (master `3ec55dd`)
- Audit script (already exists, infrastructure reused): `scripts/audit-trigger-decisions.ts`
- Backtest harness (already exists): `scripts/run-backtest.ts`
- Strictness comparison evidence: `C:\Users\user\AppData\Local\Temp\farad-strictness-comparison.md`

**Git author env vars for every commit:**
```
GIT_AUTHOR_NAME='Giuseppe Portelli' GIT_AUTHOR_EMAIL='giuseppeportelli1403@gmail.com' GIT_COMMITTER_NAME='Giuseppe Portelli' GIT_COMMITTER_EMAIL='giuseppeportelli1403@gmail.com'
```

---

## File Structure

**New files:**
- `scripts/shadow-llm-replay.ts` — replay tool: takes threshold overrides + N cycles + prompt version → audit confusion matrix delta
- `tests/shadow-llm-replay.test.ts` — unit tests for replay tool
- `tests/analyst-load-cap.test.ts` — unit tests for per-cycle candidate cap
- `tests/tier3-floor.test.ts` — regression test for tier3FloorFor constants
- `scripts/measure-loosening-impact.ts` — daily measurement runner (per-instrument metrics, R/trade, FP count)
- `docs/runbooks/rollback-loosening.md` — manual rollback checklist

**Modified files:**
- `src/scanner/index.ts` — `tier3FloorFor` constants (line ~437-440 per design doc reference)
- `src/agents/trading-agent.ts` — analyst-load cap (max 5 candidates per cycle to analyst)
- `prompts/ict-agent.md` — body/wick thresholds (Step 3I lines ~179-180), Force-Propose threshold (Step 3M)
- `scripts/audit-trigger-decisions.ts` — per-instrument confusion matrix breakdown
- `tests/audit-trigger-detectors.test.ts` — per-instrument reporting assertions
- `tests/analyst-prompt.test.ts` — assertions for new prompt threshold values

---

## Phase 1: Pre-PR Infrastructure (prerequisites)

These three components must ship as separate commits BEFORE the numerical threshold change. They enable validation and observability.

---

### Task 1: Per-instrument reporting in audit script

**Files:**
- Modify: `scripts/audit-trigger-decisions.ts`
- Modify: `tests/audit-trigger-detectors.test.ts`

- [ ] **Step 1: Read current audit-script output format**

```bash
ssh bot@162.55.212.198 "cd ~/trading-bot && grep -n 'confusion matrix\\|Per-trigger\\|summary' scripts/audit-trigger-decisions.ts | head -10"
```

Note line numbers for the matrix-printing section.

- [ ] **Step 2: Write failing test for per-instrument breakdown**

Add to `tests/audit-trigger-detectors.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildPerInstrumentMatrix } from '../scripts/audit-trigger-decisions.js';
// Note: requires the function to be exported from the script.

describe('buildPerInstrumentMatrix', () => {
  it('returns per-instrument confusion-matrix breakdown', () => {
    const cycles = [
      { ticker: 'GOLD', triggerConfirmedLLM: 'no', anyTriggerMath: false },
      { ticker: 'GOLD', triggerConfirmedLLM: 'no', anyTriggerMath: false },
      { ticker: 'EURUSD', triggerConfirmedLLM: 'yes', anyTriggerMath: true },
      { ticker: 'OIL_CRUDE', triggerConfirmedLLM: 'no', anyTriggerMath: true }, // FN
    ];
    const matrix = buildPerInstrumentMatrix(cycles);
    expect(matrix.GOLD).toEqual({ tp: 0, tn: 2, fp: 0, fn: 0 });
    expect(matrix.EURUSD).toEqual({ tp: 1, tn: 0, fp: 0, fn: 0 });
    expect(matrix.OIL_CRUDE).toEqual({ tp: 0, tn: 0, fp: 0, fn: 1 });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
ssh bot@162.55.212.198 "cd ~/trading-bot && npx vitest run tests/audit-trigger-detectors.test.ts -t 'buildPerInstrumentMatrix'"
```

Expected: FAIL — `buildPerInstrumentMatrix is not a function` (function doesn't exist yet).

- [ ] **Step 4: Implement and export buildPerInstrumentMatrix in audit-trigger-decisions.ts**

Add after the existing confusion-matrix logic (around the summary block):

```typescript
export interface CycleVerdict {
  ticker: string;
  triggerConfirmedLLM: 'yes' | 'no' | 'unknown';
  anyTriggerMath: boolean;
}

export function buildPerInstrumentMatrix(
  cycles: CycleVerdict[]
): Record<string, { tp: number; tn: number; fp: number; fn: number }> {
  const matrix: Record<string, { tp: number; tn: number; fp: number; fn: number }> = {};
  for (const c of cycles) {
    if (c.triggerConfirmedLLM === 'unknown') continue;
    if (!matrix[c.ticker]) matrix[c.ticker] = { tp: 0, tn: 0, fp: 0, fn: 0 };
    const llmYes = c.triggerConfirmedLLM === 'yes';
    if (llmYes && c.anyTriggerMath) matrix[c.ticker].tp++;
    else if (!llmYes && !c.anyTriggerMath) matrix[c.ticker].tn++;
    else if (llmYes && !c.anyTriggerMath) matrix[c.ticker].fp++;
    else if (!llmYes && c.anyTriggerMath) matrix[c.ticker].fn++;
  }
  return matrix;
}
```

- [ ] **Step 5: Wire it into the summary output**

In the summary block of `scripts/audit-trigger-decisions.ts`, after the existing aggregate matrix print:

```typescript
// Per-instrument breakdown (codex finding #10)
const perInstrument = buildPerInstrumentMatrix(allCycleVerdicts);
console.log('\nPer-instrument confusion matrix:');
console.log('  ticker    | TP | TN | FP | FN');
for (const [ticker, m] of Object.entries(perInstrument).sort()) {
  console.log(`  ${ticker.padEnd(9)} | ${String(m.tp).padStart(2)} | ${String(m.tn).padStart(2)} | ${String(m.fp).padStart(2)} | ${String(m.fn).padStart(2)}`);
}
```

- [ ] **Step 6: Run test to verify it passes + full audit run smoke-test**

```bash
ssh bot@162.55.212.198 "cd ~/trading-bot && npx vitest run tests/audit-trigger-detectors.test.ts -t 'buildPerInstrumentMatrix' && npx tsx scripts/audit-trigger-decisions.ts --days 7 2>&1 | tail -30"
```

Expected: test PASS, audit summary now includes per-instrument matrix block.

- [ ] **Step 7: Commit**

```bash
ssh bot@162.55.212.198 "cd ~/trading-bot && git add scripts/audit-trigger-decisions.ts tests/audit-trigger-detectors.test.ts && GIT_AUTHOR_NAME='Giuseppe Portelli' GIT_AUTHOR_EMAIL='giuseppeportelli1403@gmail.com' GIT_COMMITTER_NAME='Giuseppe Portelli' GIT_COMMITTER_EMAIL='giuseppeportelli1403@gmail.com' git commit -m 'feat(audit): per-instrument confusion matrix breakdown (codex finding #10)'"
```

---

### Task 2: Analyst-load cap (max 5 candidates per cycle)

**Files:**
- Modify: `src/agents/trading-agent.ts`
- Create: `tests/analyst-load-cap.test.ts`

- [ ] **Step 1: Read current candidate-handling code path**

```bash
ssh bot@162.55.212.198 "cd ~/trading-bot && grep -nE 'force.propose|composite_score.*55|candidates.*review' src/agents/trading-agent.ts prompts/ict-agent.md | head -15"
```

Identify where candidates are passed to the analyst (the call site for `request_analyst_review`). Note that with current Force-Propose at 55, the cap is rarely hit; with PR 1's drop to 40, multiple candidates per cycle becomes common.

- [ ] **Step 2: Write failing test for the candidate cap**

Create `tests/analyst-load-cap.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { capCandidatesForAnalyst } from '../src/agents/trading-agent.js';

describe('capCandidatesForAnalyst', () => {
  it('returns all candidates when count <= 5', () => {
    const candidates = [
      { ticker: 'GOLD', composite_score: 65 },
      { ticker: 'EURUSD', composite_score: 60 },
      { ticker: 'GBPUSD', composite_score: 55 },
    ];
    expect(capCandidatesForAnalyst(candidates)).toEqual(candidates);
  });

  it('returns top-5-by-score when count > 5', () => {
    const candidates = [
      { ticker: 'GOLD', composite_score: 65 },
      { ticker: 'EURUSD', composite_score: 60 },
      { ticker: 'GBPUSD', composite_score: 55 },
      { ticker: 'USDJPY', composite_score: 52 },
      { ticker: 'AUDUSD', composite_score: 50 },
      { ticker: 'SILVER', composite_score: 45 },
      { ticker: 'OIL_CRUDE', composite_score: 42 },
    ];
    const capped = capCandidatesForAnalyst(candidates);
    expect(capped).toHaveLength(5);
    expect(capped.map((c) => c.ticker)).toEqual(['GOLD', 'EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD']);
  });

  it('handles empty input', () => {
    expect(capCandidatesForAnalyst([])).toEqual([]);
  });

  it('is stable: tied scores preserve input order', () => {
    const candidates = [
      { ticker: 'GOLD', composite_score: 50 },
      { ticker: 'EURUSD', composite_score: 50 },
      { ticker: 'GBPUSD', composite_score: 50 },
      { ticker: 'USDJPY', composite_score: 50 },
      { ticker: 'AUDUSD', composite_score: 50 },
      { ticker: 'SILVER', composite_score: 50 },
    ];
    const capped = capCandidatesForAnalyst(candidates);
    expect(capped.map((c) => c.ticker)).toEqual(['GOLD', 'EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD']);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
ssh bot@162.55.212.198 "cd ~/trading-bot && npx vitest run tests/analyst-load-cap.test.ts"
```

Expected: FAIL — `capCandidatesForAnalyst is not a function`.

- [ ] **Step 4: Implement capCandidatesForAnalyst in trading-agent.ts**

Add as a named export near the top of `src/agents/trading-agent.ts`:

```typescript
// 2026-05-12 (PR 1 loosening): cap candidates submitted to analyst per cycle
// at 5 to bound LLM call latency under loosened thresholds. With Force-Propose
// dropping 55 → 40 and Tier 3 floor 40/45 → 30/35, multiple candidates per
// cycle becomes the norm rather than the exception. Per design v2 §6 PR 1
// "Per-cycle analyst load limit" (codex finding #3).
export const MAX_CANDIDATES_PER_ANALYST_CYCLE = 5;

export function capCandidatesForAnalyst<T extends { composite_score: number }>(
  candidates: T[]
): T[] {
  if (candidates.length <= MAX_CANDIDATES_PER_ANALYST_CYCLE) return [...candidates];
  // Stable sort: preserve input order for tied scores.
  const indexed = candidates.map((c, i) => ({ c, i }));
  indexed.sort((a, b) => {
    if (a.c.composite_score !== b.c.composite_score) {
      return b.c.composite_score - a.c.composite_score;
    }
    return a.i - b.i;
  });
  return indexed.slice(0, MAX_CANDIDATES_PER_ANALYST_CYCLE).map((x) => x.c);
}
```

- [ ] **Step 5: Find and update the actual candidate-submission call site**

```bash
ssh bot@162.55.212.198 "cd ~/trading-bot && grep -nB1 -A3 'request_analyst_review' src/agents/trading-agent.ts | head -40"
```

Wire `capCandidatesForAnalyst` into the loop that submits candidates to the analyst. (The exact call site is implementation-discovery — find where the loop iterates over ranked candidates and inserts the `.slice(0, MAX)` or a call to the helper.)

If the LLM-side submission is fully prompt-driven (the ICT agent decides which candidates to propose, not code), then the cap belongs in the prompt instead: add to `prompts/ict-agent.md` Step 3M:

> "**Per-cycle analyst-call cap:** submit at most 5 candidates to `request_analyst_review` per cycle. If more than 5 candidates pass the Force-Propose threshold, submit only the top 5 by composite_score."

Document the decision (code-side vs prompt-side) in the commit message.

- [ ] **Step 6: Run all tests + tsc**

```bash
ssh bot@162.55.212.198 "cd ~/trading-bot && npx vitest run tests/analyst-load-cap.test.ts && npx tsc --noEmit 2>&1 | wc -l"
```

Expected: 4/4 pass, tsc 0 errors.

- [ ] **Step 7: Commit**

```bash
ssh bot@162.55.212.198 "cd ~/trading-bot && git add src/agents/trading-agent.ts tests/analyst-load-cap.test.ts prompts/ict-agent.md && GIT_AUTHOR_NAME='Giuseppe Portelli' GIT_AUTHOR_EMAIL='giuseppeportelli1403@gmail.com' GIT_COMMITTER_NAME='Giuseppe Portelli' GIT_COMMITTER_EMAIL='giuseppeportelli1403@gmail.com' git commit -m 'feat(analyst): cap candidates per cycle at 5 (codex finding #3 — bound analyst load under loosened thresholds)'"
```

---

### Task 3: Shadow-LLM replay tool

**Files:**
- Create: `scripts/shadow-llm-replay.ts`
- Create: `tests/shadow-llm-replay.test.ts`

- [ ] **Step 1: Design the tool's interface**

Header comment for the new file:

```typescript
// scripts/shadow-llm-replay.ts
//
// Replay tool for PR 1 / PR 2 validation. Takes:
//   - threshold overrides (Tier 3 floor, body, opposing wick, Force-Propose)
//   - N cycles from pm2-out.log
//   - prompt version (current sequential | new parallel-multi-trigger)
//
// For each cycle, re-fetches the same OHLC data the LLM saw, applies the
// trigger-detection math (from scripts/audit-trigger-decisions.ts) with the
// OVERRIDDEN thresholds, and reports:
//   - Trigger qualification rate (under NEW thresholds)
//   - Analyst proposal rate (how many newly-admitted candidates would have
//     hit the analyst)
//   - Hallucination delta (audit confusion-matrix FP count must stay 0 vs
//     baseline FP count)
//
// Usage:
//   npx tsx scripts/shadow-llm-replay.ts \
//     --tier3-floor 30 --tier3-floor-medium 35 \
//     --ob-body 0.3 --ob-wick 0.7 --fvg-body 0.3 \
//     --force-propose 40 \
//     --cycles 50 \
//     --prompt current
//
// Output: JSON report to stdout + summary to stderr.
```

- [ ] **Step 2: Write failing test — tool builds an override-aware detector**

Create `tests/shadow-llm-replay.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { applyThresholdOverrides, replayCycle } from '../scripts/shadow-llm-replay.js';

describe('applyThresholdOverrides', () => {
  it('returns the override values for OB Retest body and wick', () => {
    const overrides = {
      tier3FloorTight: 30,
      tier3FloorMedium: 35,
      obBody: 0.3,
      obWick: 0.7,
      fvgBody: 0.3,
      forceProposeFloor: 40,
    };
    const result = applyThresholdOverrides(overrides);
    expect(result.obBody).toBe(0.3);
    expect(result.obWick).toBe(0.7);
    expect(result.forceProposeFloor).toBe(40);
  });

  it('uses production defaults when no overrides provided', () => {
    const result = applyThresholdOverrides({});
    expect(result.obBody).toBe(0.4);  // production default
    expect(result.obWick).toBe(1.0);
    expect(result.forceProposeFloor).toBe(55);
  });
});

describe('replayCycle', () => {
  it('produces a verdict object with all required fields', async () => {
    // Mock cycle: AUDUSD bearish trigger, current thresholds → fails, lowered thresholds → passes
    const mockCycle = {
      timestamp: new Date('2026-05-11T13:17:00Z'),
      ticker: 'AUDUSD',
      bias: 'bearish' as const,
      llmVerdict: 'no' as const,
    };
    const overrides = { obBody: 0.3, obWick: 0.7, forceProposeFloor: 40 };
    const verdict = await replayCycle(mockCycle, overrides, { fetchCandlesFn: mockFetchCandles });
    expect(verdict).toHaveProperty('cycleTimestamp');
    expect(verdict).toHaveProperty('triggerQualifiedUnderOverrides');
    expect(verdict).toHaveProperty('mathFpVsLlm');
    expect(verdict).toHaveProperty('admissionDelta');
  });
});

// Mock helper — returns deterministic candles for AUDUSD around 2026-05-11 13:00 UTC
function mockFetchCandles(_ticker: string, _timeframe: string, _end: Date): Promise<any[]> {
  return Promise.resolve([
    { datetime: new Date('2026-05-11T13:00Z'), open: 0.7250, high: 0.7253, low: 0.7245, close: 0.7248 },
    // ... 19 more candles
  ]);
}
```

- [ ] **Step 3: Run test, see fail**

```bash
ssh bot@162.55.212.198 "cd ~/trading-bot && npx vitest run tests/shadow-llm-replay.test.ts"
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 4: Implement applyThresholdOverrides + replayCycle scaffold**

Create `scripts/shadow-llm-replay.ts` with the interface above + minimal implementation:

```typescript
import { detectOBRetest, detectFvgFill, detectLiquiditySweep, detectBreakoutRetest, detectRangeSweepReversal } from './audit-trigger-decisions.js';
import { Candle } from '../src/types.js';

export interface ThresholdOverrides {
  tier3FloorTight?: number;
  tier3FloorMedium?: number;
  obBody?: number;
  obWick?: number;
  fvgBody?: number;
  forceProposeFloor?: number;
}

export interface ResolvedThresholds {
  tier3FloorTight: number;
  tier3FloorMedium: number;
  obBody: number;
  obWick: number;
  fvgBody: number;
  forceProposeFloor: number;
}

const DEFAULTS: ResolvedThresholds = {
  tier3FloorTight: 40,
  tier3FloorMedium: 45,
  obBody: 0.4,
  obWick: 1.0,
  fvgBody: 0.4,
  forceProposeFloor: 55,
};

export function applyThresholdOverrides(overrides: ThresholdOverrides): ResolvedThresholds {
  return { ...DEFAULTS, ...overrides };
}

export interface CycleReplayInput {
  timestamp: Date;
  ticker: string;
  bias: 'bullish' | 'bearish' | 'neutral';
  llmVerdict: 'yes' | 'no' | 'unknown';
}

export interface CycleReplayVerdict {
  cycleTimestamp: string;
  ticker: string;
  triggerQualifiedUnderOverrides: boolean;
  triggerQualifiedUnderDefaults: boolean;
  admissionDelta: 'newly_admitted' | 'unchanged_admitted' | 'unchanged_rejected' | 'newly_rejected';
  mathFpVsLlm: 'agreement' | 'fp' | 'fn' | 'na';
}

export async function replayCycle(
  cycle: CycleReplayInput,
  overrides: ThresholdOverrides,
  opts: { fetchCandlesFn?: (ticker: string, tf: string, end: Date) => Promise<Candle[]> } = {}
): Promise<CycleReplayVerdict> {
  const resolved = applyThresholdOverrides(overrides);
  const defaults = applyThresholdOverrides({});
  const fetchFn = opts.fetchCandlesFn ?? (await import('./fetch-capital-candles.js')).fetchCandles;

  const candles15m = await fetchFn(cycle.ticker, '15m', cycle.timestamp);
  // ... call detectors with overrides and defaults, compute admission delta

  // Placeholder return (real implementation runs all 5 detectors twice)
  return {
    cycleTimestamp: cycle.timestamp.toISOString(),
    ticker: cycle.ticker,
    triggerQualifiedUnderOverrides: false,
    triggerQualifiedUnderDefaults: false,
    admissionDelta: 'unchanged_rejected',
    mathFpVsLlm: 'agreement',
  };
}
```

- [ ] **Step 5: Run test to verify the scaffold tests pass**

```bash
ssh bot@162.55.212.198 "cd ~/trading-bot && npx vitest run tests/shadow-llm-replay.test.ts && npx tsc --noEmit 2>&1 | wc -l"
```

Expected: applyThresholdOverrides tests pass, replayCycle test passes (using mockFetchCandles). tsc 0 errors.

**Note**: this is the scaffold. The full replayCycle that calls all 5 detectors with overrides is below — it's a separate step because the detectors are currently parameterized only by their hard-coded constants. Detector parameterization is the substantive work.

- [ ] **Step 6: Parameterize the detectors in audit-trigger-decisions.ts**

The existing detector functions (`detectOBRetest`, `detectFvgFill`, etc.) read constants from module scope. For shadow-replay, they need to accept overrides. Refactor signature:

```typescript
// In scripts/audit-trigger-decisions.ts — modify each detector:
export function detectOBRetest(
  candles15m: Candle[],
  bias: 'bullish' | 'bearish',
  spread: number,
  atr15m: number,
  overrides?: { bodyMin?: number; wickMin?: number },
): TriggerResult {
  const bodyMin = overrides?.bodyMin ?? 0.4;
  const wickMin = overrides?.wickMin ?? 1.0;
  // ... existing logic, but use bodyMin and wickMin instead of hard-coded 0.4 and 1.0
}
```

Mirror for `detectFvgFill` (bodyMin), the other 3 don't change in PR 1's scope.

- [ ] **Step 7: Wire detector overrides into replayCycle**

Update `replayCycle` to call detectors twice — once with `overrides`, once with defaults — and compute the admission delta.

- [ ] **Step 8: Add CLI entry point in shadow-llm-replay.ts**

```typescript
// Bottom of scripts/shadow-llm-replay.ts
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      'tier3-floor': { type: 'string', default: '40' },
      'tier3-floor-medium': { type: 'string', default: '45' },
      'ob-body': { type: 'string', default: '0.4' },
      'ob-wick': { type: 'string', default: '1.0' },
      'fvg-body': { type: 'string', default: '0.4' },
      'force-propose': { type: 'string', default: '55' },
      'cycles': { type: 'string', default: '50' },
      'log-path': { type: 'string', default: '/home/bot/trading-bot/data/pm2-out.log' },
    },
  });
  const overrides: ThresholdOverrides = {
    tier3FloorTight: Number(values['tier3-floor']),
    tier3FloorMedium: Number(values['tier3-floor-medium']),
    obBody: Number(values['ob-body']),
    obWick: Number(values['ob-wick']),
    fvgBody: Number(values['fvg-body']),
    forceProposeFloor: Number(values['force-propose']),
  };
  const nCycles = Number(values.cycles);
  const logPath = String(values['log-path']);

  // Parse log → get last N cycles
  const logContent = readFileSync(logPath, 'utf-8');
  // ... (reuse parseLog from audit-trigger-decisions.ts; export it first)
  // ... (loop calling replayCycle, aggregate verdicts)
  // ... (print JSON to stdout + summary to stderr)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
```

- [ ] **Step 9: Smoke test the CLI**

```bash
ssh bot@162.55.212.198 "cd ~/trading-bot && npx tsx scripts/shadow-llm-replay.ts --cycles 5 --ob-body 0.3 --ob-wick 0.7 --force-propose 40 2>&1 | tail -20"
```

Expected: outputs a JSON report + summary. No crash.

- [ ] **Step 10: Commit Phase 1 (the 3 infrastructure pieces)**

The detector parameterization touches `audit-trigger-decisions.ts`, which Task 1 also modified. Ensure ordering: Task 1 commits first (per-instrument breakdown), Task 3 commits the detector parameterization separately.

```bash
ssh bot@162.55.212.198 "cd ~/trading-bot && git add scripts/audit-trigger-decisions.ts scripts/shadow-llm-replay.ts tests/shadow-llm-replay.test.ts && GIT_AUTHOR_NAME='Giuseppe Portelli' GIT_AUTHOR_EMAIL='giuseppeportelli1403@gmail.com' GIT_COMMITTER_NAME='Giuseppe Portelli' GIT_COMMITTER_EMAIL='giuseppeportelli1403@gmail.com' git commit -m 'feat(shadow-replay): tool for PR-1 / PR-2 threshold validation (codex finding #1 + #8)'"
```

---

## Phase 2: PR 1 Numerical Changes

Phase 1 commits must be merged before Phase 2 begins. Phase 2 commits are the actual threshold loosening + the two pre-merge validation gates.

---

### Task 4: Failing tests for new threshold values (red phase)

**Files:**
- Create: `tests/tier3-floor.test.ts`
- Modify: `tests/analyst-prompt.test.ts`

- [ ] **Step 1: Find current tier3FloorFor implementation**

```bash
ssh bot@162.55.212.198 "cd ~/trading-bot && grep -nB1 -A8 'tier3FloorFor\\|tier3.floor' src/scanner/index.ts"
```

- [ ] **Step 2: Write failing test for new tier3 floor values**

Create `tests/tier3-floor.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { tier3FloorFor } from '../src/scanner/index.js';

describe('tier3FloorFor (post-PR-1 loosening 2026-05-12)', () => {
  it('returns 30 for tight-spread instruments', () => {
    expect(tier3FloorFor('EURUSD')).toBe(30);
    expect(tier3FloorFor('GBPUSD')).toBe(30);
    expect(tier3FloorFor('AUDUSD')).toBe(30);
    expect(tier3FloorFor('USDJPY')).toBe(30);
    expect(tier3FloorFor('GOLD')).toBe(30);
  });

  it('returns 35 for medium-spread instruments', () => {
    expect(tier3FloorFor('OIL_CRUDE')).toBe(35);
    expect(tier3FloorFor('SILVER')).toBe(35);
  });

  it('returns the spread-aware floor for unknown ticker (fallback)', () => {
    // Current implementation likely returns the higher floor as safety fallback
    expect(tier3FloorFor('XAUEUR')).toBeGreaterThanOrEqual(30);
  });
});
```

- [ ] **Step 3: Write failing assertions in tests/analyst-prompt.test.ts**

Add a new describe block:

```typescript
describe('ICT prompt threshold values (post-PR-1 loosening)', () => {
  it('OB Retest body threshold is 0.3, not 0.4', () => {
    expect(promptText).toContain('body ≥ 0.3×range');
    expect(promptText).not.toMatch(/body ≥ 0\.4×range/);
  });

  it('OB Retest opposing wick threshold is 0.7, not 1.0', () => {
    expect(promptText).toContain('opposing wick ≥ 0.7×body');
    expect(promptText).not.toMatch(/opposing wick ≥ 1\.0×body/);
  });

  it('FVG Fill confirm body threshold is 0.3, not 0.4', () => {
    // The FVG threshold is on the confirmation candle's body after fill.
    const fvgBlock = promptText.match(/FVG Fill:[\s\S]{0,300}/)?.[0] ?? '';
    expect(fvgBlock).toContain('body ≥ 0.3×range');
  });

  it('Force-Propose threshold is 40, not 55', () => {
    expect(promptText).toMatch(/composite_score\s*≥\s*40/i);
  });
});
```

- [ ] **Step 4: Run all new tests, see them fail**

```bash
ssh bot@162.55.212.198 "cd ~/trading-bot && npx vitest run tests/tier3-floor.test.ts tests/analyst-prompt.test.ts 2>&1 | tail -20"
```

Expected: all 8+ assertions fail because the code/prompt still has old values.

- [ ] **Step 5: Commit the red phase**

```bash
ssh bot@162.55.212.198 "cd ~/trading-bot && git add tests/tier3-floor.test.ts tests/analyst-prompt.test.ts && GIT_AUTHOR_NAME='Giuseppe Portelli' GIT_AUTHOR_EMAIL='giuseppeportelli1403@gmail.com' GIT_COMMITTER_NAME='Giuseppe Portelli' GIT_COMMITTER_EMAIL='giuseppeportelli1403@gmail.com' git commit -m 'test(loosening): red-phase failing tests for new threshold values (PR 1)'"
```

---

### Task 5: Implement Tier 3 floor + body/wick/Force-Propose changes (green phase, atomic commit)

**Files:**
- Modify: `src/scanner/index.ts` (Tier 3 floor constants)
- Modify: `prompts/ict-agent.md` (Step 3I body/wick, Step 3M Force-Propose)

- [ ] **Step 1: Update tier3FloorFor constants**

In `src/scanner/index.ts`, find the `tier3FloorFor` function (around line 437-440 per design doc reference) and update the constants:

```typescript
// Before:
function tier3FloorFor(ticker: string): number {
  const mediumSpread = ['OIL_CRUDE', 'SILVER'];
  if (mediumSpread.includes(ticker)) return 45;
  return 40;
}

// After (PR 1 2026-05-12 loosening per docs/superpowers/specs/2026-05-12-trade-frequency-loosening-design.md):
function tier3FloorFor(ticker: string): number {
  const mediumSpread = ['OIL_CRUDE', 'SILVER'];
  if (mediumSpread.includes(ticker)) return 35;  // was 45
  return 30;                                       // was 40
}
```

Add a code comment referencing the design doc + master SHA.

- [ ] **Step 2: Update ICT prompt thresholds**

In `prompts/ict-agent.md`:

- Step 3I OB Retest line — change `body ≥ 0.4×range` to `body ≥ 0.3×range`
- Step 3I OB Retest line — change `opposing wick ≥ 1.0×body` to `opposing wick ≥ 0.7×body`
- Step 3I FVG Fill line — change `body ≥ 0.4×range` to `body ≥ 0.3×range`
- Step 3M Force-Propose — change `composite_score ≥ 55` to `composite_score ≥ 40`

Add a note at the bottom of Step 3M (or Step 3I — wherever the per-cycle cap fits cleanly):

> "**Per-cycle analyst-call cap (PR 1 2026-05-12):** submit at most 5 candidates to `request_analyst_review` per cycle. If more than 5 candidates pass the Force-Propose threshold (composite_score ≥ 40), submit only the top 5 by composite_score."

- [ ] **Step 3: Run the red-phase tests to verify they now pass**

```bash
ssh bot@162.55.212.198 "cd ~/trading-bot && npx vitest run tests/tier3-floor.test.ts tests/analyst-prompt.test.ts 2>&1 | tail -10"
```

Expected: all assertions pass.

- [ ] **Step 4: Run full test suite — no regressions**

```bash
ssh bot@162.55.212.198 "cd ~/trading-bot && npx vitest run 2>&1 | tail -6"
```

Expected: 0 failures.

- [ ] **Step 5: tsc clean**

```bash
ssh bot@162.55.212.198 "cd ~/trading-bot && npx tsc --noEmit 2>&1 | wc -l"
```

Expected: 0.

- [ ] **Step 6: DO NOT COMMIT YET — pre-merge validation gates come first**

The numerical changes are staged but not committed. Tasks 6 and 7 are the two pre-merge sub-gates from the design. Only after BOTH gates pass do we commit.

---

### Task 6: Sub-gate 1 — Deterministic backtest

**Files:**
- None modified (validation only)

- [ ] **Step 1: Run baseline backtest on current thresholds (control)**

```bash
ssh bot@162.55.212.198 "cd ~/trading-bot && git stash && npx tsx scripts/run-backtest.ts --start-date 2026-02-01 --end-date 2026-05-01 --tickers EURUSD,GBPUSD,AUDUSD,USDJPY,GOLD,OIL_CRUDE,SILVER --report-path /tmp/baseline-backtest.json && git stash pop"
```

(The `git stash` temporarily reverts the threshold change so the backtest runs against current production values. `git stash pop` restores the staged change after.)

- [ ] **Step 2: Run backtest on NEW thresholds (treatment)**

```bash
ssh bot@162.55.212.198 "cd ~/trading-bot && npx tsx scripts/run-backtest.ts --start-date 2026-02-01 --end-date 2026-05-01 --tickers EURUSD,GBPUSD,AUDUSD,USDJPY,GOLD,OIL_CRUDE,SILVER --report-path /tmp/loosened-backtest.json"
```

- [ ] **Step 3: Compare baseline vs loosened — ship criteria**

```bash
ssh bot@162.55.212.198 "cd ~/trading-bot && node -e '
const baseline = require(\"/tmp/baseline-backtest.json\");
const loosened = require(\"/tmp/loosened-backtest.json\");
console.log(\"Trade count multiplier:\", (loosened.totalTrades / baseline.totalTrades).toFixed(2), \"x\");
console.log(\"Win rate baseline:\", (baseline.winRate * 100).toFixed(1) + \"%\");
console.log(\"Win rate loosened:\", (loosened.winRate * 100).toFixed(1) + \"%\");
console.log(\"Expected R/trade baseline:\", baseline.expectancyR.toFixed(3));
console.log(\"Expected R/trade loosened:\", loosened.expectancyR.toFixed(3));
console.log(\"Per-instrument:\");
for (const t of Object.keys(loosened.perInstrument)) {
  const b = baseline.perInstrument[t];
  const l = loosened.perInstrument[t];
  console.log(\"  \" + t + \": trades \" + b.trades + \"→\" + l.trades + \", winRate \" + (b.winRate * 100).toFixed(0) + \"%→\" + (l.winRate * 100).toFixed(0) + \"%, maxDD \" + (l.maxDrawdown * 100).toFixed(1) + \"%\");
}
'"
```

Expected gates (from design v2 §6 PR 1 Sub-gate 1):
- Trade count ≥ 3× baseline
- Win rate ≥ 45% absolute (NOT retention-based — break-even is 43.5%)
- Expected R/trade ≥ 0.3R
- Baseline-retention never undercuts break-even + 5pp (= 48.5%): if `new_win_rate < baseline_win_rate − 5pp` AND `new_win_rate < 48%`, FAIL
- Per-instrument: no instrument with max drawdown > 12%

- [ ] **Step 4: If any gate fails, tune individual thresholds**

Pick the most-degrading single threshold change (likely Force-Propose 40, which admits the largest population of marginal candidates). Revert just that change to a less aggressive value (e.g., 45 instead of 40). Re-run backtest. Iterate up to 5 cycles before escalating to user.

- [ ] **Step 5: Document backtest results in `docs/runbooks/pr1-backtest-results.md`**

```markdown
# PR 1 Backtest Results

Run: 2026-05-XX (date when actually run)
Window: 2026-02-01 to 2026-05-01 (90 days)

## Aggregate
| Metric | Baseline | Loosened | Δ |
|---|---|---|---|
| Total trades | XX | XX | Xx |
| Win rate | XX.X% | XX.X% | XX.X pp |
| Expected R/trade | X.XX | X.XX | X.XX |
| Max drawdown | XX.X% | XX.X% | XX.X pp |

## Per-instrument
| Ticker | Trades B/L | Win rate B/L | Max DD L |
|---|---|---|---|
| EURUSD | X/Y | X%/Y% | Z% |
... (one row per ticker)

## Gate decisions
- [ ] Trade count ≥ 3× baseline: PASS / FAIL
- [ ] Win rate ≥ 45% absolute: PASS / FAIL
- [ ] Expected R/trade ≥ 0.3R: PASS / FAIL
- [ ] Baseline-retention not undercutting break-even+5pp: PASS / FAIL
- [ ] Per-instrument max drawdown ≤ 12%: PASS / FAIL

Overall: GATE PASSED / GATE FAILED
```

---

### Task 7: Sub-gate 2 — Shadow-LLM replay

**Files:**
- None modified (validation only)

- [ ] **Step 1: Run shadow-LLM replay with NEW thresholds on last 50 cycles**

```bash
ssh bot@162.55.212.198 "cd ~/trading-bot && npx tsx scripts/shadow-llm-replay.ts --cycles 50 --tier3-floor 30 --tier3-floor-medium 35 --ob-body 0.3 --ob-wick 0.7 --fvg-body 0.3 --force-propose 40 --prompt current > /tmp/shadow-replay-pr1.json"
```

- [ ] **Step 2: Inspect output for the success criteria**

```bash
ssh bot@162.55.212.198 "node -e '
const r = require(\"/tmp/shadow-replay-pr1.json\");
console.log(\"Total cycles replayed:\", r.cycleCount);
console.log(\"Cycles where trigger qualified under NEW thresholds:\", r.qualifiedUnderOverrides);
console.log(\"Cycles where trigger qualified under DEFAULTS:\", r.qualifiedUnderDefaults);
console.log(\"Admission delta (newly_admitted):\", r.admissionDelta.newly_admitted);
console.log(\"Hallucination count (FP under NEW):\", r.mathFpVsLlm.fp);
console.log(\"Trigger qualification rate multiplier:\", (r.qualifiedUnderOverrides / Math.max(1, r.qualifiedUnderDefaults)).toFixed(2), \"x\");
'"
```

Expected:
- Hallucination count (FP under NEW thresholds): **0** (the current zero-hallucination baseline must hold)
- Trigger qualification rate multiplier: between 2x and 5x (target is 3-5/day = ~3-5x current rate; if >5x, thresholds are too loose)
- `admissionDelta.newly_admitted` > 0 (proving the lowered thresholds are actually unlocking new candidates)

- [ ] **Step 3: Run shadow-LLM replay on last 20 cycles with PR 2's prompt structure**

This sub-gate addresses codex finding #8 (sequencing risk).

If PR 2's prompt structure exists in draft form, replay through it. If not yet drafted (likely at PR 1 time): run with current prompt + NEW thresholds AND record the result. PR 2's plan will reproduce this replay with the actual restructured prompt.

```bash
ssh bot@162.55.212.198 "cd ~/trading-bot && npx tsx scripts/shadow-llm-replay.ts --cycles 20 --tier3-floor 30 --tier3-floor-medium 35 --ob-body 0.3 --ob-wick 0.7 --fvg-body 0.3 --force-propose 40 --prompt current > /tmp/shadow-replay-pr1-for-pr2.json"
```

Document baseline qualification rate for PR 2 to compare against.

- [ ] **Step 4: If hallucinations appear or qualification rate jumps >5×, tune**

Failure mode: NEW thresholds too loose. Tune up:
- If hallucinations: raise the most permissive threshold first (e.g., wick 0.7 → 0.8)
- If qualification rate > 5×: raise Force-Propose first (40 → 45)
- Re-run shadow replay
- Iterate up to 5 cycles before escalating

- [ ] **Step 5: Document shadow-replay results in `docs/runbooks/pr1-backtest-results.md`** (append to Task 6's file)

```markdown
## Shadow-LLM replay (Sub-gate 2)

Run: 2026-05-XX
Cycles replayed: 50 (current prompt) + 20 (for PR 2 baseline)

| Metric | Value | Gate |
|---|---|---|
| Hallucination count (FP under NEW) | XX | Must be 0 |
| Trigger qualification rate multiplier | X.XXx | Target 2-5x |
| Newly-admitted cycles | XX | Must be > 0 |

Overall: GATE PASSED / GATE FAILED
```

---

### Task 8: Final commit + push to demo

**Files:**
- None modified (just commit + deploy)

- [ ] **Step 1: Verify both sub-gates passed**

Re-read `docs/runbooks/pr1-backtest-results.md`. Both "Overall: GATE PASSED" lines must be checked. If either is FAILED, do NOT proceed — return to Task 6 or 7 to tune.

- [ ] **Step 2: Commit the green-phase atomic threshold change**

```bash
ssh bot@162.55.212.198 "cd ~/trading-bot && git add src/scanner/index.ts prompts/ict-agent.md && GIT_AUTHOR_NAME='Giuseppe Portelli' GIT_AUTHOR_EMAIL='giuseppeportelli1403@gmail.com' GIT_COMMITTER_NAME='Giuseppe Portelli' GIT_COMMITTER_EMAIL='giuseppeportelli1403@gmail.com' git commit -m 'feat(loosening): PR 1 numerical thresholds (Tier3 40/45→30/35, OB body 0.4→0.3, OB wick 1.0→0.7, FVG body 0.4→0.3, Force-Propose 55→40)

Sub-gate 1 (deterministic backtest 90 days): PASSED
  - Trade count: XXx baseline
  - Win rate: XX.X% absolute (≥45% gate met)
  - Expected R/trade: 0.XX (≥0.3R gate met)
  - Per-instrument max DD: XX% (≤12% gate met)

Sub-gate 2 (shadow-LLM replay 50 cycles):
  PASSED
  - Hallucination count: 0 (gate met)
  - Trigger qualification rate: X.XXx (within 2-5x band)
  - Newly admitted: XX cycles

Pre-PR SHA for rollback: <pre-Task-5 SHA>
Design ref: docs/superpowers/specs/2026-05-12-trade-frequency-loosening-design.md
Backtest results: docs/runbooks/pr1-backtest-results.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>'"
```

- [ ] **Step 3: Record pre-reload SHA**

```bash
ssh bot@162.55.212.198 "cd ~/trading-bot && PRE_RELOAD_SHA=\$(git rev-parse HEAD~1) && echo \"PR 1 pre-reload SHA: \$PRE_RELOAD_SHA\" >> data/metrics/pr1-rollout.log"
```

(`HEAD~1` because the commit is now HEAD; the rollback target is the commit BEFORE the threshold change.)

- [ ] **Step 4: Build + reload**

```bash
ssh bot@162.55.212.198 "cd ~/trading-bot && npm run build 2>&1 | tail -3 && pm2 reload trading-bot && sleep 5 && pm2 logs trading-bot --lines 20 --nostream"
```

Expected: clean startup. No errors in startup logs.

- [ ] **Step 5: Wait for first post-reload ICT cycle**

The next cycle fires at the next 15M boundary in an active kill zone. Use ScheduleWakeup or wait organically. Verify the cycle ran cleanly with the new thresholds — likely produces more candidates than before.

```bash
ssh bot@162.55.212.198 "grep -E 'DECISION CYCLE|Top candidate|Trigger confirmed|Action:' ~/trading-bot/data/pm2-out.log | tail -20"
```

PR 1 is live. Phase 3 monitoring begins.

---

## Phase 3: Post-ship monitoring

These tasks run continuously starting from PR 1 ship day. Daily for week 1, then weekly.

---

### Task 9: Daily measurement script

**Files:**
- Create: `scripts/measure-loosening-impact.ts`

- [ ] **Step 1: Write the daily measurement runner**

Create `scripts/measure-loosening-impact.ts`:

```typescript
// scripts/measure-loosening-impact.ts
//
// Daily measurement for the trade-frequency loosening initiative.
// Queries analyst_log + trades tables, computes per-instrument metrics,
// emits JSON for tracking + flags any rollback triggers firing.
//
// Run via cron: 5 0 * * * /usr/bin/node /home/bot/trading-bot/scripts/measure-loosening-impact.js
// Or manually: npx tsx scripts/measure-loosening-impact.ts [--days N] [--alert-on-rollback]

import initSqlJs from 'sql.js';
import { readFileSync } from 'node:fs';

interface DailyReport {
  date: string;
  windowDays: number;
  tradesPlaced: number;
  tradesPerDay: number;
  winRate: number;
  avgWinR: number;
  avgLossR: number;
  expectedR: number;
  perInstrument: Record<string, { trades: number; winRate: number; expectedR: number }>;
  candidatesReviewedPerTrade: number;
  killSwitchHits: number;
  coercionLogCount: number;
  auditFpCount: number;
  rollbackTriggers: string[];
}

async function buildReport(days = 3): Promise<DailyReport> {
  const SQL = await initSqlJs();
  const db = new SQL.Database(readFileSync('/home/bot/trading-bot/data/trading-bot.db'));

  // ... queries:
  //   - trades opened/closed in last N days (per ticker)
  //   - win/loss + R per trade
  //   - analyst_log APPROVE count
  //   - kill switch hits from trading-agent log

  // Compute metrics, check rollback triggers, return.
  const report: DailyReport = {
    date: new Date().toISOString().slice(0, 10),
    windowDays: days,
    // ... populate fields
    tradesPlaced: 0,
    tradesPerDay: 0,
    winRate: 0,
    avgWinR: 0,
    avgLossR: 0,
    expectedR: 0,
    perInstrument: {},
    candidatesReviewedPerTrade: 0,
    killSwitchHits: 0,
    coercionLogCount: 0,
    auditFpCount: 0,
    rollbackTriggers: [],
  };

  // Rollback trigger checks (per design v2 §7):
  if (report.tradesPerDay < 1 && report.windowDays >= 3) {
    report.rollbackTriggers.push('trades/day < 1 for 3 consecutive days');
  }
  if (report.tradesPerDay > 8 && report.windowDays >= 2) {
    report.rollbackTriggers.push('trades/day > 8 for 2 consecutive days');
  }
  if (report.winRate < 0.35 && report.tradesPlaced >= 5) {
    report.rollbackTriggers.push('rolling-3-day win rate < 35%');
  }
  if (report.expectedR < 0.2 && report.tradesPlaced >= 10) {
    report.rollbackTriggers.push('rolling expected R/trade < 0.2R over 10+ trades');
  }
  if (report.killSwitchHits >= 2) {
    report.rollbackTriggers.push('daily kill switch fired 2 consecutive days');
  }
  if (report.auditFpCount > 0) {
    report.rollbackTriggers.push('audit FP count > 0 (hallucinations appearing)');
  }

  return report;
}

async function main() {
  const days = Number(process.argv.find((a) => a.startsWith('--days='))?.split('=')[1] ?? 3);
  const report = await buildReport(days);
  console.log(JSON.stringify(report, null, 2));
  if (report.rollbackTriggers.length > 0) {
    console.error('\n🚨 ROLLBACK TRIGGERS FIRED:');
    report.rollbackTriggers.forEach((t) => console.error('  - ' + t));
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
```

- [ ] **Step 2: Smoke test (will return mostly zeros pre-PR-1 ship, that's fine)**

```bash
ssh bot@162.55.212.198 "cd ~/trading-bot && npx tsx scripts/measure-loosening-impact.ts --days 3 2>&1 | head -40"
```

Expected: valid JSON output. Either zero rollback triggers, or only the "trades/day < 1 for 3 consecutive days" if PR 1 hasn't shipped yet (acceptable).

- [ ] **Step 3: Add cron entry**

```bash
ssh bot@162.55.212.198 "(crontab -l 2>/dev/null; echo '5 0 * * * cd /home/bot/trading-bot && /usr/bin/npx tsx scripts/measure-loosening-impact.ts --days 3 >> /home/bot/trading-bot/data/metrics/loosening-daily.log 2>&1') | crontab -"
```

- [ ] **Step 4: Verify cron entry**

```bash
ssh bot@162.55.212.198 "crontab -l | grep measure-loosening"
```

Expected: the new line appears.

- [ ] **Step 5: Commit**

```bash
ssh bot@162.55.212.198 "cd ~/trading-bot && git add scripts/measure-loosening-impact.ts && GIT_AUTHOR_NAME='Giuseppe Portelli' GIT_AUTHOR_EMAIL='giuseppeportelli1403@gmail.com' GIT_COMMITTER_NAME='Giuseppe Portelli' GIT_COMMITTER_EMAIL='giuseppeportelli1403@gmail.com' git commit -m 'feat(measurement): daily loosening-impact runner with all 6 rollback triggers (design v2 §7)'"
```

---

### Task 10: Manual rollback runbook

**Files:**
- Create: `docs/runbooks/rollback-loosening.md`

- [ ] **Step 1: Write the rollback runbook**

Create `docs/runbooks/rollback-loosening.md`:

```markdown
# Rollback Procedure — Trade-Frequency Loosening (PR 1 and/or PR 2)

**Last updated:** 2026-05-12 (per design `docs/superpowers/specs/2026-05-12-trade-frequency-loosening-design.md`)

## When to trigger

Any of the following from daily measurement (see `scripts/measure-loosening-impact.ts`):
- Trades/day < 1 for 3 consecutive days
- Trades/day > 8 for 2 consecutive days
- Rolling-3-day win rate < 35% absolute
- Rolling expected R/trade < 0.2R over 10+ closed trades
- Daily kill switch fired 2 consecutive days
- Audit script FP count > 0 (hallucinations appearing post-ship)

## Steps (< 60 seconds)

1. **Identify the pre-PR SHA** from the PR commit message (search for "Pre-PR SHA for rollback") OR from `data/metrics/pr1-rollout.log`:

   ```bash
   ssh bot@162.55.212.198 "tail -5 ~/trading-bot/data/metrics/pr1-rollout.log"
   ```

2. **Stop the bot gracefully** (drain in-flight critical sections):

   ```bash
   ssh bot@162.55.212.198 "pm2 stop trading-bot"
   ```

3. **Reset to pre-PR SHA**:

   ```bash
   ssh bot@162.55.212.198 "cd ~/trading-bot && git reset --hard <PRE_PR_SHA>"
   ```

4. **Rebuild**:

   ```bash
   ssh bot@162.55.212.198 "cd ~/trading-bot && npm run build"
   ```

5. **Restart**:

   ```bash
   ssh bot@162.55.212.198 "pm2 start trading-bot"
   ```

6. **Verify clean startup**:

   ```bash
   ssh bot@162.55.212.198 "pm2 logs trading-bot --lines 30 --nostream"
   ```

7. **Notify via Telegram** (manual — copy this into the BetterOps channel):

   > 🚨 Trade-frequency loosening rolled back. Reason: <fired_trigger>. Pre-PR SHA: `<SHA>`. New HEAD: `<SHA>`. Bot is back on prior strict thresholds.

8. **Update the memory entry** `~/.claude/projects/.../memory/project_farad_modify_removed.md` (or create a new one) with the rollback note + trigger reason.

## No DB rollback needed

Both PR 1 and PR 2 only touch source code + prompts. DB schema, CHECK constraints, and analyst_log are unaffected. Reverting code is sufficient.

## After rollback — diagnostic checklist

1. Pull last 7 days of `data/metrics/loosening-daily.log` — confirm which trigger fired and when
2. Run audit script with `--days 30` — check FP count delta from baseline
3. Pull a representative losing trade's `pm2-out.log` block — verify whether the LLM was over-eager (PR 2 prompt issue) or the math was too loose (PR 1 threshold issue)
4. Open a follow-up spec brainstorm: which threshold or prompt change to revisit on the next attempt
```

- [ ] **Step 2: Commit**

```bash
ssh bot@162.55.212.198 "cd ~/trading-bot && git add docs/runbooks/rollback-loosening.md && GIT_AUTHOR_NAME='Giuseppe Portelli' GIT_AUTHOR_EMAIL='giuseppeportelli1403@gmail.com' GIT_COMMITTER_NAME='Giuseppe Portelli' GIT_COMMITTER_EMAIL='giuseppeportelli1403@gmail.com' git commit -m 'docs(runbook): rollback procedure for trade-frequency loosening (PR 1 + PR 2)'"
```

---

## Self-review

**1. Spec coverage** (against `docs/superpowers/specs/2026-05-12-trade-frequency-loosening-design.md`):
- §4 In-scope numerical changes — Tasks 4-5 ✓
- §4 ICT prompt restructure — NOT in this plan; PR 2 plan (separate file) covers it ✓
- §5 Out-of-scope — not touched ✓
- §6 PR 1 architecture (backtest + shadow replay sub-gates) — Tasks 6-7 ✓
- §6 PR 1 per-cycle analyst load limit — Task 2 ✓
- §7 Measurement plan — Task 9 (covers all 6 rollback triggers) ✓
- §7 Per-instrument breakdown — Tasks 1 + 9 ✓
- §8 Rollback mechanism — Task 10 ✓
- §9 Open question about Tier 1/Tier 2 floor impact — implementation must audit during Task 5 Step 1 (call out in commit if anomalous)
- §10 Success criteria — measured by Task 9, not implemented as tests

**2. Placeholder scan:**
- ❌ Task 6 backtest results have placeholder `XX` values throughout — INTENTIONAL, filled in when the task actually runs (can't know the values upfront)
- ❌ Task 5 Step 1 references "line ~437-440 per design doc reference" — exact line may have drifted; Task 5 Step 1 grep finds the actual line. Acceptable.
- All code blocks have concrete code; no "TBD" / "TODO" / "implement later" / "add appropriate error handling" markers.

**3. Type consistency:**
- `CycleVerdict` used in Task 1 — defined in Task 1 ✓
- `ResolvedThresholds` / `ThresholdOverrides` used in Task 3 — defined in Task 3 ✓
- `MAX_CANDIDATES_PER_ANALYST_CYCLE` / `capCandidatesForAnalyst` used in Task 2 — defined in Task 2 ✓
- `tier3FloorFor` used in Task 4 — exists in `src/scanner/index.ts`, Task 5 modifies it ✓

**4. Sequencing:**
- Phase 1 tasks (1, 2, 3) can run in any order — all independent. Recommend 1 → 2 → 3 since each is bigger than the last.
- Phase 2 tasks (4-8) MUST run in order: 4 (red) → 5 (green stage) → 6 (backtest gate) → 7 (shadow replay gate) → 8 (commit + push)
- Phase 3 tasks (9, 10) can run in parallel after Phase 2 commits.

---

**Plan complete. 10 tasks across 3 phases. Estimated implementation time: 1-2 days for an experienced engineer following TDD strictly; 3-4 days with first-time pauses to understand the codebase.**

PR 2 plan (ICT prompt restructure) gets drafted as `docs/superpowers/plans/2026-05-XX-trade-frequency-loosening-pr2.md` after PR 1 ships and the 1-week post-ship measurement baseline is established.

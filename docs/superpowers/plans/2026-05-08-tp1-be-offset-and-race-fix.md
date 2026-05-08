# TP1 → SL→BE+offset + Race-Window Reduction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the GOLD-class bug where TP1's SL→BE amend was silently no-op'd by a race against fast TP2 fills, and replace exact-entry SL with `entry ± max(0.1R, 2× typical_spread)` so a stopped runner locks in a small profit instead of zero.

**Architecture:** Three coordinated changes in a single PR — (1) a `typicalSpread()` helper in `src/backtest/realism.ts` exposed for runtime use; (2) an `applied: boolean` field on `DealConfirmation` set distinctly on synthetic-skip vs real-PUT paths in `src/mcp-server/capital-client.ts` so callers can log the difference; (3) `handleTp1Hit` in `src/scheduler/index.ts` consumes both — computes the floored offset and branches its log on `confirmation.applied`. Cron cadence drops from `*/5` to `*/1` since Codex audit confirmed no hard 5-minute coupling. TDD throughout. All assertions cite specific values.

**Tech Stack:** TypeScript, Node 20.20.2, vitest 4.1.4, node-cron, Capital.com REST API.

---

## File map

- **Modify:** `src/backtest/realism.ts` — export `typicalSpread(instrument: string): number` derived from existing `EXECUTION_COSTS`
- **Modify:** `src/mcp-server/capital-client.ts` — augment `DealConfirmation` with `applied?: boolean`; set on 3 paths (`safelyAmendPosition` synthetic, `updatePosition` synthetic, `updatePosition` real-PUT wrap)
- **Modify:** `src/scheduler/index.ts` — add `computeBeStop` helper; rewire `handleTp1Hit` and `handleTp2Hit`; flip monitor cron string
- **Create:** `tests/scheduler-tp1-be-offset.test.ts` — new isolated test file for the offset/race-skip behaviour
- **Modify:** `tests/scheduler.test.ts` — update existing 2-leg TP1-hit case to assert the new `beStop` value
- **Modify:** `tests/capital-client.test.ts` — add `applied` field assertions for all 3 paths
- **Modify:** `tests/realism.test.ts` — add `typicalSpread` helper test

---

## Task 1: `typicalSpread()` helper in `src/backtest/realism.ts`

**Files:**
- Modify: `src/backtest/realism.ts`
- Test: `tests/realism.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/realism.test.ts`:

```ts
import { typicalSpread } from '../src/backtest/realism.js';

describe('typicalSpread', () => {
  it('returns native-price spread for known instruments', () => {
    expect(typicalSpread('EURUSD')).toBe(0.00008);
    expect(typicalSpread('GOLD')).toBe(0.40);
    expect(typicalSpread('SILVER')).toBe(0.025);
  });

  it('returns a sensible default for unknown instruments', () => {
    expect(typicalSpread('UNKNOWN_TICKER')).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
npx vitest run tests/realism.test.ts -t 'typicalSpread'
```
Expected: FAIL — `typicalSpread is not a function` or `typicalSpread is not exported`.

- [ ] **Step 3: Implement the helper**

In `src/backtest/realism.ts`, append below the `EXECUTION_COSTS` definition:

```ts
/**
 * Returns the typical bid-ask spread in native price units for an instrument.
 * Falls back to GOLD's spread for unknown tickers (medium-volatility default —
 * conservative for FX, lenient for tight commodities). Caller should still
 * validate ticker upstream; this helper is a safe runtime fallback for the
 * scheduler's BE-offset floor calculation.
 */
export function typicalSpread(instrument: string): number {
  const costs = EXECUTION_COSTS[instrument];
  if (costs) return costs.spread;
  return EXECUTION_COSTS.GOLD.spread;
}
```

- [ ] **Step 4: Run test to verify it passes**

```
npx vitest run tests/realism.test.ts -t 'typicalSpread'
```
Expected: PASS, both cases.

- [ ] **Step 5: Commit**

```
git add src/backtest/realism.ts tests/realism.test.ts
git commit -m "feat(realism): export typicalSpread() helper for runtime spread lookups"
```

---

## Task 2: `applied: boolean` on `safelyAmendPosition` synthetic skip path

**Files:**
- Modify: `src/mcp-server/capital-client.ts` (`DealConfirmation` interface + `safelyAmendPosition` synthetic at ~line 412)
- Test: `tests/capital-client.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/capital-client.test.ts`:

```ts
describe('safelyAmendPosition — applied flag', () => {
  it('returns applied:false on race-skip (position already closed before GET)', async () => {
    const fakeClient = makeClientWithGetThrowing(closedError());
    const result = await fakeClient.safelyAmendPosition('dealX', { stopLevel: 100 });
    expect(result.applied).toBe(false);
    expect(result.dealReference).toMatch(/^synthetic-amend-skipped-/);
    // Legacy fields preserved for backwards compat with MCP tools:
    expect(result.dealStatus).toBe('ACCEPTED');
    expect(result.status).toBe('FULLY_CLOSED');
  });
});
```

(`makeClientWithGetThrowing` and `closedError` are existing helpers in `tests/capital-client.test.ts`. If they don't exist, mirror the pattern used by adjacent tests in the same file — read the top 30 lines of the file to confirm the existing fixture style before writing the test.)

- [ ] **Step 2: Run test to verify it fails**

```
npx vitest run tests/capital-client.test.ts -t 'applied flag'
```
Expected: FAIL — `expect(result.applied).toBe(false)` because `applied` is undefined on the current synthetic.

- [ ] **Step 3: Update interface and synthetic**

In `src/mcp-server/capital-client.ts`:

(a) Add `applied?: boolean` to the `DealConfirmation` interface (or wherever the type is declared). Search for `dealStatus:` in the file to find the type declaration. Add the field as **optional** so existing call sites that build their own `DealConfirmation`-shaped objects (none currently, but defensive) don't need updates.

(b) Update the `safelyAmendPosition` synthetic at the race-skip branch (~line 412 — search for `synthetic-amend-skipped-`). Add `applied: false`:

```ts
const synthetic: DealConfirmation = {
  dealId,
  dealReference: `synthetic-amend-skipped-${dealId}`,
  dealStatus: 'ACCEPTED',
  reason: 'POSITION_ALREADY_CLOSED_BY_BROKER',
  status: 'FULLY_CLOSED',
  direction: 'BUY',
  epic: '',
  size: 0,
  level: 0,
  stopLevel: null,
  profitLevel: null,
  affectedDeals: [{ dealId, status: 'DELETED' }],
  applied: false, // NEW — race-skip marker for caller logging
};
return synthetic;
```

- [ ] **Step 4: Run test to verify it passes**

```
npx vitest run tests/capital-client.test.ts -t 'applied flag'
```
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/mcp-server/capital-client.ts tests/capital-client.test.ts
git commit -m "feat(capital): add applied:boolean to DealConfirmation; safelyAmendPosition synthetic returns applied:false on race"
```

---

## Task 3: `applied: false` on `updatePosition` synthetic + `applied: true` on real PUT

**Files:**
- Modify: `src/mcp-server/capital-client.ts` (`updatePosition` synthetic at ~line 473 + real PUT wrap at ~line 465)
- Test: `tests/capital-client.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/capital-client.test.ts`:

```ts
describe('updatePosition — applied flag', () => {
  it('returns applied:true on a real successful PUT', async () => {
    const fakeClient = makeClientWithSuccessfulPut(); // existing test fixture
    const result = await fakeClient.updatePosition('dealOk', { stopLevel: 1.1 });
    expect(result.applied).toBe(true);
  });

  it('returns applied:false when broker reports already-closed mid-PUT', async () => {
    const fakeClient = makeClientWithPutThrowing(closedError());
    const result = await fakeClient.updatePosition('dealClosed', { stopLevel: 1.1 });
    expect(result.applied).toBe(false);
    expect(result.dealReference).toMatch(/^synthetic-update-skipped-/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
npx vitest run tests/capital-client.test.ts -t 'updatePosition — applied flag'
```
Expected: FAIL — both cases (`applied` is undefined in current code on both paths).

- [ ] **Step 3: Wrap real PUT and tag synthetic**

In `src/mcp-server/capital-client.ts`:

(a) `updatePosition` real PUT path (~line 465 — currently `return this.pollDealConfirmation(...)`):

Change from:
```ts
return await this.pollDealConfirmation(response.data.dealReference);
```
to:
```ts
const confirmation = await this.pollDealConfirmation(response.data.dealReference);
return { ...confirmation, applied: true };
```

(b) `updatePosition` synthetic skip path (~line 473 — search for `synthetic-update-skipped-`). Add `applied: false`:

```ts
const synthetic: DealConfirmation = {
  dealId,
  dealReference: `synthetic-update-skipped-${dealId}`,
  // ... existing fields ...
  applied: false, // NEW
};
return synthetic;
```

- [ ] **Step 4: Run test to verify it passes**

```
npx vitest run tests/capital-client.test.ts -t 'updatePosition — applied flag'
```
Expected: PASS, both cases.

- [ ] **Step 5: Commit**

```
git add src/mcp-server/capital-client.ts tests/capital-client.test.ts
git commit -m "feat(capital): updatePosition tags applied:true on real PUT, applied:false on race-skip"
```

---

## Task 4: `computeBeStop()` helper for `handleTp1Hit`

**Files:**
- Modify: `src/scheduler/index.ts` (new helper near `handleTp1Hit`)
- Test: `tests/scheduler-tp1-be-offset.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/scheduler-tp1-be-offset.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { computeBeStop } from '../src/scheduler/index.js';

describe('computeBeStop', () => {
  it('long: entry + 0.1R when 0.1R > 2×spread (GOLD R=12.54)', () => {
    const beStop = computeBeStop({
      direction: 'long', entry: 4735.54, sl: 4723, instrument: 'GOLD',
    });
    // R = 12.54, 0.1R = 1.254, 2×spread = 0.80 → 0.1R wins
    expect(beStop).toBeCloseTo(4736.794, 3);
  });

  it('short: entry − 0.1R when 0.1R > 2×spread', () => {
    const beStop = computeBeStop({
      direction: 'short', entry: 4735.54, sl: 4748.08, instrument: 'GOLD',
    });
    expect(beStop).toBeCloseTo(4734.286, 3); // 4735.54 - 1.254
  });

  it('small-R FX long: spread floor wins over 0.1R (EURUSD R=5pips)', () => {
    const beStop = computeBeStop({
      direction: 'long', entry: 1.10000, sl: 1.09995, instrument: 'EURUSD',
    });
    // R = 0.00005, 0.1R = 0.000005, 2×spread = 0.00016 → spread floor wins
    expect(beStop).toBeCloseTo(1.10016, 5);
  });

  it('small-R FX short: spread floor in opposite direction', () => {
    const beStop = computeBeStop({
      direction: 'short', entry: 1.10000, sl: 1.10005, instrument: 'EURUSD',
    });
    expect(beStop).toBeCloseTo(1.09984, 5); // 1.10000 - 0.00016
  });

  it('zero-R defensive: returns entry exactly and warns', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const beStop = computeBeStop({
      direction: 'long', entry: 100, sl: 100, instrument: 'GOLD',
    });
    expect(beStop).toBe(100);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('zero R'),
    );
    warnSpy.mockRestore();
  });

  it('invariant sweep: 5 instruments × 2 directions, beStop respects sign', () => {
    const cases: Array<{ inst: string; entry: number; sl: number; }> = [
      { inst: 'EURUSD', entry: 1.10, sl: 1.099 },
      { inst: 'GBPUSD', entry: 1.27, sl: 1.268 },
      { inst: 'GOLD',   entry: 4735, sl: 4723  },
      { inst: 'SILVER', entry: 78.88, sl: 78.03 },
      { inst: 'OIL_CRUDE', entry: 75.0, sl: 74.5 },
    ];
    for (const { inst, entry, sl } of cases) {
      const long  = computeBeStop({ direction: 'long',  entry, sl, instrument: inst });
      const short = computeBeStop({ direction: 'short', entry, sl: 2*entry - sl, instrument: inst });
      expect(long).toBeGreaterThan(entry);
      expect(short).toBeLessThan(entry);
    }
  });
});
```

Add `import { vi } from 'vitest'` at the top.

- [ ] **Step 2: Run test to verify it fails**

```
npx vitest run tests/scheduler-tp1-be-offset.test.ts -t 'computeBeStop'
```
Expected: FAIL — `computeBeStop is not exported from src/scheduler/index.js`.

- [ ] **Step 3: Implement `computeBeStop`**

In `src/scheduler/index.ts`, add this **above** `handleTp1Hit`, and **export** it:

```ts
import { typicalSpread } from '../backtest/realism.js';

/**
 * Computes the SL value to amend a runner leg to on TP1 fill.
 * Returns entry ± max(0.1R, 2 × typicalSpread(instrument)), signed by direction.
 * The spread floor guards against the SL landing inside the bid-ask on
 * unusually small-R FX trades (e.g. EURUSD with a 5-pip stop). Falls back to
 * exact entry with a warning if R is zero (data integrity guard).
 */
export function computeBeStop(args: {
  direction: 'long' | 'short';
  entry: number;
  sl: number;
  instrument: string;
}): number {
  const { direction, entry, sl, instrument } = args;
  const r = Math.abs(entry - sl);
  if (r === 0) {
    console.warn(
      `[computeBeStop] ${instrument} has zero R (entry=sl=${entry}); falling back to exact entry`,
    );
    return entry;
  }
  const spreadFloor = 2 * typicalSpread(instrument);
  const offset = Math.max(0.1 * r, spreadFloor);
  const sign = direction === 'long' ? +1 : -1;
  return entry + sign * offset;
}
```

- [ ] **Step 4: Run test to verify it passes**

```
npx vitest run tests/scheduler-tp1-be-offset.test.ts -t 'computeBeStop'
```
Expected: PASS, all 6 cases.

- [ ] **Step 5: Commit**

```
git add src/scheduler/index.ts tests/scheduler-tp1-be-offset.test.ts
git commit -m "feat(scheduler): add computeBeStop helper with spread-floor offset"
```

---

## Task 5: Wire `computeBeStop` + applied-aware logging into `handleTp1Hit`

**Files:**
- Modify: `src/scheduler/index.ts` (`handleTp1Hit` body)
- Test: `tests/scheduler-tp1-be-offset.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/scheduler-tp1-be-offset.test.ts`:

```ts
import { handleTp1Hit } from '../src/scheduler/index.js';
import type { TradeRecord } from '../src/types.js';

const makeTrade = (over: Partial<TradeRecord> = {}): TradeRecord => ({
  id: 'trade-test', strategy_tag: 'ICT_INTRADAY', instrument: 'GOLD',
  instrument_category: 'commodity', direction: 'long', setup_type: 'OB_retest',
  entry: 4735.54, sl: 4723, tp1: 4748.08, tp2: 4751.84, tp3: null,
  position_a_id: 'A', position_b_id: 'B', position_c_id: null,
  size_a: 0.56, size_b: 0.24, size_c: null,
  status: 'open',
  pnl_a: null, pnl_b: null, pnl_c: null, pnl_total: null,
  composite_score: 65, kill_zone: 'NY Open',
  news_category: null, analyst_decision: 'APPROVE', reasoning: '',
  closure_reason: null, opened_at: '2026-05-08T13:00:00Z', closed_at: null,
  ...over,
});

const makeDeps = (amendResult: 'applied' | 'skipped') => {
  const calls: Array<{ dealId: string; changes: any }> = [];
  return {
    calls,
    capital: {
      safelyAmendPosition: vi.fn(async (dealId: string, changes: any) => {
        calls.push({ dealId, changes });
        if (amendResult === 'applied') return { applied: true, dealStatus: 'ACCEPTED' } as any;
        return { applied: false, dealReference: `synthetic-amend-skipped-${dealId}` } as any;
      }),
    } as any,
    updateTradeStatus: vi.fn(),
    deactivateSlTpOrder: vi.fn(),
    alertTp1Hit: vi.fn(async () => {}),
  };
};

describe('handleTp1Hit — offset + applied logging', () => {
  it('long 2-leg: amends Leg B SL to entry + max(0.1R, 2×spread); logs "applied"', async () => {
    const trade = makeTrade();
    const deps = makeDeps('applied');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await handleTp1Hit(trade, trade.id, deps as any);
    expect(deps.calls).toHaveLength(1);
    expect(deps.calls[0].dealId).toBe('B');
    expect(deps.calls[0].changes.stopLevel).toBeCloseTo(4736.794, 3);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\[TP1\] GOLD .* applied/),
    );
    logSpy.mockRestore();
  });

  it('short 2-leg: SL goes BELOW entry by floored offset', async () => {
    const trade = makeTrade({ direction: 'short', entry: 4735.54, sl: 4748.08, tp1: 4723, tp2: 4719 });
    const deps = makeDeps('applied');
    await handleTp1Hit(trade, trade.id, deps as any);
    expect(deps.calls[0].changes.stopLevel).toBeCloseTo(4734.286, 3);
  });

  it('3-leg long: BOTH Leg B and Leg C amended with the same offset', async () => {
    const trade = makeTrade({ position_c_id: 'C', tp3: 4760, size_c: 0.1 });
    const deps = makeDeps('applied');
    await handleTp1Hit(trade, trade.id, deps as any);
    expect(deps.calls).toHaveLength(2);
    expect(deps.calls[0].dealId).toBe('B');
    expect(deps.calls[1].dealId).toBe('C');
    expect(deps.calls[0].changes.stopLevel).toBeCloseTo(4736.794, 3);
    expect(deps.calls[1].changes.stopLevel).toBeCloseTo(4736.794, 3);
  });

  it('race-skip: status flips to tp1_hit; "skipped" log fires; no throw', async () => {
    const trade = makeTrade();
    const deps = makeDeps('skipped');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await handleTp1Hit(trade, trade.id, deps as any);
    expect(deps.updateTradeStatus).toHaveBeenCalledWith(trade.id, 'tp1_hit');
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\[TP1\] GOLD .* skipped \(race against fast TP fill\)/),
    );
    logSpy.mockRestore();
  });

  it('undefined applied defaults to "applied" log (defensive against future callers that forget the field)', async () => {
    const trade = makeTrade();
    const deps = {
      ...makeDeps('applied'),
      capital: {
        safelyAmendPosition: vi.fn(async () => ({ /* no applied field */ dealStatus: 'ACCEPTED' } as any)),
      } as any,
    };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await handleTp1Hit(trade, trade.id, deps as any);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringMatching(/applied/),
    );
    expect(logSpy).not.toHaveBeenCalledWith(
      expect.stringMatching(/skipped/),
    );
    logSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```
npx vitest run tests/scheduler-tp1-be-offset.test.ts -t 'handleTp1Hit — offset'
```
Expected: FAIL — current `handleTp1Hit` uses `trade.entry` exact, log doesn't say `applied`/`skipped`.

- [ ] **Step 3: Rewire `handleTp1Hit`**

In `src/scheduler/index.ts`, replace the `handleTp1Hit` body (the current Leg B + Leg C amend blocks). Replace:

```ts
if (trade.position_b_id) {
  try {
    await d.capital.safelyAmendPosition(trade.position_b_id, { stopLevel: trade.entry });
    console.log(`[TP1] ${trade.instrument} — Position B SL→BE (${trade.entry})`);
  } catch (error) {
    console.error(`[TP1] Failed to move Position B SL to BE for ${tradeId}: ${summarizeError(error)}`);
  }
}

if (trade.position_c_id) {
  try {
    await d.capital.safelyAmendPosition(trade.position_c_id, { stopLevel: trade.entry });
    console.log(`[TP1] ${trade.instrument} — Position C SL→BE (${trade.entry})`);
  } catch (error) {
    console.error(`[TP1] Failed to move Position C SL to BE for ${tradeId}: ${summarizeError(error)}`);
  }
}
```

with:

```ts
const beStop = computeBeStop({
  direction: trade.direction,
  entry: trade.entry,
  sl: trade.sl,
  instrument: trade.instrument,
});

const moveLegSlToBe = async (leg: 'B' | 'C', dealId: string) => {
  try {
    const result = await d.capital.safelyAmendPosition(dealId, { stopLevel: beStop });
    // applied===false explicitly means race-skip; undefined falls through as
    // "applied" (defensive default — covers any future code path that forgets
    // to tag the response).
    if (result?.applied === false) {
      console.log(
        `[TP1] ${trade.instrument} — Position ${leg} SL→${beStop.toFixed(5)} skipped (race against fast TP fill)`,
      );
    } else {
      console.log(
        `[TP1] ${trade.instrument} — Position ${leg} SL→${beStop.toFixed(5)} applied`,
      );
    }
  } catch (error) {
    console.error(
      `[TP1] Failed to move Position ${leg} SL for ${tradeId}: ${summarizeError(error)}`,
    );
  }
};

if (trade.position_b_id) await moveLegSlToBe('B', trade.position_b_id);
if (trade.position_c_id) await moveLegSlToBe('C', trade.position_c_id);
```

- [ ] **Step 4: Run tests to verify they pass**

```
npx vitest run tests/scheduler-tp1-be-offset.test.ts -t 'handleTp1Hit — offset'
```
Expected: PASS, all 5 cases.

- [ ] **Step 5: Commit**

```
git add src/scheduler/index.ts tests/scheduler-tp1-be-offset.test.ts
git commit -m "feat(scheduler): handleTp1Hit uses computeBeStop + applied-aware logging"
```

---

## Task 6: applied-aware logging in `handleTp2Hit` (3-leg trail)

**Files:**
- Modify: `src/scheduler/index.ts` (`handleTp2Hit` body — 3-leg branch only)
- Test: `tests/scheduler-tp1-be-offset.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/scheduler-tp1-be-offset.test.ts`:

```ts
import { handleTp2Hit } from '../src/scheduler/index.js';

describe('handleTp2Hit — applied logging on 3-leg trail', () => {
  it('logs "applied" when amend succeeds', async () => {
    const trade = makeTrade({ position_c_id: 'C', tp3: 4760, size_c: 0.1 });
    const deps = makeDeps('applied');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await handleTp2Hit(trade, trade.id, { ...deps, alertTp2Hit: vi.fn(async () => {}) } as any);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\[TP2\] GOLD .* applied/),
    );
    logSpy.mockRestore();
  });

  it('logs "skipped" when amend race-skipped', async () => {
    const trade = makeTrade({ position_c_id: 'C', tp3: 4760, size_c: 0.1 });
    const deps = makeDeps('skipped');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await handleTp2Hit(trade, trade.id, { ...deps, alertTp2Hit: vi.fn(async () => {}) } as any);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\[TP2\] GOLD .* skipped \(race against fast TP fill\)/),
    );
    logSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```
npx vitest run tests/scheduler-tp1-be-offset.test.ts -t 'handleTp2Hit — applied logging'
```
Expected: FAIL — current log doesn't differentiate applied vs skipped.

- [ ] **Step 3: Modify `handleTp2Hit`**

In `src/scheduler/index.ts`, in the 3-leg branch of `handleTp2Hit` (the block after `if (!trade.position_c_id) { … return; }` — search for `safelyAmendPosition(trade.position_c_id, { stopLevel: trade.tp1 })`), replace:

```ts
try {
  await d.capital.safelyAmendPosition(trade.position_c_id, { stopLevel: trade.tp1 });
  console.log(`[TP2] ${trade.instrument} — Position C SL→TP1 trailing (${trade.tp1})`);
} catch (error) {
  console.error(`[TP2] Failed to trail Position C SL to TP1 for ${tradeId}: ${summarizeError(error)}`);
}
```

with:

```ts
try {
  const result = await d.capital.safelyAmendPosition(trade.position_c_id, { stopLevel: trade.tp1 });
  if (result?.applied === false) {
    console.log(
      `[TP2] ${trade.instrument} — Position C SL→TP1 (${trade.tp1}) skipped (race against fast TP fill)`,
    );
  } else {
    console.log(
      `[TP2] ${trade.instrument} — Position C SL→TP1 (${trade.tp1}) applied`,
    );
  }
} catch (error) {
  console.error(`[TP2] Failed to trail Position C SL to TP1 for ${tradeId}: ${summarizeError(error)}`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```
npx vitest run tests/scheduler-tp1-be-offset.test.ts -t 'handleTp2Hit — applied logging'
```
Expected: PASS, both cases.

- [ ] **Step 5: Commit**

```
git add src/scheduler/index.ts tests/scheduler-tp1-be-offset.test.ts
git commit -m "feat(scheduler): handleTp2Hit applied-aware logging for 3-leg trail (parity with handleTp1Hit)"
```

---

## Task 7: Update existing `tests/scheduler.test.ts` 2-leg TP1-hit case

**Files:**
- Modify: `tests/scheduler.test.ts`

- [ ] **Step 1: Find the existing case**

```
grep -n 'tp1_hit\|handleTp1Hit\|stopLevel.*entry' tests/scheduler.test.ts
```
The Phase 2 plan added a 2-leg TP1-hit case asserting `stopLevel === trade.entry`. We need to update that single assertion.

- [ ] **Step 2: Update the assertion**

Find the line that asserts `expect(...).toBe(trade.entry)` (or similar — check by reading the test) inside the 2-leg `handleTp1Hit` test. Replace it with:

```ts
// Phase 2 → 2026-05-08 fix: SL moves to entry + max(0.1R, 2×spread), not exact entry.
const r = Math.abs(trade.entry - trade.sl);
const expectedOffset = Math.max(0.1 * r, 2 * /* GOLD spread */ 0.40);
expect(amendCall.changes.stopLevel).toBeCloseTo(trade.entry + expectedOffset, 5);
```

(Adjust `/* GOLD spread */ 0.40` to match the trade's instrument in that specific test case — read its `makeTrade` setup first.)

- [ ] **Step 3: Run the test to verify it passes**

```
npx vitest run tests/scheduler.test.ts
```
Expected: PASS, no regressions in other scheduler tests.

- [ ] **Step 4: Commit**

```
git add tests/scheduler.test.ts
git commit -m "test(scheduler): update Phase 2 TP1-hit case to expect floored BE offset"
```

---

## Task 8: Change monitor cron from `*/5` to `*/1` (and update startup banner)

**Files:**
- Modify: `src/scheduler/index.ts` (cron registration at **line 863**, startup banner at **line 997**)

- [ ] **Step 1: Verify candle-gating already protects against over-fire**

```
sed -n '130,150p' src/scheduler/index.ts
sed -n '855,875p' src/scheduler/index.ts
```

Confirm:
- The 15m + 1h candle window checks at **lines 134-148** still exist (`if (candleKey !== last15mCandle && now.getUTCMinutes() % 15 < 5)` and the 1h equivalent at line 147). These ensure the candle-driven path only fires once per candle close, regardless of how often the cron ticks.
- The `monitorRunning` overlap guard at **lines 859-872** still exists (`let monitorRunning = false;` followed by the `if (!monitorRunning) { ... } else console.warn(...)` pattern).

If either is missing, **stop and report** — the Codex audit's assumption is invalidated and the cron change needs re-design.

- [ ] **Step 2: Change the cron string at line 863**

```
sed -n '861,872p' src/scheduler/index.ts
```

You should see:
```ts
  cron.schedule('*/5 * * * *', async () => {
    if (!monitorRunning) {
      ...
```

Change `'*/5 * * * *'` to `'*/1 * * * *'`. Single string replacement, no other changes in this block.

- [ ] **Step 3: Update the startup banner at line 997**

```
sed -n '995,1000p' src/scheduler/index.ts
```

You should see:
```ts
  console.log('  */5 * * * *           — Split-position monitor + candle detection → ICT Agent');
```

Change to:
```ts
  console.log('  */1 * * * *           — Split-position monitor (every minute) + 15m/1h candle detection → ICT Agent');
```

The banner is cosmetic but operationally important — Giuseppe reads it on every startup to verify the schedule.

- [ ] **Step 4: Run the full scheduler test suite**

```
npx vitest run tests/scheduler.test.ts tests/scheduler-tp1-be-offset.test.ts
```
Expected: PASS, no regressions.

- [ ] **Step 5: Commit**

```
git add src/scheduler/index.ts
git commit -m "perf(scheduler): split-position monitor cron */5 → */1 (cuts race window 5×)"
```

---

## Task 9: Full test suite + typecheck

**Files:** none

- [ ] **Step 1: Run all tests**

```
npm test
```
Expected: All tests pass (current master baseline 774 + ~10 new = ~784). Baseline updated 2026-05-08 12:15 UTC after parallel-session merge of post-demo cleanup + Tier 0 close-reason fix + log_trade self-heal at master commit `c23309f`.

- [ ] **Step 2: Run TypeScript typecheck**

```
npx tsc --noEmit
```
Expected: zero errors. Verifies the existing 4 `safelyAmendPosition` callers still typecheck after the `applied` field addition.

- [ ] **Step 3: If anything fails — STOP**

Do not commit broken tests / typecheck failures. Report the failure verbatim and re-enter Phase 1 of `superpowers:systematic-debugging`.

---

## Task 10: Backtest sanity gate

**Files:** none

- [ ] **Step 1: Run cache-only backtest**

```
ssh bot@162.55.212.198 "cd /home/bot/trading-bot && npx tsx scripts/run-backtest.ts --start 2024 --end 2025 --tickers EURUSD,GBPUSD,GOLD,AUDUSD,OIL_CRUDE"
```

(Local can also run this if the cache is mirrored. VPS is faster + closer to the cache file.)

- [ ] **Step 2: Verify PF gate**

Look at the printed `PF` (Profit Factor) line in the output. Compare to baseline 0.61 from the Phase 2 spec.

Pass: `PF >= 0.61`.
Fail: `PF < 0.61` — investigate; the offset shouldn't regress PF, only marginally improve it.

- [ ] **Step 3: Save the result for the record**

If pass, append the JSON output path to the spec's tests-and-verification-gates section:

```
git add docs/superpowers/specs/2026-05-08-tp1-be-offset-and-race-fix-design.md
git commit -m "docs(spec): record backtest PF result post-fix"
```

(If the result is already at `backtest-results/<date>.json` and is gitignored — that's fine, just note in the commit message. No file commit needed.)

---

## Task 11: Push to master and verify live

**Files:** none

- [ ] **Step 1: Push**

```
git push origin master
```

- [ ] **Step 2: Wait for GitHub Actions to deploy**

```
gh run watch
```

(If `gh` not configured, watch the deploy log: `ssh bot@162.55.212.198 "tail -F /home/bot/deploy.log"` and Ctrl-C when done.)

- [ ] **Step 3: Verify pm2 status and monitor cadence**

```
ssh bot@162.55.212.198 "pm2 status && pm2 logs trading-bot --lines 30 --nostream"
```

Verify:
- pm2 status `online`, no error spike
- Recent logs show `[Scheduler] RSS news poll complete.` or split-position monitor activity at every minute mark, not every 5 minutes
- No new entries in `pm2-err.log` post-deploy beyond the existing Telegram Markdown noise

- [ ] **Step 4: Smoke test the next live trade (passive)**

When the bot opens its next trade, watch for:
- `[TP1] <INST> — Position B SL→<value> applied` (or `skipped` if races still happen)
- The `<value>` should be `entry + 0.1R` for normal-R trades, or `entry + 2×spread` for tight-R FX

No active code change here — just observation. If the first live trade behaves correctly, fix is verified.

---

## Self-review

**Spec coverage check:**
- [x] Q1 BE target with spread floor → Tasks 1, 4, 5 (helper, math, wiring)
- [x] Q2 cron `*/5` → `*/1` → Task 8
- [x] Q3 `applied: boolean` on all 3 paths → Tasks 2, 3
- [x] `handleTp1Hit` 2-leg + 3-leg → Tasks 4, 5
- [x] `handleTp2Hit` applied logging → Task 6
- [x] Existing test update → Task 7
- [x] Test gaps from Codex audit (real PUT applied:true, undefined applied default, zero-R, small-R FX) → Tasks 3, 4, 5
- [x] Backtest PF gate → Task 10
- [x] Live smoke → Task 11
- [x] Backwards compatibility note (4 untouched callers) → covered by Task 9 typecheck gate

**Placeholder scan:** none. Every step has exact file paths, exact commands, exact code or exact assertions.

**Type/method consistency:**
- `computeBeStop` signature: `(args: { direction, entry, sl, instrument })` — used identically in Task 4 (definition) and Task 5 (call site).
- `DealConfirmation.applied?: boolean` — declared in Task 2, set in Tasks 2 and 3, read in Tasks 5 and 6.
- `typicalSpread(instrument: string): number` — declared in Task 1, used in Task 4.
- `handleTp1Hit`, `handleTp2Hit`, `MonitorDeps` — names match across tasks.

No drift detected.

---

## Appendix: post-deploy operations checklist (NOT part of the TDD flow)

These three items came from a parallel session at master commit `c23309f` and are tracked here so they're not lost. Each is operational/diagnostic and does NOT belong in the TDD task chain — handle them outside this plan.

### A1 — systemd Node-22 service repoint (REQUIRES SUDO)

The VPS pm2 daemon is now Node 22.22.2 (nvm-managed), but `/etc/systemd/system/pm2-bot.service` still points at `/usr/lib/node_modules/pm2/bin/pm2`. On reboot, systemd would resurrect under Node 20 silently. To repoint:

```
ssh bot@162.55.212.198
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use default
sudo env PATH=$PATH:/home/bot/.nvm/versions/node/v22.22.2/bin \
  /home/bot/.nvm/versions/node/v22.22.2/lib/node_modules/pm2/bin/pm2 \
  startup systemd -u bot --hp /home/bot
```

Then run the `sudo` line pm2 prints. Verify with:
```
cat /etc/systemd/system/pm2-bot.service | grep ExecStart
```
Expect path to start with `/home/bot/.nvm/...` (NOT `/usr/lib/node_modules/...`). Run this **whenever you have sudo on the VPS**; it's a one-shot, not blocked by anything in this plan.

### A2 — ICT Agent 8-iteration cycle timeouts

Pre-existing intermittent issue, fired 3× on 2026-05-08 (08:16, 08:47, 09:01 UTC). Symptom in `pm2-err.log`:

```
[ICT Agent] CYCLE TIMED OUT after 8 iterations without end_turn.
```

NOT part of this fix. After this plan ships, recommended next steps via a fresh `superpowers:brainstorming` session:
1. Reproduce by running the ICT cycle with verbose tool-call logging (instrument `src/agents/trading-agent.ts` to log `<iteration>: <tool_name>` per loop).
2. Inspect logs from the 3 timeout cycles to identify which tool fires N times.
3. Either (a) raise the cap, (b) add a forced-decide terminal in the prompt, or (c) gate a specific tool call to fire at most once per cycle.

### A3 — Anthropic API credit balance check

Was $15.98 on 2026-05-04. Burn rate ~$0.50–2/day → expect ~$5-10 remaining as of 2026-05-08. Auto-reload disabled. When balance hits $0, the bot hard-stops silently with no alert.

```
# Quick balance check via API (adjust if Anthropic console has changed):
curl -sH "x-api-key: $ANTHROPIC_API_KEY" https://api.anthropic.com/v1/organizations/usage | jq '.balance'
```

Or via the Anthropic console at console.anthropic.com → Billing → Credits. Top up if < $5.

---

## Appendix: parallel-session changes folded into the baseline

This plan was originally drafted against master commit `a742669`. Re-verified against `c23309f` on 2026-05-08 12:15 UTC. Diff scope between the two:

- `src/scheduler/index.ts` — 134 lines added, but only in `classifyCloseReason` (Tier 0 source-field check, lines ~194-244) and `pingKeepAlive` (3-strike alert threshold, lines ~618-712). **Neither touches `handleTp1Hit`, `handleTp2Hit`, or the cron registration.** All Task 4-8 line citations re-verified above.
- `src/mcp-server/capital-client.ts` — unchanged. Tasks 2 + 3 unaffected.
- `src/backtest/realism.ts` — unchanged. Task 1 unaffected.
- `tests/scheduler.test.ts` — 246 lines of changes (likely new fixtures for the Tier 0 + ping changes). Task 7's assertion-update step still applies because the 2-leg TP1-hit case from the Phase 2 plan should still exist; just `grep -n` to find it instead of relying on a fixed line number.

No design changes needed. Implementation proceeds against `c23309f` as the working base.

// Tests for the backtest engine rewrite (Phase B, 2026-05-04 audit Finding #3).
//
// Pre-fix the engine implemented the 2026-04-22 obsolete strategy:
//   - TP ladder used the old 2R/3R/4R numbers (current ladder is 2-leg:
//     TP1 ≥ 1R, TP2 ≥ 1.3R per the 2026-05-07 Phase-2 restructure)
//   - Tier 3 floor=50 (current: 40 post-Phase-E; was 45 post-Phase-B)
//   - Bias clarity scale 0/10/20 (current rubric: 0/15/20/25)
//   - Kill zone as score component +15/+5 (current: hard gate, not scored)
//   - No range-mode path (skipped neutral bias entirely)
//   - getKillZone had London Close starting 15:00, overlapping NY Open 13-16
//
// This test file pins the post-2026-04-29 strategy behavior. The backtest
// is 1H-only and cannot model the 15M trigger logic — see comment in
// engine.ts about range-mode being skipped (honest under-count vs false
// approximation).

import { describe, it, expect } from 'vitest';
import {
  computeScore,
  assignTier,
  getKillZone,
  _internalsForTest,
} from '../src/backtest/engine.js';
import type { Candle } from '../src/types.js';

const { resolveOutcome } = _internalsForTest;

describe('computeScore — post-2026-04-29 rebalanced rubric', () => {
  it('clean bullish bias (clarity 20→25) on tight-spread instrument: 25 + 25 + 0 + 0 + 5 = 55', () => {
    expect(computeScore({ rawClarity: 20, spreadTight: true })).toBe(55);
  });

  it('moderate bullish bias (clarity 15→20) on tight-spread: 25 + 20 + 5 = 50', () => {
    expect(computeScore({ rawClarity: 15, spreadTight: true })).toBe(50);
  });

  it('weak bullish bias (clarity 10→15) on tight-spread: 25 + 15 + 5 = 45', () => {
    expect(computeScore({ rawClarity: 10, spreadTight: true })).toBe(45);
  });

  it('zero clarity on tight-spread: 25 + 0 + 5 = 30 (below floor)', () => {
    expect(computeScore({ rawClarity: 0, spreadTight: true })).toBe(30);
  });

  it('clean bias on medium-spread (no spread bonus): 25 + 25 = 50', () => {
    expect(computeScore({ rawClarity: 20, spreadTight: false })).toBe(50);
  });

  it('does NOT add a kill-zone bonus (kill zone is now a hard gate, not score)', () => {
    // The pre-fix engine added +15 for inKillZone, +5 outside. Now removed.
    // Same rawClarity + spread should yield same score regardless of kill-zone
    // input — and the function shouldn't take that param at all.
    const a = computeScore({ rawClarity: 20, spreadTight: true });
    const b = computeScore({ rawClarity: 20, spreadTight: true });
    expect(a).toBe(b);
    expect(a).toBe(55);
  });

  it('caps at 100', () => {
    // Theoretical max with all positive components: 25 + 25 + 5 = 55.
    // News in backtest is always 0 (no historical news). ICT array is 0 too
    // (backtest doesn't model ICT structure). So actual cap is 55, well
    // below 100. The Math.min(100) is defensive.
    expect(computeScore({ rawClarity: 20, spreadTight: true })).toBeLessThanOrEqual(100);
  });
});

describe('assignTier — post-2026-05-04 spread-class carve-out', () => {
  // T1/T2 are spread-agnostic; ticker arg is irrelevant for them.
  it('score 80+ → Tier 1 (any ticker)', () => {
    expect(assignTier(80, 'EURUSD')).toBe(1);
    expect(assignTier(95, 'OIL_CRUDE')).toBe(1);
    expect(assignTier(100, 'SILVER')).toBe(1);
  });

  it('score 60-79 → Tier 2 (any ticker)', () => {
    expect(assignTier(60, 'EURUSD')).toBe(2);
    expect(assignTier(70, 'OIL_CRUDE')).toBe(2);
    expect(assignTier(79, 'SILVER')).toBe(2);
  });

  // Tight-spread carve-out — Phase E floor of 40 stays in force.
  it('tight-spread score 40-59 → Tier 3', () => {
    expect(assignTier(40, 'EURUSD')).toBe(3);
    expect(assignTier(40, 'GBPUSD')).toBe(3);
    expect(assignTier(40, 'USDJPY')).toBe(3);
    expect(assignTier(40, 'AUDUSD')).toBe(3);
    expect(assignTier(40, 'GOLD')).toBe(3);
    expect(assignTier(45, 'EURUSD')).toBe(3);
    expect(assignTier(59, 'EURUSD')).toBe(3);
  });

  it('tight-spread score 39 → null', () => {
    expect(assignTier(39, 'EURUSD')).toBeNull();
  });

  // Medium-spread carve-out — floor reverts to 45 (pre-Phase-E behavior).
  // This is the whole point of the 2026-05-04 carve-out: OIL_CRUDE 40-44
  // dominated the failed Phase E backtest.
  it('medium-spread score 40-44 → null (carve-out, was Tier 3 in Phase E)', () => {
    expect(assignTier(40, 'OIL_CRUDE')).toBeNull();
    expect(assignTier(42, 'OIL_CRUDE')).toBeNull();
    expect(assignTier(44, 'OIL_CRUDE')).toBeNull();
    expect(assignTier(40, 'SILVER')).toBeNull();
    expect(assignTier(44, 'SILVER')).toBeNull();
  });

  it('medium-spread score 45-59 → Tier 3', () => {
    expect(assignTier(45, 'OIL_CRUDE')).toBe(3);
    expect(assignTier(50, 'OIL_CRUDE')).toBe(3);
    expect(assignTier(59, 'SILVER')).toBe(3);
  });

  it('medium-spread score 39 → null', () => {
    expect(assignTier(39, 'OIL_CRUDE')).toBeNull();
  });

  it('score 0 → null (any ticker)', () => {
    expect(assignTier(0, 'EURUSD')).toBeNull();
    expect(assignTier(0, 'OIL_CRUDE')).toBeNull();
  });

  it('case-insensitive ticker classification', () => {
    expect(assignTier(40, 'eurusd')).toBe(3);
    expect(assignTier(40, 'oil_crude')).toBeNull();
  });

  it('unknown ticker is treated as medium-spread (conservative)', () => {
    // Defensive default: anything not in the tight-spread set keeps the 45 floor.
    expect(assignTier(40, 'BTCUSD')).toBeNull();
    expect(assignTier(45, 'BTCUSD')).toBe(3);
  });
});

describe('getKillZone — post-2026-04-29 overlap fix', () => {
  // Live scanner has London Close starting 16:00 (not 15:00) to avoid the
  // 15:00-16:00 overlap with NY Open. The backtest must mirror.

  it('07:00–09:59 UTC → London Open', () => {
    expect(getKillZone('2026-05-04T07:00:00Z').zone).toBe('London Open');
    expect(getKillZone('2026-05-04T08:30:00Z').zone).toBe('London Open');
    expect(getKillZone('2026-05-04T09:59:00Z').zone).toBe('London Open');
  });

  it('13:00–15:59 UTC → NY Open', () => {
    expect(getKillZone('2026-05-04T13:00:00Z').zone).toBe('NY Open');
    expect(getKillZone('2026-05-04T14:30:00Z').zone).toBe('NY Open');
    expect(getKillZone('2026-05-04T15:59:00Z').zone).toBe('NY Open');
  });

  it('15:00 UTC is NY Open (not London Close — overlap fix)', () => {
    // Pre-fix: 15:00-16:00 was double-counted, first match (NY Open) won.
    // The live scanner explicitly fixed this 2026-04-29 by starting London
    // Close at 16:00. Backtest must agree.
    expect(getKillZone('2026-05-04T15:00:00Z').zone).toBe('NY Open');
    expect(getKillZone('2026-05-04T15:30:00Z').zone).toBe('NY Open');
  });

  it('16:00–16:59 UTC → London Close', () => {
    expect(getKillZone('2026-05-04T16:00:00Z').zone).toBe('London Close');
    expect(getKillZone('2026-05-04T16:30:00Z').zone).toBe('London Close');
    expect(getKillZone('2026-05-04T16:59:00Z').zone).toBe('London Close');
  });

  it('17:00 UTC and beyond → outside', () => {
    expect(getKillZone('2026-05-04T17:00:00Z').inKillZone).toBe(false);
    expect(getKillZone('2026-05-04T18:00:00Z').inKillZone).toBe(false);
    expect(getKillZone('2026-05-04T22:00:00Z').inKillZone).toBe(false);
  });

  it('00:00–06:59 UTC → outside', () => {
    expect(getKillZone('2026-05-04T03:00:00Z').inKillZone).toBe(false);
    expect(getKillZone('2026-05-04T06:59:00Z').inKillZone).toBe(false);
  });

  it('10:00–12:59 UTC (London/NY gap) → outside', () => {
    expect(getKillZone('2026-05-04T10:00:00Z').inKillZone).toBe(false);
    expect(getKillZone('2026-05-04T11:30:00Z').inKillZone).toBe(false);
    expect(getKillZone('2026-05-04T12:59:00Z').inKillZone).toBe(false);
  });
});

// ==================== resolveOutcome — 2-leg P&L (post-2026-05-07) ====================
// Pin gross AND net pnl_r values for each outcome of the new 2-leg model:
//   tp2    → +1.09R gross  (Leg A +1R × 0.70 + Leg B +1.3R × 0.30)
//   tp1_be → +0.7R  gross  (Leg A +1R × 0.70 + Leg B 0R × 0.30 — runner BE-stop)
//   sl     → -1R    gross  (both legs at SL)
// `executionCost` is subtracted from the gross to produce `pnl_r`. Tests
// below pin both gross (unknown ticker → cost=0) and net (known ticker → cost > 0).

/** Helper: build a candle with explicit OHLC. Volume is irrelevant to
 *  resolveOutcome (it inspects only high/low/datetime). */
function makeCandle(datetime: string, open: number, high: number, low: number, close: number): Candle {
  return { datetime, open, high, low, close, volume: 0 };
}

describe('resolveOutcome — gross P&L (executionCost = 0 via unknown ticker)', () => {
  // Use 'GROSS_TEST_TICKER' — not in EXECUTION_COSTS, so computeExecutionCost
  // returns 0. This isolates the gross R math from the realism subtraction.
  const ticker = 'GROSS_TEST_TICKER';

  it('LONG sl outcome → -1R gross (no TP1 hit, then SL hit)', () => {
    // entry=100, sl=98, tp1=102, tp2=102.6 (1.3R)
    // Candle 0: low touches sl → SL fires before any TP
    const candles = [makeCandle('2026-05-04T08:00:00Z', 100, 100.5, 97.5, 99)];
    const r = resolveOutcome(ticker, candles, 0, 'long', 100, 98, 102, 102.6);
    expect(r.outcome).toBe('sl');
    expect(r.pnl_r).toBe(-1);
    expect(r.exit_time).toBe('2026-05-04T08:00:00Z');
  });

  it('LONG tp1_be outcome → +0.7R gross (TP1 hit, then runner stopped at entry)', () => {
    // Candle 0: high reaches tp1 (102) → tp1Hit=true. Effective stop now = entry (100).
    // Candle 1: low drops to 100 (entry) → tp1_be fires.
    const candles = [
      makeCandle('2026-05-04T08:00:00Z', 100, 102, 99.5, 101),
      makeCandle('2026-05-04T09:00:00Z', 101, 101.5, 99.9, 100),
    ];
    const r = resolveOutcome(ticker, candles, 0, 'long', 100, 98, 102, 102.6);
    expect(r.outcome).toBe('tp1_be');
    expect(r.pnl_r).toBe(0.7);
    expect(r.exit_time).toBe('2026-05-04T09:00:00Z');
  });

  it('LONG tp2 outcome → +1.09R gross (TP1 hit, then TP2 hit on a later candle)', () => {
    // Candle 0: hits tp1 (102) only.
    // Candle 1: hits tp2 (102.6) → full win.
    const candles = [
      makeCandle('2026-05-04T08:00:00Z', 100, 102, 99.5, 101.5),
      makeCandle('2026-05-04T09:00:00Z', 101.5, 102.7, 101, 102.6),
    ];
    const r = resolveOutcome(ticker, candles, 0, 'long', 100, 98, 102, 102.6);
    expect(r.outcome).toBe('tp2');
    // Exact 1.09 — IEEE 754 is well-behaved for 1 + 0.09 here.
    expect(r.pnl_r).toBeCloseTo(1.09, 10);
    expect(r.exit_time).toBe('2026-05-04T09:00:00Z');
  });

  it('SHORT sl outcome → -1R gross', () => {
    // entry=100, sl=102, tp1=98, tp2=97.4
    // Candle 0: high reaches sl (102) before any TP.
    const candles = [makeCandle('2026-05-04T08:00:00Z', 100, 102.5, 99.5, 101.5)];
    const r = resolveOutcome(ticker, candles, 0, 'short', 100, 102, 98, 97.4);
    expect(r.outcome).toBe('sl');
    expect(r.pnl_r).toBe(-1);
  });

  it('SHORT tp1_be outcome → +0.7R gross', () => {
    // Candle 0: low touches tp1 (98). Candle 1: high recovers to entry (100).
    const candles = [
      makeCandle('2026-05-04T08:00:00Z', 100, 100.5, 98, 98.5),
      makeCandle('2026-05-04T09:00:00Z', 98.5, 100, 98.5, 100),
    ];
    const r = resolveOutcome(ticker, candles, 0, 'short', 100, 102, 98, 97.4);
    expect(r.outcome).toBe('tp1_be');
    expect(r.pnl_r).toBe(0.7);
  });

  it('SHORT tp2 outcome → +1.09R gross', () => {
    // Candle 0: low touches tp1 (98). Candle 1: low touches tp2 (97.4).
    const candles = [
      makeCandle('2026-05-04T08:00:00Z', 100, 100.5, 98, 99),
      makeCandle('2026-05-04T09:00:00Z', 99, 99.5, 97.3, 97.4),
    ];
    const r = resolveOutcome(ticker, candles, 0, 'short', 100, 102, 98, 97.4);
    expect(r.outcome).toBe('tp2');
    expect(r.pnl_r).toBeCloseTo(1.09, 10);
  });

  it('runs out of candles after TP1 → tp1_be (defensive fallback)', () => {
    // Candle 0: hits tp1 only. No further candles → fall through to the
    // out-of-candles branch which uses tp1Hit to pick tp1_be vs sl.
    const candles = [makeCandle('2026-05-04T08:00:00Z', 100, 102, 99.5, 101)];
    const r = resolveOutcome(ticker, candles, 0, 'long', 100, 98, 102, 102.6);
    expect(r.outcome).toBe('tp1_be');
    expect(r.pnl_r).toBe(0.7);
  });

  it('runs out of candles before any TP → sl (defensive fallback)', () => {
    // Candle 0: never reaches tp1, never reaches sl. tp1Hit stays false.
    const candles = [makeCandle('2026-05-04T08:00:00Z', 100, 101, 99.5, 100.5)];
    const r = resolveOutcome(ticker, candles, 0, 'long', 100, 98, 102, 102.6);
    expect(r.outcome).toBe('sl');
    expect(r.pnl_r).toBe(-1);
  });
});

describe('resolveOutcome — net P&L (executionCost > 0 via known ticker)', () => {
  // EURUSD has spread+entry+exit slippage = 0.00008 + 0.00007 + 0.00004
  // = 0.00019 native. With stopDistance = 0.0020, executionCost = 0.0950 R.
  // Gross ± 0.0950 must equal net.
  const ticker = 'EURUSD';
  const stopDistance = 0.0020;
  const expectedCost = 0.0950;     // (0.00008 + 0.00007 + 0.00004) / 0.0020

  it('LONG tp2 outcome → +1.09R gross − cost = net', () => {
    const candles = [
      makeCandle('2026-05-04T08:00:00Z', 1.1000, 1.1020, 1.0995, 1.1015),
      makeCandle('2026-05-04T09:00:00Z', 1.1015, 1.1027, 1.1010, 1.1026),
    ];
    const r = resolveOutcome(ticker, candles, 0, 'long', 1.1000, 1.0980, 1.1020, 1.1026);
    expect(r.outcome).toBe('tp2');
    expect(r.pnl_r).toBeCloseTo(1.09 - expectedCost, 4);
  });

  it('LONG tp1_be outcome → +0.7R gross − cost = net', () => {
    const candles = [
      makeCandle('2026-05-04T08:00:00Z', 1.1000, 1.1020, 1.0995, 1.1010),
      makeCandle('2026-05-04T09:00:00Z', 1.1010, 1.1015, 1.0999, 1.1000),
    ];
    const r = resolveOutcome(ticker, candles, 0, 'long', 1.1000, 1.0980, 1.1020, 1.1026);
    expect(r.outcome).toBe('tp1_be');
    expect(r.pnl_r).toBeCloseTo(0.7 - expectedCost, 4);
  });

  it('LONG sl outcome → -1R gross − cost = net', () => {
    const candles = [
      makeCandle('2026-05-04T08:00:00Z', 1.1000, 1.1005, 1.0975, 1.0980),
    ];
    const r = resolveOutcome(ticker, candles, 0, 'long', 1.1000, 1.0980, 1.1020, 1.1026);
    expect(r.outcome).toBe('sl');
    expect(r.pnl_r).toBeCloseTo(-1 - expectedCost, 4);
  });

  it('execution cost is consistently subtracted across all outcomes (regression guard)', () => {
    // Same setup as above, all three outcomes — verify the subtraction is
    // uniform (no outcome accidentally skipping the cost).
    const slCandles = [makeCandle('s', 1.1000, 1.1005, 1.0975, 1.0980)];
    const beCandles = [
      makeCandle('a', 1.1000, 1.1020, 1.0995, 1.1010),
      makeCandle('b', 1.1010, 1.1015, 1.0999, 1.1000),
    ];
    const tp2Candles = [
      makeCandle('a', 1.1000, 1.1020, 1.0995, 1.1015),
      makeCandle('b', 1.1015, 1.1027, 1.1010, 1.1026),
    ];
    const sl = resolveOutcome(ticker, slCandles, 0, 'long', 1.1000, 1.0980, 1.1020, 1.1026);
    const be = resolveOutcome(ticker, beCandles, 0, 'long', 1.1000, 1.0980, 1.1020, 1.1026);
    const tp2 = resolveOutcome(ticker, tp2Candles, 0, 'long', 1.1000, 1.0980, 1.1020, 1.1026);

    // gross_sl - net_sl == gross_be - net_be == gross_tp2 - net_tp2 == executionCost
    expect((-1) - sl.pnl_r).toBeCloseTo(expectedCost, 4);
    expect(0.7 - be.pnl_r).toBeCloseTo(expectedCost, 4);
    expect(1.09 - tp2.pnl_r).toBeCloseTo(expectedCost, 4);
  });
});

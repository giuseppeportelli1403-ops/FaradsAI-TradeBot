// tests/displacement-backtest-precedence.test.ts
// TDD for existingTriggerFires — Task 3 of Displacement Continuation Phase 0.
//
// Fixture strategy: SYNTHETIC candles designed to satisfy / avoid the
// checkObRetest criteria as documented in scripts/audit-trigger-decisions.ts.
//
// OB Retest (bullish) qualifying criteria:
//   1. bodyRatio(last) >= 0.4  (body / range)
//   2. dirOf(last) === 'bullish'  (close > open)
//   3. lowerWick(last) / bodyOf(last) >= 1.0  (opposing wick >= 1x body)
//   4. findOrderBlock finds a displacement candle (bullish, body>=0.5*range,
//      body>=1.0*ATR) in the 10 candles before L, and a bullish OB candle up
//      to 5 candles before that displacement.
//   5. last.low <= ob.high  (taps into OB)
//   6. tap depth = (ob.high - last.low) / (ob.high - ob.low) in [0.05, 0.5]
//
// atr14 requires >= 15 candles (uses slice(-15), computes 14 TRs).

import { describe, it, expect } from "vitest";
import { existingTriggerFires } from "../scripts/_displacement-backtest.js";
import type { Candle } from "../src/types.js";

// Helper: make a full Candle with dummy datetime/volume.
function mkCandle(open: number, high: number, low: number, close: number): Candle {
  return { datetime: "2026-01-01T00:00:00", open, high, low, close, volume: 1000 };
}

// ---------------------------------------------------------------------------
// Fixture 1: 15 candles where the last is a valid OB Retest.
//
// Candles 0-11: filler — small bullish candles, range=0.010, consistent
//   open=1.100, close=1.108, high=1.110, low=1.100
//   (ATR contribution: TR approx 0.010 per candle -> ATR approx 0.010)
//
// Candle 12 (OB): open=1.100, high=1.102, low=1.099, close=1.101 (bullish)
//   -> demand zone [1.099, 1.102]
//
// Candle 13 (Displacement): open=1.101, high=1.120, low=1.100, close=1.118
//   body=0.017, range=0.020 -> body/range=0.85 >= 0.5
//   body=0.017 >= 1.0 x ATR(approx 0.010)
//   dir=bullish
//   (findOrderBlock will find this as the displacement, and OB=candle 12)
//
// Candle 14 (Retest / L): open=1.109, high=1.116, low=1.1015, close=1.115
//   body = 1.115 - 1.109 = 0.006, range = 1.116 - 1.1015 = 0.0145
//   bodyRatio = 0.006/0.0145 = 0.414 >= 0.4
//   dir = bullish (close > open)
//   lowerWick = min(open,close) - low = 1.109 - 1.1015 = 0.0075
//   lowerWick/body = 0.0075/0.006 = 1.25 >= 1.0
//   last.low=1.1015 <= ob.high=1.102 -> taps OB
//   tap = (1.102 - 1.1015) / (1.102 - 1.099) = 0.0005/0.003 = 0.167 in [5,50%]
// ---------------------------------------------------------------------------
const fillerCandle = mkCandle(1.100, 1.110, 1.100, 1.108);
const obCandle     = mkCandle(1.100, 1.102, 1.099, 1.101);
const dispCandle   = mkCandle(1.101, 1.120, 1.100, 1.118);
const retestCandle = mkCandle(1.109, 1.116, 1.1015, 1.115);

const obRetestFixture: Candle[] = [
  ...Array(12).fill(fillerCandle),
  obCandle,
  dispCandle,
  retestCandle,
];

// ---------------------------------------------------------------------------
// Fixture 2: 15 plain bullish continuation candles — no OB, FVG, sweep, or
// breakout-retest pattern.
//
// 15 consecutive bullish candles, high=close, low=open, NO lower wick.
// OB Retest fails: lowerWick(last)=0 -> oppRatio=0 < 1.0.
// FVG Fill fails: no 3-candle gap (monotone rise, no gap between any two candles).
// LiqSweep fails: no wick below prior swing (all lows ascending, no sweep).
// BreakoutRetest: no fractal swing in 30-candle lookback (each candle's high
//   is higher than the previous so no candle has a lower right neighbour).
// ---------------------------------------------------------------------------
function buildContinuationFixture(): Candle[] {
  const candles: Candle[] = [];
  let price = 1.100;
  for (let i = 0; i < 15; i++) {
    const open = price;
    const close = open + 0.005;
    candles.push(mkCandle(open, close, open, close));
    price = close;
  }
  return candles;
}

const continuationFixture = buildContinuationFixture();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("existingTriggerFires (precedence check)", () => {
  it("returns true when an OB Retest qualifies (bullish bias)", () => {
    expect(existingTriggerFires(obRetestFixture, "bullish", 0.0001)).toBe(true);
  });

  it("returns false on plain trend-continuation candles (no retest pattern, bullish bias)", () => {
    expect(existingTriggerFires(continuationFixture, "bullish", 0.0001)).toBe(false);
  });

  it("returns false immediately when bias is neutral", () => {
    expect(existingTriggerFires(obRetestFixture, "neutral", 0.0001)).toBe(false);
  });
});

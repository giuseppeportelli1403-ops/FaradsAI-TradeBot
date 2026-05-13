// tests/displacement-continuation-detector.test.ts
// TDD for checkDisplacementContinuation — Task 4 of Displacement Continuation Phase 0.
//
// === 8 Criteria (spec Section 1) ===
// 1. Bias must be 'bullish' or 'bearish' (neutral → false)
// 2. Latest n=2 consecutive 15M closes all in bias direction (close vs open)
// 3. Latest candle: body/range >= X  (impulse body)
// 4. Latest candle: body >= Y × ATR-of-bodies(14)  where ATR-of-bodies = mean(|close-open|) over
//    prior 14 candles (not counting the latest itself)
// 5. Latest candle close-strength:
//    bullish: (close - low) / range >= Z
//    bearish: (high - close) / range >= Z
// 6. NO opposing-wick filter (intentionally absent)
// 7. NO retest required (intentionally absent)
// 8. Latest wick must NOT exceed prior 8-candle 15M swing by >= 1×spread:
//    bullish: latest.high - max(prior8.high) < spread
//    bearish: min(prior8.low) - latest.low < spread
//
// === Edge cases ===
// - candles.length < 14 → qualifies: 'indeterminate', reason mentions 'insufficient'
// - zero range → qualifies: false, reason mentions 'zero range'
// - ATR-of-bodies = 0 (all flat) → treat criterion 4 as passing
//
// === Fixture design (corrected to pass criterion 8) ===
// Sequence: [...atrBodyCandles14, priorBullishCandle, goodBullishCandle]
// Length: 16 candles
//
// atrBodyCandle (x14):
//   open=1.090, high=1.110, low=1.088, close=1.093
//   body = 0.003, range = 0.022
//   HIGH = 1.110 (needed so prior8 max-high >= goodBullishCandle.high=1.110)
//
// priorBullishCandle (index 14):
//   open=1.095, high=1.111, low=1.094, close=1.100  (bullish)
//   HIGH = 1.111 > goodBullishCandle.high=1.110  (criterion 8: exceedance < 0)
//
// goodBullishCandle (index 15, latest):
//   open=1.100, high=1.110, low=1.099, close=1.109
//   body = 0.009, range = 0.011
//   body/range = 0.818 >= X=0.5 (criterion 3 passes)
//   (close-low)/range = 0.909 >= Z=0.7 (criterion 5 passes)
//
// ATR-of-bodies(14):
//   prior 14 candles are indices 1..14 (relative to latest at 15):
//     indices 1-13: atrBodyCandle body = 0.003 each (x13)
//     index 14: priorBullishCandle body = |1.100-1.095| = 0.005
//     mean = (13x0.003 + 0.005) / 14 = 0.044 / 14 ≈ 0.00314
//   body/ATR-of-bodies = 0.009 / 0.00314 ≈ 2.86 >= Y=1.2 (criterion 4 passes)
//
// Prior 8 for criterion 8 (indices 7-14):
//   7 x atrBodyCandle (high=1.110) + priorBullishCandle (high=1.111)
//   max = 1.111
//   exceedance = goodBullishCandle.high(1.110) - 1.111 = -0.001 < spread → passes

import { describe, it, expect } from "vitest";
import { checkDisplacementContinuation, type DcParams } from "../scripts/_displacement-backtest.js";
import type { Candle } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helper: make a full Candle with dummy datetime/volume.
// ---------------------------------------------------------------------------
function mkCandle(open: number, high: number, low: number, close: number): Candle {
  return { datetime: "2026-01-01T00:00:00", open, high, low, close, volume: 1000 };
}

// ---------------------------------------------------------------------------
// Base params for all tests
// ---------------------------------------------------------------------------
const baseParams: DcParams = { X: 0.5, Y: 1.2, Z: 0.7, n: 2 };

// ---------------------------------------------------------------------------
// Canonical fixture candles
// ---------------------------------------------------------------------------
// ATR body candle: small body (0.003), HIGH=1.110 to ensure criterion 8 passes
const atrBodyCandle = mkCandle(1.090, 1.110, 1.088, 1.093);

// Prior bullish candle (n=2 check): bullish, high=1.111 > goodBullishCandle.high(1.110)
const priorBullishCandle = mkCandle(1.095, 1.111, 1.094, 1.100);

// The "latest" candle that should qualify
// body = 0.009, range = 0.011, body/range = 0.818, close-strength = 0.909
const goodBullishCandle = mkCandle(1.100, 1.110, 1.099, 1.109);

// Canonical sequence: 14 ATR-body candles + prior bullish + good bullish (total: 16)
const canonicalBullishFixture: Candle[] = [
  ...Array(14).fill(atrBodyCandle),
  priorBullishCandle,
  goodBullishCandle,
];

// Typical EURUSD spread
const spread = 0.0001;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("checkDisplacementContinuation (8-criterion detector, Task 4)", () => {

  // Test 1: canonical qualifying bullish setup
  it("Test 1 — canonical bullish setup passes all 8 criteria", () => {
    const result = checkDisplacementContinuation(
      canonicalBullishFixture,
      "bullish",
      baseParams,
      spread,
    );
    expect(result.qualifies).toBe(true);
  });

  // Test 2: neutral bias → false, reason mentions 'bias'
  it("Test 2 — neutral bias → qualifies: false, reason mentions 'bias'", () => {
    const result = checkDisplacementContinuation(
      canonicalBullishFixture,
      "neutral",
      baseParams,
      spread,
    );
    expect(result.qualifies).toBe(false);
    expect(result.reason.toLowerCase()).toMatch(/bias/);
  });

  // Test 3: prior candle in opposite direction (criterion 2 fails)
  it("Test 3 — prior candle bearish (criterion 2 fails) → qualifies: false, reason mentions 'consecutive'", () => {
    // bearish prior: close(1.095) < open(1.105), high=1.111 keeps criterion 8 valid
    const bearishPrior = mkCandle(1.105, 1.111, 1.094, 1.095);
    const fixture: Candle[] = [
      ...Array(14).fill(atrBodyCandle),
      bearishPrior,
      goodBullishCandle,
    ];
    const result = checkDisplacementContinuation(fixture, "bullish", baseParams, spread);
    expect(result.qualifies).toBe(false);
    expect(result.reason.toLowerCase()).toMatch(/consecutive/);
  });

  // Test 4: body/range below X (criterion 3 fails)
  it("Test 4 — body/range below X (criterion 3 fails) → qualifies: false, reason mentions 'body'", () => {
    // open=1.100, close=1.102 (bullish, body=0.002), high=1.110, low=1.099
    // body/range = 0.002/0.011 = 0.182 < 0.5 → fails C3
    // close-strength = (1.102-1.099)/0.011 = 0.273 < 0.7 → also fails C5, but C3 is checked first
    const lowBodyCandle = mkCandle(1.100, 1.110, 1.099, 1.102);
    const fixture: Candle[] = [
      ...Array(14).fill(atrBodyCandle),
      priorBullishCandle,
      lowBodyCandle,
    ];
    const result = checkDisplacementContinuation(fixture, "bullish", baseParams, spread);
    expect(result.qualifies).toBe(false);
    expect(result.reason.toLowerCase()).toMatch(/body/);
  });

  // Test 5: body below Y × ATR-of-bodies (criterion 4 fails)
  it("Test 5 — body below Y×ATR-of-bodies (criterion 4 fails) → qualifies: false, reason mentions 'ATR'", () => {
    // Use large-body ATR candles so goodBullishCandle body is smaller than Y×ATR
    // bigAtrCandle body = |1.050 - 1.000| = 0.050, high=1.110 keeps C8 valid
    const bigAtrCandle = mkCandle(1.000, 1.110, 1.088, 1.050);
    // ATR-of-bodies(14) using prior 14 (indices 1..14):
    //   13 x bigAtrCandle (body=0.050) + 1 x priorBullishCandle (body=0.005)
    //   mean = (13*0.050 + 0.005) / 14 = 0.655 / 14 ≈ 0.04679
    //   Y*ATR = 1.2 * 0.04679 ≈ 0.05614
    //   goodBullishCandle.body = 0.009 < 0.05614 → FAILS C4
    const fixture: Candle[] = [
      ...Array(13).fill(bigAtrCandle),
      priorBullishCandle,   // index 13: body=0.005
      priorBullishCandle,   // index 14: n=2 prior
      goodBullishCandle,    // index 15: latest
    ];
    const result = checkDisplacementContinuation(fixture, "bullish", baseParams, spread);
    expect(result.qualifies).toBe(false);
    expect(result.reason.toLowerCase()).toMatch(/atr/i);
  });

  // Test 6: close-strength below Z (criterion 5 fails)
  it("Test 6 — close not in top Z fraction (criterion 5 fails) → qualifies: false, reason mentions 'close'", () => {
    // Need: body/range >= 0.5 (C3 passes) AND close-strength < 0.7 (C5 fails) AND bullish
    // open=1.100, close=1.106 (body=0.006, bullish), high=1.110, low=1.099 (range=0.011)
    //   body/range = 0.006/0.011 = 0.545 >= 0.5 → passes C3
    //   close-strength = (1.106-1.099)/0.011 = 0.636 < 0.7 → fails C5
    const weakCloseCandle = mkCandle(1.100, 1.110, 1.099, 1.106);
    const fixture: Candle[] = [
      ...Array(14).fill(atrBodyCandle),
      priorBullishCandle,
      weakCloseCandle,
    ];
    const result = checkDisplacementContinuation(fixture, "bullish", baseParams, spread);
    expect(result.qualifies).toBe(false);
    expect(result.reason.toLowerCase()).toMatch(/close/);
  });

  // Test 7: wick exceeds prior 8-candle swing by >= 1×spread (criterion 8 fails)
  it("Test 7 — wick exceeds prior 8 swing by >= 1×spread (criterion 8 fails) → qualifies: false, reason mentions 'sweep'", () => {
    // Use low-high ATR candles (high=1.094) so prior 8 max-high is low
    // Then goodBullishCandle.high=1.110 exceeds by 0.012 >= 0.0001 → fails C8
    const lowHighAtrCandle = mkCandle(1.090, 1.094, 1.088, 1.093); // high=1.094
    const priorForSweep = mkCandle(1.095, 1.098, 1.094, 1.100);    // high=1.098, bullish
    // Prior 8 (indices 7-14): 7 x lowHighAtrCandle(high=1.094) + priorForSweep(high=1.098)
    // max(prior8.high) = 1.098
    // goodBullishCandle.high = 1.110, exceedance = 0.012 >= 0.0001 spread → fails C8
    const fixture: Candle[] = [
      ...Array(14).fill(lowHighAtrCandle),
      priorForSweep,
      goodBullishCandle,
    ];
    const result = checkDisplacementContinuation(fixture, "bullish", baseParams, spread);
    expect(result.qualifies).toBe(false);
    expect(result.reason.toLowerCase()).toMatch(/sweep/);
  });

  // Test 8: fewer than 14 candles → 'indeterminate'
  it("Test 8 — fewer than 14 candles → qualifies: 'indeterminate', reason mentions insufficient history", () => {
    const shortFixture: Candle[] = Array(13).fill(atrBodyCandle);
    const result = checkDisplacementContinuation(shortFixture, "bullish", baseParams, spread);
    expect(result.qualifies).toBe("indeterminate");
    expect(result.reason.toLowerCase()).toMatch(/insufficient/);
  });

});

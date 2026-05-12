// ICT array structure-quality detector (US-5 / Spec 001 / T066).
//
// Replaces the prompt-side ICT-array scoring (+0/+15/+25/+35) that lived
// in prompts/ict-agent.md s.H. Pure, deterministic functions over candle
// data — same input always produces the same output.
//
// Four primitives, each scored independently then combined:
//   1. obProximity(...)   — distance to nearest valid order block, normalised by ATR
//   2. fvgCount(...)      — count of unfilled fair value gaps in the recent window
//   3. sweepRecency(...)  — candles since the last valid liquidity sweep
//   4. bosCount(...)      — break-of-structure count in the bias direction
//
// The combiner maps signal strength to the 0/15/25/35 contribution.
// Threshold rationale documented in research.md R-2.
//
// Candle array convention (matches detectBias in scanner/index.ts):
//   index 0 = NEWEST candle, index N-1 = OLDEST. The detectors all use
//   `.slice(0, K)` to walk the most-recent K candles.

import type { Candle } from '../types.js';

export interface IctArrayInputs {
  candles1h: Candle[];                // 1H candles, newest-first
  candles15m?: Candle[];               // optional 15M candles for BOS — undefined OK in PR1
  bias: 'bullish' | 'bearish' | 'neutral';
  atr: number;                         // 14-period ATR from detectBias
  currentPrice: number;                // most recent close
  spread: number;                      // typical spread for this instrument (price units)
}

/** Per-primitive raw score 0..3. Combiner maps tuple to 0/15/25/35. */
export interface IctArraySignals {
  obProximity: 0 | 1 | 2 | 3;
  fvgCount: 0 | 1 | 2 | 3;
  sweepRecency: 0 | 1 | 2 | 3;
  bosCount: 0 | 1 | 2 | 3;
}

// ==================== ORDER BLOCK PROXIMITY ====================
//
// An order block is a rejection candle in the OPPOSITE bias direction
// (bullish trend → look for bearish OBs being respected; bearish trend
// → look for bullish OBs). The scorer asks: "how close is the current
// price to a valid recent OB, normalised by ATR?"
//
// Detection criteria (per prompts/ict-agent.md s.I OB Retest trigger):
//   - body / range >= 0.4
//   - opposing wick / body >= 1.0
//   - candle is in opposite-bias direction
//
// Score:
//   0 = no valid OB in last 20 candles
//   1 = OB found but >2 ATR away
//   2 = OB within 2 ATR
//   3 = OB within 1 ATR (price is "on" the block)

function isValidOrderBlock(c: Candle, oppositeBiasDirection: 'up' | 'down'): boolean {
  const range = c.high - c.low;
  if (range <= 0) return false;
  const body = Math.abs(c.close - c.open);
  if (body / range < 0.4) return false;
  const isBullishCandle = c.close > c.open;
  const isBearishCandle = c.close < c.open;
  if (oppositeBiasDirection === 'down' && !isBearishCandle) return false;
  if (oppositeBiasDirection === 'up' && !isBullishCandle) return false;
  // Opposing wick (the wick on the OPPOSITE side of the body's close).
  const opposingWick = isBullishCandle
    ? c.open - c.low                  // bullish candle → opposing wick is below
    : c.high - c.open;                // bearish candle → opposing wick is above
  if (body === 0 || opposingWick / body < 1.0) return false;
  return true;
}

export function obProximity(inputs: IctArrayInputs): 0 | 1 | 2 | 3 {
  const { candles1h, bias, atr, currentPrice } = inputs;
  if (bias === 'neutral' || !Number.isFinite(atr) || atr <= 0) return 0;
  if (candles1h.length < 5) return 0;
  const oppositeDir: 'up' | 'down' = bias === 'bullish' ? 'down' : 'up';

  let nearestDistance = Infinity;
  for (const c of candles1h.slice(0, 20)) {
    if (!isValidOrderBlock(c, oppositeDir)) continue;
    // OB level: the body high (for bearish OB in bull trend) or body low (bullish OB in bear trend).
    const obLevel = oppositeDir === 'down'
      ? Math.max(c.open, c.close)     // bearish candle body top — first defense for bullish trend
      : Math.min(c.open, c.close);
    const distance = Math.abs(currentPrice - obLevel);
    if (distance < nearestDistance) nearestDistance = distance;
  }
  if (!Number.isFinite(nearestDistance)) return 0;
  const distanceInAtrs = nearestDistance / atr;
  if (distanceInAtrs <= 1) return 3;
  if (distanceInAtrs <= 2) return 2;
  return 1;  // OB exists but far away
}

// ==================== FAIR VALUE GAP COUNT ====================
//
// A FVG is a 3-candle pattern where candle[i+2].low > candle[i].high
// (bullish FVG) or candle[i+2].high < candle[i].low (bearish FVG).
// "Unfilled" = subsequent candles haven't traded back through the gap.
//
// Score (per data-model.md research.md R-2):
//   0 = no unfilled FVGs in last 20 candles
//   1 = 1 unfilled FVG
//   2 = 2 unfilled FVGs
//   3 = 3+ unfilled FVGs

export function fvgCount(inputs: IctArrayInputs): 0 | 1 | 2 | 3 {
  const { candles1h, bias } = inputs;
  if (bias === 'neutral') return 0;
  if (candles1h.length < 5) return 0;

  const window = candles1h.slice(0, 20);
  // Newest-first → walk by chronological index (newest first means
  // window[i+2] is OLDER than window[i]). For FVG detection we need
  // chronological order, so reverse for clarity.
  const chrono = [...window].reverse();
  let unfilled = 0;
  for (let i = 0; i < chrono.length - 2; i++) {
    const c1 = chrono[i];
    const c3 = chrono[i + 2];
    let gapLow: number | null = null;
    let gapHigh: number | null = null;
    if (bias === 'bullish' && c3.low > c1.high) {
      gapLow = c1.high;
      gapHigh = c3.low;
    } else if (bias === 'bearish' && c3.high < c1.low) {
      gapLow = c3.high;
      gapHigh = c1.low;
    }
    if (gapLow === null || gapHigh === null) continue;
    // Check if any subsequent candle's range overlaps the gap (= filled).
    let filled = false;
    for (let j = i + 3; j < chrono.length; j++) {
      const cj = chrono[j];
      if (cj.low <= gapHigh && cj.high >= gapLow) {
        filled = true;
        break;
      }
    }
    if (!filled) unfilled++;
  }
  if (unfilled >= 3) return 3;
  if (unfilled === 2) return 2;
  if (unfilled === 1) return 1;
  return 0;
}

// ==================== LIQUIDITY SWEEP RECENCY ====================
//
// A sweep is a wick that exceeds a prior swing extreme by at least
// 1×spread, then reverses. Recency matters: recent sweeps are predictive,
// stale sweeps (>10 candles ago) are noise.
//
// Score (per research.md R-2):
//   0 = no valid sweep in last 20 candles
//   1 = sweep older than 6 candles
//   2 = sweep within last 6 candles
//   3 = sweep within last 2 candles (very recent — strongest signal)

function findRecentSweepIndex(
  candles1h: Candle[],
  bias: 'bullish' | 'bearish',
  spread: number,
): number | null {
  if (candles1h.length < 5) return null;
  const window = candles1h.slice(0, 20);
  // Walk newest-first (index 0 is newest).
  for (let i = 0; i < window.length - 3; i++) {
    const c = window[i];
    const priorWindow = window.slice(i + 1, Math.min(i + 11, window.length));
    if (priorWindow.length < 3) continue;
    if (bias === 'bullish') {
      // Bullish bias → look for sweep BELOW prior swing low (taking sell-side liquidity)
      const priorLow = Math.min(...priorWindow.map((p) => p.low));
      if (c.low < priorLow - spread && c.close > priorLow) {
        return i;  // found a valid sweep, return its candle index (0 = newest)
      }
    } else {
      // Bearish bias → look for sweep ABOVE prior swing high (taking buy-side liquidity)
      const priorHigh = Math.max(...priorWindow.map((p) => p.high));
      if (c.high > priorHigh + spread && c.close < priorHigh) {
        return i;
      }
    }
  }
  return null;
}

export function sweepRecency(inputs: IctArrayInputs): 0 | 1 | 2 | 3 {
  const { candles1h, bias, spread } = inputs;
  if (bias === 'neutral') return 0;
  const idx = findRecentSweepIndex(candles1h, bias, Math.max(spread, 0));
  if (idx === null) return 0;
  if (idx <= 2) return 3;
  if (idx <= 6) return 2;
  return 1;
}

// ==================== BREAK OF STRUCTURE COUNT ====================
//
// BOS = a candle CLOSE beyond a recent swing high (bullish bias) or low
// (bearish bias). Scored on count within last 6 candles in the bias
// direction. The 15M timeframe is preferred per ict-agent.md s.I; falls
// back to 1H if 15M data isn't supplied (PR1 scanner doesn't fetch 15M).
//
// Score:
//   0 = no BOS
//   1 = 1 BOS
//   2 = 2 BOS
//   3 = 3+ BOS

export function bosCount(inputs: IctArrayInputs): 0 | 1 | 2 | 3 {
  const { candles15m, candles1h, bias } = inputs;
  if (bias === 'neutral') return 0;
  // Prefer 15M; fall back to 1H if 15M not supplied.
  const candles = candles15m && candles15m.length >= 8 ? candles15m : candles1h;
  if (candles.length < 8) return 0;
  const window = candles.slice(0, 8);
  // Compare each candle's close against the swing extreme of the
  // preceding 5 candles. This is a simplified BOS detector — the full
  // version would track named swings, but this captures the same signal
  // for scoring purposes.
  let count = 0;
  for (let i = 0; i < window.length - 5; i++) {
    const c = window[i];
    const prior = window.slice(i + 1, i + 6);
    if (bias === 'bullish') {
      const swingHigh = Math.max(...prior.map((p) => p.high));
      if (c.close > swingHigh) count++;
    } else {
      const swingLow = Math.min(...prior.map((p) => p.low));
      if (c.close < swingLow) count++;
    }
  }
  if (count >= 3) return 3;
  if (count === 2) return 2;
  if (count === 1) return 1;
  return 0;
}

// ==================== COMBINER ====================
//
// Maps four 0..3 signal scores to the final 0/15/25/35 contribution.
// Thresholds rationale (research.md R-2):
//   sum 0      → 0   (no structure)
//   sum 1-3    → 15  (one weak signal)
//   sum 4-6    → 25  (two aligned signals OR one very strong signal)
//   sum 7-12   → 35  (three+ aligned OR a recent sweep + BOS confluence)

export function combineSignals(s: IctArraySignals): 0 | 15 | 25 | 35 {
  const sum = s.obProximity + s.fvgCount + s.sweepRecency + s.bosCount;
  if (sum >= 7) return 35;
  if (sum >= 4) return 25;
  if (sum >= 1) return 15;
  return 0;
}

/**
 * Top-level: detect all four signals from the candle data and return
 * the final 0/15/25/35 contribution. Pure function — same input always
 * returns the same output. SC-001 verifiable.
 */
export function detectIctArrayContribution(inputs: IctArrayInputs): 0 | 15 | 25 | 35 {
  const signals: IctArraySignals = {
    obProximity: obProximity(inputs),
    fvgCount: fvgCount(inputs),
    sweepRecency: sweepRecency(inputs),
    bosCount: bosCount(inputs),
  };
  return combineSignals(signals);
}

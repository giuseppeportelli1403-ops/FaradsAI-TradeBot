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

// ---------------------------------------------------------------------------
// Bias detection — Task 2
// Port of src/scanner/index.ts:detectBias — primary HH+HL / LH+LL branch.
// Slope fallback disabled (matches production SCANNER_SLOPE_FALLBACK=false default).
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Task 3: Precedence check — existingTriggerFires
//
// Returns true if ANY of the 4 existing trend triggers (OB Retest, FVG Fill,
// Liquidity Sweep, Breakout Retest) qualifies on the given candle array.
// The Displacement Continuation trigger should only fire when NONE of these
// qualify — this function implements that gate.
//
// Signature mirrors the exported detectors in audit-trigger-decisions.ts.
// qualifies === true means the detector confirms a trigger (boolean per
// TriggerResult type, not 'yes'/'no').
// ---------------------------------------------------------------------------
import {
  checkObRetest,
  checkFvgFill,
  checkLiquiditySweep,
  checkBreakoutRetest,
} from './audit-trigger-decisions.js';

export function existingTriggerFires(
  candles15m: ReadonlyArray<Candle>,
  bias: Bias,
  spread: number,
): boolean {
  if (bias === 'neutral') return false;
  const m15 = candles15m as Candle[];
  const dir = bias as 'bullish' | 'bearish';
  if (checkObRetest(m15, dir).qualifies === true) return true;
  if (checkFvgFill(m15, dir).qualifies === true) return true;
  if (checkLiquiditySweep(m15, dir, spread).qualifies === true) return true;
  if (checkBreakoutRetest(m15, dir).qualifies === true) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Task 4: Displacement Continuation detector
//
// Implements all 8 criteria from spec Section 1. Returns the same TriggerResult
// shape as the existing 4 detectors in audit-trigger-decisions.ts so it can
// be included in the 6-trigger confusion matrix (Task 14).
//
//   qualifies: true          — all 8 criteria pass
//   qualifies: false         — at least one criterion failed (reason explains which)
//   qualifies: 'indeterminate' — cannot evaluate (insufficient history)
//
// === Criteria summary ===
// 1. Bias is 'bullish' or 'bearish' (neutral → false)
// 2. Last n consecutive 15M candles close in bias direction (close > open for bull)
// 3. Latest candle: body/range >= X  (no doji)
// 4. Latest candle: body >= Y × ATR-of-bodies(14)  (impulse, not drift)
//    ATR-of-bodies = mean(|close-open|) over the 14 candles before the latest
// 5. Latest candle close-strength:
//    bullish: (close - low) / range >= Z
//    bearish: (high - close) / range >= Z
// 6. NO opposing-wick filter (intentionally absent per spec)
// 7. NO retest required (intentionally absent per spec)
// 8. Latest wick must NOT exceed prior 8-candle swing by >= 1×spread:
//    bullish: latest.high - max(prior8.high) < spread → not a sweep
//    bearish: min(prior8.low) - latest.low < spread   → not a sweep
//
// === Edge cases ===
// - candles.length < 14 → 'indeterminate' (need 14 candles for ATR-of-bodies + n consecutive)
// - Latest candle has zero range → false, reason: 'zero range candle'
// - ATR-of-bodies = 0 (all flat prior candles) → criterion 4 treated as passing (avoid div-by-zero)
// ---------------------------------------------------------------------------

export interface DcParams {
  /** body × range threshold (impulse body), e.g. 0.40 | 0.50 | 0.60 */
  X: number;
  /** body × ATR-of-bodies(14) threshold (conviction vs drift), e.g. 1.0 | 1.2 | 1.5 */
  Y: number;
  /** close-strength threshold (commitment near close), e.g. 0.60 | 0.70 | 0.75 */
  Z: number;
  /** number of consecutive same-direction closes required, e.g. 2 | 3 */
  n: number;
}

export type DcQualifies = boolean | 'indeterminate';

export interface DetectorResult {
  qualifies: DcQualifies;
  reason: string;
}

/**
 * checkDisplacementContinuation
 *
 * Evaluates whether the latest 15M candle in `candles15m` represents a
 * Displacement Continuation pattern in the given 1H `bias` direction.
 *
 * @param candles15m - 15M candle array (latest = last element). Minimum 14.
 * @param bias       - 1H structural bias ('bullish' | 'bearish' | 'neutral')
 * @param params     - Threshold parameters (X, Y, Z, n)
 * @param spread     - Instrument spread in price units (used by criterion 8)
 */
export function checkDisplacementContinuation(
  candles15m: ReadonlyArray<import('../src/types.js').Candle>,
  bias: 'bullish' | 'bearish' | 'neutral',
  params: DcParams,
  spread: number,
): DetectorResult {
  const { X, Y, Z, n } = params;

  // ── Criterion 1: bias must be directional ───────────────────────────────
  if (bias === 'neutral') {
    return { qualifies: false, reason: 'bias is neutral — continuation requires a directional bias' };
  }

  // ── Minimum history check (need 14 prior candles for ATR-of-bodies + latest) ──
  // We need the latest candle (index L) plus 14 prior candles for the ATR-of-bodies
  // window (slice(L-14, L)) → total minimum = 15. With only 14 candles, the latest
  // is at index 13 but slice(-15,-1) = indices 0..12 = only 13 elements → degraded.
  if (candles15m.length < 15) {
    return { qualifies: 'indeterminate', reason: 'insufficient history (<15 candles for ATR(14) + latest)' };
  }

  const L = candles15m.length - 1;
  const latest = candles15m[L];

  // ── Latest candle zero-range guard ─────────────────────────────────────
  const range = latest.high - latest.low;
  if (range <= 0) {
    return { qualifies: false, reason: 'zero range candle — cannot evaluate body ratio or close strength' };
  }

  // ── Criterion 2: n consecutive closes in bias direction ─────────────────
  // Check the latest n candles (indices L-(n-1) through L) all close in bias dir.
  // "Close in bias direction" = close > open (bullish) or close < open (bearish).
  if (L < n - 1) {
    // Not enough candles for the consecutive check
    return { qualifies: 'indeterminate', reason: 'insufficient history for consecutive close check' };
  }
  for (let i = L; i >= L - (n - 1); i--) {
    const c = candles15m[i];
    const isBullish = c.close > c.open;
    const isBearish = c.close < c.open;
    if (bias === 'bullish' && !isBullish) {
      return {
        qualifies: false,
        reason: `criterion 2 failed: consecutive ${n}-bar close check — candle at offset ${L - i} closed ${c.close > c.open ? 'bullish' : c.close < c.open ? 'bearish' : 'flat'} (not bullish)`,
      };
    }
    if (bias === 'bearish' && !isBearish) {
      return {
        qualifies: false,
        reason: `criterion 2 failed: consecutive ${n}-bar close check — candle at offset ${L - i} closed ${c.close > c.open ? 'bullish' : c.close < c.open ? 'bearish' : 'flat'} (not bearish)`,
      };
    }
  }

  // ── Criterion 3: body/range >= X (impulse body) ─────────────────────────
  const body = Math.abs(latest.close - latest.open);
  const bodyRatio = body / range;
  if (bodyRatio < X) {
    return {
      qualifies: false,
      reason: `criterion 3 failed: body/range ${bodyRatio.toFixed(3)} < X=${X} (doji or small body — not an impulse candle)`,
    };
  }

  // ── Criterion 4: body >= Y × ATR-of-bodies(14) ──────────────────────────
  // ATR-of-bodies = mean(|close - open|) over the 14 candles immediately
  // preceding the latest (indices L-14 through L-1).
  // If we don't have 14 prior candles (L < 14), use however many we have.
  const atrWindow = candles15m.slice(Math.max(0, L - 14), L);
  const atrBodiesSum = atrWindow.reduce((sum, c) => sum + Math.abs(c.close - c.open), 0);
  const atrOfBodies = atrWindow.length > 0 ? atrBodiesSum / atrWindow.length : 0;

  // ATR-of-bodies = 0 → all prior candles are flat → treat criterion 4 as passing (edge case)
  if (atrOfBodies > 0 && body < Y * atrOfBodies) {
    return {
      qualifies: false,
      reason: `criterion 4 failed: body ${body.toFixed(5)} < Y×ATR-of-bodies ${(Y * atrOfBodies).toFixed(5)} (Y=${Y}, ATR=${atrOfBodies.toFixed(5)}) — drift, not impulse`,
    };
  }

  // ── Criterion 5: close strength >= Z ────────────────────────────────────
  // bullish: (close - low) / range >= Z  (closed in upper Z-fraction of range)
  // bearish: (high - close) / range >= Z (closed in lower Z-fraction of range)
  const closeStrength =
    bias === 'bullish'
      ? (latest.close - latest.low) / range
      : (latest.high - latest.close) / range;
  if (closeStrength < Z) {
    return {
      qualifies: false,
      reason: `criterion 5 failed: close-strength ${closeStrength.toFixed(3)} < Z=${Z} (close not in the ${bias === 'bullish' ? 'top' : 'bottom'} ${Math.round(Z * 100)}% of the candle range)`,
    };
  }

  // ── Criterion 8: not a sweep (wick must not exceed prior 8-candle swing by >= 1×spread) ──
  // Prior 8 candles = indices L-8 through L-1 (the 8 candles before the latest).
  // bullish: if latest.high exceeds max(prior8.high) by >= spread → cede to Liquidity Sweep.
  // bearish: if latest.low undercuts min(prior8.low) by >= spread → cede to Liquidity Sweep.
  const prior8Start = Math.max(0, L - 8);
  const prior8 = candles15m.slice(prior8Start, L); // up to but not including latest

  if (prior8.length > 0) {
    if (bias === 'bullish') {
      const maxPrior8High = Math.max(...prior8.map(c => c.high));
      const wickExceedance = latest.high - maxPrior8High;
      if (wickExceedance >= spread) {
        return {
          qualifies: false,
          reason: `criterion 8 failed: wick sweep — latest.high ${latest.high.toFixed(5)} exceeds prior-8 max-high ${maxPrior8High.toFixed(5)} by ${wickExceedance.toFixed(5)} >= spread ${spread.toFixed(5)} (cede to Liquidity Sweep)`,
        };
      }
    } else {
      // bearish
      const minPrior8Low = Math.min(...prior8.map(c => c.low));
      const wickExceedance = minPrior8Low - latest.low;
      if (wickExceedance >= spread) {
        return {
          qualifies: false,
          reason: `criterion 8 failed: wick sweep — latest.low ${latest.low.toFixed(5)} undercuts prior-8 min-low ${minPrior8Low.toFixed(5)} by ${wickExceedance.toFixed(5)} >= spread ${spread.toFixed(5)} (cede to Liquidity Sweep)`,
        };
      }
    }
  }

  // ── All criteria passed ──────────────────────────────────────────────────
  return {
    qualifies: true,
    reason: `qualifies: all 8 criteria met (body/range=${bodyRatio.toFixed(3)}, body/ATR=${atrOfBodies > 0 ? (body / atrOfBodies).toFixed(2) : 'n/a'}, close-strength=${closeStrength.toFixed(3)})`,
  };
}

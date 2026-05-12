// scripts/audit-trigger-decisions.ts
//
// Forensic auditor — compares the ICT agent's "Trigger confirmed: YES/NO"
// log lines against deterministic candle math for all 5 ICT triggers.
//
// Built per memory/reference_farad_audit_script.md (re-implementation —
// the original script existed only on the VPS and never landed in this
// repo). Spec source: prompts/ict-agent.md s.I trigger definitions
// (lines 178-190 + range-mode trigger 5 at 184-191).
//
// Usage:
//   npx tsx scripts/audit-trigger-decisions.ts --days 30
//     → bulk audit, prints confusion matrix per trigger + summary
//   npx tsx scripts/audit-trigger-decisions.ts --debug-cycle 2026-05-04T09:15:00
//     → forensic dump for one cycle (fetched candles, OHLC math, each
//       detector's intermediate values)
//
// ENV:
//   AUDIT_LOG_PATH       (default: /home/bot/trading-bot/data/pm2-out.log
//                         or local override)
//   CAPITAL_API_KEY etc  (passed through to CapitalClient)

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CapitalClient } from '../src/mcp-server/capital-client.js';
import { INSTRUMENT_UNIVERSE } from '../src/scanner/index.js';
import type { Candle } from '../src/types.js';

// ==================== CLI ====================
const args = process.argv.slice(2);
const getArg = (flag: string, def: string): string => {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : def;
};

const DAYS = parseInt(getArg('--days', '30'), 10);
const DEBUG_CYCLE_ISO = getArg('--debug-cycle', '');
const LOG_PATH = process.env.AUDIT_LOG_PATH ?? '/home/bot/trading-bot/data/pm2-out.log';

// ==================== TYPICAL SPREAD CONSTANTS ====================
// Per-instrument typical spread in price units. Captures Capital.com
// demo's resting spread in mid-2026; not real-time. The Liquidity Sweep
// + Range Sweep detectors use these as the floor for "wick must exceed
// prior swing by >= 1×spread" checks.
const TYPICAL_SPREAD: Record<string, number> = {
  EURUSD: 0.00010,
  GBPUSD: 0.00012,
  USDJPY: 0.012,
  AUDUSD: 0.00012,
  GOLD: 0.30,
  SILVER: 0.020,
  OIL_CRUDE: 0.040,
};

function spreadFor(ticker: string): number {
  return TYPICAL_SPREAD[ticker] ?? 0.0010;
}

// ==================== CANDLE HELPERS ====================
// Capital.com returns candles oldest-first; detectors expect newest-first
// to match scanner/detectBias convention. Reverse on fetch.
function toNewestFirst(candles: Candle[]): Candle[] {
  return [...candles].reverse();
}

function bodyRangeRatio(c: Candle): number {
  const range = c.high - c.low;
  if (range <= 0) return 0;
  return Math.abs(c.close - c.open) / range;
}

function isBullishCandle(c: Candle): boolean { return c.close > c.open; }
function isBearishCandle(c: Candle): boolean { return c.close < c.open; }

function computeAtr14(candles1h: Candle[]): number {
  if (candles1h.length < 2) return 0;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < Math.min(14, candles1h.length - 1); i++) {
    const tr = Math.max(
      candles1h[i].high - candles1h[i].low,
      Math.abs(candles1h[i].high - candles1h[i + 1].close),
      Math.abs(candles1h[i].low - candles1h[i + 1].close),
    );
    sum += tr;
    n++;
  }
  return n > 0 ? sum / n : 0;
}

// ==================== TRIGGER DETECTORS (5 of 5) ====================

export type TriggerName =
  | 'OB_retest' | 'FVG_fill' | 'liquidity_sweep'
  | 'breakout_retest' | 'range_sweep_reversal';

export type Bias = 'bullish' | 'bearish' | 'neutral';

export interface TriggerVerdict {
  trigger: TriggerName;
  fires: boolean;
  reason: string;            // why fired or why didn't
  details?: Record<string, unknown>;   // for --debug-cycle
}

/**
 * Detector 1: OB Retest (per ict-agent.md s.I)
 *   - Rejection candle: body >= 0.4 * range
 *   - Close in bias direction
 *   - Opposing wick >= 1.0 * body
 *   - Tap depth 5-50% into the identified order block
 *
 * For audit purposes: the trigger candle is the most recent 15M candle
 * (index 0). The "identified OB" is the last opposite-color candle
 * before strong displacement in the prior 30 candles — minimal
 * heuristic, returns 'indeterminate' if no candidate OB found.
 */
export function detectOBRetest(
  m15: Candle[],
  bias: Bias,
): TriggerVerdict {
  if (bias === 'neutral' || m15.length < 5) {
    return { trigger: 'OB_retest', fires: false, reason: 'neutral bias or insufficient candles' };
  }
  const trigger = m15[0];
  const body = Math.abs(trigger.close - trigger.open);
  const range = trigger.high - trigger.low;
  if (range <= 0) return { trigger: 'OB_retest', fires: false, reason: 'zero-range trigger candle' };

  const bodyRatio = body / range;
  if (bodyRatio < 0.4) {
    return { trigger: 'OB_retest', fires: false, reason: `body/range=${bodyRatio.toFixed(2)} < 0.4`, details: { bodyRatio, body, range } };
  }
  // Direction check
  if (bias === 'bullish' && !isBullishCandle(trigger)) {
    return { trigger: 'OB_retest', fires: false, reason: 'bullish bias but bearish trigger candle' };
  }
  if (bias === 'bearish' && !isBearishCandle(trigger)) {
    return { trigger: 'OB_retest', fires: false, reason: 'bearish bias but bullish trigger candle' };
  }
  // Opposing wick (the wick on the OPPOSITE side of the bias)
  const opposingWick = bias === 'bullish'
    ? Math.min(trigger.open, trigger.close) - trigger.low      // lower wick for bullish
    : trigger.high - Math.max(trigger.open, trigger.close);    // upper wick for bearish
  if (body === 0 || opposingWick / body < 1.0) {
    return { trigger: 'OB_retest', fires: false, reason: `opposing wick/body=${(opposingWick / body).toFixed(2)} < 1.0`, details: { opposingWick, body } };
  }

  // OB identification: scan back for last opposite-color candle before a
  // strong-displacement candle in the prior 30 candles.
  let obIndex: number | null = null;
  for (let i = 1; i < Math.min(30, m15.length); i++) {
    const isOpposite = bias === 'bullish' ? isBearishCandle(m15[i]) : isBullishCandle(m15[i]);
    if (isOpposite) { obIndex = i; break; }
  }
  if (obIndex === null) {
    return { trigger: 'OB_retest', fires: false, reason: 'no candidate OB found in prior 30 candles (indeterminate)' };
  }
  const ob = m15[obIndex];
  const obBodyHigh = Math.max(ob.open, ob.close);
  const obBodyLow = Math.min(ob.open, ob.close);
  const obRange = obBodyHigh - obBodyLow;
  if (obRange <= 0) {
    return { trigger: 'OB_retest', fires: false, reason: 'zero-range candidate OB' };
  }
  // Tap depth: how far the trigger's wick reached into the OB body, as % of OB body
  const tapPrice = bias === 'bullish' ? trigger.low : trigger.high;
  const tapDepthPct = bias === 'bullish'
    ? Math.max(0, Math.min(100, ((obBodyHigh - tapPrice) / obRange) * 100))
    : Math.max(0, Math.min(100, ((tapPrice - obBodyLow) / obRange) * 100));
  if (tapDepthPct < 5 || tapDepthPct > 50) {
    return { trigger: 'OB_retest', fires: false, reason: `tap depth ${tapDepthPct.toFixed(1)}% outside [5%, 50%]`, details: { tapDepthPct, obIndex } };
  }
  return {
    trigger: 'OB_retest',
    fires: true,
    reason: `body/range=${bodyRatio.toFixed(2)} >= 0.4, wick/body=${(opposingWick / body).toFixed(2)} >= 1.0, tap=${tapDepthPct.toFixed(1)}% in OB at m15[${obIndex}]`,
    details: { bodyRatio, opposingWickRatio: opposingWick / body, tapDepthPct, obIndex },
  };
}

/**
 * Detector 2: FVG Fill (per ict-agent.md s.I)
 *   - 3-candle gap (chronological): c[i].high < c[i+2].low (bullish) or c[i].low > c[i+2].high (bearish)
 *   - Fill candle (k=i+3) covers >= 50% of the gap
 *   - Trigger candle (k+1) closes in bias direction with body >= 0.4 * range
 *
 * Audit limitation (per memory): k=1 only — the fill must be exactly 1
 * candle before the trigger. Codex suggested k>=1 but this implementation
 * keeps the tighter "then next candle" reading from the spec.
 */
export function detectFVGFill(m15: Candle[], bias: Bias): TriggerVerdict {
  if (bias === 'neutral' || m15.length < 5) {
    return { trigger: 'FVG_fill', fires: false, reason: 'neutral bias or insufficient candles' };
  }
  const trigger = m15[0];
  const fill = m15[1];
  // Chronological order: the gap is between candles "older than" fill.
  // Newest-first: fill is at index 1, gap candles are indices 2 (recent edge)
  // and 4 (older edge); m15[3] is the middle of the 3-candle pattern.
  if (m15.length < 5) {
    return { trigger: 'FVG_fill', fires: false, reason: 'need >=5 candles for FVG check' };
  }
  const gapNew = m15[2];     // chronologically "later" of the gap pair
  const gapOld = m15[4];     // chronologically "earlier" of the gap pair

  let gapLow: number, gapHigh: number;
  if (bias === 'bullish') {
    // Bullish FVG: gapOld.high < gapNew.low → gap from gapOld.high to gapNew.low
    if (gapOld.high >= gapNew.low) {
      return { trigger: 'FVG_fill', fires: false, reason: `no bullish FVG: m15[4].high=${gapOld.high} >= m15[2].low=${gapNew.low}` };
    }
    gapLow = gapOld.high;
    gapHigh = gapNew.low;
  } else {
    // Bearish FVG: gapOld.low > gapNew.high → gap from gapNew.high to gapOld.low
    if (gapOld.low <= gapNew.high) {
      return { trigger: 'FVG_fill', fires: false, reason: `no bearish FVG: m15[4].low=${gapOld.low} <= m15[2].high=${gapNew.high}` };
    }
    gapLow = gapNew.high;
    gapHigh = gapOld.low;
  }
  const gapSize = gapHigh - gapLow;
  if (gapSize <= 0) return { trigger: 'FVG_fill', fires: false, reason: 'zero-size gap' };

  // Fill check: how much of the gap did the fill candle cover?
  const fillRange = Math.min(fill.high, gapHigh) - Math.max(fill.low, gapLow);
  const fillPct = (Math.max(0, fillRange) / gapSize) * 100;
  if (fillPct < 50) {
    return { trigger: 'FVG_fill', fires: false, reason: `fill candle covered ${fillPct.toFixed(1)}% of gap (need >= 50%)`, details: { gapLow, gapHigh, fillPct } };
  }

  // Trigger candle: body >= 0.4 * range AND closes in bias direction
  const tBodyRatio = bodyRangeRatio(trigger);
  if (tBodyRatio < 0.4) {
    return { trigger: 'FVG_fill', fires: false, reason: `trigger body/range=${tBodyRatio.toFixed(2)} < 0.4` };
  }
  if (bias === 'bullish' && !isBullishCandle(trigger)) {
    return { trigger: 'FVG_fill', fires: false, reason: 'bullish bias but bearish trigger candle' };
  }
  if (bias === 'bearish' && !isBearishCandle(trigger)) {
    return { trigger: 'FVG_fill', fires: false, reason: 'bearish bias but bullish trigger candle' };
  }
  return {
    trigger: 'FVG_fill',
    fires: true,
    reason: `gap [${gapLow}, ${gapHigh}] filled ${fillPct.toFixed(1)}%; trigger body/range=${tBodyRatio.toFixed(2)}`,
    details: { gapLow, gapHigh, gapSize, fillPct, tBodyRatio },
  };
}

/**
 * Detector 3: Liquidity Sweep (per ict-agent.md s.I)
 *   - Wick exceeds prior swing extreme by >= 1 * spread
 *   - 10-candle lookback for swing
 *   - Reversal within <= 2 candles
 *
 * Audit interpretation: the most recent 15M candle is either the sweep
 * candle itself OR the reversal candle (within 2 of the sweep). Walk
 * back through m15[0..3] looking for a sweep + within-2 reversal.
 */
export function detectLiquiditySweep(
  m15: Candle[], bias: Bias, ticker: string,
): TriggerVerdict {
  if (bias === 'neutral' || m15.length < 13) {
    return { trigger: 'liquidity_sweep', fires: false, reason: 'neutral bias or <13 candles' };
  }
  const spread = spreadFor(ticker);
  // For each potential sweep candle position (newest-first 0..3):
  for (let sweepIdx = 0; sweepIdx <= 3 && sweepIdx + 10 < m15.length; sweepIdx++) {
    const sweep = m15[sweepIdx];
    const priorWindow = m15.slice(sweepIdx + 1, sweepIdx + 11);
    if (priorWindow.length < 5) continue;
    if (bias === 'bullish') {
      const priorLow = Math.min(...priorWindow.map((p) => p.low));
      if (sweep.low < priorLow - spread) {
        // Reversal within <= 2 candles AFTER sweep (in chronological terms,
        // newer than sweep — so indices sweepIdx-1, sweepIdx-2 if exist).
        for (let revOffset = 1; revOffset <= 2; revOffset++) {
          const revIdx = sweepIdx - revOffset;
          if (revIdx < 0) continue;
          const rev = m15[revIdx];
          if (rev.close > priorLow) {
            return {
              trigger: 'liquidity_sweep', fires: true,
              reason: `bullish sweep at m15[${sweepIdx}] low ${sweep.low} < priorLow ${priorLow} - spread ${spread}; reversal at m15[${revIdx}] closed ${rev.close} > priorLow`,
              details: { sweepIdx, revIdx, priorLow, spread },
            };
          }
        }
        // If no reversal yet but the sweep is the most recent candle, mark
        // as "watching" — fires=false but reason is informative.
        return { trigger: 'liquidity_sweep', fires: false, reason: `sweep candle at m15[${sweepIdx}] but no reversal close yet`, details: { sweepIdx, priorLow } };
      }
    } else {
      const priorHigh = Math.max(...priorWindow.map((p) => p.high));
      if (sweep.high > priorHigh + spread) {
        for (let revOffset = 1; revOffset <= 2; revOffset++) {
          const revIdx = sweepIdx - revOffset;
          if (revIdx < 0) continue;
          const rev = m15[revIdx];
          if (rev.close < priorHigh) {
            return {
              trigger: 'liquidity_sweep', fires: true,
              reason: `bearish sweep at m15[${sweepIdx}] high ${sweep.high} > priorHigh ${priorHigh} + spread ${spread}; reversal at m15[${revIdx}] closed ${rev.close} < priorHigh`,
              details: { sweepIdx, revIdx, priorHigh, spread },
            };
          }
        }
        return { trigger: 'liquidity_sweep', fires: false, reason: `sweep candle at m15[${sweepIdx}] but no reversal close yet`, details: { sweepIdx, priorHigh } };
      }
    }
  }
  return { trigger: 'liquidity_sweep', fires: false, reason: 'no sweep in m15[0..3]' };
}

/**
 * Detector 4: Breakout Retest (per ict-agent.md s.I)
 *   - Fractal-swing level identified in prior 30 candles
 *   - Plateau-aware ≥/> semantics (Q1 fix from memory)
 *   - Retest within <= 6 candles of break
 *   - 2 hold closes after retest in bias direction
 *
 * Simplified: take the most recent fractal swing high (bearish bias) or
 * low (bullish bias), check if recent candle broke it, then if there's
 * been a retest with 2 hold closes.
 */
export function detectBreakoutRetest(m15: Candle[], bias: Bias): TriggerVerdict {
  if (bias === 'neutral' || m15.length < 30) {
    return { trigger: 'breakout_retest', fires: false, reason: 'neutral bias or <30 candles' };
  }
  // Find the most recent fractal swing in the prior 30 candles (newest-first).
  // A fractal: candle[i].extreme is more extreme than 2 candles either side.
  let fractalIdx: number | null = null;
  let fractalLevel: number | null = null;
  for (let i = 6; i < Math.min(30, m15.length - 2); i++) {
    if (bias === 'bullish') {
      const lows = [m15[i - 2].low, m15[i - 1].low, m15[i].low, m15[i + 1].low, m15[i + 2].low];
      if (lows[2] <= lows[0] && lows[2] <= lows[1] && lows[2] <= lows[3] && lows[2] <= lows[4]) {
        fractalIdx = i; fractalLevel = lows[2]; break;
      }
    } else {
      const highs = [m15[i - 2].high, m15[i - 1].high, m15[i].high, m15[i + 1].high, m15[i + 2].high];
      if (highs[2] >= highs[0] && highs[2] >= highs[1] && highs[2] >= highs[3] && highs[2] >= highs[4]) {
        fractalIdx = i; fractalLevel = highs[2]; break;
      }
    }
  }
  if (fractalIdx === null || fractalLevel === null) {
    return { trigger: 'breakout_retest', fires: false, reason: 'no fractal swing in prior 30 candles' };
  }

  // Look for break: a CLOSE beyond the level within the recent 6 candles
  // (newer than fractalIdx).
  let breakIdx: number | null = null;
  for (let i = 0; i < Math.min(fractalIdx, 6); i++) {
    if (bias === 'bullish' && m15[i].close > fractalLevel) { breakIdx = i; break; }
    if (bias === 'bearish' && m15[i].close < fractalLevel) { breakIdx = i; break; }
  }
  if (breakIdx === null) {
    return { trigger: 'breakout_retest', fires: false, reason: `no recent close beyond fractal level ${fractalLevel}` };
  }

  // After break, look for retest + 2 hold closes — for the audit, we just
  // need 2 of the candles at breakIdx-1 and breakIdx-2 (newer than break)
  // to close on the bias side of fractalLevel.
  if (breakIdx < 2) {
    return { trigger: 'breakout_retest', fires: false, reason: `break at m15[${breakIdx}] too recent for 2 hold closes` };
  }
  const hold1 = m15[breakIdx - 1];
  const hold2 = m15[breakIdx - 2];
  const holds1 = bias === 'bullish' ? hold1.close > fractalLevel : hold1.close < fractalLevel;
  const holds2 = bias === 'bullish' ? hold2.close > fractalLevel : hold2.close < fractalLevel;
  if (holds1 && holds2) {
    return {
      trigger: 'breakout_retest', fires: true,
      reason: `fractal at m15[${fractalIdx}]=${fractalLevel}; break at m15[${breakIdx}]; 2 hold closes at m15[${breakIdx - 1}], m15[${breakIdx - 2}]`,
      details: { fractalIdx, fractalLevel, breakIdx },
    };
  }
  return { trigger: 'breakout_retest', fires: false, reason: `fractal break detected but only ${(holds1 ? 1 : 0) + (holds2 ? 1 : 0)} of 2 hold closes`, details: { fractalLevel, breakIdx, holds1, holds2 } };
}

/**
 * Detector 5: Range Sweep Reversal (per ict-agent.md s.I trigger 5)
 *   - 1H bias = neutral (this detector only fires on neutral bias)
 *   - Range from last 8 1H candles, width >= 1.5 * ATR_1h
 *   - Sweep min = max(2 * spread, 0.10 * ATR)
 *   - Reversal within <= 2 candles inclusive
 */
export function detectRangeSweepReversal(
  m15: Candle[], h1: Candle[], bias: Bias, ticker: string,
): TriggerVerdict {
  if (bias !== 'neutral') {
    return { trigger: 'range_sweep_reversal', fires: false, reason: `bias is ${bias} (range trigger requires neutral)` };
  }
  if (h1.length < 9 || m15.length < 5) {
    return { trigger: 'range_sweep_reversal', fires: false, reason: 'insufficient h1 (<9) or m15 (<5) candles' };
  }
  const rangeWindow = h1.slice(0, 8);
  const rangeHigh = Math.max(...rangeWindow.map((c) => c.high));
  const rangeLow = Math.min(...rangeWindow.map((c) => c.low));
  const rangeWidth = rangeHigh - rangeLow;
  const atr = computeAtr14(h1);
  if (rangeWidth < 1.5 * atr) {
    return { trigger: 'range_sweep_reversal', fires: false, reason: `range width ${rangeWidth.toFixed(5)} < 1.5 * ATR ${(1.5 * atr).toFixed(5)}` };
  }
  const spread = spreadFor(ticker);
  const sweepMin = Math.max(2 * spread, 0.10 * atr);

  // Look for sweep + reversal in m15[0..2] (newest-first; reversal can
  // be the sweep candle itself or up to 2 candles after).
  for (let sweepIdx = 0; sweepIdx <= 2; sweepIdx++) {
    const sweep = m15[sweepIdx];
    // Sweep above range high → expect SHORT
    if (sweep.high > rangeHigh + sweepMin) {
      // Reversal within <=2 candles inclusive of sweep
      for (let revOffset = 0; revOffset <= 2; revOffset++) {
        const revIdx = sweepIdx - revOffset;
        if (revIdx < 0) continue;
        const rev = m15[revIdx];
        if (rev.close < rangeHigh) {
          return {
            trigger: 'range_sweep_reversal', fires: true,
            reason: `sweep above range high ${rangeHigh} by ${(sweep.high - rangeHigh).toFixed(5)} (>= ${sweepMin.toFixed(5)}); reversal at m15[${revIdx}] closed back inside`,
            details: { sweepIdx, revIdx, rangeHigh, rangeLow, rangeWidth, atr, sweepMin, direction: 'short' },
          };
        }
      }
    }
    if (sweep.low < rangeLow - sweepMin) {
      for (let revOffset = 0; revOffset <= 2; revOffset++) {
        const revIdx = sweepIdx - revOffset;
        if (revIdx < 0) continue;
        const rev = m15[revIdx];
        if (rev.close > rangeLow) {
          return {
            trigger: 'range_sweep_reversal', fires: true,
            reason: `sweep below range low ${rangeLow} by ${(rangeLow - sweep.low).toFixed(5)} (>= ${sweepMin.toFixed(5)}); reversal at m15[${revIdx}] closed back inside`,
            details: { sweepIdx, revIdx, rangeHigh, rangeLow, rangeWidth, atr, sweepMin, direction: 'long' },
          };
        }
      }
    }
  }
  return { trigger: 'range_sweep_reversal', fires: false, reason: `no qualifying sweep+reversal in m15[0..2]; range [${rangeLow}, ${rangeHigh}]` };
}

// ==================== LOG PARSER ====================

export interface DecisionCycle {
  timestamp: string;          // ISO 8601 UTC
  ticker: string;
  bias: Bias;
  llmTriggerConfirmed: boolean;
  llmTriggerName?: TriggerName;        // if extractable
  rawBlock: string;
}

/** Parse one DECISION CYCLE block out of the pm2-out.log content. */
export function parseDecisionCycles(logText: string): DecisionCycle[] {
  const cycles: DecisionCycle[] = [];
  // Each cycle starts with "DECISION CYCLE" and ends at the next one or EOF.
  const blocks = logText.split(/(?=DECISION CYCLE)/g);
  for (const block of blocks) {
    if (!block.includes('DECISION CYCLE')) continue;
    // Timestamp: pm2 prefixes lines with "YYYY-MM-DD HH:MM:SS +00:00:" — find first.
    const tsMatch = block.match(/(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})/);
    if (!tsMatch) continue;
    const timestamp = tsMatch[1].replace(' ', 'T') + 'Z';
    // Ticker: scan for any universe ticker
    let ticker = '';
    for (const inst of INSTRUMENT_UNIVERSE) {
      if (new RegExp(`\\b${inst.ticker}\\b`).test(block)) { ticker = inst.ticker; break; }
    }
    if (!ticker) continue;
    // Bias: "1H Bias: Bullish/Bearish/Neutral"
    let bias: Bias = 'neutral';
    if (/1H Bias:\s*Bullish/i.test(block)) bias = 'bullish';
    else if (/1H Bias:\s*Bearish/i.test(block)) bias = 'bearish';
    // Trigger confirmed: "Trigger confirmed: Yes" or "No"
    const triggerConfirmedMatch = block.match(/Trigger confirmed:\s*(Yes|No)/i);
    const llmTriggerConfirmed = triggerConfirmedMatch ? triggerConfirmedMatch[1].toLowerCase() === 'yes' : false;
    // Trigger name (best-effort): look for OB_retest, FVG_fill, etc. in block
    let llmTriggerName: TriggerName | undefined;
    const triggerNames: TriggerName[] = ['OB_retest', 'FVG_fill', 'liquidity_sweep', 'breakout_retest', 'range_sweep_reversal'];
    for (const name of triggerNames) {
      if (new RegExp(name, 'i').test(block)) { llmTriggerName = name; break; }
    }
    cycles.push({ timestamp, ticker, bias, llmTriggerConfirmed, llmTriggerName, rawBlock: block.slice(0, 500) });
  }
  return cycles;
}

// ==================== AUDIT ENGINE ====================

interface CycleAuditResult {
  cycle: DecisionCycle;
  detectorVerdicts: TriggerVerdict[];
  anyDetectorFires: boolean;
  agreement: 'TP' | 'TN' | 'FP' | 'FN';      // confusion matrix label
}

function classifyAgreement(llmYes: boolean, detectorYes: boolean): CycleAuditResult['agreement'] {
  if (llmYes && detectorYes) return 'TP';
  if (!llmYes && !detectorYes) return 'TN';
  if (llmYes && !detectorYes) return 'FP';   // LLM hallucinated
  return 'FN';                                // LLM missed real trigger
}

async function runDetectorsForCycle(
  capital: CapitalClient,
  cycle: DecisionCycle,
): Promise<TriggerVerdict[]> {
  // Fetch m15 + h1 candles around the cycle timestamp.
  // Use `to` parameter to anchor the fetch at the cycle time.
  const m15Raw = await capital.getCandlesAsCandles(cycle.ticker, '15m', 50, undefined, cycle.timestamp);
  const h1Raw = await capital.getCandlesAsCandles(cycle.ticker, '1h', 50, undefined, cycle.timestamp);
  const m15 = toNewestFirst(m15Raw);
  const h1 = toNewestFirst(h1Raw);
  return [
    detectOBRetest(m15, cycle.bias),
    detectFVGFill(m15, cycle.bias),
    detectLiquiditySweep(m15, cycle.bias, cycle.ticker),
    detectBreakoutRetest(m15, cycle.bias),
    detectRangeSweepReversal(m15, h1, cycle.bias, cycle.ticker),
  ];
}

// ==================== REPORTING ====================

interface PerTriggerStats { tp: number; tn: number; fp: number; fn: number; }
function emptyStats(): PerTriggerStats { return { tp: 0, tn: 0, fp: 0, fn: 0 }; }

function printConfusionMatrix(perTrigger: Record<TriggerName, PerTriggerStats>, total: { tp: number; tn: number; fp: number; fn: number; }): void {
  const totalCycles = total.tp + total.tn + total.fp + total.fn;
  console.log('\n========== TRIGGER-DECISION AUDIT REPORT ==========');
  console.log(`Total comparable cycles: ${totalCycles}\n`);
  console.log(`AGGREGATE confusion matrix (LLM vs deterministic detector union):`);
  console.log(`  TP (both YES):        ${total.tp}`);
  console.log(`  TN (both NO):         ${total.tn}`);
  console.log(`  FP (LLM YES, det NO): ${total.fp}  ← potential LLM hallucination`);
  console.log(`  FN (LLM NO, det YES): ${total.fn}  ← potential LLM miss`);
  if (totalCycles > 0) {
    const agree = total.tp + total.tn;
    console.log(`  Agreement: ${((agree / totalCycles) * 100).toFixed(1)}% (${agree}/${totalCycles})`);
  }
  console.log(`\nPER-TRIGGER (only counts cycles where the LLM had this exact trigger as the action):`);
  const triggers: TriggerName[] = ['OB_retest', 'FVG_fill', 'liquidity_sweep', 'breakout_retest', 'range_sweep_reversal'];
  for (const t of triggers) {
    const s = perTrigger[t];
    const sum = s.tp + s.tn + s.fp + s.fn;
    if (sum === 0) { console.log(`  ${t}: no cycles`); continue; }
    console.log(`  ${t}: TP=${s.tp} TN=${s.tn} FP=${s.fp} FN=${s.fn} (total=${sum}, agreement ${((s.tp + s.tn) / sum * 100).toFixed(1)}%)`);
  }
}

function printDebugCycle(cycle: DecisionCycle, verdicts: TriggerVerdict[]): void {
  console.log(`\n========== DEBUG CYCLE: ${cycle.timestamp} ${cycle.ticker} ==========`);
  console.log(`LLM bias: ${cycle.bias}`);
  console.log(`LLM trigger confirmed: ${cycle.llmTriggerConfirmed} (name: ${cycle.llmTriggerName ?? 'unspecified'})`);
  console.log(`Raw log block (first 500 chars):\n${cycle.rawBlock}`);
  console.log(`\nDetector verdicts:`);
  for (const v of verdicts) {
    console.log(`\n  [${v.trigger}] fires=${v.fires}`);
    console.log(`    reason: ${v.reason}`);
    if (v.details) {
      for (const [k, val] of Object.entries(v.details)) {
        console.log(`    ${k} = ${typeof val === 'number' ? val.toFixed(5) : JSON.stringify(val)}`);
      }
    }
  }
}

// ==================== MAIN ====================

async function main(): Promise<void> {
  const apiKey = (process.env.CAPITAL_API_KEY ?? '').trim();
  if (!apiKey) {
    console.error('ERROR: CAPITAL_API_KEY not set — script needs Capital.com API access to fetch candles.');
    process.exit(1);
  }

  // Load log
  let logText = '';
  try {
    logText = readFileSync(LOG_PATH, 'utf-8');
  } catch (err) {
    console.error(`ERROR: cannot read log at ${LOG_PATH}: ${err instanceof Error ? err.message : String(err)}`);
    console.error(`Set AUDIT_LOG_PATH=/local/path/to/pm2-out.log to use a local copy.`);
    process.exit(1);
  }

  const allCycles = parseDecisionCycles(logText);
  console.log(`Parsed ${allCycles.length} DECISION CYCLE blocks from ${LOG_PATH}`);

  // Filter to last DAYS days (or specific cycle for debug mode)
  const cutoffMs = Date.now() - DAYS * 24 * 60 * 60 * 1000;
  let cycles = allCycles.filter((c) => Date.parse(c.timestamp) >= cutoffMs);
  if (DEBUG_CYCLE_ISO) {
    cycles = allCycles.filter((c) => c.timestamp.startsWith(DEBUG_CYCLE_ISO.slice(0, 19)));
    if (cycles.length === 0) {
      console.error(`No cycle found matching --debug-cycle ${DEBUG_CYCLE_ISO}`);
      process.exit(1);
    }
  }
  console.log(`Auditing ${cycles.length} cycles${DEBUG_CYCLE_ISO ? ` (debug mode: ${DEBUG_CYCLE_ISO})` : ` (last ${DAYS} days)`}`);

  const capital = new CapitalClient({
    apiKey,
    identifier: process.env.CAPITAL_IDENTIFIER || '',
    password: process.env.CAPITAL_API_KEY_PASSWORD || '',
    baseURL: process.env.CAPITAL_API_URL || 'https://demo-api-capital.backend-capital.com',
  });

  const total = { tp: 0, tn: 0, fp: 0, fn: 0 };
  const perTrigger: Record<TriggerName, PerTriggerStats> = {
    OB_retest: emptyStats(), FVG_fill: emptyStats(), liquidity_sweep: emptyStats(),
    breakout_retest: emptyStats(), range_sweep_reversal: emptyStats(),
  };

  for (const cycle of cycles) {
    let verdicts: TriggerVerdict[];
    try {
      verdicts = await runDetectorsForCycle(capital, cycle);
    } catch (err) {
      console.warn(`[audit] cycle ${cycle.timestamp} ${cycle.ticker} skipped: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    if (DEBUG_CYCLE_ISO) {
      printDebugCycle(cycle, verdicts);
      continue;
    }

    const anyFires = verdicts.some((v) => v.fires);
    const agree = classifyAgreement(cycle.llmTriggerConfirmed, anyFires);
    total[agree.toLowerCase() as 'tp' | 'tn' | 'fp' | 'fn']++;

    // Per-trigger: only count if the LLM named this specific trigger in the cycle
    if (cycle.llmTriggerName) {
      const det = verdicts.find((v) => v.trigger === cycle.llmTriggerName);
      if (det) {
        const subAgree = classifyAgreement(cycle.llmTriggerConfirmed, det.fires);
        perTrigger[cycle.llmTriggerName][subAgree.toLowerCase() as 'tp' | 'tn' | 'fp' | 'fn']++;
      }
    }
  }

  if (!DEBUG_CYCLE_ISO) {
    printConfusionMatrix(perTrigger, total);
    console.log(`\nMethodology note: per-trigger stats only count cycles where the LLM explicitly named this trigger. Aggregate counts include all comparable cycles regardless of which specific trigger fired (or didn't).`);
  }
}

// Only invoke main() when run directly via `npx tsx scripts/audit-trigger-decisions.ts`.
// Guards against vitest importing this module for unit tests of the
// detector functions — without this guard, importing the file would
// trigger main() → process.exit(1) inside the test runner.
const scriptPath = resolve(fileURLToPath(import.meta.url));
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
const isMain = scriptPath === invokedPath;
if (isMain) {
  main().catch((err) => {
    console.error('[audit] Fatal:', err);
    process.exit(1);
  });
}

// Suppress unused-import lint when isMain is false but dirname is still in scope.
void dirname;

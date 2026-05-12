// scripts/audit-trigger-decisions.ts
//
// Audit whether the ICT agent's "Trigger confirmed: YES/NO" decisions match
// what the actual 15M/1H candle math would say. Investigates whether the LLM
// (a) misses valid triggers (false negatives), or (b) hallucinates them
// (false positives), by reproducing all 5 quantitative triggers from
// `prompts/ict-agent.md:178-190` on the candles the LLM actually saw.
//
// === v2 changes vs v1 ===
//   - All 5 triggers evaluated: OB Retest, FVG Fill, Liquidity Sweep,
//     Breakout Retest (trend-mode), Range Sweep Reversal (range-mode).
//   - Data source: Capital.com mid candles (apples-to-apples with what the
//     LLM bot saw at decision time), NOT yahoo-finance2.
//   - Parser fixes: rejects "N/A"/"None" tickers, line-anchored
//     "Trigger confirmed:" capture, robust 1H Bias extraction.
//   - Per-trigger confusion matrix + overall agreement rate.
//
// === Spread approximation ===
// Triggers 3 and 5 require a spread term. This script uses a TYPICAL_SPREAD
// table per instrument (see below). Capital.com's getMarketDetails(epic)
// would give a real-time spread but is one extra API call per cycle — overkill
// for a first-cut audit. Future improvement: snapshot real spread at the
// decision timestamp via getMarketDetails().
//
// === ATR ===
// 14-period True Range SMA on 15M candles. TR = max(high-low,
// |high-prevClose|, |low-prevClose|).
//
// === OB Retest tap-depth ===
// The OB Retest detector now identifies a candidate OB via a minimal
// heuristic (last bias-side candle before a strong same-bias displacement
// candle, within a 10-candle lookback) and validates tap-depth ≤ 50% of the
// OB's range. When no candidate OB can be located the detector returns
// `qualifies: 'indeterminate'` and the cycle is excluded from TP/TN/FP/FN
// counts — see the per-trigger confusion matrix.
//
// === Usage ===
//   Normal audit:
//     npx tsx scripts/audit-trigger-decisions.ts [--log <path>] [--days <N>]
//   Forensic single-cycle:
//     npx tsx scripts/audit-trigger-decisions.ts --debug-cycle <ISO_TS>
//     e.g. --debug-cycle 2026-05-04T09:15:00
//
// Default log: ~/trading-bot/data/pm2-out.log. Default window: last 14 days.

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import process from 'node:process';

import { CapitalClient } from '../src/mcp-server/capital-client.js';
import type { Candle } from '../src/types.js';

// ==================== CONFIG ====================

const SUPPORTED_TICKERS = [
  'EURUSD',
  'GBPUSD',
  'AUDUSD',
  'USDJPY',
  'GOLD',
  'SILVER',
  'OIL_CRUDE',
] as const;

type Ticker = (typeof SUPPORTED_TICKERS)[number];

// Typical intraday spreads (price units). Real spread varies by session and
// volatility. Used as a floor for sweep detection.
const TYPICAL_SPREAD: Record<Ticker, number> = {
  EURUSD: 0.00010,
  GBPUSD: 0.00015,
  AUDUSD: 0.00015,
  USDJPY: 0.010,
  GOLD: 0.30,
  SILVER: 0.020,
  OIL_CRUDE: 0.030,
};

const RATE_LIMIT_MS = 250;

// ==================== TYPES ====================

type Bias = 'bullish' | 'bearish' | 'neutral' | 'unknown';
type LlmAnswer = 'yes' | 'no' | 'unknown';
type TriggerName =
  | 'OB_retest'
  | 'FVG_fill'
  | 'Liquidity_Sweep'
  | 'Breakout_Retest'
  | 'Range_Sweep_Reversal';

interface DecisionCycle {
  timestamp: Date;
  ticker: string; // may not be a supported ticker — caller filters
  bias: Bias;
  triggerConfirmed: LlmAnswer;
  llmReasoningSnippet: string;
  // Raw block text for the cycle (from DECISION CYCLE marker up to the next
  // marker or the end-of-cycle line). Retained for the --debug-cycle flag.
  blockText: string;
}

// `qualifies` is tri-state-plus-null:
//   - true        → math says trigger fires
//   - false       → math says trigger does not fire
//   - 'indeterminate' → criteria partially met but a required component (e.g.
//                       the OB itself) could not be located, so we cannot
//                       agree or disagree with the LLM. Excluded from
//                       confusion-matrix counts.
//   - null        → not applicable (bias mode doesn't apply, no candle, etc.)
type Qualifies = boolean | 'indeterminate' | null;

interface TriggerResult {
  qualifies: Qualifies;
  reason: string;
}

interface CycleEval {
  cycle: DecisionCycle;
  results: Record<TriggerName, TriggerResult>;
  fetchError?: string;
  unsupported?: boolean;
}

// ==================== PER-INSTRUMENT MATRIX (codex finding #10, PR 1 prereq T1) ====================
//
// Per-design-v2 §7: each measurement metric reported per ticker. The
// confusion-matrix breakdown by instrument helps surface heterogeneity —
// GOLD / OIL_CRUDE / SILVER may respond differently to loosened thresholds
// than FX pairs. Aggregate-only views can hide instrument-specific
// hallucinations or misses.

export interface CycleVerdict {
  ticker: string;
  triggerConfirmedLLM: 'yes' | 'no' | 'unknown';
  anyTriggerMath: boolean;
}

export function buildPerInstrumentMatrix(
  cycles: CycleVerdict[],
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

// ==================== ARG PARSING ====================

function parseArg(flag: string, def: string): string {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

// ==================== LOG PARSING ====================

// Strip pm2's "YYYY-MM-DD HH:MM:SS +00:00: " prefix.
function stripPm2Prefix(line: string): string {
  return line.replace(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \+\d{2}:\d{2}: /, '');
}

function parseBiasToken(raw: string | undefined): Bias {
  if (!raw) return 'unknown';
  const w = raw.trim().toLowerCase();
  if (w.startsWith('bullish')) return 'bullish';
  if (w.startsWith('bearish')) return 'bearish';
  if (w.startsWith('neutral')) return 'neutral';
  return 'unknown';
}

function parseLog(rawContent: string): DecisionCycle[] {
  const content = rawContent.split('\n').map(stripPm2Prefix).join('\n');

  const cycles: DecisionCycle[] = [];
  const blocks = content.split(/^DECISION CYCLE\s*[—-]\s*/m);

  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];

    const dtMatch = block.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[^\s\n)]*Z)/);
    if (!dtMatch) continue;

    // === Ticker extraction (parser fix #1) ===
    // Reject "N/A", "None"; verify in supported list.
    // Anchor to "Top candidate: <TICKER>" — most reliable form.
    // If the top candidate is not in the current 7-instrument universe (e.g.
    // pre-2026-04-22 cycles with GOOGL/NZDUSD/USDCAD), mark UNKNOWN — do NOT
    // fall back to any-supported-ticker-in-block, because that would attribute
    // the cycle's verdict to the wrong instrument.
    let ticker = 'UNKNOWN';
    const topCandRe = /Top candidate[s]?:\s*\*{0,2}([A-Za-z_/]+)/g;
    let tcMatch: RegExpExecArray | null;
    while ((tcMatch = topCandRe.exec(block)) !== null) {
      const cand = tcMatch[1].toUpperCase();
      if (cand === 'N' || cand === 'N/A' || cand === 'NONE') continue;
      // Pick the first token if a multi-candidate list (split on '/').
      const head = cand.split('/')[0];
      if ((SUPPORTED_TICKERS as readonly string[]).includes(head)) {
        ticker = head;
      } else {
        ticker = `UNSUPPORTED:${head}`;
      }
      break;
    }

    // === Bias extraction (parser fix #3) ===
    // First "1H Bias:" line that has a real Bullish/Bearish/Neutral token.
    let bias: Bias = 'unknown';
    const biasLines = block.match(/1H Bias[^\n]*/g) ?? [];
    for (const line of biasLines) {
      const m = line.match(/1H Bias[^:]*:\s*\*{0,2}(\w+)/);
      const parsed = parseBiasToken(m?.[1]);
      if (parsed !== 'unknown') {
        bias = parsed;
        break;
      }
    }

    // === Trigger confirmed (parser fix #2) ===
    // Anchor to start of (already-stripped) content line. Allow markdown
    // bold/italic markers and optional emoji prefix. Reject "Trigger Test:".
    let triggerConfirmed: LlmAnswer = 'unknown';
    let snippet = '';
    const tcLines = block.split('\n');
    for (const rawLine of tcLines) {
      // Strip leading whitespace + markdown decoration.
      const line = rawLine.replace(/^[\s|>\-*]+/, '');
      // Must start with "Trigger confirmed" (case-insensitive), optionally
      // followed by bold markers, then a colon.
      const m = line.match(
        /^(?:\*{0,2})Trigger confirmed(?:\s*\(15M\))?(?:\*{0,2})\s*[:|]?\s*\**\s*(?:[❌✓✗]\s*)?(YES|NO|N\/A)\b([^\n]*)/i,
      );
      if (m) {
        const verdict = m[1].toUpperCase();
        if (verdict === 'YES') triggerConfirmed = 'yes';
        else if (verdict === 'NO') triggerConfirmed = 'no';
        else triggerConfirmed = 'unknown'; // N/A → not comparable
        snippet = m[2].trim().slice(0, 80);
        break;
      }
    }

    cycles.push({
      timestamp: new Date(dtMatch[1]),
      ticker,
      bias,
      triggerConfirmed,
      llmReasoningSnippet: snippet,
      blockText: block,
    });
  }
  return cycles;
}

// ==================== CANDLE MATH ====================

function bodyOf(c: Candle): number {
  return Math.abs(c.close - c.open);
}
function rangeOf(c: Candle): number {
  return c.high - c.low;
}
function bodyRatio(c: Candle): number {
  const r = rangeOf(c);
  return r > 0 ? bodyOf(c) / r : 0;
}
function upperWick(c: Candle): number {
  return c.high - Math.max(c.open, c.close);
}
function lowerWick(c: Candle): number {
  return Math.min(c.open, c.close) - c.low;
}
function dirOf(c: Candle): 'bullish' | 'bearish' | 'doji' {
  if (c.close > c.open) return 'bullish';
  if (c.close < c.open) return 'bearish';
  return 'doji';
}

function trueRange(c: Candle, prev: Candle | undefined): number {
  const hl = c.high - c.low;
  if (!prev) return hl;
  return Math.max(hl, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
}

function atr14(candles: Candle[]): number {
  // Need ≥ 15 candles to compute 14 TRs (the first candle has no prevClose).
  if (candles.length < 15) return 0;
  const window = candles.slice(-15);
  let sum = 0;
  for (let i = 1; i < window.length; i++) {
    sum += trueRange(window[i], window[i - 1]);
  }
  return sum / 14;
}

// ==================== TRIGGERS ====================

// Trigger 1: OB Retest
//
// Returns:
//   qualifies: true  → all 4 criteria met (body, direction, opposing wick, OB tap-depth ≤ 50%)
//   qualifies: false → at least one of (body, direction, opposing wick) failed
//   qualifies: 'indeterminate' → first 3 criteria pass but no candidate OB
//                                could be located in the 10-candle displacement
//                                lookback — we can't confirm/deny tap-depth.
//
// OB identification (minimal heuristic):
//   1. Find the most recent strong opposite-bias displacement candle in the
//      ~10 candles before the retest. "Strong" = body ≥ 0.5×range AND
//      body ≥ 1.5×ATR_15m.
//   2. The OB is the most recent same-bias-side candle (bullish for a
//      bullish-bias OB-retest, since the retest comes from below an old
//      demand zone in a bullish run, retracing into a bearish OB; vice-versa
//      for bearish) before that displacement, looking back ≤ 5 candles.
//
// Note on bias convention used here, matching the prompt spec for an OB
// Retest in a *bullish* bias: price retraces DOWN into a prior BULLISH OB
// (demand). The OB is therefore the last bullish candle before a strong
// bullish displacement up. For *bearish* bias: price retraces UP into a
// prior BEARISH OB (supply). The OB is the last bearish candle before a
// strong bearish displacement down.
//
// Tap-depth:
//   bullish bias retest into bullish OB zone [ob.low, ob.high]:
//     tap_depth_pct = (ob.high - candle.low) / (ob.high - ob.low),
//     valid when candle.low <= ob.high (penetration); require 0 ≤ pct ≤ 0.5.
//   bearish bias retest into bearish OB zone [ob.low, ob.high]:
//     tap_depth_pct = (candle.high - ob.low) / (ob.high - ob.low),
//     valid when candle.high >= ob.low; require 0 ≤ pct ≤ 0.5.
function findOrderBlock(
  m15: Candle[],
  retestIdx: number,
  bias: 'bullish' | 'bearish',
  atr: number,
): Candle | null {
  // Look back up to 10 candles before the retest for a strong displacement
  // candle in the bias direction.
  const dispDir = bias; // bullish bias → bullish displacement up
  const start = Math.max(0, retestIdx - 10);
  let dispIdx = -1;
  for (let i = retestIdx - 1; i >= start; i--) {
    const c = m15[i];
    if (!c) continue;
    if (dirOf(c) !== dispDir) continue;
    const body = bodyOf(c);
    const range = rangeOf(c);
    if (range <= 0) continue;
    if (body / range < 0.5) continue;
    // 2026-05-12 Q5 polish: ATR clause loosened 1.5× → 1.0× per codex
    // adversarial review note. In high-ATR regimes the 1.5× threshold was
    // rejecting visually strong directional candles (e.g., during news
    // events when ATR spikes). 1.0× keeps the "displacement is meaningful
    // relative to recent volatility" semantics without filtering legitimate
    // moves. The body ≥ 0.5×range clause still guards candle dominance.
    if (atr > 0 && body < 1.0 * atr) continue;
    dispIdx = i;
    break;
  }
  if (dispIdx === -1) return null;
  // The OB is the most recent same-bias candle BEFORE the displacement
  // (bullish bias → last bullish candle before bullish displacement up).
  // We treat the OB itself as the demand/supply origin, so its colour
  // matches the bias direction in this minimal-heuristic version.
  const obLookback = Math.max(0, dispIdx - 5);
  for (let i = dispIdx - 1; i >= obLookback; i--) {
    const c = m15[i];
    if (!c) continue;
    if (dirOf(c) === bias) return c;
  }
  return null;
}

function checkObRetest(
  m15: Candle[],
  bias: 'bullish' | 'bearish',
): TriggerResult {
  const L = m15.length - 1;
  const last = m15[L];
  if (!last) return { qualifies: false, reason: 'no candle' };
  const reasons: string[] = [];
  const br = bodyRatio(last);
  if (br < 0.4) reasons.push(`body ${br.toFixed(2)}<0.4`);
  const closedDir = dirOf(last);
  if (closedDir !== bias) reasons.push(`close ${closedDir}≠${bias}`);
  const opposing = bias === 'bullish' ? lowerWick(last) : upperWick(last);
  const oppRatio = bodyOf(last) > 0 ? opposing / bodyOf(last) : 0;
  if (oppRatio < 1.0) reasons.push(`opp.wick ${oppRatio.toFixed(2)}<1.0×body`);

  if (reasons.length > 0) {
    return { qualifies: false, reason: reasons.join('; ') };
  }

  // First three criteria pass — now validate tap-depth into an OB.
  const atr = atr14(m15);
  const ob = findOrderBlock(m15, L, bias, atr);
  if (!ob) {
    return {
      qualifies: 'indeterminate',
      reason: 'no OB identifiable in 10-candle displacement lookback',
    };
  }
  const obRange = ob.high - ob.low;
  if (obRange <= 0) {
    return {
      qualifies: 'indeterminate',
      reason: 'OB has zero range — cannot compute tap-depth',
    };
  }
  if (bias === 'bullish') {
    // Need penetration: last.low must be ≤ ob.high.
    if (last.low > ob.high) {
      return {
        qualifies: false,
        reason: `retest did not tap OB (low ${last.low.toFixed(5)} > OB.high ${ob.high.toFixed(5)})`,
      };
    }
    const tap = (ob.high - last.low) / obRange;
    // 2026-05-12 Q8 polish: minimum tap depth 5% per codex adversarial
    // review. The prompt spec says "tap depth ≤ 50%" with no explicit
    // minimum, but 0% (bare touch of ob.high) is vulnerable to spread/
    // rounding noise — a wick that grazes the OB boundary without real
    // penetration shouldn't count as a retest. This is a deliberate
    // audit-side hardening; the LLM may still accept bare touches.
    if (tap < 0.05 || tap > 0.5) {
      return {
        qualifies: false,
        reason: `OB tap-depth ${(tap * 100).toFixed(0)}% outside [5,50%]`,
      };
    }
    return {
      qualifies: true,
      reason: `qualifies (OB tap ${(tap * 100).toFixed(0)}%)`,
    };
  } else {
    if (last.high < ob.low) {
      return {
        qualifies: false,
        reason: `retest did not tap OB (high ${last.high.toFixed(5)} < OB.low ${ob.low.toFixed(5)})`,
      };
    }
    const tap = (last.high - ob.low) / obRange;
    // 2026-05-12 Q8 polish: see bullish branch above for rationale.
    if (tap < 0.05 || tap > 0.5) {
      return {
        qualifies: false,
        reason: `OB tap-depth ${(tap * 100).toFixed(0)}% outside [5,50%]`,
      };
    }
    return {
      qualifies: true,
      reason: `qualifies (OB tap ${(tap * 100).toFixed(0)}%)`,
    };
  }
}

// Trigger 2: FVG Fill
// A bullish FVG is the gap where candle[N-2].high < candle[N].low (3-candle
// pattern, middle candle is the imbalance). For each such gap in m15, look
// for a later candle that retraces ≥ 50% into the gap, then check the
// candle AFTER the fill: must close in bias direction with body ≥ 0.4×range.
function checkFvgFill(
  m15: Candle[],
  bias: 'bullish' | 'bearish',
): TriggerResult {
  if (m15.length < 5) return { qualifies: false, reason: 'too few candles' };
  // Look at the last candle as the "trigger candle" — was the candle before
  // it a fill of an earlier-formed FVG, in the bias direction?
  const last = m15[m15.length - 1];
  const fillCandle = m15[m15.length - 2];
  if (!last || !fillCandle) return { qualifies: false, reason: 'no candles' };

  // Body/direction of the trigger candle itself.
  const br = bodyRatio(last);
  if (br < 0.4) return { qualifies: false, reason: `trigger body ${br.toFixed(2)}<0.4` };
  if (dirOf(last) !== bias)
    return { qualifies: false, reason: `trigger closed ${dirOf(last)}≠${bias}` };

  // Look back up to 10 candles before the fill candle for an FVG.
  const lookback = Math.min(10, m15.length - 3);
  for (let f = 0; f < lookback; f++) {
    // FVG is the 3-candle pattern ending at index (m15.length - 3 - f).
    const cN = m15[m15.length - 3 - f]; // candle N
    const cN1 = m15[m15.length - 3 - f - 1]; // candle N-1 (middle)
    const cN2 = m15[m15.length - 3 - f - 2]; // candle N-2
    if (!cN || !cN1 || !cN2) break;
    if (bias === 'bullish' && cN2.high < cN.low) {
      // Bullish FVG: gap = [cN2.high, cN.low]. Fill = price retraces down
      // into the gap.
      const gapLo = cN2.high;
      const gapHi = cN.low;
      const gapRange = gapHi - gapLo;
      if (gapRange <= 0) continue;
      // The fill candle's low must dip into the gap by ≥ 50% of gap range.
      const fillDepth = gapHi - fillCandle.low;
      if (fillDepth >= 0.5 * gapRange) {
        return { qualifies: true, reason: `FVG fill (depth ${(fillDepth / gapRange * 100).toFixed(0)}%)` };
      }
    }
    if (bias === 'bearish' && cN2.low > cN.high) {
      // Bearish FVG: gap = [cN.high, cN2.low].
      const gapLo = cN.high;
      const gapHi = cN2.low;
      const gapRange = gapHi - gapLo;
      if (gapRange <= 0) continue;
      // Fill candle's high must rise into the gap by ≥ 50%.
      const fillDepth = fillCandle.high - gapLo;
      if (fillDepth >= 0.5 * gapRange) {
        return { qualifies: true, reason: `FVG fill (depth ${(fillDepth / gapRange * 100).toFixed(0)}%)` };
      }
    }
  }
  return { qualifies: false, reason: 'no qualifying FVG fill' };
}

// Trigger 3: Liquidity Sweep
// Prior swing = highest high (for bearish bias) or lowest low (for bullish)
// in last ~10 15M candles before the sweep candle. Wait — re-read spec:
// "wick exceeds prior swing by ≥ 1×spread (real sweep, not spread-tag),
// reversal candle within ≤ 2 candles, body ≥ 0.6×range, closes back
// through swept level by ≥ 1×spread in bias direction."
//
// Bullish bias: sweep is BELOW (wick takes out lowest low), reversal closes
// back ABOVE swept level. Bearish bias: sweep above highest high, reversal
// closes back below.
function checkLiquiditySweep(
  m15: Candle[],
  bias: 'bullish' | 'bearish',
  spread: number,
): TriggerResult {
  if (m15.length < 12) return { qualifies: false, reason: 'too few candles' };
  // Try sweep candle at indices L-3, L-2, L-1 (last is the reversal — ≤2
  // candles back).
  const L = m15.length - 1;
  for (let sweepBack = 0; sweepBack <= 2; sweepBack++) {
    const sweepIdx = L - sweepBack;
    if (sweepIdx < 10) continue;
    const sweep = m15[sweepIdx];
    // Prior swing: last ~10 candles BEFORE sweep candle.
    const prior = m15.slice(sweepIdx - 10, sweepIdx);
    if (prior.length === 0) continue;
    if (bias === 'bullish') {
      const swingLow = Math.min(...prior.map((c) => c.low));
      const wickExceeds = swingLow - sweep.low;
      if (wickExceeds < spread) continue;
      // Reversal candle = the candle after sweep, or the sweep itself if
      // it both swept and reversed (interpretation: spec says "reversal
      // candle within ≤ 2 candles", so reversal can be at L if sweep was
      // at L-1 or L-2).
      for (let revIdx = sweepIdx; revIdx <= L; revIdx++) {
        const rev = m15[revIdx];
        const br = bodyRatio(rev);
        if (br < 0.6) continue;
        if (dirOf(rev) !== 'bullish') continue;
        if (rev.close - swingLow < spread) continue;
        return {
          qualifies: true,
          reason: `sweep low @${swingLow.toFixed(5)}, rev body ${br.toFixed(2)}`,
        };
      }
    } else {
      const swingHigh = Math.max(...prior.map((c) => c.high));
      const wickExceeds = sweep.high - swingHigh;
      if (wickExceeds < spread) continue;
      for (let revIdx = sweepIdx; revIdx <= L; revIdx++) {
        const rev = m15[revIdx];
        const br = bodyRatio(rev);
        if (br < 0.6) continue;
        if (dirOf(rev) !== 'bearish') continue;
        if (swingHigh - rev.close < spread) continue;
        return {
          qualifies: true,
          reason: `sweep high @${swingHigh.toFixed(5)}, rev body ${br.toFixed(2)}`,
        };
      }
    }
  }
  return { qualifies: false, reason: 'no qualifying sweep+reversal' };
}

// Helper: find confirmed fractal swing-high or swing-low indices in a window.
// A fractal swing high at index `i` requires:
//   candles[i].high >= candles[i-1].high && >= candles[i-2].high  (plateau-aware left)
//   candles[i].high >  candles[i+1].high && >  candles[i+2].high  (strict right)
// (2 candles each side — Bill Williams fractal definition.)
//
// 2026-05-12 Q1 polish: switched from strict > on both sides to "plateau-aware"
// (≥ on left, > on right) per codex adversarial review. Equal-highs/double-tops/
// triple-tops are exactly the liquidity-pool patterns ICT traders watch — stop
// clusters sit there. Strict > made the audit blind to them. The "≥ left, > right"
// rule ensures the LAST candle of a plateau qualifies as the swing (not every
// flat candle), giving deterministic uniqueness.
//
// Mirror for swing lows. Returns indices in ascending order.
function findFractalSwings(
  candles: Candle[],
  direction: 'high' | 'low',
): number[] {
  const swings: number[] = [];
  for (let i = 2; i < candles.length - 2; i++) {
    const c = candles[i];
    if (direction === 'high') {
      if (
        c.high >= candles[i - 1].high &&
        c.high >= candles[i - 2].high &&
        c.high > candles[i + 1].high &&
        c.high > candles[i + 2].high
      ) {
        swings.push(i);
      }
    } else {
      if (
        c.low <= candles[i - 1].low &&
        c.low <= candles[i - 2].low &&
        c.low < candles[i + 1].low &&
        c.low < candles[i + 2].low
      ) {
        swings.push(i);
      }
    }
  }
  return swings;
}

// Trigger 4: Breakout Retest
//
// Spec (revised after adversarial review):
//   - Scan the prior 30 15M candles for fractal swing highs (bullish bias)
//     or swing lows (bearish). A swing is "confirmed" when it has 2 candles
//     of lower highs / higher lows on EACH side.
//   - Use the MOST RECENT confirmed swing as "the level."
//   - Breakout: a later 15M (or 1H, but we only have 15M here) candle CLOSES
//     beyond that swing (above for bullish, below for bearish).
//   - Retest within ≤ 6 15M candles after the breakout: the candle's wick or
//     close returns to the level.
//   - Hold: 2 consecutive 15M closes on the bias side after the retest.
//   - Trigger fires at the second hold candle and is only "current" when that
//     hold candle is the most recent (index L) candle the LLM saw.
//
// If no fractal swing exists in the 30-candle lookback, return false with
// the reason 'no confirmed fractal swing in 30-candle lookback'.
function checkBreakoutRetest(
  m15: Candle[],
  bias: 'bullish' | 'bearish',
): TriggerResult {
  if (m15.length < 10) return { qualifies: false, reason: 'too few candles' };
  const L = m15.length - 1;

  // Look back at the LAST 30 candles (or all available) for fractal swings.
  const lookbackLen = Math.min(30, m15.length);
  const lookbackStart = m15.length - lookbackLen;
  const lookback = m15.slice(lookbackStart);
  const direction = bias === 'bullish' ? 'high' : 'low';
  const swingsLocal = findFractalSwings(lookback, direction);
  if (swingsLocal.length === 0) {
    return {
      qualifies: false,
      reason: 'no confirmed fractal swing in 30-candle lookback',
    };
  }
  // Use the MOST RECENT confirmed fractal swing as "the level" (per spec).
  // We do NOT fall back to older swings: if the latest swing doesn't yield a
  // breakout+retest+hold ending at L, we report no signal. This avoids
  // claiming a "breakout" against a swing that price has already invalidated.
  const lastSwingLocalIdx = swingsLocal[swingsLocal.length - 1];
  const swingIdx = lastSwingLocalIdx + lookbackStart;
  const swing = m15[swingIdx];
  const level = bias === 'bullish' ? swing.high : swing.low;

  // The breakout must happen AFTER the swing has been confirmed
  // (swingIdx + 2 is the earliest candle that "knows" the swing exists).
  // The breakout candle is some candle in [swingIdx+2 .. L-3] so we still
  // have room for a retest within 6 + 2 hold candles before L.
  for (let brkIdx = swingIdx + 2; brkIdx <= L - 3; brkIdx++) {
    const brk = m15[brkIdx];
    if (!brk) continue;
    if (bias === 'bullish') {
      if (brk.close <= level) continue;
    } else {
      if (brk.close >= level) continue;
    }

    // Retest within ≤ 6 candles after the breakout.
    for (let r = 1; r <= 6 && brkIdx + r + 2 <= L; r++) {
      const ret = m15[brkIdx + r];
      if (!ret) continue;
      // Retest = wick or close returns to the level.
      const retested =
        bias === 'bullish' ? ret.low <= level : ret.high >= level;
      if (!retested) continue;
      // Hold = 2 consecutive closes on bias side after retest.
      const hold1 = m15[brkIdx + r + 1];
      const hold2 = m15[brkIdx + r + 2];
      if (!hold1 || !hold2) continue;
      const heldBullish = hold1.close > level && hold2.close > level;
      const heldBearish = hold1.close < level && hold2.close < level;
      const held = bias === 'bullish' ? heldBullish : heldBearish;
      if (!held) continue;
      // Trigger is "current" only if the second hold candle is L.
      if (brkIdx + r + 2 === L) {
        return {
          qualifies: true,
          reason: `fractal-swing@idx${swingIdx} lvl=${level.toFixed(5)}, brk@idx${brkIdx}, retest+${r}, hold confirmed`,
        };
      }
    }
  }
  return {
    qualifies: false,
    reason: `most-recent fractal swing@idx${swingIdx} (${level.toFixed(5)}) — no qualifying breakout+retest+hold ending at last candle`,
  };
}

// Trigger 5: Range Sweep Reversal (range-mode / neutral bias only)
function checkRangeSweepReversal(
  m15: Candle[],
  h1: Candle[],
  spread: number,
): TriggerResult {
  if (h1.length < 8) return { qualifies: false, reason: '<8 1H candles' };
  if (m15.length < 17) return { qualifies: false, reason: '<17 15M candles (need ATR + history)' };
  const recent1h = h1.slice(-8);
  const rangeHigh = Math.max(...recent1h.map((c) => c.high));
  const rangeLow = Math.min(...recent1h.map((c) => c.low));
  const rangeWidth = rangeHigh - rangeLow;
  const atr = atr14(m15);
  if (atr <= 0) return { qualifies: false, reason: 'ATR=0' };
  if (rangeWidth < 1.5 * atr)
    return { qualifies: false, reason: `range ${rangeWidth.toFixed(5)} < 1.5×ATR ${(1.5 * atr).toFixed(5)}` };
  const wickFloor = Math.max(2 * spread, 0.10 * atr);
  const L = m15.length - 1;
  // Try sweep candle at L-2, L-1, L; reversal must close back inside.
  for (let sweepBack = 0; sweepBack <= 2; sweepBack++) {
    const sweepIdx = L - sweepBack;
    if (sweepIdx < 0) continue;
    const sweep = m15[sweepIdx];
    // Sweep above range high.
    if (sweep.high - rangeHigh >= wickFloor) {
      for (let revIdx = sweepIdx; revIdx <= L; revIdx++) {
        const rev = m15[revIdx];
        if (bodyRatio(rev) < 0.6) continue;
        if (dirOf(rev) !== 'bearish') continue;
        if (rangeHigh - rev.close < spread) continue;
        return {
          qualifies: true,
          reason: `sweep>${rangeHigh.toFixed(5)} → SHORT, rev body ${bodyRatio(rev).toFixed(2)}`,
        };
      }
    }
    // Sweep below range low.
    if (rangeLow - sweep.low >= wickFloor) {
      for (let revIdx = sweepIdx; revIdx <= L; revIdx++) {
        const rev = m15[revIdx];
        if (bodyRatio(rev) < 0.6) continue;
        if (dirOf(rev) !== 'bullish') continue;
        if (rev.close - rangeLow < spread) continue;
        return {
          qualifies: true,
          reason: `sweep<${rangeLow.toFixed(5)} → LONG, rev body ${bodyRatio(rev).toFixed(2)}`,
        };
      }
    }
  }
  return { qualifies: false, reason: 'no qualifying range sweep+reversal' };
}

// ==================== EVAL ONE CYCLE ====================

function naResult(reason: string): TriggerResult {
  return { qualifies: null, reason };
}

async function evaluateCycle(
  capital: CapitalClient,
  cycle: DecisionCycle,
): Promise<CycleEval> {
  const empty: Record<TriggerName, TriggerResult> = {
    OB_retest: naResult('-'),
    FVG_fill: naResult('-'),
    Liquidity_Sweep: naResult('-'),
    Breakout_Retest: naResult('-'),
    Range_Sweep_Reversal: naResult('-'),
  };

  if (!(SUPPORTED_TICKERS as readonly string[]).includes(cycle.ticker)) {
    return { cycle, results: empty, unsupported: true };
  }
  const ticker = cycle.ticker as Ticker;
  const spread = TYPICAL_SPREAD[ticker];

  // Fetch ~25 15M candles ending at the decision timestamp, and 10 1H.
  // Capital.com rejects ISO timestamps with milliseconds or trailing 'Z'.
  // Use plain "YYYY-MM-DDTHH:mm:ss" form.
  const fmtCapTs = (d: Date): string =>
    d.toISOString().replace(/\.\d{3}Z$/, '');
  const decTs = cycle.timestamp;
  const m15From = fmtCapTs(new Date(decTs.getTime() - 25 * 15 * 60 * 1000));
  const h1From = fmtCapTs(new Date(decTs.getTime() - 12 * 60 * 60 * 1000));
  const to = fmtCapTs(new Date(decTs.getTime() + 60 * 1000));

  let m15: Candle[] = [];
  let h1: Candle[] = [];
  try {
    m15 = await capital.getCandlesAsCandles(ticker, '15m', 30, m15From, to);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { cycle, results: empty, fetchError: `15m: ${msg.slice(0, 60)}` };
  }
  await new Promise((r) => setTimeout(r, RATE_LIMIT_MS));
  try {
    h1 = await capital.getCandlesAsCandles(ticker, '1h', 12, h1From, to);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { cycle, results: empty, fetchError: `1h: ${msg.slice(0, 60)}` };
  }

  if (m15.length === 0) {
    return { cycle, results: empty, fetchError: 'no 15m candles' };
  }

  const results: Record<TriggerName, TriggerResult> = { ...empty };

  if (cycle.bias === 'bullish' || cycle.bias === 'bearish') {
    results.OB_retest = checkObRetest(m15, cycle.bias);
    results.FVG_fill = checkFvgFill(m15, cycle.bias);
    results.Liquidity_Sweep = checkLiquiditySweep(m15, cycle.bias, spread);
    results.Breakout_Retest = checkBreakoutRetest(m15, cycle.bias);
    results.Range_Sweep_Reversal = naResult('n/a-bias');
  } else if (cycle.bias === 'neutral') {
    results.OB_retest = naResult('n/a-bias');
    results.FVG_fill = naResult('n/a-bias');
    results.Liquidity_Sweep = naResult('n/a-bias');
    results.Breakout_Retest = naResult('n/a-bias');
    results.Range_Sweep_Reversal = checkRangeSweepReversal(m15, h1, spread);
  } else {
    // unknown bias — skip everything.
  }

  return { cycle, results };
}

// ==================== OUTPUT ====================

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

function shortResult(r: TriggerResult): string {
  if (r.qualifies === null) return r.reason === '-' ? '-' : 'n/a-bias';
  if (r.qualifies === 'indeterminate') return 'INDETERM';
  return r.qualifies ? 'PASSES' : 'FAILS';
}

function anyPositive(results: Record<TriggerName, TriggerResult>): boolean {
  return Object.values(results).some((r) => r.qualifies === true);
}

function determineFlag(
  cycle: DecisionCycle,
  results: Record<TriggerName, TriggerResult>,
): string {
  if (cycle.triggerConfirmed === 'unknown') return '(LLM verdict not captured)';
  // If we couldn't parse bias, no trigger was evaluated — skip classification.
  if (cycle.bias === 'unknown') return '(bias not parsed — no triggers evaluated)';
  const matchExists = anyPositive(results);
  if (cycle.triggerConfirmed === 'yes' && matchExists)
    return '(agreement: LLM yes, ≥1 trigger qualifies)';
  if (cycle.triggerConfirmed === 'no' && !matchExists)
    return '(agreement: LLM no, no trigger qualifies)';
  if (cycle.triggerConfirmed === 'yes' && !matchExists)
    return '⚠ POSSIBLE-HALLUCINATION (LLM said yes, no trigger matches)';
  return '⚠ POSSIBLE-MISS (LLM said no, ≥1 trigger qualifies)';
}

// ==================== DEBUG-CYCLE ====================

// Extract the LLM reasoning prose for a single cycle: everything between
// "DECISION CYCLE" and the next "ICT Trading Agent complete" line (the
// marker the agent prints at the end of its reasoning). Falls back to the
// full block if that marker isn't found.
function extractReasoningProse(blockText: string): string {
  const endMarkerMatch = blockText.match(
    /ICT Trading Agent complete[^\n]*/,
  );
  if (!endMarkerMatch || endMarkerMatch.index === undefined) {
    return blockText.trim();
  }
  return blockText.slice(0, endMarkerMatch.index + endMarkerMatch[0].length).trim();
}

function formatCandle(c: Candle, prev: Candle | undefined, idx: number): string {
  const body = bodyOf(c);
  const range = rangeOf(c);
  const br = bodyRatio(c);
  const uw = upperWick(c);
  const lw = lowerWick(c);
  const dir = dirOf(c);
  const ts = c.datetime ? String(c.datetime).slice(0, 19) : '?';
  const tr = trueRange(c, prev);
  return (
    `  [${pad(String(idx), 2)}] ${ts} | ` +
    `O=${c.open.toFixed(5)} H=${c.high.toFixed(5)} ` +
    `L=${c.low.toFixed(5)} C=${c.close.toFixed(5)} | ` +
    `body=${body.toFixed(5)} range=${range.toFixed(5)} ` +
    `br=${br.toFixed(2)} uw=${uw.toFixed(5)} lw=${lw.toFixed(5)} ` +
    `tr=${tr.toFixed(5)} dir=${dir}`
  );
}

async function runDebugCycle(
  rawContent: string,
  targetTs: string,
): Promise<void> {
  const cycles = parseLog(rawContent);
  // Allow partial match: the user may pass "2026-05-04T09:15:00" while the
  // log has "2026-05-04T09:15:00.123Z". Match by prefix.
  const target = cycles.find((c) => c.timestamp.toISOString().startsWith(targetTs));
  if (!target) {
    console.error(`No cycle found matching timestamp "${targetTs}".`);
    console.error('Available timestamps near the request (first 5):');
    for (const c of cycles.slice(0, 5)) {
      console.error(`  ${c.timestamp.toISOString()} | ${c.ticker} | ${c.bias} | LLM=${c.triggerConfirmed}`);
    }
    process.exit(1);
  }

  console.log('\n' + '='.repeat(120));
  console.log(`DEBUG-CYCLE: ${target.timestamp.toISOString()}`);
  console.log('='.repeat(120));
  console.log('\nCycle metadata:');
  console.log(`  timestamp:           ${target.timestamp.toISOString()}`);
  console.log(`  ticker:              ${target.ticker}`);
  console.log(`  bias:                ${target.bias}`);
  console.log(`  LLM triggerConfirmed: ${target.triggerConfirmed}`);
  console.log(`  claimed-setup snippet: ${target.llmReasoningSnippet || '(none)'}`);

  console.log('\n--- LLM reasoning prose (full block) ---');
  console.log(extractReasoningProse(target.blockText));
  console.log('--- end LLM reasoning prose ---\n');

  // Capital.com env vars.
  const apiKey = process.env.CAPITAL_API_KEY ?? '';
  const identifier = process.env.CAPITAL_IDENTIFIER ?? '';
  const password = process.env.CAPITAL_API_KEY_PASSWORD ?? '';
  const baseURL =
    process.env.CAPITAL_API_URL ?? 'https://demo-api-capital.backend-capital.com';
  if (!apiKey || !identifier || !password) {
    console.error(
      'Missing Capital.com credentials. Set CAPITAL_API_KEY, CAPITAL_IDENTIFIER, CAPITAL_API_KEY_PASSWORD.',
    );
    process.exit(1);
  }
  if (!(SUPPORTED_TICKERS as readonly string[]).includes(target.ticker)) {
    console.log(`(Ticker ${target.ticker} is not in supported list — skipping candle fetch.)`);
    return;
  }
  const ticker = target.ticker as Ticker;
  const spread = TYPICAL_SPREAD[ticker];

  const capital = new CapitalClient({ apiKey, identifier, password, baseURL });
  const fmtCapTs = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, '');
  const decTs = target.timestamp;
  const m15From = fmtCapTs(new Date(decTs.getTime() - 25 * 15 * 60 * 1000));
  const h1From = fmtCapTs(new Date(decTs.getTime() - 12 * 60 * 60 * 1000));
  const to = fmtCapTs(new Date(decTs.getTime() + 60 * 1000));

  let m15: Candle[] = [];
  let h1: Candle[] = [];
  try {
    m15 = await capital.getCandlesAsCandles(ticker, '15m', 30, m15From, to);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`Fetch error (15m): ${msg}`);
    try {
      await capital.logout();
    } catch {
      /* ignore */
    }
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, RATE_LIMIT_MS));
  try {
    h1 = await capital.getCandlesAsCandles(ticker, '1h', 12, h1From, to);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`Fetch error (1h): ${msg}`);
  }

  const atr = atr14(m15);
  console.log(`ATR(14) on 15M = ${atr.toFixed(5)}`);
  console.log(`Spread (typical) = ${spread.toFixed(5)}`);

  console.log(`\nFetched 15M candles (showing last 10 of ${m15.length}):`);
  const m15Slice = m15.slice(-10);
  for (let i = 0; i < m15Slice.length; i++) {
    const c = m15Slice[i];
    const globalIdx = m15.length - m15Slice.length + i;
    const prev = globalIdx > 0 ? m15[globalIdx - 1] : undefined;
    console.log(formatCandle(c, prev, globalIdx));
  }

  console.log(`\nFetched 1H candles (showing last 10 of ${h1.length}):`);
  const h1Slice = h1.slice(-10);
  for (let i = 0; i < h1Slice.length; i++) {
    const c = h1Slice[i];
    const globalIdx = h1.length - h1Slice.length + i;
    const prev = globalIdx > 0 ? h1[globalIdx - 1] : undefined;
    console.log(formatCandle(c, prev, globalIdx));
  }

  // Run every detector that could apply, regardless of bias, so the user
  // can see why each one fired or didn't.
  console.log('\nDetector outputs:');
  const biases: Array<'bullish' | 'bearish'> = ['bullish', 'bearish'];
  if (target.bias === 'bullish' || target.bias === 'bearish') {
    const b = target.bias;
    const obR = checkObRetest(m15, b);
    const fvgR = checkFvgFill(m15, b);
    const lsR = checkLiquiditySweep(m15, b, spread);
    const brR = checkBreakoutRetest(m15, b);
    console.log(`  bias = ${b} (trend-mode triggers):`);
    console.log(`    OB_retest:        qualifies=${String(obR.qualifies)} | ${obR.reason}`);
    console.log(`    FVG_fill:         qualifies=${String(fvgR.qualifies)} | ${fvgR.reason}`);
    console.log(`    Liquidity_Sweep:  qualifies=${String(lsR.qualifies)} | ${lsR.reason}`);
    console.log(`    Breakout_Retest:  qualifies=${String(brR.qualifies)} | ${brR.reason}`);
    // Also show fractal-swing diagnostic for Breakout_Retest.
    const lookbackLen = Math.min(30, m15.length);
    const direction = b === 'bullish' ? 'high' : 'low';
    const lookback = m15.slice(m15.length - lookbackLen);
    const swingsLocal = findFractalSwings(lookback, direction);
    if (swingsLocal.length === 0) {
      console.log(`    └─ fractal swings in last ${lookbackLen} candles: NONE`);
    } else {
      const desc = swingsLocal
        .map((i) => {
          const globalIdx = i + (m15.length - lookbackLen);
          const c = m15[globalIdx];
          const lvl = direction === 'high' ? c.high : c.low;
          return `idx${globalIdx}@${lvl.toFixed(5)}`;
        })
        .join(', ');
      console.log(`    └─ fractal swings in last ${lookbackLen} candles: ${desc}`);
    }
    // OB-identification diagnostic.
    const ob = findOrderBlock(m15, m15.length - 1, b, atr);
    if (ob) {
      console.log(`    └─ identified OB: O=${ob.open.toFixed(5)} H=${ob.high.toFixed(5)} L=${ob.low.toFixed(5)} C=${ob.close.toFixed(5)}`);
    } else {
      console.log(`    └─ identified OB: NONE in 10-candle displacement lookback`);
    }
  } else if (target.bias === 'neutral') {
    const rsR = checkRangeSweepReversal(m15, h1, spread);
    console.log(`  bias = neutral (range-mode trigger):`);
    console.log(`    Range_Sweep_Reversal: qualifies=${String(rsR.qualifies)} | ${rsR.reason}`);
  } else {
    console.log(`  bias = ${target.bias} — no trigger evaluated.`);
    // Still show both trend-mode runs so the user can see what each would
    // have said if bias had parsed.
    for (const b of biases) {
      const obR = checkObRetest(m15, b);
      const fvgR = checkFvgFill(m15, b);
      const lsR = checkLiquiditySweep(m15, b, spread);
      const brR = checkBreakoutRetest(m15, b);
      console.log(`  hypothetical bias=${b}:`);
      console.log(`    OB_retest:        qualifies=${String(obR.qualifies)} | ${obR.reason}`);
      console.log(`    FVG_fill:         qualifies=${String(fvgR.qualifies)} | ${fvgR.reason}`);
      console.log(`    Liquidity_Sweep:  qualifies=${String(lsR.qualifies)} | ${lsR.reason}`);
      console.log(`    Breakout_Retest:  qualifies=${String(brR.qualifies)} | ${brR.reason}`);
    }
  }

  try {
    await capital.logout();
  } catch {
    /* ignore */
  }
}

// ==================== MAIN ====================

async function main(): Promise<void> {
  const logPath = parseArg('--log', `${process.env.HOME ?? ''}/trading-bot/data/pm2-out.log`);
  const days = Number(parseArg('--days', '14'));
  const debugCycle = parseArg('--debug-cycle', '');

  // --debug-cycle: forensic single-cycle inspection. Skips the normal audit
  // output entirely.
  if (debugCycle) {
    let rawDebug: string;
    try {
      rawDebug = readFileSync(logPath, 'utf-8');
    } catch (e) {
      console.error(`ERROR reading ${logPath}: ${(e as Error).message}`);
      process.exit(1);
    }
    await runDebugCycle(rawDebug, debugCycle);
    return;
  }

  // Capital.com env vars (exact names per .env.example).
  const apiKey = process.env.CAPITAL_API_KEY ?? '';
  const identifier = process.env.CAPITAL_IDENTIFIER ?? '';
  const password = process.env.CAPITAL_API_KEY_PASSWORD ?? '';
  const baseURL =
    process.env.CAPITAL_API_URL ?? 'https://demo-api-capital.backend-capital.com';

  if (!apiKey || !identifier || !password) {
    console.error(
      'Missing Capital.com credentials. Set CAPITAL_API_KEY, CAPITAL_IDENTIFIER, CAPITAL_API_KEY_PASSWORD.',
    );
    process.exit(1);
  }

  console.log('\nFaradbot trigger-decision audit (v2 — all 5 triggers, Capital data)');
  console.log(`  log:      ${logPath}`);
  console.log(`  window:   last ${days} days`);
  console.log(`  triggers: OB_retest, FVG_fill, Liquidity_Sweep, Breakout_Retest (trend); Range_Sweep_Reversal (neutral)`);
  console.log(`  source:   Capital.com mid candles\n`);

  let rawContent: string;
  try {
    rawContent = readFileSync(logPath, 'utf-8');
  } catch (e) {
    console.error(`ERROR reading ${logPath}: ${(e as Error).message}`);
    process.exit(1);
  }

  const cycles = parseLog(rawContent);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const recent = cycles.filter(
    (c) =>
      c.timestamp >= cutoff &&
      c.triggerConfirmed !== 'unknown' &&
      (SUPPORTED_TICKERS as readonly string[]).includes(c.ticker),
  );

  console.log(`Parsed ${cycles.length} total cycles, ${recent.length} comparable in window\n`);
  if (recent.length === 0) {
    console.log('(no comparable cycles — try a larger --days, or check log freshness)');
    return;
  }

  const capital = new CapitalClient({ apiKey, identifier, password, baseURL });

  // Header
  const HDR =
    pad('timestamp_utc', 19) +
    ' | ' +
    pad('ticker', 9) +
    ' | ' +
    pad('bias', 8) +
    ' | ' +
    pad('llm', 3) +
    ' | ' +
    pad('OB', 9) +
    ' | ' +
    pad('FVG', 9) +
    ' | ' +
    pad('LiqSwp', 9) +
    ' | ' +
    pad('BrkRet', 9) +
    ' | ' +
    pad('RngSwp', 9) +
    ' | flag';
  console.log(HDR);
  console.log('-'.repeat(HDR.length));

  const evals: CycleEval[] = [];
  let fetchErrors = 0;

  for (const cycle of recent) {
    let ev: CycleEval;
    try {
      ev = await evaluateCycle(capital, cycle);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ev = {
        cycle,
        results: {
          OB_retest: naResult('-'),
          FVG_fill: naResult('-'),
          Liquidity_Sweep: naResult('-'),
          Breakout_Retest: naResult('-'),
          Range_Sweep_Reversal: naResult('-'),
        },
        fetchError: msg.slice(0, 80),
      };
    }
    evals.push(ev);

    const ts = cycle.timestamp.toISOString().slice(0, 19);
    const tk = pad(cycle.ticker, 9);
    const bi = pad(cycle.bias, 8);
    const llm = pad(cycle.triggerConfirmed, 3);

    if (ev.fetchError) {
      fetchErrors++;
      console.log(
        `${ts} | ${tk} | ${bi} | ${llm} | ${pad('FETCH_ERROR', 9)} | ${pad('-', 9)} | ${pad('-', 9)} | ${pad('-', 9)} | ${pad('-', 9)} | ${ev.fetchError}`,
      );
      continue;
    }

    const flag = determineFlag(cycle, ev.results);
    console.log(
      `${ts} | ${tk} | ${bi} | ${llm} | ${pad(shortResult(ev.results.OB_retest), 9)} | ${pad(shortResult(ev.results.FVG_fill), 9)} | ${pad(shortResult(ev.results.Liquidity_Sweep), 9)} | ${pad(shortResult(ev.results.Breakout_Retest), 9)} | ${pad(shortResult(ev.results.Range_Sweep_Reversal), 9)} | ${flag}`,
    );

    await new Promise((r) => setTimeout(r, RATE_LIMIT_MS));
  }

  // Capital cleanup
  try {
    await capital.logout();
  } catch {
    /* ignore */
  }

  // ==================== SUMMARY ====================
  console.log('\n' + '='.repeat(120));
  console.log('SUMMARY');
  console.log('='.repeat(120));

  // Per-trigger confusion matrix.
  // Counting rule (from spec): only count where the LLM's answer is
  // comparable to the trigger:
  //   - LLM=yes votes for ALL triggers whose bias-mode matches (the LLM
  //     can only fire one trigger, but the math could match any single
  //     trigger and that's a "true positive" for at least one).
  //   - LLM=no votes against ALL triggers whose bias-mode matches (a
  //     "no" claim means none should fire — so every trigger that the
  //     math says PASSES is a false-negative; every FAIL is a true-negative).
  // Result: ANY-match interpretation.
  const triggers: TriggerName[] = [
    'OB_retest',
    'FVG_fill',
    'Liquidity_Sweep',
    'Breakout_Retest',
    'Range_Sweep_Reversal',
  ];

  console.log('\nPer-trigger confusion matrix (LLM verdict vs. math result):');
  console.log(
    `  ${pad('trigger', 22)} | ${pad('TP', 5)} | ${pad('TN', 5)} | ${pad('FP', 5)} | ${pad('FN', 5)} | ${pad('INDETERM', 9)} | comparable`,
  );
  console.log('  ' + '-'.repeat(72));
  let totalIndeterminate = 0;
  for (const t of triggers) {
    let tp = 0,
      tn = 0,
      fp = 0,
      fn = 0,
      indeterminate = 0;
    for (const ev of evals) {
      if (ev.fetchError || ev.unsupported) continue;
      const r = ev.results[t];
      if (r.qualifies === null) continue;
      // 'indeterminate' is neither agreement nor disagreement — track
      // separately and exclude from TP/TN/FP/FN.
      if (r.qualifies === 'indeterminate') {
        indeterminate++;
        continue;
      }
      const llm = ev.cycle.triggerConfirmed;
      if (llm === 'yes' && r.qualifies === true) tp++;
      else if (llm === 'no' && r.qualifies === false) tn++;
      else if (llm === 'yes' && r.qualifies === false) fp++;
      else if (llm === 'no' && r.qualifies === true) fn++;
    }
    const total = tp + tn + fp + fn;
    if (t === 'OB_retest') totalIndeterminate = indeterminate;
    console.log(
      `  ${pad(t, 22)} | ${pad(String(tp), 5)} | ${pad(String(tn), 5)} | ${pad(String(fp), 5)} | ${pad(String(fn), 5)} | ${pad(String(indeterminate), 9)} | ${total}`,
    );
  }
  if (totalIndeterminate > 0) {
    console.log(
      `\n  OB_retest indeterminate cases: ${totalIndeterminate} — neither agreement nor disagreement.`,
    );
  }

  // Per-instrument confusion matrix (codex finding #10 — design v2 §7).
  // Adapts the evals[] structure into the simpler CycleVerdict[] shape that
  // buildPerInstrumentMatrix consumes. anyTriggerMath = any of the 5 triggers
  // qualifies for this cycle.
  const cycleVerdicts: CycleVerdict[] = evals
    .filter((ev) => !ev.fetchError && !ev.unsupported)
    .map((ev) => {
      const anyTriggerMath = triggers.some((t) => ev.results[t].qualifies === true);
      return {
        ticker: ev.cycle.ticker,
        triggerConfirmedLLM: ev.cycle.triggerConfirmed,
        anyTriggerMath,
      };
    });
  const perInstrument = buildPerInstrumentMatrix(cycleVerdicts);
  if (Object.keys(perInstrument).length > 0) {
    console.log('\nPer-instrument confusion matrix (ANY-trigger rule):');
    console.log(`  ${pad('ticker', 10)} | ${pad('TP', 3)} | ${pad('TN', 3)} | ${pad('FP', 3)} | ${pad('FN', 3)}`);
    console.log('  ' + '-'.repeat(34));
    for (const [ticker, m] of Object.entries(perInstrument).sort()) {
      console.log(
        `  ${pad(ticker, 10)} | ${pad(String(m.tp), 3)} | ${pad(String(m.tn), 3)} | ${pad(String(m.fp), 3)} | ${pad(String(m.fn), 3)}`,
      );
    }
  }

  // Overall agreement (ANY-trigger rule).
  let agree = 0,
    disagree = 0;
  const mismatches: Array<{ ev: CycleEval; flag: string }> = [];
  for (const ev of evals) {
    if (ev.fetchError || ev.unsupported) continue;
    const flag = determineFlag(ev.cycle, ev.results);
    if (flag.startsWith('(bias not parsed') || flag.startsWith('(LLM verdict not')) continue;
    if (flag.startsWith('(agreement')) agree++;
    else if (flag.startsWith('⚠')) {
      disagree++;
      mismatches.push({ ev, flag });
    }
  }
  const total = agree + disagree;
  console.log(`\nOverall agreement (any-trigger rule):`);
  if (total > 0) {
    console.log(`  Agreements:    ${agree} / ${total} (${((agree / total) * 100).toFixed(1)}%)`);
    console.log(`  Disagreements: ${disagree} / ${total} (${((disagree / total) * 100).toFixed(1)}%)`);
  } else {
    console.log('  (no comparable cycles)');
  }
  console.log(`  Fetch errors:  ${fetchErrors}`);

  if (mismatches.length > 0) {
    console.log(`\nMismatches (${mismatches.length}):`);
    for (const { ev, flag } of mismatches) {
      const ts = ev.cycle.timestamp.toISOString().slice(0, 19);
      const passingTriggers = triggers.filter((t) => ev.results[t].qualifies === true);
      console.log(
        `  ${ts} | ${ev.cycle.ticker} | ${ev.cycle.bias} | LLM=${ev.cycle.triggerConfirmed} | passing: ${passingTriggers.join(',') || 'none'} | ${flag.replace('⚠ ', '')}`,
      );
    }
  }

  console.log('\nInterpretation:');
  console.log('  - High FN count = LLM may be overcautious; deterministic detector could unlock trades.');
  console.log('  - High FP count = LLM may be miscounting; analyst CHECK 1 sanity gate is the safety net.');
  console.log('  - Spread approx (TYPICAL_SPREAD) may bias Liq_Sweep / Range_Sweep results in either direction.');
  console.log('  - OB_retest INDETERMINATE = OB candidate not identifiable; excluded from agreement counts.');
  console.log('  - Breakout_Retest now uses fractal swings (2-each-side) for level identification.\n');
}

main().catch((e) => {
  console.error('Audit failed:', e);
  process.exit(1);
});

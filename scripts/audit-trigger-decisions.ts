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
// === OB Retest tap-depth caveat ===
// The OB Retest spec also requires "tap depth ≤ 50% inside the OB". This
// audit does NOT validate that condition (would require identifying the OB
// boundary, which is itself a multi-candle pattern). The other 3 criteria are
// reported; tap-depth shows as "OB not validated" in the reason chain.
//
// === Usage ===
//   npx tsx scripts/audit-trigger-decisions.ts [--log <path>] [--days <N>]
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
}

interface TriggerResult {
  qualifies: boolean | null; // null = n/a (bias-mismatched)
  reason: string;
}

interface CycleEval {
  cycle: DecisionCycle;
  results: Record<TriggerName, TriggerResult>;
  fetchError?: string;
  unsupported?: boolean;
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
function checkObRetest(
  m15: Candle[],
  bias: 'bullish' | 'bearish',
): TriggerResult {
  const last = m15[m15.length - 1];
  if (!last) return { qualifies: false, reason: 'no candle' };
  const reasons: string[] = [];
  const br = bodyRatio(last);
  if (br < 0.4) reasons.push(`body ${br.toFixed(2)}<0.4`);
  const closedDir = dirOf(last);
  if (closedDir !== bias) reasons.push(`close ${closedDir}≠${bias}`);
  const opposing = bias === 'bullish' ? lowerWick(last) : upperWick(last);
  const oppRatio = bodyOf(last) > 0 ? opposing / bodyOf(last) : 0;
  if (oppRatio < 1.0) reasons.push(`opp.wick ${oppRatio.toFixed(2)}<1.0×body`);
  if (reasons.length === 0) {
    return { qualifies: true, reason: 'qualifies (OB not validated)' };
  }
  return { qualifies: false, reason: reasons.join('; ') };
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

// Trigger 4: Breakout Retest
// "Level broken on a 1H or 15M close" — identify level as the most recent
// significant swing high (bullish bias) or swing low (bearish) in prior 20
// 15M candles. Breakout = close beyond. Retest within ≤ 6×15M candles. Hold
// = 2 consecutive 15M closes on the bias side after retest.
function checkBreakoutRetest(
  m15: Candle[],
  bias: 'bullish' | 'bearish',
): TriggerResult {
  if (m15.length < 25) return { qualifies: false, reason: 'too few candles' };
  const L = m15.length - 1;
  // Scan for a breakout candle in the last 10 candles, then look for retest
  // + hold after it.
  for (let brkBack = 2; brkBack <= 10; brkBack++) {
    const brkIdx = L - brkBack;
    if (brkIdx < 20) continue;
    // Prior 20 candles before breakout.
    const prior = m15.slice(brkIdx - 20, brkIdx);
    if (prior.length < 5) continue;
    if (bias === 'bullish') {
      const level = Math.max(...prior.map((c) => c.high));
      const brk = m15[brkIdx];
      if (brk.close <= level) continue;
      // Look for retest in next ≤6 candles, then hold by next 2 closes.
      for (let r = 1; r <= 6 && brkIdx + r + 2 <= L; r++) {
        const ret = m15[brkIdx + r];
        // Retest = candle's low touches or goes below level (wick or close).
        if (ret.low > level) continue;
        // Hold = next 2 closes above level.
        const hold1 = m15[brkIdx + r + 1];
        const hold2 = m15[brkIdx + r + 2];
        if (hold1.close > level && hold2.close > level) {
          // Trigger fires at the second hold candle. Accept only if the
          // trigger candle is at L (most recent — what the LLM would see).
          if (brkIdx + r + 2 === L) {
            return { qualifies: true, reason: `brk @${level.toFixed(5)}, retest +${r}, hold confirmed` };
          }
        }
      }
    } else {
      const level = Math.min(...prior.map((c) => c.low));
      const brk = m15[brkIdx];
      if (brk.close >= level) continue;
      for (let r = 1; r <= 6 && brkIdx + r + 2 <= L; r++) {
        const ret = m15[brkIdx + r];
        if (ret.high < level) continue;
        const hold1 = m15[brkIdx + r + 1];
        const hold2 = m15[brkIdx + r + 2];
        if (hold1.close < level && hold2.close < level) {
          if (brkIdx + r + 2 === L) {
            return { qualifies: true, reason: `brk @${level.toFixed(5)}, retest +${r}, hold confirmed` };
          }
        }
      }
    }
  }
  return { qualifies: false, reason: 'no qualifying breakout+retest+hold' };
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

// ==================== MAIN ====================

async function main(): Promise<void> {
  const logPath = parseArg('--log', `${process.env.HOME ?? ''}/trading-bot/data/pm2-out.log`);
  const days = Number(parseArg('--days', '14'));

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
    `  ${pad('trigger', 22)} | ${pad('TP', 5)} | ${pad('TN', 5)} | ${pad('FP', 5)} | ${pad('FN', 5)} | comparable`,
  );
  console.log('  ' + '-'.repeat(60));
  for (const t of triggers) {
    let tp = 0,
      tn = 0,
      fp = 0,
      fn = 0;
    for (const ev of evals) {
      if (ev.fetchError || ev.unsupported) continue;
      const r = ev.results[t];
      if (r.qualifies === null) continue;
      const llm = ev.cycle.triggerConfirmed;
      if (llm === 'yes' && r.qualifies) tp++;
      else if (llm === 'no' && !r.qualifies) tn++;
      else if (llm === 'yes' && !r.qualifies) fp++;
      else if (llm === 'no' && r.qualifies) fn++;
    }
    const total = tp + tn + fp + fn;
    console.log(
      `  ${pad(t, 22)} | ${pad(String(tp), 5)} | ${pad(String(tn), 5)} | ${pad(String(fp), 5)} | ${pad(String(fn), 5)} | ${total}`,
    );
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
  console.log('  - OB tap-depth NOT validated — true OB_retest count may be lower than reported PASSES.\n');
}

main().catch((e) => {
  console.error('Audit failed:', e);
  process.exit(1);
});

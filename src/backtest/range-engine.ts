// Range-mode backtest engine extension (US-4 / Spec 001 / T074-T076).
//
// The main backtest engine at src/backtest/engine.ts skips neutral-1H
// bars because trigger-5 (range sweep reversal) requires 15M data and
// spread/ATR floors the legacy engine doesn't model. This module fills
// that gap with a 1H-only simplified range-mode replay so we can
// produce comparative win-rate evidence for the score-59 cap decision.
//
// Methodology (1H simplified — see file header at engine.ts for full
// trigger-5 spec):
//   - Range = prior 8 1H candles
//   - Range width = max(highs) - min(lows)
//   - Range width must be >= 1.5 * ATR (per ict-agent.md s.I trigger 5)
//   - Sweep detection: current 1H candle's wick exceeds range extreme
//     by >= 1 * spread AND closes back INSIDE the range
//   - Entry: next 1H candle's open
//   - SL: 0.5 * ATR beyond the swept extreme
//   - TP1: mid-range (50% of range height)
//   - TP2: opposite range extreme
//   - Risk per trade: 0.25% (range-mode half-size per spec)
//
// Comparison rendered:
//   * Cap-on  (current behaviour, all range-mode setups Tier 3 / 0.5%)
//   * Cap-off (experimental, range-mode allowed any tier per scanner score)
//
// Decision rule (FR-012): cap-off wins if range-mode T2-eligible (raw
// score 60-79) wins at >= 45% win rate AND >= 1.3R average AND within
// 5pp of trend-mode T2 win rate.

import { detectBias } from '../scanner/index.js';
import { tier3FloorFor } from '../agents/spread.js';
import { composeScore } from '../scoring/compose.js';
import { computeExecutionCost } from './realism.js';
import { getKillZone, type BacktestTrade } from './engine.js';
import type { Candle } from '../types.js';

export interface RangeBacktestTrade extends BacktestTrade {
  /** Tier as scored under the EXPERIMENTAL cap-off rule. May differ from `tier`. */
  tier_capoff: 1 | 2 | 3;
  /** True if cap-on rule fired (i.e. raw score would have been > 59). */
  cap_was_applied: boolean;
}

export interface RangeBacktestResult {
  ticker: string;
  setups_detected: number;
  trades_simulated: number;
  /** Trades under the current cap-on rule (all forced to Tier 3, 0.5% risk). */
  cap_on: { trades: BacktestTrade[]; win_rate: number; total_r: number; avg_r: number };
  /** Same setups under the experimental cap-off rule (tier follows raw score). */
  cap_off: { trades: BacktestTrade[]; win_rate: number; total_r: number; avg_r: number };
  /** Per-tier breakdown under cap-off — answers "are T1/T2 range setups any good?" */
  cap_off_tier_breakdown: Array<{ tier: 1 | 2 | 3; count: number; wins: number; total_r: number; win_rate: number }>;
  /** Raw replay trades (one per detected setup; fields apply under cap-on rules). */
  trades: RangeBacktestTrade[];
}

interface SetupCandidate {
  i: number;                   // index of the sweep candle
  direction: 'long' | 'short';
  rangeHigh: number;
  rangeLow: number;
  rangeWidth: number;
  atr: number;
  composeRaw: number;          // composite_score WITHOUT range-cap
  composeCapped: number;       // composite_score WITH range-cap (current behaviour)
}

const RANGE_LOOKBACK = 8;
const ATR_LOOKBACK = 14;

function computeAtr(candles: Candle[]): number {
  if (candles.length < 2) return 0;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < Math.min(ATR_LOOKBACK, candles.length - 1); i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i + 1].close),
      Math.abs(candles[i].low - candles[i + 1].close),
    );
    sum += tr;
    n++;
  }
  return n > 0 ? sum / n : 0;
}

function spreadFor(spreadTight: boolean): number {
  // Conservative 1-pip equivalent. Real instruments vary; this is a
  // proxy that matches the bot's tight/medium classification.
  return spreadTight ? 0.0001 : 0.0010;
}

/**
 * Walk forward from a sweep candle to find TP1 / TP2 / SL hit.
 * Returns outcome + R-units. Same structure as engine.ts resolveOutcome.
 */
function resolveRangeOutcome(
  ticker: string,
  candles: Candle[],
  startIdx: number,
  direction: 'long' | 'short',
  entry: number,
  sl: number,
  tp1: number,
  tp2: number,
): { outcome: 'tp2' | 'tp1_be' | 'sl'; exit_time: string; pnl_r: number } {
  let tp1Hit = false;
  for (let j = startIdx + 1; j < Math.min(startIdx + 30, candles.length); j++) {
    const c = candles[j];
    if (direction === 'long') {
      if (c.low <= sl) {
        if (tp1Hit) {
          return { outcome: 'tp1_be', exit_time: c.datetime, pnl_r: 0.7 - computeExecutionCost(ticker, Math.abs(entry - sl)) };
        }
        return { outcome: 'sl', exit_time: c.datetime, pnl_r: -1.0 - computeExecutionCost(ticker, Math.abs(entry - sl)) };
      }
      if (!tp1Hit && c.high >= tp1) {
        tp1Hit = true;
        sl = entry; // BE on Leg B
      }
      if (tp1Hit && c.high >= tp2) {
        return { outcome: 'tp2', exit_time: c.datetime, pnl_r: 1.09 - computeExecutionCost(ticker, Math.abs(entry - sl)) };
      }
    } else {
      if (c.high >= sl) {
        if (tp1Hit) {
          return { outcome: 'tp1_be', exit_time: c.datetime, pnl_r: 0.7 - computeExecutionCost(ticker, Math.abs(entry - sl)) };
        }
        return { outcome: 'sl', exit_time: c.datetime, pnl_r: -1.0 - computeExecutionCost(ticker, Math.abs(entry - sl)) };
      }
      if (!tp1Hit && c.low <= tp1) {
        tp1Hit = true;
        sl = entry;
      }
      if (tp1Hit && c.low <= tp2) {
        return { outcome: 'tp2', exit_time: c.datetime, pnl_r: 1.09 - computeExecutionCost(ticker, Math.abs(entry - sl)) };
      }
    }
  }
  // Ran out of candles — same convention as engine.ts.
  const lastCandle = candles[candles.length - 1];
  return tp1Hit
    ? { outcome: 'tp1_be', exit_time: lastCandle.datetime, pnl_r: 0.7 - computeExecutionCost(ticker, Math.abs(entry - sl)) }
    : { outcome: 'sl', exit_time: lastCandle.datetime, pnl_r: -1.0 - computeExecutionCost(ticker, Math.abs(entry - sl)) };
}

/**
 * Detect a range-mode setup at candle index `i`. Returns null when no
 * valid setup. Uses prior RANGE_LOOKBACK 1H candles for the range,
 * the candle at i for sweep detection, and i+1 for entry.
 */
export function detectRangeSetup(
  ticker: string,
  candles: Candle[],
  i: number,
  spreadTight: boolean,
): SetupCandidate | null {
  if (i < RANGE_LOOKBACK + 1) return null;
  if (i + 1 >= candles.length) return null;

  const rangeWindow = candles.slice(i - RANGE_LOOKBACK, i);
  const rangeHigh = Math.max(...rangeWindow.map((c) => c.high));
  const rangeLow = Math.min(...rangeWindow.map((c) => c.low));
  const rangeWidth = rangeHigh - rangeLow;
  if (rangeWidth <= 0) return null;

  // ATR from a slightly wider window to match detectBias convention.
  const atrWindow = candles.slice(i - ATR_LOOKBACK, i).reverse();
  const atr = computeAtr(atrWindow);
  if (atr <= 0) return null;

  // Range width must be >= 1.5 * ATR (per ict-agent.md s.I trigger 5).
  if (rangeWidth < 1.5 * atr) return null;

  const sweepCandle = candles[i];
  const spread = spreadFor(spreadTight);

  // Sweep up + close back inside → SHORT setup.
  let direction: 'long' | 'short' | null = null;
  if (sweepCandle.high > rangeHigh + spread && sweepCandle.close < rangeHigh) {
    direction = 'short';
  } else if (sweepCandle.low < rangeLow - spread && sweepCandle.close > rangeLow) {
    direction = 'long';
  }
  if (direction === null) return null;

  // 1H bias must be neutral for range-mode (other triggers used for
  // trending bias).
  const biasWindow = candles.slice(i - 20, i).reverse();
  const bias = detectBias(biasWindow);
  if (bias.bias !== 'neutral') return null;

  // Compose the score TWICE: once with isRangeMode=true (cap on, current),
  // and once with isRangeMode=false (cap off, experimental).
  const composedCapOn = composeScore({
    ticker,
    rawBiasClarity: bias.clarity,    // 0 for neutral
    rawNewsScore: 0,
    spreadQuality: spreadTight ? 'tight' : 'medium',
    isRangeMode: true,
    ictArrayInputs: undefined,
  });
  const composedCapOff = composeScore({
    ticker,
    rawBiasClarity: bias.clarity,
    rawNewsScore: 0,
    spreadQuality: spreadTight ? 'tight' : 'medium',
    isRangeMode: false,            // pretend this is a normal setup
    ictArrayInputs: undefined,
  });

  return {
    i,
    direction,
    rangeHigh,
    rangeLow,
    rangeWidth,
    atr,
    composeRaw: composedCapOff.composite_score,
    composeCapped: composedCapOn.composite_score,
  };
}

export function runRangeBacktest(
  ticker: string,
  candles: Candle[],
  spreadTight: boolean,
): RangeBacktestResult {
  const trades: RangeBacktestTrade[] = [];
  let lastEntryIdx = -5;

  for (let i = RANGE_LOOKBACK; i < candles.length - 30; i++) {
    if (i - lastEntryIdx < 3) continue;            // engine.ts cooldown convention
    if (!getKillZone(candles[i].datetime).inKillZone) continue;

    const setup = detectRangeSetup(ticker, candles, i, spreadTight);
    if (!setup) continue;

    // Entry at the next candle's open.
    const entryCandle = candles[i + 1];
    if (!entryCandle) continue;
    const entry = entryCandle.open;

    let sl: number, tp1: number, tp2: number;
    if (setup.direction === 'long') {
      sl = candles[i].low - 0.5 * setup.atr;       // beyond the swept low
      const risk = entry - sl;
      if (risk <= 0) continue;
      tp1 = setup.rangeLow + setup.rangeWidth / 2; // mid-range
      tp2 = setup.rangeHigh;                       // opposite extreme
    } else {
      sl = candles[i].high + 0.5 * setup.atr;
      const risk = sl - entry;
      if (risk <= 0) continue;
      tp1 = setup.rangeHigh - setup.rangeWidth / 2;
      tp2 = setup.rangeLow;
    }

    // R:R floors per engine.ts convention (1.0 / 1.3).
    const tp1RR = Math.abs(tp1 - entry) / Math.abs(sl - entry);
    const tp2RR = Math.abs(tp2 - entry) / Math.abs(sl - entry);
    if (tp1RR < 1.0 || tp2RR < 1.3) continue;

    const { outcome, exit_time, pnl_r } = resolveRangeOutcome(
      ticker, candles, i, setup.direction, entry, sl, tp1, tp2,
    );

    // Cap-on tier (always 3 because range-mode is capped at 59).
    const tierOn: 1 | 2 | 3 = 3;
    // Cap-off tier (per scanner mapping on the un-capped score).
    const tierOff: 1 | 2 | 3 =
      setup.composeRaw >= 80 ? 1 :
      setup.composeRaw >= 60 ? 2 :
      setup.composeRaw >= tier3FloorFor(ticker) ? 3 : 3;

    trades.push({
      ticker,
      direction: setup.direction,
      entry,
      sl,
      tp1,
      tp2,
      entry_time: entryCandle.datetime,
      exit_time,
      outcome,
      pnl_r,
      score: setup.composeCapped,
      tier: tierOn,
      tier_capoff: tierOff,
      cap_was_applied: setup.composeRaw > setup.composeCapped,
      kill_zone: getKillZone(candles[i].datetime).zone,
      risk_pct: 0.25,                              // range-mode half-size
    });
    lastEntryIdx = i;
  }

  // Aggregate cap-on (all trades use risk_pct=0.25 / 0.5% scaling per
  // tier 3) — for comparison purposes we report raw R-units; the
  // 0.25%-vs-tier-mapped scaling decision is downstream.
  const capOnTrades: BacktestTrade[] = trades.map((t) => ({
    ticker: t.ticker, direction: t.direction, entry: t.entry, sl: t.sl, tp1: t.tp1, tp2: t.tp2,
    entry_time: t.entry_time, exit_time: t.exit_time, outcome: t.outcome,
    pnl_r: t.pnl_r, score: t.score, tier: t.tier, kill_zone: t.kill_zone, risk_pct: 0.25,
  }));
  // Cap-off: same trades, but tier and risk_pct follow the un-capped score.
  const capOffTrades: BacktestTrade[] = trades.map((t) => {
    const riskPct = t.tier_capoff === 1 ? 1.5 : t.tier_capoff === 2 ? 1.0 : 0.5;
    return {
      ticker: t.ticker, direction: t.direction, entry: t.entry, sl: t.sl, tp1: t.tp1, tp2: t.tp2,
      entry_time: t.entry_time, exit_time: t.exit_time, outcome: t.outcome,
      pnl_r: t.pnl_r, score: t.score, tier: t.tier_capoff, kill_zone: t.kill_zone, risk_pct: riskPct,
    };
  });

  const summarize = (ts: BacktestTrade[]): { trades: BacktestTrade[]; win_rate: number; total_r: number; avg_r: number } => {
    if (ts.length === 0) return { trades: [], win_rate: 0, total_r: 0, avg_r: 0 };
    const wins = ts.filter((t) => t.pnl_r > 0).length;
    const totalR = ts.reduce((sum, t) => sum + t.pnl_r, 0);
    return {
      trades: ts,
      win_rate: wins / ts.length,
      total_r: totalR,
      avg_r: totalR / ts.length,
    };
  };

  const tierBreakdown: Array<{ tier: 1 | 2 | 3; count: number; wins: number; total_r: number; win_rate: number }> =
    ([1, 2, 3] as const).map((tier) => {
      const subset = capOffTrades.filter((t) => t.tier === tier);
      const wins = subset.filter((t) => t.pnl_r > 0).length;
      const totalR = subset.reduce((s, t) => s + t.pnl_r, 0);
      return {
        tier,
        count: subset.length,
        wins,
        total_r: totalR,
        win_rate: subset.length > 0 ? wins / subset.length : 0,
      };
    });

  return {
    ticker,
    setups_detected: trades.length,
    trades_simulated: trades.length,
    cap_on: summarize(capOnTrades),
    cap_off: summarize(capOffTrades),
    cap_off_tier_breakdown: tierBreakdown,
    trades,
  };
}

/**
 * Render a markdown report comparing cap-on vs cap-off across one or
 * more instrument backtests. The decision rule is in research.md R-5
 * and FR-012 — implemented here so the script can highlight a verdict.
 */
export function renderRangeReport(results: RangeBacktestResult[], generatedAt: string): string {
  const total = results.reduce((s, r) => s + r.trades_simulated, 0);
  const totalCapOn = results.reduce((s, r) => s + r.cap_on.total_r, 0);
  const totalCapOff = results.reduce((s, r) => s + r.cap_off.total_r, 0);
  const allCapOff = results.flatMap((r) => r.cap_off.trades);
  const t2Trades = allCapOff.filter((t) => t.tier === 2);
  const t2Wins = t2Trades.filter((t) => t.pnl_r > 0).length;
  const t2WinRate = t2Trades.length > 0 ? t2Wins / t2Trades.length : 0;
  const t2AvgR = t2Trades.length > 0 ? t2Trades.reduce((s, t) => s + t.pnl_r, 0) / t2Trades.length : 0;

  // Decision per FR-012: cap-off wins if T2 win rate >= 45% AND avg R >= 1.3.
  // (Spec also asks for "within 5pp of trend-mode T2" but trend-mode T2 win rate
  // is taken from the main backtest run separately.)
  let verdict: string;
  if (t2Trades.length < 30) {
    verdict = `**INSUFFICIENT DATA** — only ${t2Trades.length} cap-off T2 trades simulated. Need 30+ for a meaningful decision. Cap stays.`;
  } else if (t2WinRate >= 0.45 && t2AvgR >= 1.3) {
    verdict = `**LIFT THE CAP** — cap-off T2 win rate ${(t2WinRate * 100).toFixed(1)}% (>= 45%) AND avg R ${t2AvgR.toFixed(2)}R (>= 1.3R). Range-mode setups warrant T2 sizing.`;
  } else {
    verdict = `**KEEP THE CAP** — cap-off T2 win rate ${(t2WinRate * 100).toFixed(1)}% / avg R ${t2AvgR.toFixed(2)}R does not meet thresholds (45% / 1.3R). Cap stays.`;
  }

  const perInstrumentRows = results.map((r) =>
    `| ${r.ticker} | ${r.trades_simulated} | ${(r.cap_on.win_rate * 100).toFixed(1)}% | ${r.cap_on.avg_r.toFixed(2)}R | ${(r.cap_off.win_rate * 100).toFixed(1)}% | ${r.cap_off.avg_r.toFixed(2)}R |`,
  ).join('\n');

  return `# Range-Mode Backtest Report (US-4 / Spec 001)

Generated: ${generatedAt}
Source: src/backtest/range-engine.ts on backtest-data/*

## Verdict

${verdict}

## Aggregate

- Total range-mode setups simulated: **${total}**
- Total R under cap-on (current — all T3 / 0.5%): **${totalCapOn.toFixed(2)}R**
- Total R under cap-off (experimental — tier follows score): **${totalCapOff.toFixed(2)}R**
- Cap-off T2 trades: ${t2Trades.length} (win rate ${(t2WinRate * 100).toFixed(1)}%, avg R ${t2AvgR.toFixed(2)}R)

## Per-instrument

| Ticker | Trades | Cap-on win% | Cap-on avg R | Cap-off win% | Cap-off avg R |
|---|---|---|---|---|---|
${perInstrumentRows || '_No instruments evaluated._'}

## Per-tier breakdown (cap-off)

${results.map((r) => `### ${r.ticker}

| Tier | Trades | Wins | Win% | Total R |
|---|---|---|---|---|
${r.cap_off_tier_breakdown.map((b) => `| ${b.tier} | ${b.count} | ${b.wins} | ${(b.win_rate * 100).toFixed(1)}% | ${b.total_r.toFixed(2)}R |`).join('\n')}
`).join('\n')}

---

_Methodology: 1H-only simplified replay. Range = prior 8 1H candles, width >= 1.5 * ATR. Sweep = wick beyond extreme + close back inside. Entry = next candle open, SL = 0.5 * ATR beyond swept extreme, TP1 = mid-range, TP2 = opposite extreme. Risk = 0.25% (cap-on) or tier-mapped (cap-off). 15M trigger-5 nuance (reversal candle within <= 2 candles, body >= 0.6 * range) is approximated by 1H wick + close-back-inside. Backtest will UNDER-detect vs live behaviour where the ICT agent has 15M precision._
`;
}

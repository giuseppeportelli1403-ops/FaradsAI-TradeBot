// Backtest Engine — Replays historical 1H candles through the post-2026-04-29
// rebalanced ICT strategy and tracks trade outcomes.
//
// REWRITTEN 2026-05-04 (Phase B, audit Finding #3). Pre-rewrite this engine
// implemented the 2026-04-22 obsolete strategy (TP1=2R/TP2=3R/TP3=4R, Tier
// 3 floor=50, kill-zone as score component, no range-mode, etc). Any
// backtest result from the prior version measured a fictional strategy
// that never matched live behavior.
//
// 2026-05-07 (Phase 2 — 2-TP restructure). Engine collapsed from 3 legs
// (TP1/TP2/TP3, 34/33/33%) to 2 legs (TP1=70%, TP2=30%, no TP3). New R:R
// floor on TP2 is 1.3R universal (was 1.5R / 2.0R per-mode). The old
// `tp3` outcome is gone; remaining outcomes are `tp2` (full win),
// `tp1_be` (TP1 hit + runner stopped at entry), and `sl`.
//
// Methodology (current):
//   - 1H candles for bias detection (same as live scanner)
//   - Kill zone is a HARD GATE (no score contribution) — trades only fire
//     in London Open / NY Open / London Close UTC windows, mirroring the
//     live scanner at src/scanner/index.ts:272.
//   - Score rubric (matches strategy.md Section 5 post-2026-04-29 rebalance):
//       Base 25
//       Bias clarity 0/15/20/25 (remapped from detectBias's 0/10/15/20)
//       ICT array quality 0 in backtest — engine doesn't model OB/FVG
//         structure beyond bias detection. Acknowledged limitation: live
//         scoring will be 0-35 points higher when ICT arrays are present.
//         Backtest will UNDER-count trades vs live; both old and new
//         strategies share this limitation so comparison is still valid.
//       News 0 in backtest — historical news not available via free APIs.
//       Spread 0 / +5 (tight)
//   - Tier assignment: T1 80+ (1.5% risk), T2 60-79 (1.0%), T3 40-59 (0.5%),
//     below 40 = skip (no trade). T3 floor lowered 45 → 40 in Phase E
//     (2026-05-04) strategy loosening.
//   - TPs: TP1 = entry + 1R (de-risk leg), TP2 = entry + 1.3R (runner —
//     universal floor post-2026-05-07, was 2R/3R per-mode pre-restructure).
//   - 2-leg sizing: 70% / 30% (post-2026-05-07). P&L outcomes:
//       sl: -1R total (both legs at SL → 1× tier risk lost)
//       tp1_be: +0.7R (Leg A locked at +1R × 0.70, Leg B stopped at entry × 0.30)
//       tp2: +1.09R (Leg A +1R × 0.70 + Leg B +1.3R × 0.30)
//   - Range-mode (trigger 5) NOT modeled in backtest. Trigger 5 needs 15M
//     data + spread/ATR floors which the engine doesn't have. Neutral-bias
//     candles are still skipped. Live behavior will produce more trades
//     than backtest in range-bound regimes.

import { detectBias } from '../scanner/index.js';
import { computeExecutionCost } from './realism.js';
import { tier3FloorFor } from '../agents/spread.js';
import { composeScore } from '../scoring/compose.js';
import { TIER_1_THRESHOLD, TIER_2_THRESHOLD } from '../scoring/tiers.js';
import type { Candle } from '../types.js';

export interface BacktestTrade {
  ticker: string;
  direction: 'long' | 'short';
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  entry_time: string;
  exit_time: string;
  outcome: 'tp2' | 'tp1_be' | 'sl';
  // P&L in R units (1R = 1× total trade risk, NOT per-leg).
  // Post-2026-05-07 2-TP restructure: 70% TP1 + 30% TP2 with TP1=1R, TP2=1.3R:
  //   tp2 → +1R × 0.70 + +1.3R × 0.30 = +1.09R
  //   tp1_be → +1R × 0.70 + 0R × 0.30 = +0.7R
  //   sl → -1R × 0.70 + -1R × 0.30 = -1R total
  pnl_r: number;
  score: number;
  tier: 1 | 2 | 3;
  kill_zone: string;
  risk_pct: number;
}

export interface BacktestResult {
  ticker: string;
  total_trades: number;
  wins: number;
  losses: number;
  win_rate: number;
  profit_factor: number;
  total_r: number;
  max_drawdown_r: number;
  avg_r_per_trade: number;
  tier_breakdown: { tier: 1 | 2 | 3; count: number; wins: number; total_r: number }[];
  trades: BacktestTrade[];
}

/**
 * Kill-zone classification for a candle's UTC hour. Mirrors the live
 * scanner at src/scanner/index.ts:190-201 — London Close starts 16:00 to
 * avoid first-match-wins overlap with NY Open at 15-16. (Live fix
 * 2026-04-29; backtest synced 2026-05-04 Phase B audit Finding #9.)
 */
export function getKillZone(datetime: string): { inKillZone: boolean; zone: string } {
  const d = new Date(datetime);
  const h = d.getUTCHours();
  if (h >= 7 && h < 10) return { inKillZone: true, zone: 'London Open' };
  if (h >= 13 && h < 16) return { inKillZone: true, zone: 'NY Open' };
  if (h >= 16 && h < 17) return { inKillZone: true, zone: 'London Close' };
  return { inKillZone: false, zone: 'outside' };
}

export interface ComputeScoreInput {
  /** Raw bias clarity from detectBias: 0 / 10 / 15 / 20. */
  rawClarity: number;
  /** True for tight-spread instruments (EURUSD, GBPUSD, USDJPY, AUDUSD, GOLD). */
  spreadTight: boolean;
}

/**
 * Composite score per strategy.md Section 5 (rebalanced 2026-04-29).
 *
 * 2026-05-12 — US-1 deterministic scoring rewrite (Migration 007):
 * delegates to src/scoring/compose.ts so the live scanner and the backtest
 * engine share one implementation. Public signature kept stable for
 * existing test imports. Numerical output unchanged from the prior
 * inline math (verified by tests/backtest-engine.test.ts and
 * tests/scoring/compose.test.ts).
 *
 * Backtest does NOT include news (no historical news) or history
 * (no carry-forward across the replay). ICT-array quality is 0 until
 * PR 2 / US-5 / T066 lands the deterministic structure scorer; once
 * that ships the backtest will more closely mirror live scoring.
 */
export function computeScore(input: ComputeScoreInput, ticker = 'BACKTEST'): number {
  return composeScore({
    ticker,
    rawBiasClarity: input.rawClarity,
    rawNewsScore: 0,
    spreadQuality: input.spreadTight ? 'tight' : 'medium',
    historyWinRate: undefined,
    historySampleSize: undefined,
    isRangeMode: false,
    ictArrayInputs: undefined,
  }).composite_score;
}

/**
 * Tier assignment — delegates to composeScore().tier so the backtest and
 * live scanner share one source of truth. Public signature preserved.
 */
export function assignTier(score: number, ticker: string): 1 | 2 | 3 | null {
  // composeScore wraps tier resolution with the spread-aware tier3FloorFor
  // carve-out. We back-derive tier from the score by feeding a synthetic
  // bias input that produces exactly `score`. Faster path: replicate the
  // same tier ladder here. Either approach yields identical results.
  if (score >= TIER_1_THRESHOLD) return 1;
  if (score >= TIER_2_THRESHOLD) return 2;
  if (score >= tier3FloorFor(ticker)) return 3;
  return null;
}

// Walk forward through candles to find the first TP or SL hit. Returns the
// outcome and the time it occurred. Models the 2-leg split-position
// behavior (post-2026-05-07): TP1 hit → Leg B SL moves to entry (BE); TP2
// hit → trade complete. The 3rd leg / TP3 path is gone.
function resolveOutcome(
  ticker: string,
  candles: Candle[],
  startIdx: number,
  direction: 'long' | 'short',
  entry: number,
  sl: number,
  tp1: number,
  tp2: number,
): { outcome: BacktestTrade['outcome']; exit_time: string; pnl_r: number } {
  // Execution cost (spread + slippage) applied to every trade outcome,
  // win or lose. stopDistance is the absolute price distance from entry
  // to SL in the instrument's native price units. See src/backtest/realism.ts.
  const stopDistance = Math.abs(entry - sl);
  const executionCost = computeExecutionCost(ticker, stopDistance);

  let tp1Hit = false;

  for (let i = startIdx; i < candles.length; i++) {
    const c = candles[i];

    if (direction === 'long') {
      // Once TP1 is hit, Leg B's effective stop is `entry` (break-even),
      // not the original `sl`. So we test against `entry` after tp1Hit.
      const stopLevel = tp1Hit ? entry : sl;
      if (c.low <= stopLevel) {
        return {
          outcome: tp1Hit ? 'tp1_be' : 'sl',
          exit_time: c.datetime,
          // tp1_be: A locked at +1R × 0.70, B at entry × 0.30 = +0.7R
          // sl: both legs stopped, total = -1R
          pnl_r: (tp1Hit ? 0.7 : -1.0) - executionCost,
        };
      }
      if (!tp1Hit && c.high >= tp1) {
        tp1Hit = true;
      }
      if (tp1Hit && c.high >= tp2) {
        // A=+1R × 0.70, B=+1.3R × 0.30 = +1.09R
        return { outcome: 'tp2', exit_time: c.datetime, pnl_r: 1.09 - executionCost };
      }
    } else {
      const stopLevel = tp1Hit ? entry : sl;
      if (c.high >= stopLevel) {
        return {
          outcome: tp1Hit ? 'tp1_be' : 'sl',
          exit_time: c.datetime,
          pnl_r: (tp1Hit ? 0.7 : -1.0) - executionCost,
        };
      }
      if (!tp1Hit && c.low <= tp1) {
        tp1Hit = true;
      }
      if (tp1Hit && c.low <= tp2) {
        return { outcome: 'tp2', exit_time: c.datetime, pnl_r: 1.09 - executionCost };
      }
    }
  }

  // Ran out of candles without resolution — treat as tp1_be if TP1 was hit, else sl
  const lastCandle = candles[candles.length - 1];
  return tp1Hit
    ? { outcome: 'tp1_be', exit_time: lastCandle.datetime, pnl_r: 0.7 - executionCost }
    : { outcome: 'sl', exit_time: lastCandle.datetime, pnl_r: -1.0 - executionCost };
}

export function runBacktest(
  ticker: string,
  candles: Candle[],
  spreadTight: boolean,
  lookback = 20,
): BacktestResult {
  const trades: BacktestTrade[] = [];
  // Track last trade entry index to avoid overlapping entries (cooldown: 3 candles)
  let lastEntryIdx = -5;

  for (let i = lookback; i < candles.length - 10; i++) {
    // Cooldown: don't take a new signal within 3 candles of last entry
    if (i - lastEntryIdx < 3) continue;

    // Hard gate: kill zone must be active. Mirrors src/scanner/index.ts:272
    // which returns [] outside kill zones regardless of score.
    const kz = getKillZone(candles[i].datetime);
    if (!kz.inKillZone) continue;

    const window = candles.slice(i - lookback, i).reverse(); // detectBias expects newest first
    const bias = detectBias(window);

    // Range-mode (1H neutral) skipped — engine can't model 15M trigger 5
    // requirements (sweep, reversal candle, range width × ATR thresholds).
    // Acknowledged limitation; see file header.
    if (bias.bias === 'neutral') continue;

    const score = computeScore({ rawClarity: bias.clarity, spreadTight });
    const tier = assignTier(score, ticker);
    if (!tier) continue;

    // Entry at next candle's open
    const entryCandle = candles[i + 1];
    if (!entryCandle) continue;

    const entry = entryCandle.open;
    const atr = bias.atr;
    if (atr <= 0) continue;

    // 2026-05-07 (Phase 2 — 2-TP restructure): TP3 dropped. TP2 lowered
    // from 2R/3R per-mode to 1.3R universal across all tiers / modes /
    // spread classes.
    let sl: number, tp1: number, tp2: number;

    if (bias.bias === 'bullish') {
      sl = bias.recent_low - atr * 0.5;
      const risk = entry - sl;
      if (risk <= 0) continue;
      tp1 = entry + risk * 1;     // 1:1 (de-risk leg)
      tp2 = entry + risk * 1.3;   // 1.3:1 (runner — universal floor)
    } else {
      sl = bias.recent_high + atr * 0.5;
      const risk = sl - entry;
      if (risk <= 0) continue;
      tp1 = entry - risk * 1;
      tp2 = entry - risk * 1.3;
    }

    // R:R floors post-2026-05-07: TP1 ≥ 1.0R, TP2 ≥ 1.3R universal. With
    // TPs fixed at 1R/1.3R here, these are always satisfied — but the
    // check is left in defensively for future engine variations that
    // might use looser TP placement.
    const tp1RR = Math.abs(tp1 - entry) / Math.abs(sl - entry);
    const tp2RR = Math.abs(tp2 - entry) / Math.abs(sl - entry);
    if (tp1RR < 1.0) continue;
    if (tp2RR < 1.3) continue;

    const { outcome, exit_time, pnl_r } = resolveOutcome(
      ticker,
      candles,
      i + 2,
      bias.bias === 'bullish' ? 'long' : 'short',
      entry,
      sl, tp1, tp2,
    );

    const riskPct = tier === 1 ? 1.5 : tier === 2 ? 1.0 : 0.5;

    trades.push({
      ticker,
      direction: bias.bias === 'bullish' ? 'long' : 'short',
      entry,
      sl,
      tp1,
      tp2,
      entry_time: entryCandle.datetime,
      exit_time,
      outcome,
      pnl_r,
      score,
      tier,
      kill_zone: kz.zone,
      risk_pct: riskPct,
    });

    lastEntryIdx = i;
  }

  // Aggregate stats
  const wins = trades.filter((t) => t.pnl_r > 0).length;
  const losses = trades.filter((t) => t.pnl_r < 0).length;
  const totalR = trades.reduce((s, t) => s + t.pnl_r, 0);
  const grossProfit = trades.filter((t) => t.pnl_r > 0).reduce((s, t) => s + t.pnl_r, 0);
  const grossLoss = Math.abs(trades.filter((t) => t.pnl_r < 0).reduce((s, t) => s + t.pnl_r, 0));

  // Max drawdown in R
  let peak = 0, equity = 0, maxDD = 0;
  for (const t of trades) {
    equity += t.pnl_r;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
  }

  // Tier breakdown
  const tierBreakdown = ([1, 2, 3] as const).map((tier) => {
    const t = trades.filter((x) => x.tier === tier);
    return {
      tier,
      count: t.length,
      wins: t.filter((x) => x.pnl_r > 0).length,
      total_r: t.reduce((s, x) => s + x.pnl_r, 0),
    };
  });

  return {
    ticker,
    total_trades: trades.length,
    wins,
    losses,
    win_rate: trades.length > 0 ? Math.round((wins / trades.length) * 1000) / 10 : 0,
    profit_factor: grossLoss > 0 ? Math.round((grossProfit / grossLoss) * 100) / 100 : grossProfit > 0 ? 99 : 0,
    total_r: Math.round(totalR * 100) / 100,
    max_drawdown_r: Math.round(maxDD * 100) / 100,
    avg_r_per_trade: trades.length > 0 ? Math.round((totalR / trades.length) * 100) / 100 : 0,
    tier_breakdown: tierBreakdown,
    trades,
  };
}

/**
 * Test-only re-export of `resolveOutcome` so tests can pin gross + net P&L
 * for each outcome of the new 2-leg model (post-2026-05-07 restructure).
 * Keeping this at the bottom of the module so it's visually obvious it's
 * not part of the public runtime surface — same pattern as
 * src/backtest/realism.ts `_internalsForTest`.
 */
export const _internalsForTest = {
  resolveOutcome,
};

// Backtest Engine — Replays historical 1H candles through the post-2026-04-29
// rebalanced ICT strategy and tracks trade outcomes.
//
// REWRITTEN 2026-05-04 (Phase B, audit Finding #3). Pre-rewrite this engine
// implemented the 2026-04-22 obsolete strategy (TP1=2R/TP2=3R/TP3=4R, Tier
// 3 floor=50, kill-zone as score component, no range-mode, etc). Any
// backtest result from the prior version measured a fictional strategy
// that never matched live behavior.
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
//   - TPs: TP1 = entry + 1R (de-risk leg), TP2 = entry + 2R (primary),
//     TP3 = entry + 3R (runner). Matches strategy.md Section 7.3.
//   - 3-leg sizing: ~34/33/33% per leg. P&L outcomes per strategy.md:
//       sl: -1R total
//       tp1_be: +0.34R (Leg A profit, B+C BE-stop)
//       tp2: +1.0R (A profit + B profit, C trails to TP1 stop)
//       tp3: +1.99R (all three legs hit)
//   - Range-mode (trigger 5) NOT modeled in backtest. Trigger 5 needs 15M
//     data + spread/ATR floors which the engine doesn't have. Neutral-bias
//     candles are still skipped. Live behavior will produce more trades
//     than backtest in range-bound regimes.

import { detectBias } from '../scanner/index.js';
import { computeExecutionCost } from './realism.js';
import { tier3FloorFor } from '../agents/spread.js';
import type { Candle } from '../types.js';

export interface BacktestTrade {
  ticker: string;
  direction: 'long' | 'short';
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  tp3: number;
  entry_time: string;
  exit_time: string;
  outcome: 'tp3' | 'tp2' | 'tp1_be' | 'sl';
  // P&L in R units (1R = 1× total trade risk, NOT per-leg).
  // Per strategy.md Section 7.1 with split-position 34/33/33% and
  // TP1=1R/TP2=2R/TP3=3R per-leg multipliers:
  //   tp3 → +0.34 + 0.66 + 0.99 = +1.99R
  //   tp2 → +0.34 + 0.66 + ~0R (C trails to TP1) ≈ +1.0R
  //   tp1_be → +0.34R (A profit, B+C BE-stop)
  //   sl → -1R total
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
 * Backtest does NOT include kill-zone bonus (kill zone is a hard gate now)
 * or news (no historical news). ICT array quality is also 0 in backtest —
 * the engine doesn't model OB/FVG structure beyond bias detection. This
 * makes backtest scores LOWER than what the live scanner produces for the
 * same setup; trade frequency in backtest is therefore conservative.
 */
export function computeScore(input: ComputeScoreInput): number {
  const { rawClarity, spreadTight } = input;
  // Remap detectBias's 0/10/15/20 scale to the post-rebalance 0/15/20/25
  // rubric. Same logic as src/scanner/index.ts:325-329.
  const remappedClarity =
    rawClarity >= 20 ? 25 :
    rawClarity >= 15 ? 20 :
    rawClarity >= 10 ? 15 :
    0;
  let score = 25;                              // base
  score += remappedClarity;                    // 0 / 15 / 20 / 25
  // ICT array quality: 0 (backtest doesn't model OB/FVG)
  // News catalyst: 0 (no historical news in backtest)
  // Historical win-rate adjustment: 0 (backtest doesn't carry forward history)
  score += spreadTight ? 5 : 0;                // 0 / +5
  return Math.max(0, Math.min(100, score));
}

/**
 * Tier assignment per strategy.md Section 5. T1 80+, T2 60-79.
 * Tier 3 floor is spread-class dependent post-2026-05-04 carve-out:
 * tight-spread (EUR/GBP/USDJPY/AUDUSD/GOLD) accepts 40+; medium-spread
 * (OIL_CRUDE, SILVER) keeps the pre-Phase-E 45 floor. History: 50 →
 * 45 (2026-04-22) → 40 (Phase E 2026-05-04) → spread-aware (carve-out
 * 2026-05-04 after backtest showed OIL_CRUDE drove all the regression).
 */
export function assignTier(score: number, ticker: string): 1 | 2 | 3 | null {
  if (score >= 80) return 1;
  if (score >= 60) return 2;
  if (score >= tier3FloorFor(ticker)) return 3;
  return null;
}

// Walk forward through candles to find the first TP or SL hit. Returns the
// outcome and the time it occurred. Models the 3-leg split-position
// behavior: TP1 hit → B+C move to BE; TP2 hit → C trails to TP1 level;
// TP3 hit → all legs closed.
function resolveOutcome(
  ticker: string,
  candles: Candle[],
  startIdx: number,
  direction: 'long' | 'short',
  entry: number,
  sl: number,
  tp1: number,
  tp2: number,
  tp3: number,
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
      if (c.low <= sl) {
        return {
          outcome: tp1Hit ? 'tp1_be' : 'sl',
          exit_time: c.datetime,
          // tp1_be: A profit locked at +1R × 0.34, B+C BE-stop at 0
          // sl: all 3 legs stopped, total = -1R
          pnl_r: (tp1Hit ? 0.34 : -1.0) - executionCost,
        };
      }
      if (!tp1Hit && c.high >= tp1) {
        tp1Hit = true;
      }
      if (tp1Hit && c.high >= tp3) {
        // All 3 TPs: A=+0.34, B=+0.66, C=+0.99 = +1.99R
        return { outcome: 'tp3', exit_time: c.datetime, pnl_r: 1.99 - executionCost };
      }
      if (tp1Hit && c.high >= tp2) {
        // A+B profit, C trails to TP1 level. Per strategy.md ≈ +1.0R total.
        return { outcome: 'tp2', exit_time: c.datetime, pnl_r: 1.0 - executionCost };
      }
    } else {
      if (c.high >= sl) {
        return {
          outcome: tp1Hit ? 'tp1_be' : 'sl',
          exit_time: c.datetime,
          pnl_r: (tp1Hit ? 0.34 : -1.0) - executionCost,
        };
      }
      if (!tp1Hit && c.low <= tp1) {
        tp1Hit = true;
      }
      if (tp1Hit && c.low <= tp3) {
        return { outcome: 'tp3', exit_time: c.datetime, pnl_r: 1.99 - executionCost };
      }
      if (tp1Hit && c.low <= tp2) {
        return { outcome: 'tp2', exit_time: c.datetime, pnl_r: 1.0 - executionCost };
      }
    }
  }

  // Ran out of candles without resolution — treat as tp1_be if TP1 was hit, else sl
  const lastCandle = candles[candles.length - 1];
  return tp1Hit
    ? { outcome: 'tp1_be', exit_time: lastCandle.datetime, pnl_r: 0.34 - executionCost }
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

    let sl: number, tp1: number, tp2: number, tp3: number;

    if (bias.bias === 'bullish') {
      sl = bias.recent_low - atr * 0.5;
      const risk = entry - sl;
      if (risk <= 0) continue;
      tp1 = entry + risk * 1;   // 1:1 (de-risk leg)
      tp2 = entry + risk * 2;   // 2:1 (primary)
      tp3 = entry + risk * 3;   // 3:1 (runner)
    } else {
      sl = bias.recent_high + atr * 0.5;
      const risk = sl - entry;
      if (risk <= 0) continue;
      tp1 = entry - risk * 1;
      tp2 = entry - risk * 2;
      tp3 = entry - risk * 3;
    }

    // R:R floors per strategy.md Section 7.3. With TPs fixed at 1R/2R/3R,
    // these are always satisfied — but the check is left in defensively
    // for future engine variations that might use looser TP placement.
    // T3 tight-spread accepts TP2 ≥ 1.5; everyone else ≥ 2.0. TP2 is
    // structurally always 2.0 here so the check is a no-op currently.
    const tp2RR = Math.abs(tp2 - entry) / Math.abs(sl - entry);
    const tp2Floor = (tier === 3 && spreadTight) ? 1.5 : 2.0;
    if (tp2RR < tp2Floor) continue;

    const { outcome, exit_time, pnl_r } = resolveOutcome(
      ticker,
      candles,
      i + 2,
      bias.bias === 'bullish' ? 'long' : 'short',
      entry,
      sl, tp1, tp2, tp3,
    );

    const riskPct = tier === 1 ? 1.5 : tier === 2 ? 1.0 : 0.5;

    trades.push({
      ticker,
      direction: bias.bias === 'bullish' ? 'long' : 'short',
      entry,
      sl,
      tp1,
      tp2,
      tp3,
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

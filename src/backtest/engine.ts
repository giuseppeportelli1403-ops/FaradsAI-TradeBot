// Backtest Engine — Replays historical candles through the scoring system
// Simulates ICT entries and tracks trade outcomes across 2019–2025.
//
// Methodology:
//   - 1H candles used for bias detection (same as live bot)
//   - Kill zone check based on UTC hour of each candle
//   - Entry at next candle's open when conditions met
//   - SL: recent_low/high ± 0.5×ATR (structural)
//   - TP1: 2× risk (2:1 R:R) — first partial exit (50% of position)
//   - TP2: 3× risk (3:1 R:R) — second partial exit (remaining 50%)
//   - TP3: 4× risk (4:1 R:R) — optional runner (if Tier 1, trailing)
//   - News score set to 0 (historical news not available via free APIs)

import { detectBias } from '../scanner/index.js';
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
  // P&L in R (1R = 1× risk):
  // tp3 = +3.5R (TP1 at 2R + TP2 at 3R + TP3 at 4R average), tp2 = +2.5R, tp1_be = +1R, sl = -1R
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

// Kill zone check for a candle's UTC hour
function getKillZone(datetime: string): { inKillZone: boolean; zone: string } {
  const d = new Date(datetime);
  const h = d.getUTCHours();
  if (h >= 7 && h < 10) return { inKillZone: true, zone: 'London Open' };
  if (h >= 13 && h < 16) return { inKillZone: true, zone: 'NY Open' };
  if (h >= 15 && h < 17) return { inKillZone: true, zone: 'London Close' };
  return { inKillZone: false, zone: 'outside' };
}

// Compute composite score — mirrors the live scanner logic
function computeScore(
  biasClarity: number,
  inKillZone: boolean,
  newsScore: number,
  spreadTight: boolean,
): number {
  let score = 25; // base
  score += biasClarity;                            // 0 / 10 / 20
  score += inKillZone ? 15 : 5;                   // 15 in-zone, 5 outside
  score += newsScore;                              // 0 in backtest (no historical news)
  score += spreadTight ? 5 : 0;
  return Math.max(0, Math.min(100, score));
}

function assignTier(score: number): 1 | 2 | 3 | null {
  if (score >= 80) return 1;
  if (score >= 60) return 2;
  if (score >= 50) return 3;
  return null;
}

// Walk forward through candles to find the first TP or SL hit.
// Returns the outcome and the time it occurred.
function resolveOutcome(
  candles: Candle[],
  startIdx: number,
  direction: 'long' | 'short',
  sl: number,
  tp1: number,
  tp2: number,
  tp3: number,
): { outcome: BacktestTrade['outcome']; exit_time: string; pnl_r: number } {
  let tp1Hit = false;

  for (let i = startIdx; i < candles.length; i++) {
    const c = candles[i];

    if (direction === 'long') {
      if (c.low <= sl) {
        return {
          outcome: tp1Hit ? 'tp1_be' : 'sl',
          exit_time: c.datetime,
          pnl_r: tp1Hit ? 1.0 : -1.0,
        };
      }
      if (!tp1Hit && c.high >= tp1) {
        tp1Hit = true;
        // TP1 hit — half closed at 2R, SL moved to break-even on the runner
      }
      if (tp1Hit && c.high >= tp3) {
        return { outcome: 'tp3', exit_time: c.datetime, pnl_r: 3.5 }; // avg of TP1@2R + TP2@3R + TP3@4R
      }
      if (tp1Hit && c.high >= tp2) {
        return { outcome: 'tp2', exit_time: c.datetime, pnl_r: 2.5 }; // avg of TP1@2R + TP2@3R
      }
    } else {
      if (c.high >= sl) {
        return {
          outcome: tp1Hit ? 'tp1_be' : 'sl',
          exit_time: c.datetime,
          pnl_r: tp1Hit ? 1.0 : -1.0,
        };
      }
      if (!tp1Hit && c.low <= tp1) {
        tp1Hit = true;
      }
      if (tp1Hit && c.low <= tp3) {
        return { outcome: 'tp3', exit_time: c.datetime, pnl_r: 3.5 };
      }
      if (tp1Hit && c.low <= tp2) {
        return { outcome: 'tp2', exit_time: c.datetime, pnl_r: 2.5 };
      }
    }
  }

  // Ran out of candles without resolution — treat as tp1_be if TP1 was hit, else sl
  const lastCandle = candles[candles.length - 1];
  return tp1Hit
    ? { outcome: 'tp1_be', exit_time: lastCandle.datetime, pnl_r: 1.0 }
    : { outcome: 'sl', exit_time: lastCandle.datetime, pnl_r: -1.0 };
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

    const window = candles.slice(i - lookback, i).reverse(); // detectBias expects newest first
    const bias = detectBias(window);

    if (bias.bias === 'neutral') continue;

    const kz = getKillZone(candles[i].datetime);
    const score = computeScore(bias.clarity, kz.inKillZone, 0, spreadTight);
    const tier = assignTier(score);

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
      tp1 = entry + risk * 2;
      tp2 = entry + risk * 3;
      tp3 = entry + risk * 4;
    } else {
      sl = bias.recent_high + atr * 0.5;
      const risk = sl - entry;
      if (risk <= 0) continue;
      tp1 = entry - risk * 2;
      tp2 = entry - risk * 3;
      tp3 = entry - risk * 4;
    }

    // Verify minimum R:R requirement per tier
    const minRR = tier === 3 ? 1.5 : 2.0;
    const actualRR = Math.abs(tp1 - entry) / Math.abs(sl - entry);
    if (actualRR < minRR) continue;

    const { outcome, exit_time, pnl_r } = resolveOutcome(
      candles,
      i + 2,
      bias.bias === 'bullish' ? 'long' : 'short',
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

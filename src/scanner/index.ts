// Universe Scanner — Ranks Instruments by Composite Score
// Called by trading agents in Step 2 of their decision cycles
//
// Scans the configured instrument universe and produces a ranked shortlist.
// Does NOT do full ICT/Swing analysis — just enough to rank and filter.
//
// Scoring (preliminary — agents do the full composite score themselves):
//   - 1H bias clarity (bullish/bearish/neutral)
//   - Recent volatility (ATR-based)
//   - Kill zone alignment
//   - News catalyst presence
//
// The agents then take the top N and run their full analysis pipeline.
//
// NOTE: epic values on INSTRUMENT_UNIVERSE were verified live against the
// Capital.com demo API on 2026-04-17. For all 20 instruments epic == ticker
// verbatim. Ignore scripts/epic-mapping.json — that file was produced by the
// older markets[0] heuristic and contains ETF/weekend contracts for 4 entries;
// the epic field here is the source of truth.

import { fetchCandles } from '../mcp-server/market-data.js';
import { getNewsScore } from '../news/index.js';
import type { Candle, RankedInstrument } from '../types.js';

// ==================== INSTRUMENT UNIVERSE ====================
// Categorised for position concentration limits.
// `ticker` is the human-readable identifier (used for display, logging,
// Telegram alerts, news lookups via Alpha Vantage, candle fetches via Twelve
// Data, and DB storage). `epic` is the Capital.com broker identifier used
// for any Capital REST API call (searchMarkets, getMarketDetails,
// openPosition, closePosition, getCandles, etc.).
//
// epic values verified live against Capital.com demo on 2026-04-17 — epic == ticker for all 20.
//
// WARNING: do NOT add an instrument where epic !== ticker without first
// refactoring src/agents/researcher-agent.ts. The researcher emits tickers
// (not epics) in its shortlist briefs, and the trading/swing agents forward
// those strings verbatim to Capital tool calls that expect an epic. The
// invariant is locked by tests/instrument-universe.test.ts — if that test
// fails, fix the researcher-agent contract, not the test.
export const INSTRUMENT_UNIVERSE: Array<{
  ticker: string;
  epic: string;
  name: string;
  category: string;
  spread_quality: 'tight' | 'medium' | 'wide';
}> = [
  // Indices
  { ticker: 'US100', epic: 'US100', name: 'Nasdaq 100', category: 'index', spread_quality: 'tight' },
  { ticker: 'US500', epic: 'US500', name: 'S&P 500', category: 'index', spread_quality: 'tight' },
  { ticker: 'US30', epic: 'US30', name: 'Dow Jones 30', category: 'index', spread_quality: 'tight' },
  { ticker: 'DE40', epic: 'DE40', name: 'DAX 40', category: 'index', spread_quality: 'tight' },
  { ticker: 'UK100', epic: 'UK100', name: 'FTSE 100', category: 'index', spread_quality: 'medium' },

  // Commodities
  { ticker: 'GOLD', epic: 'GOLD', name: 'Gold', category: 'commodity', spread_quality: 'tight' },
  { ticker: 'SILVER', epic: 'SILVER', name: 'Silver', category: 'commodity', spread_quality: 'medium' },
  { ticker: 'OIL_CRUDE', epic: 'OIL_CRUDE', name: 'Crude Oil WTI', category: 'commodity', spread_quality: 'medium' },

  // FX Majors
  { ticker: 'EURUSD', epic: 'EURUSD', name: 'EUR/USD', category: 'fx', spread_quality: 'tight' },
  { ticker: 'GBPUSD', epic: 'GBPUSD', name: 'GBP/USD', category: 'fx', spread_quality: 'tight' },
  { ticker: 'USDJPY', epic: 'USDJPY', name: 'USD/JPY', category: 'fx', spread_quality: 'tight' },
  { ticker: 'GBPJPY', epic: 'GBPJPY', name: 'GBP/JPY', category: 'fx', spread_quality: 'medium' },
  { ticker: 'AUDUSD', epic: 'AUDUSD', name: 'AUD/USD', category: 'fx', spread_quality: 'tight' },

  // US Large-Cap Stocks
  { ticker: 'AAPL', epic: 'AAPL', name: 'Apple', category: 'us-large-cap', spread_quality: 'tight' },
  { ticker: 'MSFT', epic: 'MSFT', name: 'Microsoft', category: 'us-large-cap', spread_quality: 'tight' },
  { ticker: 'NVDA', epic: 'NVDA', name: 'NVIDIA', category: 'us-large-cap', spread_quality: 'tight' },
  { ticker: 'AMZN', epic: 'AMZN', name: 'Amazon', category: 'us-large-cap', spread_quality: 'tight' },
  { ticker: 'GOOGL', epic: 'GOOGL', name: 'Alphabet', category: 'us-large-cap', spread_quality: 'tight' },
  { ticker: 'META', epic: 'META', name: 'Meta', category: 'us-large-cap', spread_quality: 'tight' },
  { ticker: 'TSLA', epic: 'TSLA', name: 'Tesla', category: 'us-large-cap', spread_quality: 'medium' },
];

// ==================== BIAS DETECTION ====================

interface BiasResult {
  bias: 'bullish' | 'bearish' | 'neutral';
  clarity: number; // 0, 10, or 20
  recent_high: number;
  recent_low: number;
  atr: number;
}

export function detectBias(candles: Candle[]): BiasResult {
  if (candles.length < 20) {
    return { bias: 'neutral', clarity: 0, recent_high: 0, recent_low: 0, atr: 0 };
  }

  // Use last 20 candles for structure analysis
  const recent = candles.slice(0, 20);

  // Find swing highs and lows (simple: compare with 2 candles either side)
  const swingHighs: number[] = [];
  const swingLows: number[] = [];

  for (let i = 2; i < recent.length - 2; i++) {
    const c = recent[i];
    if (c.high > recent[i - 1].high && c.high > recent[i - 2].high &&
        c.high > recent[i + 1].high && c.high > recent[i + 2].high) {
      swingHighs.push(c.high);
    }
    if (c.low < recent[i - 1].low && c.low < recent[i - 2].low &&
        c.low < recent[i + 1].low && c.low < recent[i + 2].low) {
      swingLows.push(c.low);
    }
  }

  // Calculate ATR (14-period)
  let atrSum = 0;
  for (let i = 0; i < Math.min(14, recent.length - 1); i++) {
    const tr = Math.max(
      recent[i].high - recent[i].low,
      Math.abs(recent[i].high - recent[i + 1].close),
      Math.abs(recent[i].low - recent[i + 1].close)
    );
    atrSum += tr;
  }
  const atr = atrSum / Math.min(14, recent.length - 1);

  const recentHigh = Math.max(...recent.slice(0, 10).map(c => c.high));
  const recentLow = Math.min(...recent.slice(0, 10).map(c => c.low));

  // Determine bias from swing structure
  if (swingHighs.length >= 2 && swingLows.length >= 2) {
    const higherHighs = swingHighs[0] > swingHighs[1];
    const higherLows = swingLows[0] > swingLows[1];
    const lowerHighs = swingHighs[0] < swingHighs[1];
    const lowerLows = swingLows[0] < swingLows[1];

    if (higherHighs && higherLows) {
      return { bias: 'bullish', clarity: 20, recent_high: recentHigh, recent_low: recentLow, atr };
    }
    if (lowerHighs && lowerLows) {
      return { bias: 'bearish', clarity: 20, recent_high: recentHigh, recent_low: recentLow, atr };
    }
    if (higherHighs || higherLows) {
      return { bias: 'bullish', clarity: 10, recent_high: recentHigh, recent_low: recentLow, atr };
    }
    if (lowerHighs || lowerLows) {
      return { bias: 'bearish', clarity: 10, recent_high: recentHigh, recent_low: recentLow, atr };
    }
  }

  return { bias: 'neutral', clarity: 0, recent_high: recentHigh, recent_low: recentLow, atr };
}

// ==================== KILL ZONE CHECK ====================

export function getCurrentKillZone(): { inKillZone: boolean; zone: string } {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcMinute = now.getUTCMinutes();
  const timeDecimal = utcHour + utcMinute / 60;

  if (timeDecimal >= 7 && timeDecimal < 10) return { inKillZone: true, zone: 'London Open' };
  if (timeDecimal >= 13 && timeDecimal < 16) return { inKillZone: true, zone: 'NY Open' };
  if (timeDecimal >= 15 && timeDecimal < 17) return { inKillZone: true, zone: 'London Close' };

  return { inKillZone: false, zone: 'outside' };
}

// ==================== MAIN SCANNER ====================

// Demo-phase gate relaxations. Set DEMO_RELAXED_GATES=true in the env to
// unlock more trade candidates during the 2-week evaluation window:
//   - Kill-zone bonus: inside 15 / outside 10 (instead of 15 / 0) — narrows
//     the penalty gap from 15 points to 5 so off-hours setups can clear the
//     Tier 2 threshold when bias + news + spread are strong.
//   - Tier 3 bracket at score 50-64 — adds a new risk band (0.5% risk per
//     trade; see agent prompt demo-context block) for marginal setups.
// Default (unset flag) preserves the stricter production behaviour.
function demoRelaxedGatesActive(): boolean {
  return process.env.DEMO_RELAXED_GATES === 'true';
}

const KILL_ZONE_BONUS_IN = 15;
function killZoneBonusOut(): number {
  return demoRelaxedGatesActive() ? 10 : 0;
}

const TIER_1_THRESHOLD = 80;
const TIER_2_THRESHOLD = 65;
function tier3Threshold(): number {
  return demoRelaxedGatesActive() ? 50 : Infinity;
}

// Hourly ranking cache. During the free-tier demo window, the scanner's full
// fan-out (20 × fetchCandles('1h', 30) = 20 Twelve Data credits per call) ran
// every ICT cycle (~every 15 min), burning the daily cap by mid-session.
// Cache the full ranked list for 60 min, invalidating early on kill-zone
// transitions so the killZone score bonus stays accurate. Post-demo, once
// Twelve Data Grow is active, drop RANKING_TTL_MS to 0 to restore per-cycle
// freshness (memory note: reference_farad_scanner_throttle.md).
let rankingCache: { at: number; zone: string; results: RankedInstrument[] } | null = null;
const RANKING_TTL_MS = 60 * 60_000;

/** Exposed for tests — clear the ranking cache. */
export function _resetRankingCache(): void {
  rankingCache = null;
}

/** Exposed for tests/monitoring — current cache state. */
export function _getRankingCache(): { at: number; zone: string; results: RankedInstrument[] } | null {
  return rankingCache;
}

export async function getRankedInstruments(limit: number = 20): Promise<RankedInstrument[]> {
  const killZone = getCurrentKillZone();

  // Serve from cache if within TTL AND kill zone hasn't transitioned. A zone
  // change flips the killZone bonus baked into composite_score, so we must
  // re-rank when it does.
  if (
    rankingCache &&
    Date.now() - rankingCache.at < RANKING_TTL_MS &&
    rankingCache.zone === killZone.zone
  ) {
    return rankingCache.results.slice(0, limit);
  }

  const results: RankedInstrument[] = [];

  // Scan all instruments in parallel (batched to respect rate limits)
  const batchSize = 5;
  for (let i = 0; i < INSTRUMENT_UNIVERSE.length; i += batchSize) {
    const batch = INSTRUMENT_UNIVERSE.slice(i, i + batchSize);

    const batchResults = await Promise.all(
      batch.map(async (inst) => {
        try {
          // Get 1H candles for bias detection
          const candles = await fetchCandles(inst.ticker, '1h', 30);
          const biasResult = detectBias(candles);

          // Skip neutral instruments
          if (biasResult.bias === 'neutral') {
            return null;
          }

          // Get news score (quick check)
          const newsScore = await getNewsScore(inst.ticker);

          // Preliminary composite score
          let score = 0;
          score += biasResult.clarity;                                           // 0/10/20
          score += killZone.inKillZone ? KILL_ZONE_BONUS_IN : killZoneBonusOut(); // 0/10/15
          score += newsScore;                                                    // -15 to +20
          score += inst.spread_quality === 'tight' ? 5 : 0;                    // Bonus for tight spreads

          // Base score of 25 so Tier 2 (65+) is achievable with moderate signals
          score += 25;

          const tier: 1 | 2 | 3 | null =
            score >= TIER_1_THRESHOLD ? 1 :
            score >= TIER_2_THRESHOLD ? 2 :
            score >= tier3Threshold() ? 3 :
            null;

          return {
            ticker: inst.ticker,
            name: inst.name,
            composite_score: Math.max(0, Math.min(100, score)),
            bias: biasResult.bias as 'bullish' | 'bearish' | 'neutral',
            tier,
          } satisfies RankedInstrument;
        } catch {
          return null;
        }
      })
    );

    for (const r of batchResults) {
      if (r !== null) results.push(r);
    }
  }

  // Sort by score descending, then cache the full list (slice on read).
  results.sort((a, b) => b.composite_score - a.composite_score);
  rankingCache = { at: Date.now(), zone: killZone.zone, results };
  return results.slice(0, limit);
}

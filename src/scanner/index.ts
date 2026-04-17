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

import { fetchCandles } from '../mcp-server/market-data.js';
import { getNewsScore } from '../news/index.js';
import type { Candle, RankedInstrument } from '../types.js';

// ==================== INSTRUMENT UNIVERSE ====================
// Categorised for position concentration limits

export const INSTRUMENT_UNIVERSE: Array<{
  ticker: string;
  name: string;
  category: string;
  spread_quality: 'tight' | 'medium' | 'wide';
}> = [
  // Indices
  { ticker: 'NAS100', name: 'Nasdaq 100', category: 'index', spread_quality: 'tight' },
  { ticker: 'SPX500', name: 'S&P 500', category: 'index', spread_quality: 'tight' },
  { ticker: 'US30', name: 'Dow Jones 30', category: 'index', spread_quality: 'tight' },
  { ticker: 'DE40', name: 'DAX 40', category: 'index', spread_quality: 'tight' },
  { ticker: 'UK100', name: 'FTSE 100', category: 'index', spread_quality: 'medium' },

  // Commodities
  { ticker: 'XAUUSD', name: 'Gold', category: 'commodity', spread_quality: 'tight' },
  { ticker: 'XAGUSD', name: 'Silver', category: 'commodity', spread_quality: 'medium' },
  { ticker: 'USOIL', name: 'Crude Oil WTI', category: 'commodity', spread_quality: 'medium' },

  // FX Majors
  { ticker: 'EURUSD', name: 'EUR/USD', category: 'fx', spread_quality: 'tight' },
  { ticker: 'GBPUSD', name: 'GBP/USD', category: 'fx', spread_quality: 'tight' },
  { ticker: 'USDJPY', name: 'USD/JPY', category: 'fx', spread_quality: 'tight' },
  { ticker: 'GBPJPY', name: 'GBP/JPY', category: 'fx', spread_quality: 'medium' },
  { ticker: 'AUDUSD', name: 'AUD/USD', category: 'fx', spread_quality: 'tight' },

  // US Large-Cap Stocks
  { ticker: 'AAPL', name: 'Apple', category: 'us-large-cap', spread_quality: 'tight' },
  { ticker: 'MSFT', name: 'Microsoft', category: 'us-large-cap', spread_quality: 'tight' },
  { ticker: 'NVDA', name: 'NVIDIA', category: 'us-large-cap', spread_quality: 'tight' },
  { ticker: 'AMZN', name: 'Amazon', category: 'us-large-cap', spread_quality: 'tight' },
  { ticker: 'GOOGL', name: 'Alphabet', category: 'us-large-cap', spread_quality: 'tight' },
  { ticker: 'META', name: 'Meta', category: 'us-large-cap', spread_quality: 'tight' },
  { ticker: 'TSLA', name: 'Tesla', category: 'us-large-cap', spread_quality: 'medium' },
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

export async function getRankedInstruments(limit: number = 20): Promise<RankedInstrument[]> {
  const killZone = getCurrentKillZone();
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
          score += biasResult.clarity;                          // 0/10/20
          score += killZone.inKillZone ? 15 : 0;              // 0/15
          score += newsScore;                                   // -15 to +20
          score += inst.spread_quality === 'tight' ? 5 : 0;   // Bonus for tight spreads

          // Base score of 25 so Tier 2 (65+) is achievable with moderate signals
          score += 25;

          return {
            ticker: inst.ticker,
            name: inst.name,
            composite_score: Math.max(0, Math.min(100, score)),
            bias: biasResult.bias as 'bullish' | 'bearish' | 'neutral',
            tier: score >= 80 ? 1 as const : score >= 65 ? 2 as const : null,
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

  // Sort by score descending, return top N
  results.sort((a, b) => b.composite_score - a.composite_score);
  return results.slice(0, limit);
}

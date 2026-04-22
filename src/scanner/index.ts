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

import { fetchCandles, TwelveDataDailyCapError } from '../mcp-server/market-data.js';
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
  // Core 7 (post-2026-04-22 audit: indices removed).
  // All tight-spread, deepest-liquidity instruments where ICT structure reads
  // cleanest. See commit history for the 10/25-instrument predecessors if
  // you want to restore indices or minor pairs.
  //
  // Indices (US30/US100/US500/DE40/UK100) removed 2026-04-22: each one routes
  // to an unrelated Euronext/NASDAQ ETF on Twelve Data Grow tier, so the
  // scanner was scoring bias on wrong underlyings. Added to
  // TWELVE_DATA_UNAVAILABLE and removed from this universe so agents don't
  // ship place_order calls for instruments we have no reliable bias for.
  // Re-add when a real index feed is wired (Pro-tier TD or Finnhub /indices).

  // Commodities (3) — OIL_CRUDE + SILVER restored 2026-04-21. Gold-silver
  // ratio + gold-oil correlation give the agent useful cross-asset macro
  // reads during kill zones. Medium spread on silver/oil is tolerable
  // because they trade large enough ATR ranges that the spread is a small
  // % of typical setup distance.
  { ticker: 'GOLD', epic: 'GOLD', name: 'Gold', category: 'commodity', spread_quality: 'tight' },
  { ticker: 'SILVER', epic: 'SILVER', name: 'Silver', category: 'commodity', spread_quality: 'medium' },
  { ticker: 'OIL_CRUDE', epic: 'OIL_CRUDE', name: 'Crude Oil WTI', category: 'commodity', spread_quality: 'medium' },

  // FX Majors (4) — highest-liquidity pairs, cleanest kill-zone behaviour
  { ticker: 'EURUSD', epic: 'EURUSD', name: 'EUR/USD', category: 'fx', spread_quality: 'tight' },
  { ticker: 'GBPUSD', epic: 'GBPUSD', name: 'GBP/USD', category: 'fx', spread_quality: 'tight' },
  { ticker: 'USDJPY', epic: 'USDJPY', name: 'USD/JPY', category: 'fx', spread_quality: 'tight' },
  { ticker: 'AUDUSD', epic: 'AUDUSD', name: 'AUD/USD', category: 'fx', spread_quality: 'tight' },
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

  // ============== SLOPE-BASED CLARITY FALLBACK (2026-04-22) ==============
  // If formal swing structure is inconclusive, check whether the last 10
  // closes are strongly monotonic. >=7 of the 9 transitions in the same
  // direction earns clarity=15 — weaker than clean HH+HL (20) but stronger
  // than a single partial-swing signal (10). Added to resolve the "scanner
  // says bearish, 1H says bullish" conflicts that dominated morning SKIP
  // decisions on 2026-04-22.
  const last10 = recent.slice(0, 10);
  let upTransitions = 0;
  let downTransitions = 0;
  for (let i = 0; i < last10.length - 1; i++) {
    // last10 is reverse-chronological: index i is newer than index i+1.
    if (last10[i].close > last10[i + 1].close) upTransitions++;
    else if (last10[i].close < last10[i + 1].close) downTransitions++;
  }
  if (upTransitions >= 7) {
    return { bias: 'bullish', clarity: 15, recent_high: recentHigh, recent_low: recentLow, atr };
  }
  if (downTransitions >= 7) {
    return { bias: 'bearish', clarity: 15, recent_high: recentHigh, recent_low: recentLow, atr };
  }
  // ============== END SLOPE FALLBACK ==============

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
const KILL_ZONE_BONUS_OUT = 0;

const TIER_1_THRESHOLD = 80;
// Tier 2 lowered from 65 → 60 to capture more high-quality setups.
const TIER_2_THRESHOLD = 60;
// Tier 3 is now permanent (was demo-only). 0.5% risk, requires score 50-59.
// Tier 3 lowered from 50 → 45 (2026-04-22) as part of Approach 2 loosening
// to unblock observable trade cycles during the demo window. Both demo and
// non-demo paths now use the same value — the demo-flag split no longer
// serves a purpose since the production bar should match the demo bar.
const TIER_3_THRESHOLD = 45;
function tier3Threshold(): number {
  return TIER_3_THRESHOLD;
}

// Hourly ranking cache. During the free-tier demo window, the scanner's full
// fan-out (20 × fetchCandles('1h', 30) = 20 Twelve Data credits per call) ran
// every ICT cycle (~every 15 min), burning the daily cap by mid-session.
// Cache the full ranked list for 60 min, invalidating early on kill-zone
// transitions so the killZone score bonus stays accurate. Post-demo, once
// Twelve Data Grow is active, drop RANKING_TTL_MS to 0 to restore per-cycle
// freshness (memory note: reference_farad_scanner_throttle.md).
let rankingCache: { at: number; zone: string; results: RankedInstrument[] } | null = null;
// Reduced from 60 min → 15 min so fresh signals are picked up faster each cycle.
const RANKING_TTL_MS = 15 * 60_000;

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

  // Hard gate — no scanning outside kill zones
  if (!killZone.inKillZone) {
    console.log('[Scanner] Outside kill zone — no instruments ranked.');
    return [];
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
          score += killZone.inKillZone ? KILL_ZONE_BONUS_IN : KILL_ZONE_BONUS_OUT; // 15 in-zone, 0 outside
          score += newsScore;                                                    // -15 to +20
          score += inst.spread_quality === 'tight' ? 5 : 0;                    // Bonus for tight spreads

          // Base score lifted 25 → 30 (2026-04-22) as part of Approach 2 loosening.
          // Combined with the Tier 3 threshold drop to 45, any instrument that had
          // clarity>=10 in a kill zone now clears Tier 3 (base 30 + clarity 10 +
          // kz 15 + spread 5 = 60, a clean Tier 2).
          score += 30;

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
        } catch (err) {
          // Per-instrument failures are expected (TD outage on a single
          // symbol, rate-limit queue timeout on one call, etc.) and the
          // scanner's job is to score what it can. But the daily-cap
          // breaker tripping is a DIFFERENT class of signal — it means
          // every subsequent fetchCandles will also fail for the rest of
          // the UTC day. Ops needs to see that once, loudly, so they can
          // investigate why credits were consumed early.
          if (err instanceof TwelveDataDailyCapError) {
            console.error(
              `[Scanner] Twelve Data daily cap tripped while scoring ${inst.ticker} — ` +
                `resets at ${err.resetsAt.toISOString()}. Remaining cycles today ` +
                `will return mostly-neutral bias.`,
            );
          }
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

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
import { tier3FloorFor } from '../agents/spread.js';
import type { Candle, RankedInstrument } from '../types.js';

// ==================== INSTRUMENT UNIVERSE ====================
// Categorised for position concentration limits.
// `ticker` is the human-readable identifier (used for display, logging,
// Telegram alerts, news lookups via MarketAux, candle fetches via Twelve
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
  // CODEX P1 #6 + #6 again on third pass (2026-04-28): this fallback is
  // momentum-following ("7 of last 9 closes went up → call it bullish").
  // ICT methodology is REVERSAL/STRUCTURAL — trade against extended momentum
  // at premium/discount levels. Calling something "bullish bias" precisely
  // when it has been going up for 7 closes is the OPPOSITE of what ICT
  // teaches; the bot may have been entering longs at the top of momentum
  // runs where ICT wants to short.
  //
  // Now feature-flagged behind SCANNER_SLOPE_FALLBACK=true (default OFF).
  // Disabled by default; enable only after a controlled A/B with logged
  // win-rate by bias-source (clean HH/LL vs slope-fallback) shows it
  // beats the ICT-pure baseline.
  if (process.env.SCANNER_SLOPE_FALLBACK === 'true') {
    const last10 = recent.slice(0, 10);
    let upTransitions = 0;
    let downTransitions = 0;
    for (let i = 0; i < last10.length - 1; i++) {
      // last10 is reverse-chronological: index i is newer than index i+1.
      if (last10[i].close > last10[i + 1].close) upTransitions++;
      else if (last10[i].close < last10[i + 1].close) downTransitions++;
    }
    if (upTransitions >= 7) {
      console.log(`[Scanner] Slope fallback fired: bullish (${upTransitions}/9 up). Feature-flag-gated.`);
      return { bias: 'bullish', clarity: 15, recent_high: recentHigh, recent_low: recentLow, atr };
    }
    if (downTransitions >= 7) {
      console.log(`[Scanner] Slope fallback fired: bearish (${downTransitions}/9 down). Feature-flag-gated.`);
      return { bias: 'bearish', clarity: 15, recent_high: recentHigh, recent_low: recentLow, atr };
    }
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

  // 2026-04-29 audit-3 r3 fix (scanner+misc P1-3): eliminated the
  // 15:00-16:00 UTC overlap between NY Open (13:00-16:00) and London
  // Close (was 15:00-17:00). Pre-fix, first-match-wins put every
  // 15:00-16:00 trade under "NY Open" even though the London Close
  // session was active too, persistently mis-attributing kill_zone on
  // every lesson row from that hour and corrupting Reflection /
  // Weekly-Review session-attribution training data. Fix: London Close
  // window starts at 16:00 (the moment NY Open's window ends) so the
  // boundary is clean and exactly one zone is active at any UTC minute.
  if (timeDecimal >= 7 && timeDecimal < 10) return { inKillZone: true, zone: 'London Open' };
  if (timeDecimal >= 13 && timeDecimal < 16) return { inKillZone: true, zone: 'NY Open' };
  if (timeDecimal >= 16 && timeDecimal < 17) return { inKillZone: true, zone: 'London Close' };

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
// Tier 3 floor is now spread-class dependent (see ../agents/spread.ts).
// History: 50 (original) → 45 (2026-04-22) → 40 (Phase E 2026-05-04 for
// tight-spread only after the 2026-05-04 backtest showed OIL_CRUDE at
// score 40-44 dominated the loosened-run drawdown). Tight-spread tickers
// (EUR/GBP/USDJPY/AUDUSD/GOLD): floor 40. Medium-spread (OIL_CRUDE,
// SILVER): floor stays 45. Resolved per ticker via tier3FloorFor().

// Ranking cache. Originally a 60 min cache during the free-tier demo to fit
// Twelve Data's 800/day cap (scanner fan-out is 20 × 1h-candle fetches per
// call). Reduced to 15 min mid-demo after the Grow tier ($79/mo, 5,000/day)
// was paid. Now zero post-demo (2026-05-08): on Grow the budget is no longer
// the constraint, and per-cycle ranking gives the freshest signal-quality.
// Kill-zone transition invalidation (below) becomes a no-op when TTL is 0
// but is left in place — the cache write still happens (trivial memory),
// just never serves. Set TTL > 0 if a future scheduler cadence change makes
// per-cycle calls a budget concern again.
let rankingCache: { at: number; zone: string; results: RankedInstrument[] } | null = null;
const RANKING_TTL_MS = 0;

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

          // 2026-04-29 range-mode (5th trigger) addition:
          // Neutral-bias instruments are NO LONGER filtered out at
          // scanner stage. Pre-fix this dropped 5/7 of the universe on
          // pre-FOMC days, leaving the bot trading the same 1-2
          // instruments cycle after cycle. Post-fix neutrals are passed
          // through with a Tier-3-capped score so the agent can apply
          // the Range Sweep Reversal trigger (strategy.md Section 3
          // trigger 5) when 1H is genuinely sideways.
          //
          // Score cap rationale: range-mode setups are higher-variance
          // than trend-following, so they're capped at Tier 3 (45-59
          // band, score ≤ 65 — leaves headroom for the agent's added
          // ICT array score). The agent prompt enforces the half-size
          // posture (0.25% total risk) and the trigger-5 requirements.
          const isRangeMode = biasResult.bias === 'neutral';

          // Get news score (quick check). 2026-05-05 audit (A2): now returns
          // { score, news_unavailable } so we can log when news is degraded.
          // Score is still added to the composite — when news is unavailable
          // it's 0 (neutral fallback), but the loud log gives ops a signal
          // that the instrument's news context is missing this cycle.
          const newsResult = await getNewsScore(inst.ticker);
          if (newsResult.news_unavailable) {
            console.warn(
              `[Scanner] ${inst.ticker} ranked with news_unavailable=true (score defaulted to 0). ` +
              `Agent will see this in get_news_context if it queries; downstream Cat-A-opposing veto cannot fire.`,
            );
          }
          const rawNewsScore = newsResult.score;

          // 2026-04-29 structural-overhaul rebalance (item 3 from
          // strategy.md Section 5):
          //   - base 30 → 25
          //   - bias clarity scale lifted 0/10/15/20 → 0/15/20/25
          //   - kill zone REMOVED as score component (now hard gate only)
          //   - news capped at +10 / -15 (was +20 / -15) to prevent
          //     news-pump on no-structure setups
          //   - spread bonus unchanged at +5 tight / 0 medium
          //   - history adjustment is applied LATER inside the agent
          //     prompt (not in scanner) and is unchanged here
          let score = 0;
          // Lift the legacy clarity scale 0/10/15/20 to the new
          // 0/15/20/25 by remapping. detectBias.clarity returns the
          // legacy scale; we convert deterministically here so the
          // bias-detector code stays unchanged.
          const remappedClarity =
            biasResult.clarity >= 20 ? 25 :
            biasResult.clarity >= 15 ? 20 :
            biasResult.clarity >= 10 ? 15 :
            0;
          score += remappedClarity;                                              // 0/15/20/25
          // News contribution is now emitted directly at -15/+10 (Cat A) and
          // -5/+5 (Cat B) by src/news/index.ts. Phase A2 (2026-05-04, audit
          // Finding #5): pre-fix the function emitted +20/+10 and the
          // scanner capped here. Now redundant — source-side fix in
          // news/index.ts:135-141 means rawNewsScore is already bounded.
          score += rawNewsScore;                                                  // -15 to +10
          score += inst.spread_quality === 'tight' ? 5 : 0;                      // 0 / +5
          score += 25;                                                            // base (was 30)
          // NOTE: kill_zone score component intentionally removed.
          // killZone.inKillZone === true is enforced as a hard gate
          // earlier in this function (line 272 `if (!killZone.inKillZone) return []`).

          // Range-mode handling (codex review of 7b6db35):
          //
          // Pre-fix: range-mode max scanner output was 25 (base) + 0 (no
          // bias clarity, neutral always) + 0 (no ICT array — that's the
          // agent's job in trigger 5) + 10 (news) + 5 (spread) = 40.
          // Below the 45 floor. Bot would never propose a range trade.
          //
          // Post-fix: range-mode gets a +20 "range candidate" baseline
          // representing "this instrument is range-eligible — pre-screen
          // pass". The AGENT validates the actual range quality in Step
          // 3I (trigger 5 criteria) and rejects if the range / sweep /
          // reversal conditions aren't met. The +20 represents the
          // "structural payment" the agent would have earned via the
          // ICT array score in trend-mode; range-mode equivalent is the
          // range itself being a valid setup framework.
          //
          // Net range-mode max: 25 + 20 + 10 + 5 = 60 → capped at 59.
          // Net range-mode floor (no news, no spread bonus): 25 + 20 = 45.
          // Just above the executor floor — qualifies for Tier 3.
          if (isRangeMode) {
            score += 20;                                                          // range-candidate baseline
            score = Math.min(score, 59);                                          // Tier 3 cap
          }

          const tier: 1 | 2 | 3 | null =
            score >= TIER_1_THRESHOLD ? 1 :
            score >= TIER_2_THRESHOLD ? 2 :
            score >= tier3FloorFor(inst.ticker) ? 3 :
            null;

          return {
            ticker: inst.ticker,
            name: inst.name,
            composite_score: Math.max(0, Math.min(100, score)),
            bias: biasResult.bias as 'bullish' | 'bearish' | 'neutral',
            tier,
            // Placeholder — Task 3 wires this to a real cache fetch via capital.getMarketDetails().
            min_deal_size: null,
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

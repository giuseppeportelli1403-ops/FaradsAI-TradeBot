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
// Capital.com demo API on 2026-04-17. For all 7 instruments (post-2026-04-22
// indices removal) epic == ticker verbatim. Ignore scripts/epic-mapping.json
// — that file was produced by the older markets[0] heuristic and contains
// ETF/weekend contracts for 4 entries; the epic field here is the source of
// truth.

import { fetchCandles, TwelveDataDailyCapError } from '../mcp-server/market-data.js';
import { capital } from '../mcp-server/capital-singleton.js';
import { getNewsScore } from '../news/index.js';
import { tier3FloorFor } from '../agents/spread.js';
import { composeScore } from '../scoring/compose.js';
import { recordRejection } from '../rejection-log/record.js';
import type { Candle, RankedInstrument } from '../types.js';

// ==================== INSTRUMENT UNIVERSE ====================
// Categorised for position concentration limits.
// `ticker` is the human-readable identifier (used for display, logging,
// Telegram alerts, news lookups via MarketAux, candle fetches via Twelve
// Data, and DB storage). `epic` is the Capital.com broker identifier used
// for any Capital REST API call (searchMarkets, getMarketDetails,
// openPosition, closePosition, getCandles, etc.).
//
// epic values verified live against Capital.com demo on 2026-04-17 — epic == ticker for all 7 (post-2026-04-22 indices removal).
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

// 2026-05-09: min_deal_size lookup cache. Capital's broker minimums rarely
// change (typically stable for months), so we cache per-instrument values
// for the lifetime of the scanner module. PM2 restarts (deploy, daily cron)
// refresh the cache. The agent's L3b-2 feasibility check (prompts/ict-agent.md
// STEP 3 sub-step L0) reads min_deal_size to skip infeasible candidates
// upfront; the existing pre-check at trading-agent.ts:869 still does a fresh
// fetch on every request_analyst_review call as the defensive last gate, so
// stale cache entries result in at most one wasted analyst round-trip per
// drift event (caught and corrected by the live fetch).
//
// In-flight promise dedup: when two callers hit the same cold ticker
// concurrently (e.g. researcher-agent + scheduler ICT trigger overlapping
// at startup), we want exactly one Capital fetch per ticker. Storing the
// in-flight promise in the cache means subsequent callers await the same
// promise and resolve with the same value, no duplicate API calls.
let minDealSizeCache: Map<string, Promise<number | null>> | null = null;

/** Test-only export so tests/scanner-min-deal-size.test.ts can drive the helper directly. */
export async function _getMinDealSizeFor(ticker: string): Promise<number | null> {
  return getMinDealSizeFor(ticker);
}

async function getMinDealSizeFor(ticker: string): Promise<number | null> {
  if (!minDealSizeCache) {
    minDealSizeCache = new Map();
  }
  const cached = minDealSizeCache.get(ticker);
  if (cached !== undefined) {
    return cached;
  }
  // Store the IN-FLIGHT promise so concurrent callers dedupe to one fetch.
  const fetchPromise = (async (): Promise<number | null> => {
    try {
      const md = await capital.getMarketDetails(ticker);
      const v = md?.dealingRules?.minDealSize?.value;
      return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[Scanner] min_deal_size fetch failed for ${ticker}: ${msg} — caching null; agent will fall through to request_analyst_review pre-check.`,
      );
      return null;
    }
  })();
  minDealSizeCache.set(ticker, fetchPromise);
  return fetchPromise;
}

/** Test-only: clear the min_deal_size cache. Mirrors the _resetRankingCache pattern. */
export function _resetMinDealSizeCache(): void {
  minDealSizeCache = null;
}

/** Test-only: read current cache state for assertion. Returns the Map of in-flight or resolved Promises (test code can await each value to inspect resolved size). */
export function _getMinDealSizeCache(): Map<string, Promise<number | null>> | null {
  return minDealSizeCache;
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
    // T032 (US-2): record one KILL_ZONE_OUT rejection per instrument so the
    // daily digest accurately reflects what was skipped. Wrapped in
    // try/catch because a DB hiccup must not break the scanner's hard gate.
    try {
      for (const inst of INSTRUMENT_UNIVERSE) {
        recordRejection({
          instrument: inst.ticker,
          layer: 'scanner',
          category: 'KILL_ZONE_OUT',
          reason_text: `Outside kill zones (current zone: ${killZone.zone}). Active windows: London Open 07-10 UTC, NY Open 13-16 UTC, London Close 16-17 UTC.`,
          subcategory: killZone.zone,
        });
      }
    } catch (err) {
      console.warn(`[Scanner] recordRejection(KILL_ZONE_OUT) failed: ${err instanceof Error ? err.message : String(err)}`);
    }
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

          // 2026-05-12 — US-1 deterministic scoring rewrite (Migration 007).
          // The 35-line inline rubric below was lifted into the dedicated
          // src/scoring/ module so the live scanner AND the backtest engine
          // share one source of truth. Numerical output equals the legacy
          // inline math PLUS the new deterministic ictArrayComponent (US-5
          // / T066, 2026-05-12). The history component (±10) is still 0
          // here because history depends on setup_type, which only the
          // agent knows after trigger detection; the agent continues to
          // compute its own history adjustment per prompts/ict-agent.md §G.
          //
          // 2026-05-12 — US-5 / T066: ictArrayInputs now populated with
          // 1H candles + bias + ATR + current price + spread, so the
          // OB/FVG/sweep/BOS detector at src/scoring/ict-array-detector.ts
          // can return non-zero contributions. This makes Tier 1 reachable
          // from the scanner WITHOUT prompt-side LLM math (SC-001 + the
          // Tier 1 reachability gap closed). Range-mode setups still
          // typically score 0 here because bias is neutral — the +20
          // baseline + cap-59 logic continues to govern that case.
          const currentPrice = candles.length > 0 ? candles[0].close : 0;
          const composed = composeScore({
            ticker: inst.ticker,
            rawBiasClarity: biasResult.clarity,
            rawNewsScore,
            spreadQuality: inst.spread_quality,
            historyWinRate: undefined,    // agent-side per prompt s.G
            historySampleSize: undefined,
            isRangeMode,
            ictArrayInputs: {
              candles1h: candles,
              bias: biasResult.bias as 'bullish' | 'bearish' | 'neutral',
              atr: biasResult.atr,
              currentPrice,
              spread: inst.spread_quality === 'tight' ? 0.0001 : 0.001,
            },
          });

          return {
            ticker: inst.ticker,
            name: inst.name,
            composite_score: composed.composite_score,
            bias: biasResult.bias as 'bullish' | 'bearish' | 'neutral',
            tier: composed.tier,
            score_breakdown: composed.score_breakdown,
            scorer_version: composed.scorer_version,
            // min_deal_size populated post-loop via getMinDealSizeFor (L3b-2).
            // Double-cast bridges the partial literal through the
            // RankedInstrument type until the Promise.all augmentation
            // below fills the field on every result before return.
          } as Omit<RankedInstrument, 'min_deal_size'> as RankedInstrument;
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
          // T033 (US-2): per-instrument scanner failure now visible in
          // the daily digest as SCANNER_FETCH_ERROR. Subcategory carries
          // the error class (TwelveDataDailyCapError, AxiosError, etc.)
          // so ops can spot patterns without log-trawling.
          try {
            recordRejection({
              instrument: inst.ticker,
              layer: 'scanner',
              category: 'SCANNER_FETCH_ERROR',
              reason_text: `Per-instrument scoring failed: ${err instanceof Error ? err.message : String(err)}`,
              subcategory: err instanceof Error ? err.constructor.name : 'unknown',
            });
          } catch (recErr) {
            console.warn(`[Scanner] recordRejection(FETCH_ERROR) failed: ${recErr instanceof Error ? recErr.message : String(recErr)}`);
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

  // 2026-05-09 (L3b-2): augment each result with min_deal_size from the
  // module-level cache. Promise.all means the 7-instrument universe fetches
  // concurrently on cold cache; subsequent cycles return instantly from
  // the in-memory map. The agent now sees min_deal_size in
  // get_ranked_instruments output and can run the L0 feasibility check
  // before requesting analyst review for an oversized-notional candidate.
  // 2026-05-09 (L3b-2 review-hardening): wrap Promise.all in try/catch so a
  // rejection in any getMinDealSizeFor promise can't take down the entire
  // ranking call. Today getMinDealSizeFor catches all errors internally
  // (returns null on Capital fetch failure) so this path is unreachable —
  // but a future change that broke that invariant would otherwise propagate
  // an unhandled rejection up to the agent's executeTool, killing the
  // cycle. Fall back to all-null min_deal_size so the agent's L0 prompt
  // step routes everything through the live pre-check at
  // trading-agent.ts:869 — same defensive behavior as for individual ticker
  // failures.
  let augmented: RankedInstrument[];
  try {
    augmented = await Promise.all(
      results.map(async (r) => ({
        ...r,
        min_deal_size: await getMinDealSizeFor(r.ticker),
      })),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[Scanner] min_deal_size augmentation failed: ${msg} — returning results with null min_deal_size; agent will fall through to request_analyst_review pre-check.`,
    );
    augmented = results.map((r) => ({ ...r, min_deal_size: null }));
  }
  rankingCache = { at: Date.now(), zone: killZone.zone, results: augmented };
  return augmented.slice(0, limit);
}

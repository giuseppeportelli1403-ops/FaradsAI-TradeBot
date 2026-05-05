// News Context System — Fetcher, Scorer, and Categoriser
// Provides scored news items for trading agents and the scanner
//
// Data source: MarketAux News API (per-entity sentiment) + RSS aggregator
// Categories:
//   Cat A: Major macro catalyst — keyword whitelist (FOMC, NFP, CPI, ECB, BoE,
//          BoJ, RBA, BoC, SNB, RBNZ, Core PCE, AHE, Unemployment Rate, Retail
//          Sales, ISM PMI, OPEC, oil inventories, etc). Banker surnames
//          (Powell, Lagarde, Bailey, Ueda, Macklem, Jordan, Orr) require
//          central-bank context to count. Sentiment magnitude alone does NOT
//          qualify.
//   Cat B: Moderate supporting context (e.g. analyst upgrades, sector rotation)
//   Cat C: Noise — ignored downstream
//
// Rebalanced rubric (strategy.md Section 5, post-2026-04-29):
//   Cat A aligned → +10 (was +20 pre-rebalance; capped to +10 by scanner
//                        until 2026-05-04, when this function was synced
//                        directly per audit Finding #5)
//   Cat A opposing → -15
//   Cat B aligned → +5 (was +10 pre-rebalance; same sync)
//   Cat B opposing → -5
//   Cat C / neutral / none → 0
//
// Opposing-news posture: Cat A opposing softens size to 50% (post-2026-04-23
// P2). Cat B opposing is neutral on size (just the score penalty). Range-mode
// Cat A opposing INVALIDATES the setup entirely (does not soften — see
// strategy.md §K, ict-agent.md:201).

import { fetchNewsContext } from '../mcp-server/market-data.js';
import type { NewsItem } from '../types.js';
import { getRssNewsForInstrument, rssArticleToNewsItem } from './rss-aggregator.js';
import { instrumentToCurrencies } from './calendar-veto.js';
import { canonicalizeUrl } from './url-canonical.js';

// ==================== NEWS SCORING ====================

export interface ScoredNews {
  items: NewsItem[];
  overall_score: number;          // -15 to +10 for composite scoring (post-2026-04-29 rebalance)
  dominant_category: 'A' | 'B' | 'C' | 'none';
  dominant_sentiment: 'bullish' | 'bearish' | 'neutral';
  summary: string;
  // Added 2026-04-23 (news-resilience Layer 4). Max stale_minutes across items
  // in this batch. 0 on fresh provider hits. Non-zero when served from stale cache
  // during news-provider quota exhaustion. `stale_dampened` is true when the overall_score
  // was attenuated because stale bearish news is unreliable signal — see
  // STALE_BEARISH_DAMPEN_MINUTES constant below.
  stale_minutes: number;
  stale_dampened: boolean;
  // Added 2026-04-28 (Codex P1 #15). True when ALL news sources failed
  // (MarketAux fetch threw + RSS aggregator empty). The downstream agent
  // should treat this as DEGRADED-DATA and refuse to take Cat-A-driven
  // sizing rather than treating "no news" as "no news risk."
  news_unavailable: boolean;
}

// If cached news is older than this AND the aggregate is bearish, its
// magnitude is halved. Rationale: during news-provider quota exhaustion the bot serves
// cached news up to 4 h old. Stale BULLISH news that's still in the cache is
// at worst "missed the boost" — conservative. Stale BEARISH news that the
// market has since moved past, however, would cause the bot to skip good
// setups OR worse, if the news has flipped and the bot can't see it, trade
// INTO unseen fresh bullish news. Halving magnitude lets the bot still
// respect obviously-bearish cached signal without treating it as gospel.
export const STALE_BEARISH_DAMPEN_MINUTES = 60;

export async function getNewsContext(instrument: string): Promise<ScoredNews> {
  let items: NewsItem[];
  let marketauxFailed = false;

  try {
    items = await fetchNewsContext(instrument);
  } catch {
    items = [];
    marketauxFailed = true;
  }

  // B3 (2026-04-28): merge cached RSS articles into the MarketAux pool.
  // RSS feeds (FXStreet, Kitco, OilPrice, Fed/ECB/BoE, etc) cover FX +
  // commodity narratives that MarketAux's equity-centric entity DB misses.
  // The aggregator polls 18 feeds every 10 min via cron; here we just read
  // from cache. Articles deduped by canonical URL against MarketAux items.
  const currencies = instrumentToCurrencies(instrument);
  const rssArticles = getRssNewsForInstrument(instrument, currencies, {
    maxAgeHours: 24,
    limit: 30,
  });
  if (rssArticles.length > 0) {
    const seenUrls = new Set<string>();
    for (const item of items) {
      if (item.url) seenUrls.add(canonicalizeUrl(item.url));
    }
    for (const article of rssArticles) {
      const key = article.canonicalLink;
      if (key && seenUrls.has(key)) continue;
      if (key) seenUrls.add(key);
      items.push(rssArticleToNewsItem(article));
    }
  }

  if (items.length === 0) {
    // Differentiate between "fetch failed entirely" (data degraded — bot
    // should treat as risk-on, not risk-neutral) and "fetch succeeded
    // but returned 0 articles" (genuinely quiet news cycle, treat neutral).
    const newsUnavailable = marketauxFailed;
    return {
      items: [],
      overall_score: 0,
      dominant_category: 'none',
      dominant_sentiment: 'neutral',
      summary: newsUnavailable
        ? '⚠️ NEWS DATA UNAVAILABLE — both MarketAux and RSS aggregator returned no results. DO NOT treat as "no news risk." Refuse Cat-A-driven sizing decisions until the next cycle.'
        : 'No recent news for this instrument',
      stale_minutes: 0,
      stale_dampened: false,
      news_unavailable: newsUnavailable,
    };
  }

  // Aggregate sentiment over items that ACTUALLY carry sentiment.
  // RSS items default sentiment_score=0 (RSS doesn't carry sentiment scores;
  // the impact-keyword classifier handles Cat A/B/C from title+body).
  // Averaging RSS zeros into MarketAux sentiment dilutes directional signal —
  // see Codex P1 #14, 2026-04-28. We average only items with non-zero score
  // (typically MarketAux), and fall back to 0 if every item is sentiment-less.
  const sentimentItems = items.filter((item) => item.sentiment_score !== 0);
  const avgSentiment = sentimentItems.length > 0
    ? sentimentItems.reduce((sum, item) => sum + item.sentiment_score, 0) / sentimentItems.length
    : 0;

  // 2026-05-05 audit (Phase 2 / Round 4): tier-weighted dominant category.
  // Pre-fix dominantCategory was a binary count — a single Tier-3 blog post
  // tagged Cat A by the keyword classifier produced the same ±10/-15 score
  // as a Federal Reserve press release. Now we weight by relevance_score
  // (RSS sets 1.0/0.6/0.3 by tier in rssArticleToNewsItem; MarketAux sets
  // its own relevance from the source provider). Cat A "active" requires
  // weight sum ≥ 1.0 (one Tier-1 item OR multiple corroborating mid-tier
  // items); Cat B requires ≥ 0.6.
  const catAItems = items.filter((i) => i.category === 'A');
  const catBItems = items.filter((i) => i.category === 'B');
  const sumCatARelevance = catAItems.reduce((s, i) => s + (Number.isFinite(i.relevance_score) ? i.relevance_score : 0), 0);
  const sumCatBRelevance = catBItems.reduce((s, i) => s + (Number.isFinite(i.relevance_score) ? i.relevance_score : 0), 0);

  const CAT_A_WEIGHT_THRESHOLD = 1.0;
  const CAT_B_WEIGHT_THRESHOLD = 0.6;

  let dominantCategory: 'A' | 'B' | 'C' | 'none';
  if (sumCatARelevance >= CAT_A_WEIGHT_THRESHOLD) dominantCategory = 'A';
  else if (sumCatARelevance > 0 || sumCatBRelevance >= CAT_B_WEIGHT_THRESHOLD) {
    // Cat-A items below the weight threshold are downgraded to Cat B effective.
    // (Single Tier-3 blog flagged Cat A by keyword → counts toward B floor.)
    dominantCategory = 'B';
  } else if (catBItems.length > 0) dominantCategory = 'C';  // weak Cat B signal
  else dominantCategory = 'C';

  // Determine dominant sentiment direction
  let dominantSentiment: 'bullish' | 'bearish' | 'neutral';
  if (avgSentiment > 0.1) dominantSentiment = 'bullish';
  else if (avgSentiment < -0.1) dominantSentiment = 'bearish';
  else dominantSentiment = 'neutral';

  // Calculate composite score adjustment per the post-2026-04-29 rebalanced
  // rubric (strategy.md Section 5). 2026-05-05 (Phase 2 / Round 4): score
  // additionally multiplied by the relevance-weight clamp [0,1] so weak
  // single-source signals don't get full-credit scores. A Tier-1 source
  // alone clears 1.0 and yields full ±10/-15; a single Tier-2 (0.6) yields
  // 60% magnitude; multiple corroborating sources cap at 1.0.
  const catAWeightFactor = Math.min(1, sumCatARelevance / CAT_A_WEIGHT_THRESHOLD);
  const catBWeightFactor = Math.min(1, sumCatBRelevance / CAT_A_WEIGHT_THRESHOLD); // same denominator: relevance vs full Tier-1
  let overallScore = 0;
  if (dominantCategory === 'A') {
    const base = avgSentiment > 0 ? 10 : avgSentiment < 0 ? -15 : 0;
    overallScore = Math.round(base * catAWeightFactor);
  } else if (dominantCategory === 'B') {
    const base = avgSentiment > 0 ? 5 : avgSentiment < 0 ? -5 : 0;
    // Cat B uses its own weight factor (sumCatBRelevance OR sumCatA below threshold).
    const factor = sumCatBRelevance > 0 ? catBWeightFactor : catAWeightFactor;
    overallScore = Math.round(base * factor);
  }

  // ===== Layer 4 — stale-bearish dampening =====
  // During news-provider quota exhaustion, fetchNewsContext serves cached items up to
  // 4 h old. Bearish stale news is dangerous: the market may have moved past
  // the catalyst, or the news may have flipped. Halve the magnitude when
  // items are > STALE_BEARISH_DAMPEN_MINUTES old AND the aggregate is bearish.
  // Bullish stale news is untouched — worst case is "missed boost", which is
  // conservative. Pure-positive and pure-neutral stale news flow through
  // unchanged.
  const staleMinutes = items.reduce((max, item) => Math.max(max, item.stale_minutes ?? 0), 0);
  let staleDampened = false;
  if (staleMinutes > STALE_BEARISH_DAMPEN_MINUTES && overallScore < 0) {
    const before = overallScore;
    overallScore = Math.round(overallScore * 0.5);
    staleDampened = true;
    console.log(
      `[News] Stale-bearish dampening engaged for ${instrument}: ` +
        `${staleMinutes} min old, score ${before} → ${overallScore}`,
    );
  }

  // Build summary from top news items
  const topItems = items
    .filter(i => i.category === 'A' || i.category === 'B')
    .slice(0, 3)
    .map(i => i.title)
    .join(' | ');

  const summary = staleDampened
    ? `[stale ${staleMinutes}min, bearish-dampened] ${topItems || 'No significant news catalysts'}`
    : (staleMinutes > 0
        ? `[stale ${staleMinutes}min] ${topItems || 'No significant news catalysts'}`
        : (topItems || 'No significant news catalysts'));

  return {
    items,
    overall_score: overallScore,
    dominant_category: dominantCategory,
    dominant_sentiment: dominantSentiment,
    summary,
    stale_minutes: staleMinutes,
    stale_dampened: staleDampened,
    news_unavailable: false,
  };
}

// ==================== QUICK SCORE (for scanner) ====================
// 2026-05-05 audit (A2): now returns a structured result so the scanner
// can distinguish "news fetched, score 0" from "news unavailable, defaulted
// to 0". Pre-fix the catch silently returned 0 → scanner treated unavailable
// as neutral, defeating the news_unavailable mechanism that getNewsContext
// already supports. Callers who only care about the score can read .score.

export interface NewsScoreResult {
  score: number;
  news_unavailable: boolean;
}

export async function getNewsScore(instrument: string): Promise<NewsScoreResult> {
  try {
    const result = await getNewsContext(instrument);
    return { score: result.overall_score, news_unavailable: result.news_unavailable };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[News] getNewsScore failed for ${instrument}: ${msg}. Returning {score:0, news_unavailable:true}.`);
    return { score: 0, news_unavailable: true };
  }
}

// ==================== NEWS vs DIRECTION CHECK ====================
// Called by agents after they establish bias, to check if news opposes

export function isNewsOpposing(
  newsSentiment: 'bullish' | 'bearish' | 'neutral',
  newsCategory: 'A' | 'B' | 'C' | 'none',
  tradeBias: 'bullish' | 'bearish'
): boolean {
  // Only Cat A opposing news should block a trade
  if (newsCategory !== 'A') return false;
  if (newsSentiment === 'neutral') return false;

  return (
    (tradeBias === 'bullish' && newsSentiment === 'bearish') ||
    (tradeBias === 'bearish' && newsSentiment === 'bullish')
  );
}

/**
 * Returns the position-size multiplier to apply when the trade is otherwise
 * valid. 1.0 = full size, 0.5 = half size (opposing Cat-A news, P2 softening),
 * 0.0 = do not take the trade.
 *
 * Current policy (post-P2, 2026-04-23):
 *   - Opposing Cat-A news → 0.5 (half-size; softened from former hard SKIP)
 *   - Everything else → 1.0 (full size)
 *
 * The 0.0 value is reserved for future hard-SKIP cases (e.g. extreme
 * opposing news, kill-switch active) but is not returned by any current
 * path. Callers should treat 0.0 as "do not trade".
 *
 * This function is exposed for BOTH: (a) future code-level enforcement,
 * and (b) clarity in the ICT agent prompt (the prompt references the
 * function name so the LLM and the code are aligned semantically).
 */
export function getNewsRiskFactor(
  newsSentiment: 'bullish' | 'bearish' | 'neutral',
  newsCategory: 'A' | 'B' | 'C' | 'none',
  tradeBias: 'bullish' | 'bearish',
): 1.0 | 0.5 | 0.0 {
  if (isNewsOpposing(newsSentiment, newsCategory, tradeBias)) return 0.5;
  return 1.0;
}

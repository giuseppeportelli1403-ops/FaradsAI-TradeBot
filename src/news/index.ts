// News Context System — Fetcher, Scorer, and Categoriser
// Provides scored news items for trading agents and the scanner
//
// Data source: Alpha Vantage News Sentiment API
// Categories:
//   Cat A (score 4-5): Major catalyst — strong directional impact (e.g. FOMC, earnings beat/miss)
//   Cat B (score 2-3): Moderate supporting context (e.g. analyst upgrades, sector rotation)
//   Cat C (score 0-1): Noise — ignore
//
// Rules:
//   - News opposing technical direction → skip instrument entirely
//   - Cat A aligned with direction → +20 score bonus
//   - Cat B aligned → +10 bonus
//   - Cat A opposing → -15 penalty (should skip)
//   - No relevant news → 0 (neutral)

import { fetchNewsContext } from '../mcp-server/market-data.js';
import type { NewsItem } from '../types.js';

// ==================== NEWS SCORING ====================

export interface ScoredNews {
  items: NewsItem[];
  overall_score: number;          // -15 to +20 for composite scoring
  dominant_category: 'A' | 'B' | 'C' | 'none';
  dominant_sentiment: 'bullish' | 'bearish' | 'neutral';
  summary: string;
  // Added 2026-04-23 (news-resilience Layer 4). Max stale_minutes across items
  // in this batch. 0 on fresh AV hits. Non-zero when served from stale cache
  // during AV quota exhaustion. `stale_dampened` is true when the overall_score
  // was attenuated because stale bearish news is unreliable signal — see
  // STALE_BEARISH_DAMPEN_MINUTES constant below.
  stale_minutes: number;
  stale_dampened: boolean;
}

// If cached news is older than this AND the aggregate is bearish, its
// magnitude is halved. Rationale: during AV quota exhaustion the bot serves
// cached news up to 4 h old. Stale BULLISH news that's still in the cache is
// at worst "missed the boost" — conservative. Stale BEARISH news that the
// market has since moved past, however, would cause the bot to skip good
// setups OR worse, if the news has flipped and the bot can't see it, trade
// INTO unseen fresh bullish news. Halving magnitude lets the bot still
// respect obviously-bearish cached signal without treating it as gospel.
export const STALE_BEARISH_DAMPEN_MINUTES = 60;

export async function getNewsContext(instrument: string): Promise<ScoredNews> {
  let items: NewsItem[];

  try {
    items = await fetchNewsContext(instrument);
  } catch {
    return {
      items: [],
      overall_score: 0,
      dominant_category: 'none',
      dominant_sentiment: 'neutral',
      summary: 'No news data available',
      stale_minutes: 0,
      stale_dampened: false,
    };
  }

  if (items.length === 0) {
    return {
      items: [],
      overall_score: 0,
      dominant_category: 'none',
      dominant_sentiment: 'neutral',
      summary: 'No recent news for this instrument',
      stale_minutes: 0,
      stale_dampened: false,
    };
  }

  // Aggregate sentiment
  const totalSentiment = items.reduce((sum, item) => sum + item.sentiment_score, 0);
  const avgSentiment = totalSentiment / items.length;

  // Find dominant category (highest impact news wins)
  const catACounts = items.filter(i => i.category === 'A').length;
  const catBCounts = items.filter(i => i.category === 'B').length;

  let dominantCategory: 'A' | 'B' | 'C' | 'none';
  if (catACounts > 0) dominantCategory = 'A';
  else if (catBCounts > 0) dominantCategory = 'B';
  else dominantCategory = 'C';

  // Determine dominant sentiment direction
  let dominantSentiment: 'bullish' | 'bearish' | 'neutral';
  if (avgSentiment > 0.1) dominantSentiment = 'bullish';
  else if (avgSentiment < -0.1) dominantSentiment = 'bearish';
  else dominantSentiment = 'neutral';

  // Calculate composite score adjustment (-15 to +20)
  let overallScore = 0;
  if (dominantCategory === 'A') {
    overallScore = avgSentiment > 0 ? 20 : avgSentiment < 0 ? -15 : 5;
  } else if (dominantCategory === 'B') {
    overallScore = avgSentiment > 0 ? 10 : avgSentiment < 0 ? -5 : 0;
  }

  // ===== Layer 4 — stale-bearish dampening =====
  // During AV quota exhaustion, fetchNewsContext serves cached items up to
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
  };
}

// ==================== QUICK SCORE (for scanner) ====================
// Returns just the numeric score adjustment without full news detail

export async function getNewsScore(instrument: string): Promise<number> {
  try {
    const result = await getNewsContext(instrument);
    return result.overall_score;
  } catch {
    return 0;
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

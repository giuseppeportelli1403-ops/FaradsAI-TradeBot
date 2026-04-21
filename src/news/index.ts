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
  opposing_direction: boolean;    // True if strong news opposes likely trade direction
  summary: string;
}

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
      opposing_direction: false,
      summary: 'No news data available',
    };
  }

  if (items.length === 0) {
    return {
      items: [],
      overall_score: 0,
      dominant_category: 'none',
      dominant_sentiment: 'neutral',
      opposing_direction: false,
      summary: 'No recent news for this instrument',
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

  // Build summary from top news items
  const topItems = items
    .filter(i => i.category === 'A' || i.category === 'B')
    .slice(0, 3)
    .map(i => i.title)
    .join(' | ');

  return {
    items,
    overall_score: overallScore,
    dominant_category: dominantCategory,
    dominant_sentiment: dominantSentiment,
    opposing_direction: false, // Agent determines this based on their bias analysis
    summary: topItems || 'No significant news catalysts',
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

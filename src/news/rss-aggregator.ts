// Tiered RSS news aggregator — B3 (2026-04-28).
//
// Polls 18 hand-curated RSS feeds (see rss-feeds.ts), parses each into a
// normalised RssArticle record with tier metadata, and caches per-feed.
// The aggregator complements MarketAux + Jina Reader, NOT replaces them:
// when the agent calls getNewsContext(instrument), the existing pipeline
// merges MarketAux articles + RSS articles, deduping by URL via the
// canonicalizeUrl helper.
//
// Tier semantics (POST-2026-05-13 NEWS-PRUNING):
//   - Tier 1 is currently the only active tier — every entry in RSS_FEEDS
//     has tier:1 after the prune. A single Tier-1 article can qualify as
//     Cat A on its own.
//   - Tier 2 / Tier 3 branches below are intentionally preserved (per
//     specs/001-news-pruning/ FR-7) so future re-introduction of lower-
//     tier feeds doesn't require a migration. They are presently dead
//     paths — every concrete article has tier:1.
//
// (The tier-aware classifier upgrade — wiring this weighting into the
// impact classifier — is left for a follow-up commit. This commit ships
// the data pipeline; the existing matchesHighImpactKeyword runs on the
// merged article body the same as before.)

import Parser from 'rss-parser';
import type { NewsItem } from '../types.js';
import { matchesHighImpactKeyword } from './impact-classifier.js';
import { RSS_FEEDS, type FeedConfig, type FeedTier } from './rss-feeds.js';
import { canonicalizeUrl } from './url-canonical.js';

const parser = new Parser({
  timeout: 10_000,
  headers: { 'User-Agent': 'BetterOpsAI-Farad/1.0 (RSS aggregator)' },
});

const POLL_FRESH_MS = 10 * 60_000; // serve cached articles for 10 min
const MAX_ARTICLES_PER_FEED = 30;

interface CachedFeed {
  fetchedAt: number;
  config: FeedConfig;
  articles: RssArticle[];
}

export interface RssArticle {
  feedName: string;
  tier: FeedTier;
  feedTags: ReadonlyArray<string>;
  title: string;
  link: string;
  /** Canonical URL, used for cross-source dedup. */
  canonicalLink: string;
  pubDate: string; // ISO timestamp
  pubDateMs: number;
  contentSnippet: string;
}

const cache = new Map<string, CachedFeed>();

/** Exposed for tests. */
export function _resetRssCache(): void {
  cache.clear();
}

/**
 * Poll one feed, parse articles, and update the cache. Returns the parsed
 * articles. Failures (network, parse, timeout) are logged and the previous
 * cache entry is preserved.
 */
export async function pollFeed(config: FeedConfig): Promise<RssArticle[]> {
  const cached = cache.get(config.url);
  if (cached && Date.now() - cached.fetchedAt < POLL_FRESH_MS) {
    return cached.articles;
  }

  let parsed: Parser.Output<Parser.Item>;
  try {
    parsed = await parser.parseURL(config.url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[RSS] Feed ${config.name} (${config.url}): ${msg}. Serving cached if any.`);
    return cached?.articles ?? [];
  }

  const items = (parsed.items ?? []).slice(0, MAX_ARTICLES_PER_FEED);
  const articles: RssArticle[] = [];

  for (const item of items) {
    const link = item.link ?? '';
    if (!link) continue;
    const pubDate = item.isoDate ?? item.pubDate ?? new Date().toISOString();
    const pubDateMs = Date.parse(pubDate);
    if (!Number.isFinite(pubDateMs)) continue;

    articles.push({
      feedName: config.name,
      tier: config.tier,
      feedTags: config.tags ?? ['*'],
      title: (item.title ?? '').trim(),
      link,
      canonicalLink: canonicalizeUrl(link),
      pubDate: new Date(pubDateMs).toISOString(),
      pubDateMs,
      contentSnippet: (item.contentSnippet ?? item.content ?? '').trim().slice(0, 1000),
    });
  }

  cache.set(config.url, { fetchedAt: Date.now(), config, articles });
  return articles;
}

/**
 * Poll all configured feeds in parallel with a small concurrency cap so we
 * don't open 18 simultaneous TCP connections. Failures are isolated per
 * feed — one dead source doesn't take down the others.
 */
export async function pollAllFeeds(
  feeds: ReadonlyArray<FeedConfig> = RSS_FEEDS,
  concurrency: number = 6,
): Promise<void> {
  for (let cursor = 0; cursor < feeds.length; cursor += concurrency) {
    const batch = feeds.slice(cursor, cursor + concurrency);
    await Promise.all(batch.map((feed) => pollFeed(feed)));
  }
}

/**
 * Returns all cached articles across all feeds, newest first.
 * Used by getRssNewsForInstrument and tier-aware corroboration logic.
 */
export function getAllCachedArticles(): RssArticle[] {
  const all: RssArticle[] = [];
  for (const entry of cache.values()) {
    all.push(...entry.articles);
  }
  all.sort((a, b) => b.pubDateMs - a.pubDateMs);
  return all;
}

/**
 * Filter cached RSS articles to those relevant for `instrument`.
 *
 * Matching rules:
 *   - Feed tagged ['*'] → every article passes
 *   - Feed tagged with any currency in instrumentToCurrencies(instrument) →
 *     all articles pass (the feed itself is currency-targeted)
 *   - Feed tagged with the exact instrument ticker (e.g. 'GOLD') → all
 *     articles pass
 *   - Otherwise → match per-article: title or snippet contains the
 *     instrument ticker OR any of its component currencies
 *
 * Returns articles newest first, capped at maxAgeHours (default 24).
 */
export function getRssNewsForInstrument(
  instrument: string,
  currencies: ReadonlyArray<string>,
  options: { maxAgeHours?: number; limit?: number } = {},
): RssArticle[] {
  const upperInstrument = instrument.toUpperCase();
  const upperCurrencies = currencies.map((c) => c.toUpperCase());
  const maxAgeMs = (options.maxAgeHours ?? 24) * 60 * 60_000;
  const cutoff = Date.now() - maxAgeMs;

  const matches: RssArticle[] = [];

  for (const article of getAllCachedArticles()) {
    if (article.pubDateMs < cutoff) continue;

    const tags = article.feedTags;
    let isFeedRelevant = tags.includes('*') || tags.includes(upperInstrument);
    if (!isFeedRelevant) {
      for (const ccy of upperCurrencies) {
        if (tags.includes(ccy)) {
          isFeedRelevant = true;
          break;
        }
      }
    }

    if (isFeedRelevant) {
      matches.push(article);
      continue;
    }

    // Per-article fallback for global feeds: search title + snippet for
    // the instrument ticker or any component currency.
    const haystack = `${article.title} ${article.contentSnippet}`.toUpperCase();
    if (haystack.includes(upperInstrument)) {
      matches.push(article);
      continue;
    }
    for (const ccy of upperCurrencies) {
      if (haystack.includes(ccy)) {
        matches.push(article);
        break;
      }
    }
  }

  return matches.slice(0, options.limit ?? 50);
}

/**
 * Adapter: convert RssArticle records to the NewsItem shape consumed by
 * the existing news pipeline (`getNewsContext`, the impact classifier,
 * the dedup loop). Sentiment and relevance are NOT computed by this
 * aggregator — RSS doesn't carry sentiment scores; the impact-keyword
 * classifier handles Cat A/B/C downstream from title+snippet.
 */
export function rssArticleToNewsItem(article: RssArticle): NewsItem {
  // Cat A only when impact-keyword fires. Post-2026-05-13 pruning every
  // article has tier:1; the tier-2/3 fallback at :221 is preserved per
  // FR-7 but currently unreachable. Sentiment defaulted to 0; the
  // impact-classifier doesn't need it.
  const haystack = `${article.title}\n\n${article.contentSnippet}`;
  let category: 'A' | 'B' | 'C';
  if (matchesHighImpactKeyword(article.title, article.contentSnippet)) {
    category = 'A';
  } else {
    // Without sentiment scores, default RSS articles to Cat C unless the
    // keyword fires. Tier-2 specialist articles get Cat B floor since they
    // come from FX/commodity-targeted feeds.
    // FR-7: tier-2/3 fallback preserved; post-2026-05-13 every article is tier:1 so this consistently returns 'B'. The :C branch is the dead path.
    category = article.tier <= 2 ? 'B' : 'C';
  }
  return {
    title: article.title,
    source: article.feedName,
    published_at: article.pubDate,
    sentiment_score: 0,
    // FR-7: tier-aware branch preserved; post-2026-05-13 every article is tier:1 so this evaluates to 1.0 in practice.
    relevance_score: article.tier === 1 ? 1.0 : article.tier === 2 ? 0.6 : 0.3,
    category,
    summary: article.contentSnippet || haystack.slice(0, 500),
    stale_minutes: 0,
    url: article.canonicalLink,
  };
}

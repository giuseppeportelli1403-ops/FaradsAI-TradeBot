import { describe, it, expect, vi } from 'vitest';
import axios from 'axios';
import {
  getNewsContext,
  isNewsOpposing,
  getNewsRiskFactor,
  STALE_BEARISH_DAMPEN_MINUTES,
} from '../src/news/index.js';
import {
  _resetNewsResilienceState,
  _resetMarketAuxRateLimitFlag,
} from '../src/mcp-server/market-data.js';

/**
 * Reset all news-path module state so each test starts clean. Restores all
 * vi spies so axios.get call counts don't carry across tests.
 */
function resetNewsTest(): void {
  vi.restoreAllMocks();
  process.env.MARKETAUX_API_KEY = 'test-marketaux-key';
  _resetMarketAuxRateLimitFlag();
  _resetNewsResilienceState();
}

describe('isNewsOpposing', () => {
  it('Cat A bearish news + bullish bias → true (opposing)', () => {
    expect(isNewsOpposing('bearish', 'A', 'bullish')).toBe(true);
  });

  it('Cat A bullish news + bearish bias → true (opposing)', () => {
    expect(isNewsOpposing('bullish', 'A', 'bearish')).toBe(true);
  });

  it('Cat B opposing news → false (not strong enough to block)', () => {
    expect(isNewsOpposing('bearish', 'B', 'bullish')).toBe(false);
  });

  it('Cat A aligned news → false (supports trade)', () => {
    expect(isNewsOpposing('bullish', 'A', 'bullish')).toBe(false);
    expect(isNewsOpposing('bearish', 'A', 'bearish')).toBe(false);
  });

  it('Neutral sentiment + any category → false', () => {
    expect(isNewsOpposing('neutral', 'A', 'bullish')).toBe(false);
    expect(isNewsOpposing('neutral', 'A', 'bearish')).toBe(false);
    expect(isNewsOpposing('neutral', 'B', 'bullish')).toBe(false);
  });

  it('Cat C + any direction → false', () => {
    expect(isNewsOpposing('bearish', 'C', 'bullish')).toBe(false);
    expect(isNewsOpposing('bullish', 'C', 'bearish')).toBe(false);
  });

  it('Category none + any direction → false', () => {
    expect(isNewsOpposing('bearish', 'none', 'bullish')).toBe(false);
    expect(isNewsOpposing('bullish', 'none', 'bearish')).toBe(false);
  });
});

describe('getNewsRiskFactor (P2 softening — 2026-04-23)', () => {
  // Post-P2 policy: opposing Cat-A news no longer hard-SKIPs the trade.
  // Instead, position size is halved (0.5 multiplier) when the setup is
  // otherwise valid. Cat B, Cat C, neutral sentiment, and aligned news all
  // leave size untouched (1.0).

  it('bullish trade + bearish Cat-A news → 0.5 (opposing, soften)', () => {
    expect(getNewsRiskFactor('bearish', 'A', 'bullish')).toBe(0.5);
  });

  it('bearish trade + bullish Cat-A news → 0.5 (opposing, soften)', () => {
    expect(getNewsRiskFactor('bullish', 'A', 'bearish')).toBe(0.5);
  });

  it('bullish trade + bullish Cat-A news → 1.0 (aligned, no softening)', () => {
    expect(getNewsRiskFactor('bullish', 'A', 'bullish')).toBe(1.0);
  });

  it('bearish trade + bearish Cat-A news → 1.0 (aligned, no softening)', () => {
    expect(getNewsRiskFactor('bearish', 'A', 'bearish')).toBe(1.0);
  });

  it('Cat B opposing news → 1.0 (Cat B not strong enough to trigger softening)', () => {
    expect(getNewsRiskFactor('bearish', 'B', 'bullish')).toBe(1.0);
    expect(getNewsRiskFactor('bullish', 'B', 'bearish')).toBe(1.0);
  });

  it('neutral sentiment → 1.0 (no directional news)', () => {
    expect(getNewsRiskFactor('neutral', 'A', 'bullish')).toBe(1.0);
    expect(getNewsRiskFactor('neutral', 'A', 'bearish')).toBe(1.0);
    expect(getNewsRiskFactor('neutral', 'B', 'bullish')).toBe(1.0);
  });

  it('Cat C or "none" opposing news → 1.0 (noise, ignored)', () => {
    expect(getNewsRiskFactor('bearish', 'C', 'bullish')).toBe(1.0);
    expect(getNewsRiskFactor('bullish', 'C', 'bearish')).toBe(1.0);
    expect(getNewsRiskFactor('bearish', 'none', 'bullish')).toBe(1.0);
    expect(getNewsRiskFactor('bullish', 'none', 'bearish')).toBe(1.0);
  });
});

describe('getNewsContext — Layer 4 stale-bearish dampening', () => {
  // Regression for 2026-04-23 news-resilience: when the news-provider quota exhausts mid-day
  // and fetchNewsContext serves stale cache, bearish-leaning news older than
  // STALE_BEARISH_DAMPEN_MINUTES must have its magnitude halved before reaching
  // the composite score. Rationale in src/news/index.ts. Bullish stale news
  // flows through unchanged — worst case is "missed boost", which is safe.

  /** Build a MarketAux-shaped success response with one article per sentiment entry.
   * Title hard-codes "FOMC" so the post-2026-04-28 impact-keyword classifier
   * promotes the article to Cat A — these tests are about Cat A dampening
   * behaviour, so the fixture must legitimately be Cat A.
   */
  const mkMarketAuxResponse = (articles: Array<{ sentiment: number }>) => ({
    data: {
      meta: { found: articles.length, returned: articles.length, limit: 10, page: 1 },
      data: articles.map((a, i) => ({
        uuid: `uuid-${i}`,
        title: `FOMC headline ${i}`,
        description: `Description for headline ${i} with enough text to qualify`,
        snippet: `Snippet ${i}`,
        keywords: '',
        url: 'https://example.com',
        image_url: '',
        language: 'en',
        published_at: '2026-04-23T06:00:00.000Z',
        source: 'Wire',
        relevance_score: null,
        entities: [{
          symbol: 'EURUSD',
          name: 'EUR/USD',
          exchange: null,
          exchange_long: null,
          country: 'global',
          type: 'currency',
          industry: 'N/A',
          match_score: 90.0,
          sentiment_score: a.sentiment,
          highlights: [],
        }],
        similar: [],
      })),
    },
  });

  /** MarketAux quota-exhausted error (HTTP 402) — thrown by axios for non-2xx. */
  const mkQuotaError = () => Object.assign(new Error('Request failed with status code 402'), {
    isAxiosError: true,
    response: {
      status: 402,
      data: { error: { code: 'usage_limit_reached', message: 'Daily usage limit reached.' } },
    },
  });

  it('fresh bearish Cat A news keeps its full -15 penalty', async () => {
    resetNewsTest();
    vi.spyOn(axios, 'get').mockResolvedValueOnce(mkMarketAuxResponse([
      { sentiment: -0.45 },  // Cat A bearish (|x| >= 0.35)
    ]));

    const result = await getNewsContext('EURUSD');
    expect(result.overall_score).toBe(-15);
    expect(result.stale_minutes).toBe(0);
    expect(result.stale_dampened).toBe(false);
  });

  it('stale bearish Cat A news is halved — trades safer during quota exhaustion', async () => {
    // Build a scenario where the cache is older than the dampen threshold
    // but within the 4-h stale-max. The bot sees bearish news from 90 min
    // ago; dampening halves the -15 → -8 (rounded). A setup at score 57
    // that would've been skipped at -15 (42 < Tier 3 45) now scores 49 →
    // Tier 3 trade. Conservative: we'd rather miss a skip than trade
    // INTO unseen bullish news the old bearish print has since been reversed.
    resetNewsTest();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    // Prime cache at t-90min with bearish news.
    const NINETY_MIN_AGO = Date.now() - 90 * 60 * 1000;
    const realNow = Date.now;
    vi.spyOn(Date, 'now').mockImplementation(() => NINETY_MIN_AGO);
    vi.spyOn(axios, 'get').mockResolvedValueOnce(mkMarketAuxResponse([
      { sentiment: -0.45 },
    ]));
    await getNewsContext('GBPUSD');

    // Restore time + simulate quota-exhausted (HTTP 402) → stale fallback.
    vi.mocked(Date.now).mockImplementation(realNow);
    vi.mocked(axios.get).mockRejectedValueOnce(mkQuotaError());

    const result = await getNewsContext('GBPUSD');
    expect(result.stale_minutes).toBeGreaterThanOrEqual(STALE_BEARISH_DAMPEN_MINUTES);
    expect(result.stale_dampened).toBe(true);
    // Halved from -15 → round(-7.5) = -8 (or -7 depending on rounding mode —
    // Math.round(-7.5) is -7 in JS because banker's round is not used; but
    // Math.round(-7.5) actually gives -7 on IEEE. We test the RANGE so the
    // test doesn't lock to implementation detail of Math.round.)
    expect(result.overall_score).toBeGreaterThan(-15);
    expect(result.overall_score).toBeLessThan(0);
    expect(Math.abs(result.overall_score)).toBeLessThanOrEqual(8);
    expect(result.summary).toContain('stale');
    expect(result.summary).toContain('bearish-dampened');

    vi.mocked(Date.now).mockRestore();
  });

  it('stale BULLISH news is NOT dampened — conservative only downside', async () => {
    resetNewsTest();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const NINETY_MIN_AGO = Date.now() - 90 * 60 * 1000;
    const realNow = Date.now;
    vi.spyOn(Date, 'now').mockImplementation(() => NINETY_MIN_AGO);
    vi.spyOn(axios, 'get').mockResolvedValueOnce(mkMarketAuxResponse([
      { sentiment: 0.45 },  // Cat A bullish
    ]));
    await getNewsContext('AUDUSD');

    vi.mocked(Date.now).mockImplementation(realNow);
    vi.mocked(axios.get).mockRejectedValueOnce(mkQuotaError());

    const result = await getNewsContext('AUDUSD');
    expect(result.stale_minutes).toBeGreaterThanOrEqual(STALE_BEARISH_DAMPEN_MINUTES);
    expect(result.stale_dampened).toBe(false);       // bullish not dampened
    // Phase A2 (2026-05-04, audit Finding #5): Cat A bullish dropped from
    // +20 to +10 to match strategy.md Section 5 post-rebalance rubric.
    expect(result.overall_score).toBe(10);           // post-rebalance Cat A bullish bonus
    expect(result.summary).toContain('stale');
    expect(result.summary).not.toContain('bearish-dampened');

    vi.mocked(Date.now).mockRestore();
  });

  it('slightly-stale bearish news BELOW the 60-min threshold is NOT dampened', async () => {
    // The cache is 30 min old. Still bearish, still Cat A, but within the
    // "trust the cache" window. Stays at -15.
    resetNewsTest();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const THIRTY_ONE_MIN_AGO = Date.now() - 31 * 60 * 1000;
    const realNow = Date.now;
    vi.spyOn(Date, 'now').mockImplementation(() => THIRTY_ONE_MIN_AGO);
    vi.spyOn(axios, 'get').mockResolvedValueOnce(mkMarketAuxResponse([
      { sentiment: -0.45 },
    ]));
    await getNewsContext('USDJPY');

    vi.mocked(Date.now).mockImplementation(realNow);
    vi.mocked(axios.get).mockRejectedValueOnce(mkQuotaError());

    const result = await getNewsContext('USDJPY');
    expect(result.stale_minutes).toBeGreaterThanOrEqual(31);
    expect(result.stale_minutes).toBeLessThanOrEqual(STALE_BEARISH_DAMPEN_MINUTES);
    expect(result.stale_dampened).toBe(false);
    expect(result.overall_score).toBe(-15);

    vi.mocked(Date.now).mockRestore();
  });
});

// 2026-05-05 audit (Phase 2 / Round 2 / item 2.2): propagation test.
// fetchNewsContext now throws when MARKETAUX_API_KEY is missing
// (commit 497d831). getNewsContext catches that and must surface
// news_unavailable=true so the analyst sees real signal that news is
// degraded. Pre-fix the missing-key path served stale news silently.
describe('getNewsContext — propagation when MARKETAUX_API_KEY missing', () => {
  it('returns news_unavailable=true when MARKETAUX_API_KEY is unset', async () => {
    vi.restoreAllMocks();
    _resetMarketAuxRateLimitFlag();
    _resetNewsResilienceState();
    const original = process.env.MARKETAUX_API_KEY;
    delete process.env.MARKETAUX_API_KEY;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await getNewsContext('EURUSD');
      expect(result.news_unavailable).toBe(true);
      expect(result.summary).toMatch(/UNAVAILABLE|degraded/i);
      expect(result.items).toEqual([]);
    } finally {
      if (original !== undefined) process.env.MARKETAUX_API_KEY = original;
    }
  });
});

// 2026-05-05 audit (Phase 2 / Round 4): tier-weighted dominant category +
// relevance-clamped score. Pre-fix a single Tier-3 blog tagged Cat A by
// the keyword classifier produced the same ±10/-15 score as a Tier-1
// regulator press release. Post-fix the score scales by relevance weight.
import { rssArticleToNewsItem } from '../src/news/rss-aggregator.js';
import type { RssArticle } from '../src/news/rss-aggregator.js';

describe('Tier-weighted news scoring', () => {
  function mkRssArticle(opts: { tier: 1 | 2 | 3; title: string; snippet?: string }): RssArticle {
    return {
      title: opts.title,
      contentSnippet: opts.snippet ?? '',
      pubDate: new Date().toISOString(),
      canonicalLink: `https://example.com/${opts.title.replace(/\s+/g, '-')}`,
      feedName: opts.tier === 1 ? 'Federal Reserve press releases' : opts.tier === 2 ? 'FXStreet' : 'Random Blog',
      tier: opts.tier,
      tags: [],
    };
  }

  // Manually exercise getNewsContext via mocked fetchNewsContext in a future
  // refactor; for now test the per-article relevance via rssArticleToNewsItem.
  it('Tier 1 RSS article gets relevance_score 1.0', () => {
    const art = mkRssArticle({ tier: 1, title: 'FOMC Rate Decision: 25bp cut' });
    const item = rssArticleToNewsItem(art);
    expect(item.relevance_score).toBe(1.0);
    expect(item.category).toBe('A'); // keyword 'FOMC' fires Cat A
  });

  it('Tier 2 RSS article gets relevance_score 0.6', () => {
    const art = mkRssArticle({ tier: 2, title: 'EUR/USD outlook unchanged' });
    const item = rssArticleToNewsItem(art);
    expect(item.relevance_score).toBe(0.6);
    expect(item.category).toBe('B'); // tier 2 default
  });

  it('Tier 3 RSS article gets relevance_score 0.3 + Cat C default', () => {
    const art = mkRssArticle({ tier: 3, title: 'Random analysis on EUR' });
    const item = rssArticleToNewsItem(art);
    expect(item.relevance_score).toBe(0.3);
    expect(item.category).toBe('C');
  });

  it('Tier 3 RSS article CAN be Cat A if impact-keyword fires (was the bug)', () => {
    const art = mkRssArticle({ tier: 3, title: 'Random Blog says FOMC will pivot' });
    const item = rssArticleToNewsItem(art);
    expect(item.category).toBe('A');
    expect(item.relevance_score).toBe(0.3);
    // Pre-fix this would have produced ±10 score in getNewsContext.
    // Post-fix the score is multiplied by 0.3/1.0 = 0.3 → ±3 max.
    // (The integration test is in tests/market-data.test.ts via mocked
    // fetchNewsContext; here we just verify the article-level shape.)
  });
});

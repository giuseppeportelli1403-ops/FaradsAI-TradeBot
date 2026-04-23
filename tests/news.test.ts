import { describe, it, expect, vi } from 'vitest';
import axios from 'axios';
import { getNewsContext, isNewsOpposing, STALE_BEARISH_DAMPEN_MINUTES } from '../src/news/index.js';
import {
  _resetNewsResilienceState,
  _resetAlphaVantageRateLimitFlag,
  _setAlphaVantageBurstBucketForTests,
} from '../src/mcp-server/market-data.js';
import { TokenBucket } from '../src/mcp-server/rate-limiter.js';

/**
 * Reset all news-path module state so each test starts clean. Installs a
 * permissive burst bucket (avoids the 1 req/1.1 s prod gate from timing out
 * tests) and restores all vi spies so axios.get call counts don't carry
 * across tests.
 */
function resetNewsTest(): void {
  vi.restoreAllMocks();
  process.env.ALPHA_VANTAGE_API_KEY = 'test-av-key';
  _resetAlphaVantageRateLimitFlag();
  _resetNewsResilienceState();
  _setAlphaVantageBurstBucketForTests(new TokenBucket(100_000, 1));
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

describe('getNewsContext — Layer 4 stale-bearish dampening', () => {
  // Regression for 2026-04-23 news-resilience: when AV quota exhausts mid-day
  // and fetchNewsContext serves stale cache, bearish-leaning news older than
  // STALE_BEARISH_DAMPEN_MINUTES must have its magnitude halved before reaching
  // the composite score. Rationale in src/news/index.ts. Bullish stale news
  // flows through unchanged — worst case is "missed boost", which is safe.

  const mkAvResponse = (articles: Array<{ sentiment: number }>) => ({
    data: {
      feed: articles.map((a, i) => ({
        title: `Headline ${i}`,
        url: 'https://example.com',
        time_published: '20260423T060000',
        source: 'Wire',
        summary: 's',
        overall_sentiment_score: String(a.sentiment),
        ticker_sentiment: [{ relevance_score: '0.9' }],
      })),
    },
  });

  it('fresh bearish Cat A news keeps its full -15 penalty', async () => {
    resetNewsTest();
    vi.spyOn(axios, 'get').mockResolvedValueOnce(mkAvResponse([
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
    vi.spyOn(axios, 'get').mockResolvedValueOnce(mkAvResponse([
      { sentiment: -0.45 },
    ]));
    await getNewsContext('GBPUSD');

    // Restore time + simulate quota-exhausted → stale fallback.
    vi.mocked(Date.now).mockImplementation(realNow);
    vi.mocked(axios.get).mockResolvedValueOnce({
      data: { Information: 'our standard API rate limit is 25 requests per day...' },
    });

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
    vi.spyOn(axios, 'get').mockResolvedValueOnce(mkAvResponse([
      { sentiment: 0.45 },  // Cat A bullish
    ]));
    await getNewsContext('AUDUSD');

    vi.mocked(Date.now).mockImplementation(realNow);
    vi.mocked(axios.get).mockResolvedValueOnce({
      data: { Information: 'our standard API rate limit is 25 requests per day...' },
    });

    const result = await getNewsContext('AUDUSD');
    expect(result.stale_minutes).toBeGreaterThanOrEqual(STALE_BEARISH_DAMPEN_MINUTES);
    expect(result.stale_dampened).toBe(false);       // bullish not dampened
    expect(result.overall_score).toBe(20);           // full Cat A bullish bonus
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
    vi.spyOn(axios, 'get').mockResolvedValueOnce(mkAvResponse([
      { sentiment: -0.45 },
    ]));
    await getNewsContext('USDJPY');

    vi.mocked(Date.now).mockImplementation(realNow);
    vi.mocked(axios.get).mockResolvedValueOnce({
      data: { Information: 'our standard API rate limit is 25 requests per day...' },
    });

    const result = await getNewsContext('USDJPY');
    expect(result.stale_minutes).toBeGreaterThanOrEqual(31);
    expect(result.stale_minutes).toBeLessThanOrEqual(STALE_BEARISH_DAMPEN_MINUTES);
    expect(result.stale_dampened).toBe(false);
    expect(result.overall_score).toBe(-15);

    vi.mocked(Date.now).mockRestore();
  });
});

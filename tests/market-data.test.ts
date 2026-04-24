// Tests for withCache and withFallback utilities
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import {
  withCache,
  withFallback,
  fetchCandles,
  fetchYieldCurve,
  fetchSectorStrength,
  computeCorrelation,
  _getTwelveDataDailyCap,
  _resetTwelveDataDailyCap,
  _resetTwelveDataState,
  _getCandleCache,
  _mapToTwelveDataSymbol,
  _resetMarketAuxRateLimitFlag,
  _resetNewsResilienceState,
  _getMarketAuxCallCount,
  fetchNewsContext,
  normalizeForMarketAux,
} from '../src/mcp-server/market-data.js';

describe('withCache', () => {
  it('returns cached value on second call without re-invoking fetcher', async () => {
    let callCount = 0;
    const fetcher = async () => {
      callCount++;
      return [1, 2, 3];
    };

    const cached = withCache(fetcher, 60_000);

    const first = await cached();
    const second = await cached();

    expect(first).toEqual([1, 2, 3]);
    expect(second).toEqual([1, 2, 3]);
    expect(callCount).toBe(1);
  });

  it('re-fetches after TTL expires', async () => {
    let callCount = 0;
    const fetcher = async () => {
      callCount++;
      return callCount;
    };

    // TTL of 0ms means always stale
    const cached = withCache(fetcher, 0);

    await cached();
    await cached();

    expect(callCount).toBe(2);
  });
});

describe('withFallback', () => {
  it('returns the fetcher result when it succeeds', async () => {
    const result = await withFallback(async () => [1, 2, 3], [] as number[]);
    expect(result).toEqual([1, 2, 3]);
  });

  it('returns fallback default when fetcher throws', async () => {
    const result = await withFallback(async () => { throw new Error('API down'); }, [] as number[]);
    expect(result).toEqual([]);
  });

  it('returns fallback object when fetcher throws', async () => {
    const fallback = { vix: 0, vix_30d_avg: 0 };
    const result = await withFallback(async () => { throw new Error('fail'); }, fallback);
    expect(result).toEqual({ vix: 0, vix_30d_avg: 0 });
  });
});

describe('Researcher-facing fetcher resilience (regression test for 2026-04-21 05:30 UTC crash)', () => {
  // On 2026-04-21 at 05:30 UTC the Market Researcher crashed when fetchVix
  // threw because the Twelve Data circuit breaker was tripped. The throw
  // propagated through Promise.all -> detectRegime -> runResearcherAgent ->
  // safeRun, aborting the whole research cycle. After the fix every external
  // fetcher is wrapped in withFallback — they can NEVER propagate an
  // exception; callers always get a sensible default.
  const originalKey = process.env.TWELVE_DATA_API_KEY;

  beforeEach(() => {
    process.env.TWELVE_DATA_API_KEY = 'test-key';
    _resetTwelveDataDailyCap();
    _getCandleCache().clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.TWELVE_DATA_API_KEY;
    else process.env.TWELVE_DATA_API_KEY = originalKey;
    _resetTwelveDataDailyCap();
    vi.restoreAllMocks();
  });

  it('computeCorrelation returns neutral-correlation when fetchCandles throws', async () => {
    vi.spyOn(axios, 'get').mockRejectedValue(new Error('Rate limited'));
    const result = await computeCorrelation('EURUSD', 'DXY', 30);
    expect(result.correlation_30d).toBe(0);
    expect(result.correlation_90d).toBe(0);
    expect(result.instrument_a).toBe('EURUSD');
    expect(result.instrument_b).toBe('DXY');
  });

  it('Promise.all of [fetchYieldCurve, fetchSectorStrength, computeCorrelation] never rejects — Researcher invariant', async () => {
    // The researcher's Phase 1 `Promise.all` must never reject, even when
    // every external call is failing. This is the regression invariant that
    // originally crashed the 2026-04-21 05:30 UTC Researcher cycle.
    vi.spyOn(axios, 'get').mockRejectedValue(new Error('Everything is on fire'));
    await expect(
      Promise.all([fetchYieldCurve(), fetchSectorStrength(), computeCorrelation('EURUSD', 'USDJPY')])
    ).resolves.toBeDefined();
  });
});

describe('Twelve Data symbol mapping', () => {
  // Verified by hand against the Grow-tier API on 2026-04-21.
  it('inserts slashes for forex majors', () => {
    expect(_mapToTwelveDataSymbol('EURUSD')).toBe('EUR/USD');
    expect(_mapToTwelveDataSymbol('GBPUSD')).toBe('GBP/USD');
    expect(_mapToTwelveDataSymbol('USDJPY')).toBe('USD/JPY');
    expect(_mapToTwelveDataSymbol('GBPJPY')).toBe('GBP/JPY');
    expect(_mapToTwelveDataSymbol('AUDUSD')).toBe('AUD/USD');
  });

  it('returns null for all equity indices (Grow tier has no reliable index feed)', () => {
    // Pre-2026-04-22: US30→DJIA, DE40→DAX, UK100→UKX. Each of those TD symbols
    // resolves to an ETF tracking the index at a completely different price
    // level (~$40 ETF vs ~$38k index, etc.), so the scanner was computing 1H
    // bias on unrelated series. Moved to UNAVAILABLE alongside US100/US500/SPX/NAS100.
    expect(_mapToTwelveDataSymbol('US30')).toBeNull();
    expect(_mapToTwelveDataSymbol('US100')).toBeNull();
    expect(_mapToTwelveDataSymbol('US500')).toBeNull();
    expect(_mapToTwelveDataSymbol('DE40')).toBeNull();
    expect(_mapToTwelveDataSymbol('UK100')).toBeNull();
  });

  it('maps OIL_CRUDE to WTI/USD', () => {
    expect(_mapToTwelveDataSymbol('OIL_CRUDE')).toBe('WTI/USD');
  });

  it('maps GOLD and SILVER to TD spot symbols (not the unrelated NYSE/BSE listings)', () => {
    expect(_mapToTwelveDataSymbol('GOLD')).toBe('XAU/USD');
    expect(_mapToTwelveDataSymbol('SILVER')).toBe('XAG/USD');
  });

  it('resolves common cross-broker aliases to the same TD destinations', () => {
    expect(_mapToTwelveDataSymbol('XAUUSD')).toBe('XAU/USD');
    expect(_mapToTwelveDataSymbol('XAGUSD')).toBe('XAG/USD');
    expect(_mapToTwelveDataSymbol('USOIL')).toBe('WTI/USD');
    expect(_mapToTwelveDataSymbol('WTIUSD')).toBe('WTI/USD');
  });

  it('returns null for VIX, US equity indices, and DXY (unavailable on Grow tier)', () => {
    expect(_mapToTwelveDataSymbol('VIX')).toBeNull();
    expect(_mapToTwelveDataSymbol('NAS100')).toBeNull();
    expect(_mapToTwelveDataSymbol('SPX')).toBeNull();
    // DXY's previous 'DX' mapping resolved to a NYSE REIT, not the dollar
    // index. Grow-tier alternatives (USDX, USD) are directional ETF proxies
    // with absolute levels 25–70x off real DXY (~99). Marked unavailable so
    // fetchDxy returns dxy=0/flat rather than shipping misleading numbers
    // to the researcher brief.
    expect(_mapToTwelveDataSymbol('DXY')).toBeNull();
  });

  it('passes through natively-accepted TD symbols (individual US stocks)', () => {
    expect(_mapToTwelveDataSymbol('AAPL')).toBe('AAPL');
    expect(_mapToTwelveDataSymbol('MSFT')).toBe('MSFT');
    expect(_mapToTwelveDataSymbol('NVDA')).toBe('NVDA');
    expect(_mapToTwelveDataSymbol('TSLA')).toBe('TSLA');
  });

  it('is case-insensitive on input', () => {
    expect(_mapToTwelveDataSymbol('eurusd')).toBe('EUR/USD');
    expect(_mapToTwelveDataSymbol('EurUsd')).toBe('EUR/USD');
  });
});

describe('fetchCandles cache keying by mapped TD symbol', () => {
  const originalKey = process.env.TWELVE_DATA_API_KEY;

  beforeEach(() => {
    process.env.TWELVE_DATA_API_KEY = 'test-key';
    _resetTwelveDataState();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.TWELVE_DATA_API_KEY;
    else process.env.TWELVE_DATA_API_KEY = originalKey;
    _resetTwelveDataState();
    vi.restoreAllMocks();
  });

  it('GOLD and XAUUSD share a cache entry (both resolve to XAU/USD at TD)', async () => {
    // Mock one TD response; if the second call comes from cache, axios.get
    // fires exactly once even though we call fetchCandles with different
    // Farad tickers.
    const getSpy = vi.spyOn(axios, 'get').mockResolvedValue({
      data: {
        status: 'ok',
        values: [
          { datetime: '2026-04-22 17:00:00', open: '4759', high: '4762', low: '4758', close: '4760', volume: '0' },
        ],
      },
    });

    const goldCandles = await fetchCandles('GOLD', '1h', 5);
    const xauCandles = await fetchCandles('XAUUSD', '1h', 5);

    expect(goldCandles).toEqual(xauCandles);
    // The critical assertion: TD was hit exactly once. Pre-fix both aliases
    // triggered separate network calls, doubling credit usage.
    expect(getSpy).toHaveBeenCalledTimes(1);
  });

  it('drops candles with non-finite OHLC values instead of poisoning downstream math with NaN', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(axios, 'get').mockResolvedValue({
      data: {
        status: 'ok',
        values: [
          // Good candle.
          { datetime: '2026-04-22 17:00:00', open: '1.175', high: '1.176', low: '1.174', close: '1.175', volume: '0' },
          // Missing close — parseFloat → NaN. Must be dropped.
          { datetime: '2026-04-22 16:00:00', open: '1.174', high: '1.176', low: '1.173', close: '', volume: '0' },
          // Good candle.
          { datetime: '2026-04-22 15:00:00', open: '1.173', high: '1.175', low: '1.172', close: '1.174', volume: '0' },
          // Garbage string in high — parseFloat('abc') → NaN. Must be dropped.
          { datetime: '2026-04-22 14:00:00', open: '1.172', high: 'abc', low: '1.170', close: '1.173', volume: '0' },
        ],
      },
    });

    const candles = await fetchCandles('EURUSD', '1h', 10);

    // Only the two well-formed candles survive.
    expect(candles).toHaveLength(2);
    for (const c of candles) {
      expect(Number.isFinite(c.open)).toBe(true);
      expect(Number.isFinite(c.high)).toBe(true);
      expect(Number.isFinite(c.low)).toBe(true);
      expect(Number.isFinite(c.close)).toBe(true);
    }
    // Ops gets a visible warning when candles are dropped.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Dropped 2 malformed'),
    );
  });

  it('fetchNewsContext returns [] + logs once when MarketAux daily quota is exhausted', async () => {
    resetNewsTest();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // MarketAux quota-exhaustion shape — HTTP 402 with an `error` body.
    // Axios throws for non-2xx by default; we mock a rejection that
    // carries the response object on `err.response`.
    const quotaError = Object.assign(new Error('Request failed with status code 402'), {
      isAxiosError: true,
      response: {
        status: 402,
        data: { error: { code: 'usage_limit_reached', message: 'Daily usage limit reached.' } },
      },
    });
    vi.spyOn(axios, 'get').mockRejectedValue(quotaError);

    const first = await fetchNewsContext('EURUSD');
    const second = await fetchNewsContext('GOLD');
    const third = await fetchNewsContext('OIL_CRUDE');

    expect(first).toEqual([]);
    expect(second).toEqual([]);
    expect(third).toEqual([]);

    const rateLimitLogCalls = errSpy.mock.calls.filter((args) =>
      typeof args[0] === 'string' && args[0].includes('MarketAux daily rate limit reached'),
    );
    expect(rateLimitLogCalls).toHaveLength(1);
  });

  it('fetchNewsContext wraps in withFallback — axios throws degrade to []', async () => {
    resetNewsTest();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(axios, 'get').mockRejectedValue(new Error('Network outage'));

    // Pre-fix (unwrapped), this throw would propagate to the caller and
    // crash researcher-agent's Promise.all. Post-fix: silent empty.
    // MarketAux errors (network, 5xx, etc.) must degrade gracefully.
    const result = await fetchNewsContext('EURUSD');
    expect(result).toEqual([]);
  });

  // ========== News-resilience layered defense (added 2026-04-23 pm) ==========
  // See market-data.ts "News-resilience layers" block for the full architecture.
  // Each layer has its own test below. All tests call `resetNewsTest()` first
  // to: (a) clear prior axios.get spies so call counts reset, (b) reset the
  // MarketAux rate-limit / cache / counter state.

  const resetNewsTest = () => {
    vi.restoreAllMocks();
    process.env.MARKETAUX_API_KEY = 'test-marketaux-key';
    _resetMarketAuxRateLimitFlag();
    _resetNewsResilienceState();
  };

  /** Build a MarketAux-shaped success response with one article. */
  const mkMarketAuxResponse = (opts: {
    symbol: string;
    title?: string;
    sentiment?: number;
    matchScore?: number;
    description?: string;
    snippet?: string;
  }) => ({
    data: {
      meta: { found: 1, returned: 1, limit: 3, page: 1 },
      data: [{
        uuid: 'aaaa-bbbb-' + opts.symbol,
        title: opts.title ?? `${opts.symbol} headline`,
        description: opts.description ?? `${opts.symbol} news description content exceeding twenty chars`,
        snippet: opts.snippet ?? `${opts.symbol} news snippet content.`,
        keywords: '',
        url: `https://example.com/${opts.symbol}`,
        image_url: '',
        language: 'en',
        published_at: '2026-04-24T08:00:00.000Z',
        source: 'example.com',
        relevance_score: null,
        entities: [{
          symbol: opts.symbol,
          name: opts.symbol,
          exchange: null,
          exchange_long: null,
          country: 'global',
          type: opts.symbol.length === 6 ? 'currency' : 'etf',
          industry: 'N/A',
          match_score: opts.matchScore ?? 50.0,
          sentiment_score: opts.sentiment ?? 0.2,
          highlights: [],
        }],
        similar: [],
      }],
    },
  });

  it('Layer 1: serves fresh cache without hitting MarketAux on repeat calls within TTL', async () => {
    // The ICT agent re-invokes get_news_context several times within a single
    // reasoning chain (logs showed 5 SILVER calls in 90 min on 2026-04-23 am).
    // Each repeat must be absorbed by the cache — otherwise the 100/day quota
    // burns before NY Open.
    resetNewsTest();

    const successResponse = mkMarketAuxResponse({ symbol: 'EURUSD', title: 'Headline A' });
    const getSpy = vi.spyOn(axios, 'get').mockResolvedValue(successResponse);

    const first = await fetchNewsContext('EURUSD');
    const second = await fetchNewsContext('EURUSD');
    const third = await fetchNewsContext('EURUSD');

    // Exactly one axios hit — the other two served from cache.
    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(first[0]?.title).toBe('Headline A');
    expect(second[0]?.title).toBe('Headline A');
    expect(third[0]?.title).toBe('Headline A');
    // stale_minutes stays 0 on fresh cache hits (< 30 min old).
    expect(first[0]?.stale_minutes).toBe(0);
    expect(second[0]?.stale_minutes).toBe(0);
    expect(third[0]?.stale_minutes).toBe(0);
    // Cache hits do NOT count against the daily quota — only real MarketAux calls do.
    expect(_getMarketAuxCallCount()).toBe(1);
  });

  it('Layer 1: cache is per-ticker — EURUSD cache does not short-circuit GBPUSD', async () => {
    resetNewsTest();

    const getSpy = vi.spyOn(axios, 'get')
      .mockResolvedValueOnce(mkMarketAuxResponse({ symbol: 'EURUSD', title: 'EUR-news' }))
      .mockResolvedValueOnce(mkMarketAuxResponse({ symbol: 'GBPUSD', title: 'GBP-news' }));

    const eur = await fetchNewsContext('EURUSD');
    const gbp = await fetchNewsContext('GBPUSD');

    expect(getSpy).toHaveBeenCalledTimes(2);
    expect(eur[0]?.title).toBe('EUR-news');
    expect(gbp[0]?.title).toBe('GBP-news');
  });

  it('Layer 2: serves stale cache (with stale_minutes tagged) when MarketAux daily quota exhausts', async () => {
    // The critical layer. Primes the cache with a successful fetch, then the
    // next call returns daily-quota-exhausted. Bot must keep seeing news, not
    // fall off the cliff at 0.
    resetNewsTest();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    // Prime the cache at a timestamp 90 min ago so the next read is beyond
    // the 30-min fresh window (forcing a real MarketAux attempt), but within
    // the 4-h stale window (so stale-fallback should serve it).
    const NINETY_MIN_AGO = Date.now() - 90 * 60 * 1000;
    const realNow = Date.now;
    vi.spyOn(Date, 'now').mockImplementation(() => NINETY_MIN_AGO);

    vi.spyOn(axios, 'get').mockResolvedValueOnce(
      mkMarketAuxResponse({ symbol: 'USDJPY', title: 'Cached-USDJPY-headline' })
    );
    await fetchNewsContext('USDJPY');  // primes cache

    // Restore time, then return daily-quota-exhausted on the next call.
    vi.mocked(Date.now).mockImplementation(realNow);
    const quotaError = Object.assign(new Error('Request failed with status code 402'), {
      isAxiosError: true,
      response: {
        status: 402,
        data: { error: { code: 'usage_limit_reached', message: 'Daily usage limit reached.' } },
      },
    });
    vi.mocked(axios.get).mockRejectedValueOnce(quotaError);

    const stale = await fetchNewsContext('USDJPY');

    // Should NOT be [] — stale cache served instead.
    expect(stale).toHaveLength(1);
    expect(stale[0]?.title).toBe('Cached-USDJPY-headline');
    // stale_minutes tagged with the real age of the cache.
    expect(stale[0]?.stale_minutes).toBeGreaterThanOrEqual(89);
    expect(stale[0]?.stale_minutes).toBeLessThanOrEqual(91);

    vi.mocked(Date.now).mockRestore();
  });

  it('Layer 2: falls through to [] when cache is older than 4 h (stale-max exceeded)', async () => {
    resetNewsTest();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    // Prime cache 5 h ago — beyond the stale-max.
    const FIVE_H_AGO = Date.now() - 5 * 60 * 60 * 1000;
    const realNow = Date.now;
    vi.spyOn(Date, 'now').mockImplementation(() => FIVE_H_AGO);

    vi.spyOn(axios, 'get').mockResolvedValueOnce(
      mkMarketAuxResponse({ symbol: 'AUDUSD', title: 'Old' })
    );
    await fetchNewsContext('AUDUSD');  // primes 5 h-old cache

    vi.mocked(Date.now).mockImplementation(realNow);
    const quotaError = Object.assign(new Error('Request failed with status code 402'), {
      isAxiosError: true,
      response: {
        status: 402,
        data: { error: { code: 'usage_limit_reached', message: 'Daily usage limit reached.' } },
      },
    });
    vi.mocked(axios.get).mockRejectedValueOnce(quotaError);

    const result = await fetchNewsContext('AUDUSD');
    expect(result).toEqual([]);  // too stale to serve

    vi.mocked(Date.now).mockRestore();
  });

  it('Layer 3: daily soft-cap at 90 — 91st attempt skips axios and serves stale/[] instead', async () => {
    resetNewsTest();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    // Feed 90 successful calls across 90 distinct tickers so each populates
    // the counter without being absorbed by the per-ticker cache.
    const getSpy = vi.spyOn(axios, 'get');
    for (let i = 0; i < 90; i++) getSpy.mockResolvedValueOnce(
      mkMarketAuxResponse({ symbol: `TICKER${i}`, title: `T${i}` })
    );

    for (let i = 0; i < 90; i++) {
      await fetchNewsContext(`TICKER${i}`);
    }
    expect(_getMarketAuxCallCount()).toBe(90);
    expect(getSpy).toHaveBeenCalledTimes(90);

    // 91st call for a new, uncached ticker. Must NOT hit axios (cap reached).
    const result = await fetchNewsContext('TICKER_91');
    expect(getSpy).toHaveBeenCalledTimes(90);     // still 90 — no axios hit
    expect(result).toEqual([]);                     // no cache for this ticker
    expect(_getMarketAuxCallCount()).toBe(90); // counter not bumped on skip
  });

  it('Layer 3: cache hits do not count against the daily cap', async () => {
    resetNewsTest();

    vi.spyOn(axios, 'get').mockResolvedValue(mkMarketAuxResponse({ symbol: 'GLD' }));

    // 100 repeat calls for the same ticker — only the first hits MarketAux.
    for (let i = 0; i < 100; i++) {
      await fetchNewsContext('GOLD');
    }
    expect(_getMarketAuxCallCount()).toBe(1);
  });

  it('Layer 5: news-degraded Telegram alert fires at most once per UTC day', async () => {
    // Whether triggered by daily-quota exhaustion OR soft-cap hit, the alert
    // must be idempotent — Giuseppe should not get N Telegram pings per day.
    resetNewsTest();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // 5 consecutive MarketAux quota-exhausted responses (HTTP 402).
    const quotaError = Object.assign(new Error('Request failed with status code 402'), {
      isAxiosError: true,
      response: {
        status: 402,
        data: { error: { code: 'usage_limit_reached', message: 'Daily usage limit reached.' } },
      },
    });
    vi.spyOn(axios, 'get').mockRejectedValue(quotaError);

    await fetchNewsContext('T1');
    await fetchNewsContext('T2');
    await fetchNewsContext('T3');
    await fetchNewsContext('T4');
    await fetchNewsContext('T5');

    // Exactly one "News feed degraded" loud log — the gate for the Telegram
    // call, which is the same one-shot state.
    const degradedLogs = errSpy.mock.calls.filter((args) =>
      typeof args[0] === 'string' && args[0].includes('News feed degraded'),
    );
    expect(degradedLogs).toHaveLength(1);
  });


  it('_resetTwelveDataState clears BOTH the daily-cap breaker and the candle cache', async () => {
    // Prime the cache with a fetch.
    vi.spyOn(axios, 'get').mockResolvedValue({
      data: {
        status: 'ok',
        values: [{ datetime: '2026-04-22 17:00:00', open: '1', high: '1', low: '1', close: '1', volume: '0' }],
      },
    });
    await fetchCandles('EURUSD', '1h', 5);
    expect(_getCandleCache().size()).toBeGreaterThan(0);

    _resetTwelveDataState();
    expect(_getCandleCache().size()).toBe(0);
    expect(_getTwelveDataDailyCap()).toBeNull();
  });
});

describe('normalizeForMarketAux', () => {
  it('maps FX pairs to bare ticker symbols (no suffix)', () => {
    expect(normalizeForMarketAux('EURUSD')).toBe('EURUSD');
    expect(normalizeForMarketAux('GBPUSD')).toBe('GBPUSD');
    expect(normalizeForMarketAux('USDJPY')).toBe('USDJPY');
    expect(normalizeForMarketAux('AUDUSD')).toBe('AUDUSD');
  });

  it('maps commodities to ETF proxy tickers', () => {
    expect(normalizeForMarketAux('GOLD')).toBe('GLD');
    expect(normalizeForMarketAux('SILVER')).toBe('SLV');
    expect(normalizeForMarketAux('OIL_CRUDE')).toBe('USO');
  });

  it('maps cross-broker aliases to the same ETF destinations', () => {
    expect(normalizeForMarketAux('XAUUSD')).toBe('GLD');
    expect(normalizeForMarketAux('XAGUSD')).toBe('SLV');
    expect(normalizeForMarketAux('USOIL')).toBe('USO');
    expect(normalizeForMarketAux('WTIUSD')).toBe('USO');
  });

  it('passes US equities through uppercased', () => {
    expect(normalizeForMarketAux('AAPL')).toBe('AAPL');
    expect(normalizeForMarketAux('msft')).toBe('MSFT');
  });
});

describe('Twelve Data daily-cap circuit breaker', () => {
  const originalKey = process.env.TWELVE_DATA_API_KEY;

  beforeEach(() => {
    process.env.TWELVE_DATA_API_KEY = 'test-key';
    _resetTwelveDataDailyCap();
    _getCandleCache().clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.TWELVE_DATA_API_KEY;
    else process.env.TWELVE_DATA_API_KEY = originalKey;
    _resetTwelveDataDailyCap();
    vi.restoreAllMocks();
  });

  it('trips on the exact credit-exhaustion message Twelve Data emits', async () => {
    // Exact string from production pm2-err.log, 2026-04-20.
    const exhaustionMessage =
      'You have run out of API credits for the day. 1316 API credits were used, with the current limit being 800.';
    vi.spyOn(axios, 'get').mockResolvedValue({
      data: { status: 'error', message: exhaustionMessage },
    });

    await expect(fetchCandles('EURUSD', '15m', 10)).rejects.toThrow(/Twelve Data error/);

    const breakerState = _getTwelveDataDailyCap();
    expect(breakerState).not.toBeNull();
    expect(breakerState!.resetsAt).toBeGreaterThan(Date.now());
  });

  it('short-circuits subsequent calls without hitting the network once tripped', async () => {
    const axiosSpy = vi.spyOn(axios, 'get').mockResolvedValue({
      data: { status: 'error', message: 'You have run out of API credits for the day.' },
    });

    // First call: hits API, trips breaker.
    await expect(fetchCandles('GBPUSD', '1h', 10)).rejects.toThrow();
    expect(axiosSpy).toHaveBeenCalledTimes(1);

    // Second call: must short-circuit with the breaker message, no network hit.
    await expect(fetchCandles('USDJPY', '1h', 10)).rejects.toThrow(/daily cap reached/);
    expect(axiosSpy).toHaveBeenCalledTimes(1); // still only 1 — breaker held
  });

  it('does NOT trip on unrelated Twelve Data errors (e.g. bad symbol)', async () => {
    vi.spyOn(axios, 'get').mockResolvedValue({
      data: { status: 'error', message: 'Symbol NOT_A_REAL_SYMBOL was not found.' },
    });

    await expect(fetchCandles('NOT_A_REAL_SYMBOL', '1h', 10)).rejects.toThrow(/Twelve Data error/);
    expect(_getTwelveDataDailyCap()).toBeNull();
  });

  it('trips on HTTP 429 responses as a defensive fallback', async () => {
    const axiosErr = Object.assign(new Error('Too many requests'), {
      isAxiosError: true,
      response: { status: 429, data: {} },
    });
    vi.spyOn(axios, 'isAxiosError').mockReturnValue(true);
    vi.spyOn(axios, 'get').mockRejectedValue(axiosErr);

    await expect(fetchCandles('EURUSD', '5m', 10)).rejects.toThrow();
    expect(_getTwelveDataDailyCap()).not.toBeNull();
  });
});

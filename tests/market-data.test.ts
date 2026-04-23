// Tests for withCache and withFallback utilities
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import {
  withCache,
  withFallback,
  fetchCandles,
  fetchVix,
  fetchDxy,
  computeCorrelation,
  _getTwelveDataDailyCap,
  _resetTwelveDataDailyCap,
  _resetTwelveDataState,
  _getCandleCache,
  _mapToTwelveDataSymbol,
  _resetAlphaVantageRateLimitFlag,
  fetchNewsContext,
  normalizeForAlphaVantage,
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

  it('fetchVix returns zero-defaults when the upstream fetchCandles throws', async () => {
    vi.spyOn(axios, 'get').mockRejectedValue(new Error('Network is down'));
    const result = await fetchVix();
    expect(result).toEqual({ vix: 0, vix_30d_avg: 0 });
  });

  it('fetchDxy returns zero-defaults when the upstream fetchCandles throws', async () => {
    vi.spyOn(axios, 'get').mockRejectedValue(new Error('API returned 500'));
    const result = await fetchDxy();
    expect(result).toEqual({ dxy: 0, direction: 'flat' });
  });

  it('computeCorrelation returns neutral-correlation when fetchCandles throws', async () => {
    vi.spyOn(axios, 'get').mockRejectedValue(new Error('Rate limited'));
    const result = await computeCorrelation('EURUSD', 'DXY', 30);
    expect(result.correlation_30d).toBe(0);
    expect(result.correlation_90d).toBe(0);
    expect(result.instrument_a).toBe('EURUSD');
    expect(result.instrument_b).toBe('DXY');
  });

  it('fetchVix degrades when the breaker is tripped (exact crash scenario)', async () => {
    // Trip the breaker by returning the credit-exhaustion payload.
    vi.spyOn(axios, 'get').mockResolvedValue({
      data: { status: 'error', message: 'You have run out of API credits for the day.' },
    });
    // First call trips the breaker (via AAPL since VIX returns [] before hitting TD)
    await fetchCandles('AAPL', '1d', 10).catch(() => undefined);
    expect(_getTwelveDataDailyCap()).not.toBeNull();

    // Now fetchVix/fetchDxy must still return defaults, not throw.
    const vix = await fetchVix();
    const dxy = await fetchDxy();
    expect(vix).toEqual({ vix: 0, vix_30d_avg: 0 });
    expect(dxy).toEqual({ dxy: 0, direction: 'flat' });
  });

  it('Promise.all of [fetchVix, fetchDxy, computeCorrelation] never rejects — Researcher invariant', async () => {
    // Simulate the detectRegime() call shape that crashed: Promise.all of these
    // three. The researcher's Promise.all MUST never reject now.
    vi.spyOn(axios, 'get').mockRejectedValue(new Error('Everything is on fire'));
    await expect(
      Promise.all([fetchVix(), fetchDxy(), computeCorrelation('EURUSD', 'USDJPY')])
    ).resolves.toEqual([
      { vix: 0, vix_30d_avg: 0 },
      { dxy: 0, direction: 'flat' },
      expect.objectContaining({ correlation_30d: 0, correlation_90d: 0 }),
    ]);
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

  it('fetchNewsContext returns [] + logs once when AV rate-limit response is detected', async () => {
    process.env.ALPHA_VANTAGE_API_KEY = 'test-av-key';
    _resetAlphaVantageRateLimitFlag();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Exact shape AV returns on free-tier exhaustion — HTTP 200, {Information}
    // body, no `feed`. Pre-fix this fell through `!data.feed` → silent [].
    vi.spyOn(axios, 'get').mockResolvedValue({
      data: {
        Information:
          'We have detected your API key as ABCDEFGH and our standard API rate limit is 25 requests per day. Please subscribe to any of the premium plans...',
      },
    });

    const first = await fetchNewsContext('EURUSD');
    const second = await fetchNewsContext('GOLD');
    const third = await fetchNewsContext('OIL_CRUDE');

    // All three return [] gracefully — no throws.
    expect(first).toEqual([]);
    expect(second).toEqual([]);
    expect(third).toEqual([]);

    // Loud log fires exactly once — not three times. Ops sees the signal
    // without the log being flooded by every cycle's worth of calls.
    const rateLimitLogCalls = errSpy.mock.calls.filter((args) =>
      typeof args[0] === 'string' && args[0].includes('Alpha Vantage daily rate limit reached'),
    );
    expect(rateLimitLogCalls).toHaveLength(1);
  });

  it('fetchNewsContext wraps in withFallback — axios throws degrade to []', async () => {
    process.env.ALPHA_VANTAGE_API_KEY = 'test-av-key';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(axios, 'get').mockRejectedValue(new Error('Network outage'));

    // Pre-fix (unwrapped), this throw would propagate to the caller and
    // crash researcher-agent's Promise.all. Post-fix: silent empty.
    const result = await fetchNewsContext('EURUSD');
    expect(result).toEqual([]);
  });

  it('fetchNewsContext detects AV burst-limit message, retries once, and logs once per day', async () => {
    // Regression for 2026-04-23 finding: AV free tier enforces a 1 req/sec
    // burst limit in addition to the 25 req/day daily quota. Parallel scanner
    // calls (Promise.all across N tickers) landed all-but-first inside that
    // burst, which AV signals with an `Information` body distinct from the
    // daily-quota message. Pre-fix the daily-quota regex didn't match, so
    // throttled calls fell through to the `!Array.isArray(data.feed)` guard
    // and returned []. EURUSD/GBPUSD/OIL_CRUDE had been pinned at 0 news
    // score since day 1 of the demo despite being in the mapping table.
    process.env.ALPHA_VANTAGE_API_KEY = 'test-av-key';
    _resetAlphaVantageRateLimitFlag();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Exact AV burst-limit payload shape — HTTP 200, Information body, no
    // `feed`. On retry, return a valid feed so we exercise the full
    // "throttled → wait → succeed" path end-to-end.
    const burstResponse = {
      data: {
        Information:
          'Thank you for using Alpha Vantage! Please consider spreading out your free API requests more sparingly (1 request per second). You may subscribe to any of the premium plans at https://www.alphavantage.co/premium/ to lift the free key rate limit (25 requests per day)...',
      },
    };
    const successResponse = {
      data: {
        items: '1',
        feed: [{
          title: 'Headline',
          url: 'https://example.com',
          time_published: '20260423T080000',
          source: 'Wire',
          summary: 'Summary',
          overall_sentiment_score: '0.2',
          ticker_sentiment: [{ relevance_score: '0.9' }],
        }],
      },
    };
    const getSpy = vi.spyOn(axios, 'get')
      .mockResolvedValueOnce(burstResponse)
      .mockResolvedValueOnce(successResponse);

    const result = await fetchNewsContext('GBPUSD');

    // Retry path executed: two axios calls, one successful feed returned.
    expect(getSpy).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(1);
    expect(result[0]?.title).toBe('Headline');

    // Loud warning fires exactly once.
    const burstLogCalls = errSpy.mock.calls.filter((args) =>
      typeof args[0] === 'string' && args[0].includes('Alpha Vantage burst limit hit'),
    );
    expect(burstLogCalls).toHaveLength(1);
  }, 10_000);

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

describe('normalizeForAlphaVantage', () => {
  it('maps EURUSD to FOREX:EUR,FOREX:USD (both sides of the pair)', () => {
    expect(normalizeForAlphaVantage('EURUSD')).toBe('FOREX:EUR,FOREX:USD');
  });

  it('maps all scanner-universe FX pairs to FOREX:X,FOREX:Y', () => {
    expect(normalizeForAlphaVantage('GBPUSD')).toBe('FOREX:GBP,FOREX:USD');
    expect(normalizeForAlphaVantage('USDJPY')).toBe('FOREX:USD,FOREX:JPY');
    expect(normalizeForAlphaVantage('AUDUSD')).toBe('FOREX:AUD,FOREX:USD');
  });

  it('maps commodities to their ETF news proxies (GLD / SLV / USO)', () => {
    expect(normalizeForAlphaVantage('GOLD')).toBe('GLD');
    expect(normalizeForAlphaVantage('SILVER')).toBe('SLV');
    expect(normalizeForAlphaVantage('OIL_CRUDE')).toBe('USO');
  });

  it('maps cross-broker commodity aliases to the same ETF proxies', () => {
    expect(normalizeForAlphaVantage('XAUUSD')).toBe('GLD');
    expect(normalizeForAlphaVantage('XAGUSD')).toBe('SLV');
    expect(normalizeForAlphaVantage('USOIL')).toBe('USO');
    expect(normalizeForAlphaVantage('WTIUSD')).toBe('USO');
  });

  it('passes through native AV stock tickers unchanged (uppercased)', () => {
    expect(normalizeForAlphaVantage('AAPL')).toBe('AAPL');
    expect(normalizeForAlphaVantage('MSFT')).toBe('MSFT');
    expect(normalizeForAlphaVantage('NVDA')).toBe('NVDA');
  });

  it('is case-insensitive on input', () => {
    expect(normalizeForAlphaVantage('eurusd')).toBe('FOREX:EUR,FOREX:USD');
    expect(normalizeForAlphaVantage('Gold')).toBe('GLD');
    expect(normalizeForAlphaVantage('aapl')).toBe('AAPL');
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

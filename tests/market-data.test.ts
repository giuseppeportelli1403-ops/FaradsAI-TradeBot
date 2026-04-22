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
  _getCandleCache,
  _mapToTwelveDataSymbol,
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

  it('maps broker-style indices to TD index codes', () => {
    expect(_mapToTwelveDataSymbol('US30')).toBe('DJIA');
    expect(_mapToTwelveDataSymbol('DE40')).toBe('DAX');
    expect(_mapToTwelveDataSymbol('UK100')).toBe('UKX');
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

  it('passes through natively-accepted TD symbols', () => {
    expect(_mapToTwelveDataSymbol('AAPL')).toBe('AAPL');
    expect(_mapToTwelveDataSymbol('MSFT')).toBe('MSFT');
    expect(_mapToTwelveDataSymbol('NVDA')).toBe('NVDA');
    expect(_mapToTwelveDataSymbol('TSLA')).toBe('TSLA');
    // US100 / US500 aren't in the map and aren't in UNAVAILABLE either — they
    // currently pass through to TD raw. TD happens to resolve them to Euronext
    // ETF listings (wrong, but non-empty), so keeping status-quo here rather
    // than risking a broader rework of the scanner's index handling mid-demo.
    expect(_mapToTwelveDataSymbol('US100')).toBe('US100');
    expect(_mapToTwelveDataSymbol('US500')).toBe('US500');
  });

  it('is case-insensitive on input', () => {
    expect(_mapToTwelveDataSymbol('eurusd')).toBe('EUR/USD');
    expect(_mapToTwelveDataSymbol('EurUsd')).toBe('EUR/USD');
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

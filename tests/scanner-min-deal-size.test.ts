// Unit tests for src/scanner/index.ts min_deal_size cache + helper.
// Tests cover the in-flight-promise-deduped cache pattern that prevents
// duplicate Capital API calls when concurrent callers hit the same cold
// ticker (e.g. researcher-agent + scheduler ICT trigger overlapping at
// startup). Per spec docs/superpowers/specs/2026-05-09-leg-b-notional-preflight-design.md.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.mock factory must reference vi.hoisted vars so they exist at hoist time.
const { mockGetMarketDetails, mockFetchCandles, mockGetNewsScore } = vi.hoisted(() => ({
  mockGetMarketDetails: vi.fn(),
  mockFetchCandles: vi.fn(),
  mockGetNewsScore: vi.fn(),
}));

// Mock the capital singleton — same module the scanner imports.
vi.mock('../src/mcp-server/capital-singleton.js', () => ({
  capital: {
    getMarketDetails: mockGetMarketDetails,
  },
}));

// Mock market-data + news so the integration test can drive
// getRankedInstruments deterministically without real Capital/MarketAux/TD calls.
// The TwelveDataDailyCapError class must still be exported (the scanner imports
// it for instanceof checks); we re-export a minimal stand-in.
vi.mock('../src/mcp-server/market-data.js', () => ({
  fetchCandles: mockFetchCandles,
  TwelveDataDailyCapError: class TwelveDataDailyCapError extends Error {
    public resetsAt: Date;
    constructor(resetsAt: Date) {
      super('Twelve Data daily cap exceeded (test stub)');
      this.name = 'TwelveDataDailyCapError';
      this.resetsAt = resetsAt;
    }
  },
}));
vi.mock('../src/news/index.js', () => ({
  getNewsScore: mockGetNewsScore,
}));

// Import after the mock is set up.
import {
  _resetMinDealSizeCache,
  _getMinDealSizeCache,
  _getMinDealSizeFor as getMinDealSizeFor,
} from '../src/scanner/index.js';

describe('scanner getMinDealSizeFor', () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockGetMarketDetails.mockReset();
    _resetMinDealSizeCache();
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('happy path: returns the broker minDealSize value', async () => {
    mockGetMarketDetails.mockResolvedValueOnce({
      dealingRules: { minDealSize: { value: 5 } },
    });

    const size = await getMinDealSizeFor('SILVER');

    expect(size).toBe(5);
    expect(mockGetMarketDetails).toHaveBeenCalledTimes(1);
    expect(mockGetMarketDetails).toHaveBeenCalledWith('SILVER');
  });

  it('fetch failure: caches null and emits a console.warn', async () => {
    mockGetMarketDetails.mockRejectedValueOnce(new Error('Capital API down'));

    const size = await getMinDealSizeFor('SILVER');

    expect(size).toBeNull();
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('min_deal_size fetch failed for SILVER'),
    );
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Capital API down'),
    );
  });

  it('cache reuse: second call for same ticker does NOT re-fetch', async () => {
    mockGetMarketDetails.mockResolvedValueOnce({
      dealingRules: { minDealSize: { value: 1000 } },
    });

    const a = await getMinDealSizeFor('USDJPY');
    const b = await getMinDealSizeFor('USDJPY');

    expect(a).toBe(1000);
    expect(b).toBe(1000);
    expect(mockGetMarketDetails).toHaveBeenCalledTimes(1);
  });

  it('concurrent dedup: two parallel calls for the same cold ticker share one fetch', async () => {
    let resolve: (value: { dealingRules: { minDealSize: { value: number } } }) => void = () => {};
    const pending = new Promise<{ dealingRules: { minDealSize: { value: number } } }>((r) => {
      resolve = r;
    });
    mockGetMarketDetails.mockReturnValueOnce(pending);

    const callA = getMinDealSizeFor('GOLD');
    const callB = getMinDealSizeFor('GOLD');

    await new Promise((r) => setImmediate(r));
    expect(mockGetMarketDetails).toHaveBeenCalledTimes(1);

    resolve({ dealingRules: { minDealSize: { value: 0.1 } } });

    const [a, b] = await Promise.all([callA, callB]);

    expect(a).toBe(0.1);
    expect(b).toBe(0.1);
    expect(mockGetMarketDetails).toHaveBeenCalledTimes(1);
  });

  it('numeric guard: caches null for 0 / negative / NaN / missing minDealSize', async () => {
    const cases: Array<[string, unknown]> = [
      ['ZERO_TICKER', { dealingRules: { minDealSize: { value: 0 } } }],
      ['NEG_TICKER', { dealingRules: { minDealSize: { value: -1 } } }],
      ['NAN_TICKER', { dealingRules: { minDealSize: { value: NaN } } }],
      ['MISSING_TICKER', { dealingRules: {} }],
    ];

    for (const [ticker, response] of cases) {
      _resetMinDealSizeCache();
      mockGetMarketDetails.mockReset();
      mockGetMarketDetails.mockResolvedValueOnce(response);
      const size = await getMinDealSizeFor(ticker);
      expect(size).toBeNull();
    }
  });
});

describe('getRankedInstruments populates min_deal_size on each result', () => {
  beforeEach(() => {
    mockGetMarketDetails.mockReset();
    mockFetchCandles.mockReset();
    mockGetNewsScore.mockReset();
    _resetMinDealSizeCache();
    // Pin clock to 09:00 UTC so getCurrentKillZone() returns
    // { inKillZone: true, zone: 'London Open' } and getRankedInstruments
    // bypasses its kill-zone hard gate.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-09T09:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('each RankedInstrument carries min_deal_size from the cache', async () => {
    // Set up min_deal_size for each universe ticker. Capital.com's
    // INSTRUMENT_UNIVERSE in the scanner is fixed (FX majors + GOLD +
    // SILVER + OIL_CRUDE = 7 tickers). Mock the fetch to return realistic
    // values keyed off the ticker arg.
    mockGetMarketDetails.mockImplementation(async (ticker: string) => {
      const map: Record<string, number> = {
        EURUSD: 1000,
        GBPUSD: 1000,
        USDJPY: 1000,
        AUDUSD: 1000,
        GOLD: 0.1,
        SILVER: 5,
        OIL_CRUDE: 25,
      };
      const value = map[ticker] ?? null;
      return value !== null
        ? { dealingRules: { minDealSize: { value } } }
        : { dealingRules: {} };
    });

    // Deterministic candle generator: 30 candles with mild upward drift so
    // detectBias has enough data to score (> 20 candles required) without
    // demanding a specific bias outcome — the test only cares that each
    // RankedInstrument carries the right min_deal_size, not its score/bias.
    mockFetchCandles.mockImplementation(async () => {
      const candles = [];
      const base = 100;
      for (let i = 0; i < 30; i++) {
        const close = base + (29 - i) * 0.05;
        candles.push({
          datetime: new Date(Date.now() - i * 3600_000).toISOString(),
          open: close - 0.02,
          high: close + 0.1,
          low: close - 0.1,
          close,
          volume: 1000,
        });
      }
      return candles;
    });

    // Quiet news (score 0, news_unavailable false) keeps scoring stable
    // and avoids the 'news_unavailable=true' console.warn fan-out.
    mockGetNewsScore.mockResolvedValue({ score: 0, news_unavailable: false });

    // Reset ranking cache too so getRankedInstruments fully runs the
    // result-build path.
    const { getRankedInstruments, _resetRankingCache } = await import(
      '../src/scanner/index.js'
    );
    _resetRankingCache();

    const ranked = await getRankedInstruments(20);

    // Sanity: the 7-ticker universe should produce 7 results when every
    // per-instrument fetch succeeds. If this fails the upstream
    // fetchCandles/getNewsScore mock contract has drifted.
    expect(ranked.length).toBe(7);

    // Every result has min_deal_size populated (number or null).
    for (const r of ranked) {
      expect(r).toHaveProperty('min_deal_size');
      expect(
        typeof r.min_deal_size === 'number' || r.min_deal_size === null,
      ).toBe(true);
    }

    // At least one of the universe tickers we mocked should appear with
    // its expected min_deal_size value.
    const expectedSizes: Record<string, number> = {
      EURUSD: 1000, GBPUSD: 1000, USDJPY: 1000, AUDUSD: 1000,
      GOLD: 0.1, SILVER: 5, OIL_CRUDE: 25,
    };
    const mockedTickers = Object.keys(expectedSizes);
    for (const r of ranked) {
      if (mockedTickers.includes(r.ticker)) {
        expect(r.min_deal_size).toBe(expectedSizes[r.ticker]);
      }
    }
  });
});

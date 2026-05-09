// Unit tests for src/scanner/index.ts min_deal_size cache + helper.
// Tests cover the in-flight-promise-deduped cache pattern that prevents
// duplicate Capital API calls when concurrent callers hit the same cold
// ticker (e.g. researcher-agent + scheduler ICT trigger overlapping at
// startup). Per spec docs/superpowers/specs/2026-05-09-leg-b-notional-preflight-design.md.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock factory must reference vi.hoisted vars so they exist at hoist time.
const { mockGetMarketDetails } = vi.hoisted(() => ({
  mockGetMarketDetails: vi.fn(),
}));

// Mock the capital singleton — same module the scanner imports.
vi.mock('../src/mcp-server/capital-singleton.js', () => ({
  capital: {
    getMarketDetails: mockGetMarketDetails,
  },
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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CandleCache, TIMEFRAME_INTERVAL } from '../src/mcp-server/candle-cache.js';
import type { Candle } from '../src/types.js';

const sampleCandles: Candle[] = [
  { datetime: '2026-04-20T07:00:00Z', open: 1, high: 2, low: 0.9, close: 1.5, volume: 100 },
];

describe('CandleCache', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns null on miss', () => {
    const cache = new CandleCache();
    expect(cache.get(CandleCache.key('EURUSD', '15min', 100))).toBeNull();
  });

  it('returns cached candles within TTL', () => {
    const cache = new CandleCache();
    const key = CandleCache.key('EURUSD', '15min', 100);
    cache.set(key, sampleCandles, 60_000);

    vi.advanceTimersByTime(30_000);
    expect(cache.get(key)).toEqual(sampleCandles);
  });

  it('expires after TTL elapses', () => {
    const cache = new CandleCache();
    const key = CandleCache.key('EURUSD', '15min', 100);
    cache.set(key, sampleCandles, 60_000);

    vi.advanceTimersByTime(60_001);
    expect(cache.get(key)).toBeNull();
  });

  it('evicts expired entries on access', () => {
    const cache = new CandleCache();
    const key = CandleCache.key('EURUSD', '15min', 100);
    cache.set(key, sampleCandles, 60_000);

    vi.advanceTimersByTime(60_001);
    cache.get(key);
    expect(cache.size()).toBe(0);
  });

  it('keys by symbol, interval and outputSize', () => {
    expect(CandleCache.key('EURUSD', '15min', 100)).toBe('EURUSD:15min:100');
    expect(CandleCache.key('GOLD', '1h', 50)).toBe('GOLD:1h:50');
  });

  it('returns a sensible TTL for every supported interval', () => {
    for (const interval of Object.values(TIMEFRAME_INTERVAL)) {
      expect(CandleCache.ttlFor(interval)).toBeGreaterThan(0);
    }
  });

  it('falls back to a default TTL for unknown intervals', () => {
    expect(CandleCache.ttlFor('unknown-interval')).toBeGreaterThan(0);
  });
});

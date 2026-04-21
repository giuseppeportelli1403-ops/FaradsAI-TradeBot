// In-memory TTL cache for Twelve Data candle responses.
//
// The agent re-fetches the same (symbol, interval, count) within a single
// decision cycle; caching removes those duplicates without changing call
// semantics. TTLs are set slightly below the candle duration so callers
// still see fresh closes but avoid burning rate-limit credits.

import type { Candle, Timeframe } from '../types.js';

interface Entry {
  candles: Candle[];
  expiresAt: number;
}

// TTL per timeframe, keyed by the Twelve Data `interval` string.
const TTL_MS_BY_INTERVAL: Record<string, number> = {
  '15min': 60_000,        // 1 minute — candles close every 15m; short TTL ok
  '1h':    5 * 60_000,    // 5 minutes
  '4h':    20 * 60_000,   // 20 minutes
  '1day':  60 * 60_000,   // 1 hour
  '1week': 4 * 60 * 60_000, // 4 hours
};

export class CandleCache {
  private cache = new Map<string, Entry>();

  static key(symbol: string, interval: string, outputSize: number): string {
    return `${symbol}:${interval}:${outputSize}`;
  }

  static ttlFor(interval: string): number {
    return TTL_MS_BY_INTERVAL[interval] ?? 5 * 60_000;
  }

  get(key: string): Candle[] | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.candles;
  }

  set(key: string, candles: Candle[], ttlMs: number): void {
    this.cache.set(key, { candles, expiresAt: Date.now() + ttlMs });
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }
}

/** Map a high-level timeframe to the Twelve Data `interval` string. */
export const TIMEFRAME_INTERVAL: Record<Timeframe, string> = {
  '15m': '15min',
  '1h':  '1h',
  '4h':  '4h',
  '1d':  '1day',
  '1w':  '1week',
};

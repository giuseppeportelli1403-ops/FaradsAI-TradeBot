// Tests for withCache and withFallback utilities
import { describe, it, expect, vi } from 'vitest';
import { withCache, withFallback } from '../src/mcp-server/market-data.js';

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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TokenBucket, RateLimitQueuedError } from '../src/mcp-server/rate-limiter.js';

describe('TokenBucket', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('grants tokens up to capacity immediately', async () => {
    const bucket = new TokenBucket(3, 60_000);
    await bucket.acquire();
    await bucket.acquire();
    await bucket.acquire();
    expect(bucket.getTokens()).toBeLessThan(1);
  });

  it('refills over time at capacity/interval rate', async () => {
    const bucket = new TokenBucket(8, 60_000);
    // Drain the bucket
    for (let i = 0; i < 8; i++) await bucket.acquire();
    expect(bucket.getTokens()).toBeLessThan(1);

    // Advance 30s — should refill half
    vi.advanceTimersByTime(30_000);
    expect(bucket.getTokens()).toBeCloseTo(4, 0);
  });

  it('throws RateLimitQueuedError when deadline expires before refill', async () => {
    const bucket = new TokenBucket(1, 60_000);
    await bucket.acquire(); // drain

    const promise = bucket.acquire(500);
    // Pre-attach a handler so the (expected) rejection is never unhandled while
    // fake timers advance.
    promise.catch(() => { /* asserted below */ });
    await vi.advanceTimersByTimeAsync(600);
    await expect(promise).rejects.toBeInstanceOf(RateLimitQueuedError);
  });

  it('serves the queued acquire once a token refills within the deadline', async () => {
    const bucket = new TokenBucket(1, 1_000); // 1 token per second
    await bucket.acquire(); // drain

    const promise = bucket.acquire(5_000);
    // After 1.1s one token should have refilled
    await vi.advanceTimersByTimeAsync(1_100);
    await expect(promise).resolves.toBeUndefined();
  });

  it('caps refill at capacity', async () => {
    const bucket = new TokenBucket(5, 60_000);
    await bucket.acquire(); // 4 tokens left
    vi.advanceTimersByTime(10 * 60_000); // way more than a full refill
    expect(bucket.getTokens()).toBe(5);
  });
});

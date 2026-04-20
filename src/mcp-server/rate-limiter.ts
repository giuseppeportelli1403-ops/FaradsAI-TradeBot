// Token-bucket rate limiter for external API calls.
//
// Twelve Data free tier allows 8 credits/minute. `fetchCandles` burns 1 credit
// per call, but an ICT cycle can issue 20+ calls in seconds. We bucket them
// and make the extras wait instead of letting the API 429 us.

export class RateLimitQueuedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateLimitQueuedError';
  }
}

export class TokenBucket {
  private tokens: number;
  private readonly capacity: number;
  private readonly refillIntervalMs: number;
  private lastRefill: number;

  constructor(capacity: number, refillIntervalMs: number) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillIntervalMs = refillIntervalMs;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    const tokensToAdd = (elapsed / this.refillIntervalMs) * this.capacity;
    this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }

  /**
   * Await one token. Rejects with RateLimitQueuedError if the wait exceeds
   * `timeoutMs`. Poll interval is intentionally short (100 ms) so the wait is
   * bounded by token refill, not polling granularity.
   */
  async acquire(timeoutMs: number = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (true) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      if (Date.now() >= deadline) {
        throw new RateLimitQueuedError(
          `Rate limit: no token available within ${timeoutMs}ms`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /** Exposed for tests. */
  getTokens(): number {
    this.refill();
    return this.tokens;
  }
}

// Tests for makeCandleKey — month padding and boundary correctness
import { describe, it, expect } from 'vitest';
import { makeCandleKey } from '../src/scheduler/index.js';

describe('makeCandleKey', () => {
  it('pads January (month 0 internally) correctly for 15m', () => {
    // January 5, 2026 09:30 UTC
    const date = new Date(Date.UTC(2026, 0, 5, 9, 30));
    const key = makeCandleKey(date, '15m');
    expect(key).toBe('2026-01-05T09:30');
  });

  it('pads December (month 11 internally) correctly for 15m', () => {
    // December 31, 2026 23:45 UTC
    const date = new Date(Date.UTC(2026, 11, 31, 23, 45));
    const key = makeCandleKey(date, '15m');
    expect(key).toBe('2026-12-31T23:45');
  });

  it('handles month boundary correctly — March 31 to April 1', () => {
    const march31 = new Date(Date.UTC(2026, 2, 31, 23, 45));
    const april1 = new Date(Date.UTC(2026, 3, 1, 0, 0));

    const keyMarch = makeCandleKey(march31, '15m');
    const keyApril = makeCandleKey(april1, '15m');

    expect(keyMarch).toBe('2026-03-31T23:45');
    expect(keyApril).toBe('2026-04-01T00:00');
    expect(keyMarch).not.toBe(keyApril);
  });

  it('uses hour granularity for 1h timeframe', () => {
    const date = new Date(Date.UTC(2026, 0, 5, 14, 37));
    const key = makeCandleKey(date, '1h');
    expect(key).toBe('2026-01-05T14:00');
  });

  it('snaps 15m candle to correct 15-minute boundary', () => {
    // 09:07 should snap to 09:00
    const date = new Date(Date.UTC(2026, 5, 15, 9, 7));
    const key = makeCandleKey(date, '15m');
    expect(key).toBe('2026-06-15T09:00');
  });

  it('snaps 15m candle at :32 to :30', () => {
    const date = new Date(Date.UTC(2026, 5, 15, 9, 32));
    const key = makeCandleKey(date, '15m');
    expect(key).toBe('2026-06-15T09:30');
  });
});

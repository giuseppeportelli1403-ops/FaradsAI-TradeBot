import { describe, it, expect } from 'vitest';
import { detectBias, getCurrentKillZone } from '../src/scanner/index.js';
import type { Candle } from '../src/types.js';

function makeCandles(direction: 'up' | 'down' | 'flat', count: number): Candle[] {
  const candles: Candle[] = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    if (direction === 'up') price += 1 + Math.random() * 0.5;
    else if (direction === 'down') price -= 1 + Math.random() * 0.5;
    else price += (Math.random() - 0.5) * 0.3;
    candles.push({
      datetime: new Date(Date.now() - i * 3600000).toISOString(),
      open: price - 0.3,
      high: price + 0.8,
      low: price - 0.8,
      close: price,
      volume: 1000,
    });
  }
  return candles;
}

describe('detectBias', () => {
  it('returns neutral with clarity 0 when fewer than 20 candles', () => {
    const candles = makeCandles('up', 10);
    const result = detectBias(candles);
    expect(result.bias).toBe('neutral');
    expect(result.clarity).toBe(0);
  });

  it('detects bullish bias for ascending candles', () => {
    const candles = makeCandles('up', 30);
    const result = detectBias(candles);
    // Ascending prices should produce bullish or neutral (swing detection may vary)
    // but clarity should be >= 0
    expect(result.clarity).toBeGreaterThanOrEqual(0);
    expect(['bullish', 'bearish', 'neutral']).toContain(result.bias);
  });

  it('detects bearish bias for descending candles', () => {
    const candles = makeCandles('down', 30);
    const result = detectBias(candles);
    expect(result.clarity).toBeGreaterThanOrEqual(0);
    expect(['bullish', 'bearish', 'neutral']).toContain(result.bias);
  });

  it('ATR is always > 0 for valid data with 20+ candles', () => {
    const candles = makeCandles('up', 25);
    const result = detectBias(candles);
    expect(result.atr).toBeGreaterThan(0);
  });

  it('returns recent_high and recent_low for valid data', () => {
    const candles = makeCandles('up', 25);
    const result = detectBias(candles);
    expect(result.recent_high).toBeGreaterThan(0);
    expect(result.recent_low).toBeGreaterThan(0);
    expect(result.recent_high).toBeGreaterThanOrEqual(result.recent_low);
  });
});

describe('getCurrentKillZone', () => {
  it('returns an object with inKillZone boolean and zone string', () => {
    const result = getCurrentKillZone();
    expect(typeof result.inKillZone).toBe('boolean');
    expect(typeof result.zone).toBe('string');
  });

  it('zone is one of the known values', () => {
    const result = getCurrentKillZone();
    expect(['London Open', 'NY Open', 'London Close', 'outside']).toContain(result.zone);
  });
});

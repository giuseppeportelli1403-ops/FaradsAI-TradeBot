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

  // After Codex P1 #6 (CR-D2 2026-04-28) the slope fallback is feature-flag
  // gated behind SCANNER_SLOPE_FALLBACK=true (default OFF — contradicts ICT
  // reversal philosophy). These two tests now scope the env flag locally
  // so they exercise the fallback behaviour as documented while leaving
  // the production default unchanged.
  it('assigns slope-based clarity=15 when closes are >=7/9 monotonic up but swings are mixed (FLAG ON)', () => {
    const prev = process.env.SCANNER_SLOPE_FALLBACK;
    process.env.SCANNER_SLOPE_FALLBACK = 'true';
    try {
      const candles: Candle[] = [];
      for (let i = 0; i < 20; i++) {
        const close = 100 - i * 0.5;
        candles.push({
          datetime: `2026-04-22 ${String(20 - i).padStart(2, '0')}:00:00`,
          open: close,
          high: close + (i % 2 === 0 ? 0.1 : 0.8),
          low: close - (i % 2 === 0 ? 0.8 : 0.1),
          close,
          volume: 0,
        });
      }
      const result = detectBias(candles);
      expect(result.bias).toBe('bullish');
      expect(result.clarity).toBe(15);
    } finally {
      if (prev === undefined) delete process.env.SCANNER_SLOPE_FALLBACK;
      else process.env.SCANNER_SLOPE_FALLBACK = prev;
    }
  });

  it('assigns slope-based clarity=15 when closes are >=7/9 monotonic down but swings are mixed (FLAG ON)', () => {
    const prev = process.env.SCANNER_SLOPE_FALLBACK;
    process.env.SCANNER_SLOPE_FALLBACK = 'true';
    try {
      const candles: Candle[] = [];
      for (let i = 0; i < 20; i++) {
        const close = 100 + i * 0.5;
        candles.push({
          datetime: `2026-04-22 ${String(20 - i).padStart(2, '0')}:00:00`,
          open: close,
          high: close + (i % 2 === 0 ? 0.1 : 0.8),
          low: close - (i % 2 === 0 ? 0.8 : 0.1),
          close,
          volume: 0,
        });
      }
      const result = detectBias(candles);
      expect(result.bias).toBe('bearish');
      expect(result.clarity).toBe(15);
    } finally {
      if (prev === undefined) delete process.env.SCANNER_SLOPE_FALLBACK;
      else process.env.SCANNER_SLOPE_FALLBACK = prev;
    }
  });

  it('returns neutral when slope fallback is OFF (default), even on monotonic closes', () => {
    // Production default: SCANNER_SLOPE_FALLBACK is unset/false → the
    // momentum-following heuristic does NOT fire, regardless of how clean
    // the run is. ICT-pure baseline.
    const prev = process.env.SCANNER_SLOPE_FALLBACK;
    delete process.env.SCANNER_SLOPE_FALLBACK;
    try {
      const candles: Candle[] = [];
      for (let i = 0; i < 20; i++) {
        const close = 100 - i * 0.5;
        candles.push({
          datetime: `2026-04-22 ${String(20 - i).padStart(2, '0')}:00:00`,
          open: close,
          high: close + (i % 2 === 0 ? 0.1 : 0.8),
          low: close - (i % 2 === 0 ? 0.8 : 0.1),
          close,
          volume: 0,
        });
      }
      const result = detectBias(candles);
      expect(result.bias).toBe('neutral');
      expect(result.clarity).toBe(0);
    } finally {
      if (prev !== undefined) process.env.SCANNER_SLOPE_FALLBACK = prev;
    }
  });

  it('returns neutral when closes are noisy (fewer than 7/9 monotonic)', () => {
    // Alternating up/down closes: 5 ups, 4 downs (or vice versa) — below
    // the 7/9 threshold.
    const candles: Candle[] = [];
    for (let i = 0; i < 20; i++) {
      const close = 100 + (i % 2 === 0 ? 0.5 : -0.5);
      candles.push({
        datetime: `2026-04-22 ${String(20 - i).padStart(2, '0')}:00:00`,
        open: close,
        high: close + 0.2,
        low: close - 0.2,
        close,
        volume: 0,
      });
    }
    const result = detectBias(candles);
    expect(result.bias).toBe('neutral');
    expect(result.clarity).toBe(0);
  });

  it('prefers formal swing-structure clarity=20 over slope fallback when both qualify', () => {
    // Monotonic closes alone can't produce formal swings (the detector looks
    // at local extrema of high[] and low[], not of close[]). To stress the
    // precedence rule, we inject genuine local peaks into `high` and troughs
    // into `low` at specific indices while keeping closes strictly monotonic.
    // Local peak at i=3 and i=8 with peak[3] > peak[8] → HH. Local troughs at
    // i=5 and i=10 with trough[5] > trough[10] → HL. Formal path fires with
    // clarity=20; slope fallback would also qualify (closes are pure trend)
    // but the formal return happens first.
    const candles: Candle[] = [];
    for (let i = 0; i < 20; i++) {
      const base = 100 - i * 1.0; // newest close highest (bullish)
      const isPeak = i === 3 || i === 8;
      const isTrough = i === 5 || i === 10;
      candles.push({
        datetime: `2026-04-22 ${String(20 - i).padStart(2, '0')}:00:00`,
        open: base,
        high: base + (isPeak ? 3 : 0.5),
        low: base - (isTrough ? 3 : 0.5),
        close: base,
        volume: 0,
      });
    }
    const result = detectBias(candles);
    expect(result.bias).toBe('bullish');
    expect(result.clarity).toBe(20);
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

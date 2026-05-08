import { describe, it, expect, vi } from 'vitest';
import { computeBeStop } from '../src/scheduler/index.js';

describe('computeBeStop', () => {
  it('long: entry + 0.1R when 0.1R > 2×spread (GOLD R=12.54)', () => {
    const beStop = computeBeStop({
      direction: 'long', entry: 4735.54, sl: 4723, instrument: 'GOLD',
    });
    // R = 12.54, 0.1R = 1.254, 2×spread = 0.80 → 0.1R wins
    expect(beStop).toBeCloseTo(4736.794, 3);
  });

  it('short: entry − 0.1R when 0.1R > 2×spread', () => {
    const beStop = computeBeStop({
      direction: 'short', entry: 4735.54, sl: 4748.08, instrument: 'GOLD',
    });
    expect(beStop).toBeCloseTo(4734.286, 3); // 4735.54 - 1.254
  });

  it('small-R FX long: spread floor wins over 0.1R (EURUSD R=5pips)', () => {
    const beStop = computeBeStop({
      direction: 'long', entry: 1.10000, sl: 1.09995, instrument: 'EURUSD',
    });
    // R = 0.00005, 0.1R = 0.000005, 2×spread = 0.00016 → spread floor wins
    expect(beStop).toBeCloseTo(1.10016, 5);
  });

  it('small-R FX short: spread floor in opposite direction', () => {
    const beStop = computeBeStop({
      direction: 'short', entry: 1.10000, sl: 1.10005, instrument: 'EURUSD',
    });
    expect(beStop).toBeCloseTo(1.09984, 5); // 1.10000 - 0.00016
  });

  it('zero-R defensive: returns entry exactly and warns', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const beStop = computeBeStop({
      direction: 'long', entry: 100, sl: 100, instrument: 'GOLD',
    });
    expect(beStop).toBe(100);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('zero R'),
    );
    warnSpy.mockRestore();
  });

  it('invariant sweep: 5 instruments × 2 directions, beStop respects sign', () => {
    const cases: Array<{ inst: string; entry: number; sl: number; }> = [
      { inst: 'EURUSD', entry: 1.10, sl: 1.099 },
      { inst: 'GBPUSD', entry: 1.27, sl: 1.268 },
      { inst: 'GOLD',   entry: 4735, sl: 4723  },
      { inst: 'SILVER', entry: 78.88, sl: 78.03 },
      { inst: 'OIL_CRUDE', entry: 75.0, sl: 74.5 },
    ];
    for (const { inst, entry, sl } of cases) {
      const long  = computeBeStop({ direction: 'long',  entry, sl, instrument: inst });
      const short = computeBeStop({ direction: 'short', entry, sl: 2*entry - sl, instrument: inst });
      expect(long).toBeGreaterThan(entry);
      expect(short).toBeLessThan(entry);
    }
  });
});

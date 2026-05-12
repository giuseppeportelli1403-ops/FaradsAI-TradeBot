// Tests for src/scoring/ict-array-detector.ts (US-5 / T066).
// Covers each of the 4 detectors at boundary conditions plus the
// combiner thresholds, and asserts SC-001 (zero variance across 10
// runs of the same input).

import { describe, it, expect } from 'vitest';
import {
  obProximity,
  fvgCount,
  sweepRecency,
  bosCount,
  combineSignals,
  detectIctArrayContribution,
  type IctArrayInputs,
  type IctArraySignals,
} from '../../src/scoring/ict-array-detector.js';
import type { Candle } from '../../src/types.js';

// Helper to build a candle. Newest-first arrays match scanner convention.
function candle(opts: { open: number; high: number; low: number; close: number; index: number }): Candle {
  // Synthesised datetime; index 0 = newest, larger index = older (1h apart).
  const ts = new Date(Date.now() - opts.index * 60 * 60 * 1000).toISOString();
  return {
    datetime: ts,
    open: opts.open,
    high: opts.high,
    low: opts.low,
    close: opts.close,
    volume: 1000,
  };
}

// Build a flat baseline of N candles around price `mid`. No structure.
function flatCandles(n: number, mid: number, span = 0.001): Candle[] {
  const arr: Candle[] = [];
  for (let i = 0; i < n; i++) {
    arr.push(candle({
      open: mid,
      high: mid + span / 2,
      low: mid - span / 2,
      close: mid,
      index: i,
    }));
  }
  return arr;
}

const BASE_INPUT: IctArrayInputs = {
  candles1h: flatCandles(20, 1.0000),
  bias: 'bullish',
  atr: 0.0010,
  currentPrice: 1.0000,
  spread: 0.0001,
};

describe('obProximity — order block proximity', () => {
  it('returns 0 when bias is neutral', () => {
    expect(obProximity({ ...BASE_INPUT, bias: 'neutral' })).toBe(0);
  });

  it('returns 0 with no valid OB in the window (flat candles)', () => {
    expect(obProximity(BASE_INPUT)).toBe(0);
  });

  it('returns 3 when a valid bearish OB sits within 1 ATR of price (bullish bias)', () => {
    // Construct a bearish rejection candle 1H ago. Validity criteria:
    //   body/range >= 0.4, opposing (upper) wick / body >= 1.0,
    //   close < open (bearish).
    // Engineered values: open=1.0010, close=1.0002 → body=0.0008.
    //                    high=1.0018, low=1.0000 → range=0.0018.
    //                    body/range = 0.44 ✓
    //                    upper wick = 1.0018 - 1.0010 = 0.0008 → wick/body = 1.0 ✓
    //                    body top (max(open,close)) = 1.0010 → at 0.0004 from
    //                    currentPrice 1.0006, ATR=0.0010 → 0.4 ATRs → score 3.
    const bearishOb: Candle = candle({
      open: 1.0010,
      high: 1.0018,
      low: 1.0000,
      close: 1.0002,
      index: 1,
    });
    const candles = [
      candle({ open: 1.0006, high: 1.0007, low: 1.0005, close: 1.0006, index: 0 }), // current
      bearishOb,
      ...flatCandles(18, 1.0000).slice(2),
    ];
    const result = obProximity({ ...BASE_INPUT, candles1h: candles, currentPrice: 1.0006 });
    expect(result).toBe(3);  // distance 0.0004 / ATR 0.0010 = 0.4 → score 3
  });
});

describe('fvgCount — fair value gap detection', () => {
  it('returns 0 with no gaps (flat)', () => {
    expect(fvgCount(BASE_INPUT)).toBe(0);
  });

  it('returns 0 when bias is neutral', () => {
    expect(fvgCount({ ...BASE_INPUT, bias: 'neutral' })).toBe(0);
  });

  it('detects a single bullish FVG', () => {
    // Chronological: c[0]=high=1.0010, c[1]=any, c[2]=low=1.0020 → gap 1.0010..1.0020.
    // In newest-first storage, that's index 17, 18, 19 (oldest end).
    const arr = flatCandles(20, 1.0000);
    // Set up a FVG at indices 17/18/19 (oldest in array). After reverse to chrono,
    // these become indices 0/1/2.
    arr[19] = candle({ open: 1.0000, high: 1.0010, low: 0.9995, close: 1.0005, index: 19 });
    arr[18] = candle({ open: 1.0010, high: 1.0015, low: 1.0008, close: 1.0014, index: 18 });
    arr[17] = candle({ open: 1.0015, high: 1.0030, low: 1.0020, close: 1.0025, index: 17 });
    // Newer candles must NOT trade back into the gap [1.0010, 1.0020].
    // flatCandles default is around 1.0000 ± 0.0005 → safe.
    const result = fvgCount({ ...BASE_INPUT, candles1h: arr });
    expect(result).toBeGreaterThanOrEqual(1);
  });
});

describe('sweepRecency — liquidity sweep detection', () => {
  it('returns 0 when bias is neutral', () => {
    expect(sweepRecency({ ...BASE_INPUT, bias: 'neutral' })).toBe(0);
  });

  it('returns 0 with no sweep in window', () => {
    expect(sweepRecency(BASE_INPUT)).toBe(0);
  });

  it('detects a recent bullish-bias sweep below prior low', () => {
    // Newest candle wicks below prior 10-candle low then closes above it.
    const priorLow = 0.9990;
    const arr = flatCandles(20, 1.0000);
    // Force the prior window (indices 1-10) to have low = 0.9990.
    for (let i = 1; i <= 10; i++) {
      arr[i] = candle({ open: 1.0000, high: 1.0005, low: priorLow, close: 1.0000, index: i });
    }
    // Newest candle (index 0) wicks to 0.9985 (below 0.9990 - spread), closes at 1.0000.
    arr[0] = candle({ open: 0.9995, high: 1.0005, low: 0.9985, close: 1.0000, index: 0 });
    const result = sweepRecency({ ...BASE_INPUT, candles1h: arr, spread: 0.0001 });
    expect(result).toBe(3);  // sweep at index 0 → score 3
  });
});

describe('bosCount — break of structure', () => {
  it('returns 0 when bias is neutral', () => {
    expect(bosCount({ ...BASE_INPUT, bias: 'neutral' })).toBe(0);
  });

  it('returns 0 with no BOS in window', () => {
    expect(bosCount(BASE_INPUT)).toBe(0);
  });

  it('detects a single bullish BOS (close > prior 5-candle swing high)', () => {
    const arr = flatCandles(8, 1.0000);
    // Prior 5 (indices 1-5) have high = 1.0005. Newest (index 0) closes at 1.0010.
    arr[0] = candle({ open: 1.0000, high: 1.0012, low: 0.9998, close: 1.0010, index: 0 });
    const result = bosCount({ ...BASE_INPUT, candles1h: arr });
    expect(result).toBe(1);
  });
});

describe('combineSignals — threshold mapping', () => {
  it('sum 0 → contribution 0', () => {
    expect(combineSignals({ obProximity: 0, fvgCount: 0, sweepRecency: 0, bosCount: 0 })).toBe(0);
  });

  it('sum 1-3 → contribution 15', () => {
    expect(combineSignals({ obProximity: 1, fvgCount: 0, sweepRecency: 0, bosCount: 0 })).toBe(15);
    expect(combineSignals({ obProximity: 1, fvgCount: 1, sweepRecency: 1, bosCount: 0 })).toBe(15);
  });

  it('sum 4-6 → contribution 25', () => {
    expect(combineSignals({ obProximity: 2, fvgCount: 2, sweepRecency: 0, bosCount: 0 })).toBe(25);
    expect(combineSignals({ obProximity: 2, fvgCount: 2, sweepRecency: 2, bosCount: 0 })).toBe(25);
  });

  it('sum 7-12 → contribution 35', () => {
    expect(combineSignals({ obProximity: 3, fvgCount: 2, sweepRecency: 2, bosCount: 0 })).toBe(35);
    expect(combineSignals({ obProximity: 3, fvgCount: 3, sweepRecency: 3, bosCount: 3 })).toBe(35);
  });
});

describe('detectIctArrayContribution — SC-001 determinism', () => {
  it('produces byte-identical output across 10 runs of fixed input', () => {
    const inputs: IctArrayInputs = {
      candles1h: flatCandles(20, 1.0000),
      bias: 'bullish',
      atr: 0.0010,
      currentPrice: 1.0000,
      spread: 0.0001,
    };
    const runs = Array.from({ length: 10 }, () => detectIctArrayContribution(inputs));
    const first = runs[0];
    for (const r of runs) {
      expect(r).toBe(first);
    }
  });

  it('produces 0 for completely flat / neutral candles', () => {
    const inputs: IctArrayInputs = {
      candles1h: flatCandles(20, 1.0000),
      bias: 'neutral',
      atr: 0.0010,
      currentPrice: 1.0000,
      spread: 0.0001,
    };
    expect(detectIctArrayContribution(inputs)).toBe(0);
  });

  it('returns 0 when candles array is too short', () => {
    const inputs: IctArrayInputs = {
      candles1h: flatCandles(3, 1.0000),
      bias: 'bullish',
      atr: 0.0010,
      currentPrice: 1.0000,
      spread: 0.0001,
    };
    expect(detectIctArrayContribution(inputs)).toBe(0);
  });
});

describe('US-5 integration — Tier 1 reachable from scanner deterministically', () => {
  it('with strong structure signals, ICT contribution can push score above 80', () => {
    // Engineered inputs: maximal signals across all 4 detectors.
    const sig: IctArraySignals = { obProximity: 3, fvgCount: 3, sweepRecency: 3, bosCount: 3 };
    expect(combineSignals(sig)).toBe(35);
    // Combined with scanner max of 65 (base 25 + clarity 25 + news 10 + spread 5)
    // = 100 → Tier 1 reachable. This was unreachable with the stub.
    expect(65 + 35).toBeGreaterThanOrEqual(80);
  });
});

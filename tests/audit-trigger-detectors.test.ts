import { describe, it, expect } from 'vitest';
import { buildPerInstrumentMatrix } from '../scripts/audit-trigger-decisions.js';

describe('buildPerInstrumentMatrix', () => {
  it('returns per-instrument confusion-matrix breakdown', () => {
    const cycles = [
      { ticker: 'GOLD', triggerConfirmedLLM: 'no' as const, anyTriggerMath: false },
      { ticker: 'GOLD', triggerConfirmedLLM: 'no' as const, anyTriggerMath: false },
      { ticker: 'EURUSD', triggerConfirmedLLM: 'yes' as const, anyTriggerMath: true },
      { ticker: 'OIL_CRUDE', triggerConfirmedLLM: 'no' as const, anyTriggerMath: true }, // FN
    ];
    const matrix = buildPerInstrumentMatrix(cycles);
    expect(matrix.GOLD).toEqual({ tp: 0, tn: 2, fp: 0, fn: 0 });
    expect(matrix.EURUSD).toEqual({ tp: 1, tn: 0, fp: 0, fn: 0 });
    expect(matrix.OIL_CRUDE).toEqual({ tp: 0, tn: 0, fp: 0, fn: 1 });
  });

  it('excludes unknown LLM verdicts from the matrix', () => {
    const cycles = [
      { ticker: 'GOLD', triggerConfirmedLLM: 'unknown' as const, anyTriggerMath: true },
      { ticker: 'EURUSD', triggerConfirmedLLM: 'yes' as const, anyTriggerMath: true },
    ];
    const matrix = buildPerInstrumentMatrix(cycles);
    expect(matrix.GOLD).toBeUndefined();
    expect(matrix.EURUSD).toEqual({ tp: 1, tn: 0, fp: 0, fn: 0 });
  });
});

import { checkDisplacementContinuation, type DcParams } from '../scripts/_displacement-backtest.js';

describe('checkDisplacementContinuation (via audit-script integration path)', () => {
  it('is importable from the backtest script (Task 14 integration)', () => {
    expect(typeof checkDisplacementContinuation).toBe('function');
  });

  it('returns qualifies:true on a canonical Displacement-only fixture', () => {
    const params: DcParams = { X: 0.4, Y: 1.0, Z: 0.6, n: 2 };
    // 14 prior "flat" candles for ATR-of-bodies baseline (body=0.003)
    // Higher highs to avoid criterion-8 (sweep) tripping
    const atrBodyCandles14 = Array(14).fill({
      open: 1.090, high: 1.110, low: 1.088, close: 1.093,
    });
    // Prior bullish candle (consecutive close)
    const priorBullishCandle = { open: 1.095, high: 1.111, low: 1.094, close: 1.100 };
    // Latest qualifying bullish candle:
    // body = 0.009, range = 0.011, body/range = 0.82 → passes X=0.4
    // close-position = (1.109 - 1.099) / 0.011 = 0.91 → passes Z=0.6
    // body / ATR-bodies ≈ 0.009 / 0.003 = 3.0 → passes Y=1.0
    const goodBullishCandle = { open: 1.100, high: 1.110, low: 1.099, close: 1.109 };
    const sequence = [...atrBodyCandles14, priorBullishCandle, goodBullishCandle];
    const result = checkDisplacementContinuation(sequence, 'bullish', params, 0.0001);
    expect(result.qualifies).toBe(true);
  });
});

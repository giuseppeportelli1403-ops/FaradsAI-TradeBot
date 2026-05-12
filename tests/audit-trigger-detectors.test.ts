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

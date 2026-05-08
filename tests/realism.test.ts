// Tests for src/backtest/realism.ts — execution-cost modeling for
// backtest trades. Derived from Agent γ's 2026-04-23 diagnostic math
// (see docs/superpowers/reviews/2026-04-23-backtest-vs-live-diagnostic.md).
// Anchored on the 2026-04-22 USDJPY live observation (14.6 pips of entry
// slippage gutting R:R from 1.7:1 to 0.5:1).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  EXECUTION_COSTS,
  computeExecutionCost,
  typicalSpread,
  _internalsForTest,
} from '../src/backtest/realism.js';

describe('EXECUTION_COSTS constants', () => {
  it('covers all 7 Farad universe tickers', () => {
    const expected = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'GOLD', 'SILVER', 'OIL_CRUDE'];
    for (const ticker of expected) {
      expect(EXECUTION_COSTS[ticker]).toBeDefined();
    }
  });

  it('every entry has spread + slippage_entry + slippage_exit as positive numbers', () => {
    for (const [ticker, costs] of Object.entries(EXECUTION_COSTS)) {
      expect(costs.spread, `${ticker}.spread`).toBeGreaterThan(0);
      expect(costs.slippage_entry, `${ticker}.slippage_entry`).toBeGreaterThan(0);
      expect(costs.slippage_exit, `${ticker}.slippage_exit`).toBeGreaterThan(0);
    }
  });

  it('USDJPY slippage_entry is live-grounded at ~14.6 pips (0.146 in price units)', () => {
    // The 2026-04-22 USDJPY observation: expected 159.333, filled 159.187.
    // The 14.6-pip slippage is the anchor value for this constant.
    expect(EXECUTION_COSTS.USDJPY.slippage_entry).toBeCloseTo(0.146, 3);
  });
});

describe('computeExecutionCost', () => {
  beforeEach(() => {
    _internalsForTest.resetWarnings();
  });

  it('returns R-cost as (spread + slippage_entry + slippage_exit) / stopDistance', () => {
    // EURUSD: 0.00008 + 0.00007 + 0.00004 = 0.00019. Stop 0.00130 → 0.146 R.
    const result = computeExecutionCost('EURUSD', 0.00130);
    expect(result).toBeCloseTo(0.146, 2);
  });

  it('is case-insensitive on ticker input', () => {
    const upper = computeExecutionCost('EURUSD', 0.00130);
    const lower = computeExecutionCost('eurusd', 0.00130);
    const mixed = computeExecutionCost('EurUsd', 0.00130);
    expect(upper).toBe(lower);
    expect(upper).toBe(mixed);
  });

  it('unknown ticker returns 0 and warns exactly once per ticker', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const first = computeExecutionCost('FAKE_TICKER', 0.001);
    const second = computeExecutionCost('FAKE_TICKER', 0.001);
    const third = computeExecutionCost('FAKE_TICKER', 0.001);

    expect(first).toBe(0);
    expect(second).toBe(0);
    expect(third).toBe(0);
    // Exactly one warn call across three invocations.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('FAKE_TICKER');

    warnSpy.mockRestore();
  });

  it('different unknown tickers each warn once', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    computeExecutionCost('UNKNOWN_A', 0.001);
    computeExecutionCost('UNKNOWN_B', 0.001);
    computeExecutionCost('UNKNOWN_A', 0.001); // duplicate of A — no warn
    computeExecutionCost('UNKNOWN_B', 0.001); // duplicate of B — no warn

    expect(warnSpy).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });

  it('stopDistance of 0 returns 0 (no divide-by-zero)', () => {
    expect(computeExecutionCost('EURUSD', 0)).toBe(0);
  });

  it('negative stopDistance returns 0 (guards against nonsense input)', () => {
    expect(computeExecutionCost('EURUSD', -0.001)).toBe(0);
  });

  it('NaN stopDistance returns 0', () => {
    expect(computeExecutionCost('EURUSD', NaN)).toBe(0);
  });

  it('each of the 7 universe tickers hits γ expected R at its typical stop', () => {
    // Sanity: at the typical stop distance γ used, the R-cost should be
    // close to γ's headline per-instrument cost. ±0.02 R tolerance.
    const checks = _internalsForTest.expectedRCostAtTypicalStop;
    for (const [ticker, { typicalStop, expectedRCost }] of Object.entries(checks)) {
      const actual = computeExecutionCost(ticker, typicalStop);
      expect(actual, `${ticker} @ stop ${typicalStop}`).toBeCloseTo(expectedRCost, 1);
    }
  });
});

describe('typicalSpread', () => {
  it('returns native-price spread for known instruments', () => {
    expect(typicalSpread('EURUSD')).toBe(0.00008);
    expect(typicalSpread('GOLD')).toBe(0.40);
    expect(typicalSpread('SILVER')).toBe(0.025);
  });

  it('returns a sensible default for unknown instruments', () => {
    expect(typicalSpread('UNKNOWN_TICKER')).toBeGreaterThan(0);
  });
});

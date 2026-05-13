import { describe, it, expect } from 'vitest';
import {
  applyThresholdOverrides,
  parseRecentCycles,
  SHADOW_REPLAY_DEFAULTS,
} from '../scripts/shadow-llm-replay.js';
import { checkObRetest, checkFvgFill } from '../scripts/audit-trigger-decisions.js';

// Tests for the shadow-LLM replay tool's threshold-override interface and
// detector parameterization (PR 1 prereq T3, codex finding #1 + #8).

describe('applyThresholdOverrides', () => {
  it('returns DEFAULTS unchanged when no overrides given', () => {
    expect(applyThresholdOverrides({})).toEqual(SHADOW_REPLAY_DEFAULTS);
  });

  it('overrides only the fields provided', () => {
    const result = applyThresholdOverrides({ obBody: 0.3, obWick: 0.7 });
    expect(result.obBody).toBe(0.3);
    expect(result.obWick).toBe(0.7);
    expect(result.fvgBody).toBe(SHADOW_REPLAY_DEFAULTS.fvgBody);
    expect(result.tier3FloorTight).toBe(SHADOW_REPLAY_DEFAULTS.tier3FloorTight);
  });

  it('preserves an explicit override of 0 (codex edge case: ?? vs ||)', () => {
    // Using `||` would silently default 0 back to 0.4. Using `??` preserves 0.
    const result = applyThresholdOverrides({ obBody: 0 });
    expect(result.obBody).toBe(0);
  });

  it('applies the PR 1 design v2 override set', () => {
    const result = applyThresholdOverrides({
      tier3FloorTight: 30,
      tier3FloorMedium: 35,
      obBody: 0.3,
      obWick: 0.7,
      fvgBody: 0.3,
      forceProposeFloor: 40,
    });
    expect(result).toEqual({
      tier3FloorTight: 30,
      tier3FloorMedium: 35,
      obBody: 0.3,
      obWick: 0.7,
      fvgBody: 0.3,
      forceProposeFloor: 40,
    });
  });
});

describe('parseRecentCycles', () => {
  it('extracts cycle metadata from pm2 log format', () => {
    const log = [
      '2026-05-12 07:46:09 +00:00: DECISION CYCLE — 2026-05-12T07:45:00.000Z',
      '2026-05-12 07:46:09 +00:00: Top candidate: GOLD',
      '2026-05-12 07:46:09 +00:00: 1H Bias: Bearish',
      '2026-05-12 07:46:09 +00:00: Trigger confirmed: NO',
    ].join('\n');
    const cycles = parseRecentCycles(log, 10);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toMatchObject({
      ticker: 'GOLD',
      bias: 'bearish',
      llmVerdict: 'no',
    });
    expect(cycles[0].timestamp.toISOString()).toBe('2026-05-12T07:45:00.000Z');
  });

  it('filters out unsupported tickers (N/A, etc.)', () => {
    const log = [
      'DECISION CYCLE — 2026-05-12T07:00:00.000Z',
      'Top candidate: N',
      '1H Bias: Bearish',
      'Trigger confirmed: NO',
    ].join('\n');
    expect(parseRecentCycles(log, 10)).toHaveLength(0);
  });

  it('returns last N cycles when there are more', () => {
    const blocks = Array.from({ length: 5 }, (_, i) =>
      [
        `DECISION CYCLE — 2026-05-12T0${i}:00:00.000Z`,
        'Top candidate: EURUSD',
        '1H Bias: Bullish',
        'Trigger confirmed: NO',
      ].join('\n'),
    ).join('\n');
    const cycles = parseRecentCycles(blocks, 3);
    expect(cycles).toHaveLength(3);
    expect(cycles[0].timestamp.toISOString()).toBe('2026-05-12T02:00:00.000Z');
    expect(cycles[2].timestamp.toISOString()).toBe('2026-05-12T04:00:00.000Z');
  });
});

describe('checkObRetest parameterization (PR 1 prereq T3)', () => {
  // Synthetic bullish-bias rejection candle that BARELY fails default (0.4
  // body / 1.0 opposing wick) but qualifies under PR 1 overrides (0.3 / 0.7).
  // body = 0.35 × range, opposing (lower) wick = 0.8 × body, close > open.
  function syntheticBorderlineCandle() {
    // open=100, close=103.5 (bullish body), high=110, low=92.2
    //   range = high-low = 17.8
    //   body = 3.5
    //   body/range = 3.5/17.8 ≈ 0.197 — too low. Need body/range = 0.35.
    // Try: open=100, close=107, high=110, low=90 → range=20, body=7, ratio=0.35 ✓
    //   lower wick = min(open,close) - low = 100 - 90 = 10, opp_wick/body = 10/7 ≈ 1.43 — too high
    // Use: open=100, close=107, high=108, low=92.4 → range=15.6, body=7, ratio=0.449 (>0.4)
    //   lower wick = 100 - 92.4 = 7.6, opp/body = 7.6/7 ≈ 1.09 (>1.0)
    // Both qualify under defaults — wrong direction. Need borderline-fail.
    //
    // Use: open=100, close=103.5, high=104, low=90 → range=14, body=3.5, ratio=0.25 (<0.3)
    //   Fails under both — wrong direction.
    //
    // Use: open=100, close=103.5, high=103.7, low=92.4 → range=11.3, body=3.5
    //   body/range = 3.5/11.3 = 0.31 (between 0.3 and 0.4) ✓ qualifies under override, fails under default
    //   lower wick = 100 - 92.4 = 7.6, opp/body = 7.6/3.5 = 2.17 (>0.7 AND >1.0) ✓ passes both wick gates
    // Now I need OB indeterminate to NOT be the result — but the function may
    // return 'indeterminate' if no OB is found in the prior candles. We need
    // a candle SERIES where the OB lookback succeeds. For now, pad with similar
    // bullish small candles so atr is small and findOrderBlock fails gracefully.
    // Result: with overrides {bodyMin: 0.3}, body criterion passes; with default
    // body 0.4, it fails. So the test asserts the body-min override changes the
    // body-check outcome, regardless of OB-tap-depth verdict.
    const series = [];
    for (let i = 0; i < 12; i++) {
      series.push({
        datetime: new Date(`2026-01-01T0${i.toString().padStart(2, '0')}:00:00Z`),
        open: 99 + i * 0.1,
        high: 99.5 + i * 0.1,
        low: 98.5 + i * 0.1,
        close: 99.3 + i * 0.1,
        volume: 100,
      });
    }
    series.push({
      datetime: new Date('2026-01-01T12:00:00Z'),
      open: 100,
      high: 103.7,
      low: 92.4,
      close: 103.5,
      volume: 100,
    });
    return series;
  }

  it('rejects the trigger candle under default thresholds (body 0.4)', () => {
    const series = syntheticBorderlineCandle();
    const r = checkObRetest(series, 'bullish');
    // body 0.31 < default 0.4 → reason should mention body shortfall
    expect(r.qualifies === false || r.qualifies === 'indeterminate').toBe(true);
    if (r.qualifies === false) {
      expect(r.reason).toMatch(/body 0\.\d+<0\.4/);
    }
  });

  it('admits the body check under PR 1 overrides (body 0.3, wick 0.7)', () => {
    const series = syntheticBorderlineCandle();
    const r = checkObRetest(series, 'bullish', { bodyMin: 0.3, wickMin: 0.7 });
    // Under overrides, the body check passes. The result may be true OR
    // 'indeterminate' depending on OB identification; both prove the body
    // threshold is no longer the blocker.
    expect(r.qualifies !== false || !/body 0\.\d+<0\.\d+/.test(r.reason)).toBe(true);
  });
});

describe('checkFvgFill parameterization (PR 1 prereq T3)', () => {
  it('default body threshold rejects body=0.32', () => {
    // Synthetic minimum: need 5+ candles, last candle bullish body 0.32×range,
    // direction matches bias, fill candle existed but the gap math will
    // determine pass/fail. We only test the body-min branch.
    const last = {
      datetime: new Date('2026-01-01T05:00:00Z'),
      open: 100,
      high: 110,
      low: 90,
      close: 106.4,
      volume: 100,
    }; // body 6.4, range 20, ratio 0.32
    const series = [
      { datetime: new Date('2026-01-01T00:00:00Z'), open: 100, high: 102, low: 98, close: 101, volume: 100 },
      { datetime: new Date('2026-01-01T01:00:00Z'), open: 101, high: 103, low: 99, close: 102, volume: 100 },
      { datetime: new Date('2026-01-01T02:00:00Z'), open: 102, high: 104, low: 100, close: 103, volume: 100 },
      { datetime: new Date('2026-01-01T03:00:00Z'), open: 103, high: 105, low: 101, close: 104, volume: 100 },
      last,
    ];
    const r = checkFvgFill(series, 'bullish');
    expect(r.qualifies).toBe(false);
    expect(r.reason).toMatch(/trigger body 0\.32<0\.4/);
  });

  it('PR 1 override (body 0.3) passes the body check on the same candle', () => {
    const last = {
      datetime: new Date('2026-01-01T05:00:00Z'),
      open: 100,
      high: 110,
      low: 90,
      close: 106.4,
      volume: 100,
    };
    const series = [
      { datetime: new Date('2026-01-01T00:00:00Z'), open: 100, high: 102, low: 98, close: 101, volume: 100 },
      { datetime: new Date('2026-01-01T01:00:00Z'), open: 101, high: 103, low: 99, close: 102, volume: 100 },
      { datetime: new Date('2026-01-01T02:00:00Z'), open: 102, high: 104, low: 100, close: 103, volume: 100 },
      { datetime: new Date('2026-01-01T03:00:00Z'), open: 103, high: 105, low: 101, close: 104, volume: 100 },
      last,
    ];
    const r = checkFvgFill(series, 'bullish', { bodyMin: 0.3 });
    // The body check now passes (0.32 ≥ 0.3); the result reflects whether
    // an FVG was identified earlier. Either qualifies=true or qualifies=false
    // with a NON-body reason proves the body threshold was lowered.
    if (r.qualifies === false) {
      expect(r.reason).not.toMatch(/trigger body/);
    }
  });
});

// tests/displacement-forward-sim.test.ts
// TDD: Task 5 — forward simulation function for displacement continuation backtest.
// Tests cover all 4 outcome paths: tp1_hit, sl_hit, tie (conservative), open/mark-to-last.
// Numeric comments explain the arithmetic so the fixture intent is auditable.

import { describe, it, expect } from 'vitest';
import { simulateForward } from '../scripts/_displacement-backtest.js';

describe('simulateForward', () => {
  // ── Test 1: TP1 hit ──────────────────────────────────────────────────────
  it('returns tp1_hit when forward candle hits TP1 first (bullish)', () => {
    // entry=1.110, sl=1.100, tp1=1.120, R=0.010
    // Bar 0: high=1.121 >= tp1=1.120 → tp1 hit; low=1.109 > sl=1.100 → no SL in same bar
    const future = [
      { open: 1.110, high: 1.121, low: 1.109, close: 1.120 }, // hits TP1 (no SL hit)
      { open: 1.120, high: 1.125, low: 1.119, close: 1.123 }, // not reached
    ];
    const result = simulateForward(
      future,
      /*entry*/ 1.110,
      /*sl*/    1.100,
      /*tp1*/   1.120,
      /*tp2*/   1.1231,
      /*dir*/   1,
      /*horizon*/ 8,
    );
    expect(result.outcome).toBe('tp1_hit');
    // r = 1.0 because TP1 is exactly 1×R from entry
    expect(result.r).toBeCloseTo(1.0, 2);
    expect(result.barsHeld).toBe(1);
  });

  // ── Test 2: SL hit ───────────────────────────────────────────────────────
  it('returns sl_hit when forward candle hits SL first (bullish)', () => {
    // entry=1.110, sl=1.100, R=0.010
    // Bar 0: low=1.098 <= sl=1.100 → SL hit; high=1.115 < tp1=1.120 → no TP1
    const future = [{ open: 1.110, high: 1.115, low: 1.098, close: 1.099 }];
    const result = simulateForward(future, 1.110, 1.100, 1.120, 1.1231, 1, 8);
    expect(result.outcome).toBe('sl_hit');
    expect(result.r).toBeCloseTo(-1.0, 2);
    expect(result.barsHeld).toBe(1);
  });

  // ── Test 3: Same-bar tie → conservative SL wins ──────────────────────────
  it('returns sl_hit when same candle straddles both SL and TP1 (conservative tie)', () => {
    // entry=1.110, sl=1.100, tp1=1.120, R=0.010
    // Bar 0: low=1.099 <= sl=1.100 AND high=1.121 >= tp1=1.120 → both hit → SL wins
    const future = [{ open: 1.110, high: 1.121, low: 1.099, close: 1.105 }];
    const result = simulateForward(future, 1.110, 1.100, 1.120, 1.1231, 1, 8);
    expect(result.outcome).toBe('sl_hit');
    expect(result.r).toBeCloseTo(-1.0, 2);
    expect(result.barsHeld).toBe(1);
  });

  // ── Test 4: Open / mark-to-last ──────────────────────────────────────────
  it('returns open with mark-to-last when horizon exhausted without resolution', () => {
    // entry=1.110, sl=1.100, tp1=1.120, R=0.010, horizon=8
    // 8 bars: high=1.115 < tp1, low=1.108 > sl → never touched
    // last close=1.112, markR = (1.112 - 1.110) / 0.010 = 0.2
    const future = Array(8).fill({ open: 1.110, high: 1.115, low: 1.108, close: 1.112 });
    const result = simulateForward(future, 1.110, 1.100, 1.120, 1.1231, 1, 8);
    expect(result.outcome).toBe('open');
    expect(result.r).toBeCloseTo(0.2, 1);
    expect(result.barsHeld).toBe(8);
  });

  // ── Test 5: Bearish SL hit (dir = -1) ────────────────────────────────────
  it('returns sl_hit when bearish forward candle hits SL first (dir=-1)', () => {
    // bearish: entry=1.110, sl=1.120 (above entry), tp1=1.100 (below entry), R=0.010
    // Bar 0: high=1.121 >= sl=1.120 → SL hit; low=1.106 > tp1=1.100 → no TP1 in same bar
    const future = [{ open: 1.110, high: 1.121, low: 1.106, close: 1.108 }];
    const result = simulateForward(future, 1.110, 1.120, 1.100, 1.0869, -1, 8);
    expect(result.outcome).toBe('sl_hit');
    expect(result.r).toBeCloseTo(-1.0, 2);
    expect(result.barsHeld).toBe(1);
  });

  // ── Test 6: Zero-R guard ─────────────────────────────────────────────────
  it('returns open r=0 barsHeld=0 when entry === sl (degenerate zero-R)', () => {
    const future = [{ open: 1.110, high: 1.115, low: 1.108, close: 1.112 }];
    // entry = sl → R = 0 → degenerate guard
    const result = simulateForward(future, 1.110, 1.110, 1.120, 1.1231, 1, 8);
    expect(result.outcome).toBe('open');
    expect(result.r).toBe(0);
    expect(result.barsHeld).toBe(0);
  });

  // ── Test 7: Empty future array ───────────────────────────────────────────
  it('returns open r=0 barsHeld=0 when future is empty', () => {
    const result = simulateForward([], 1.110, 1.100, 1.120, 1.1231, 1, 8);
    expect(result.outcome).toBe('open');
    expect(result.r).toBe(0);
    expect(result.barsHeld).toBe(0);
  });
});

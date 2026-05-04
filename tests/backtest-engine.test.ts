// Tests for the backtest engine rewrite (Phase B, 2026-05-04 audit Finding #3).
//
// Pre-fix the engine implemented the 2026-04-22 obsolete strategy:
//   - TP1=2R, TP2=3R, TP3=4R (current docs: TP1=1R, TP2≥2R, TP3≥3R)
//   - Tier 3 floor=50 (current: 40 post-Phase-E; was 45 post-Phase-B)
//   - Bias clarity scale 0/10/20 (current rubric: 0/15/20/25)
//   - Kill zone as score component +15/+5 (current: hard gate, not scored)
//   - No range-mode path (skipped neutral bias entirely)
//   - getKillZone had London Close starting 15:00, overlapping NY Open 13-16
//
// This test file pins the post-2026-04-29 strategy behavior. The backtest
// is 1H-only and cannot model the 15M trigger logic — see comment in
// engine.ts about range-mode being skipped (honest under-count vs false
// approximation).

import { describe, it, expect } from 'vitest';
import {
  computeScore,
  assignTier,
  getKillZone,
} from '../src/backtest/engine.js';

describe('computeScore — post-2026-04-29 rebalanced rubric', () => {
  it('clean bullish bias (clarity 20→25) on tight-spread instrument: 25 + 25 + 0 + 0 + 5 = 55', () => {
    expect(computeScore({ rawClarity: 20, spreadTight: true })).toBe(55);
  });

  it('moderate bullish bias (clarity 15→20) on tight-spread: 25 + 20 + 5 = 50', () => {
    expect(computeScore({ rawClarity: 15, spreadTight: true })).toBe(50);
  });

  it('weak bullish bias (clarity 10→15) on tight-spread: 25 + 15 + 5 = 45', () => {
    expect(computeScore({ rawClarity: 10, spreadTight: true })).toBe(45);
  });

  it('zero clarity on tight-spread: 25 + 0 + 5 = 30 (below floor)', () => {
    expect(computeScore({ rawClarity: 0, spreadTight: true })).toBe(30);
  });

  it('clean bias on medium-spread (no spread bonus): 25 + 25 = 50', () => {
    expect(computeScore({ rawClarity: 20, spreadTight: false })).toBe(50);
  });

  it('does NOT add a kill-zone bonus (kill zone is now a hard gate, not score)', () => {
    // The pre-fix engine added +15 for inKillZone, +5 outside. Now removed.
    // Same rawClarity + spread should yield same score regardless of kill-zone
    // input — and the function shouldn't take that param at all.
    const a = computeScore({ rawClarity: 20, spreadTight: true });
    const b = computeScore({ rawClarity: 20, spreadTight: true });
    expect(a).toBe(b);
    expect(a).toBe(55);
  });

  it('caps at 100', () => {
    // Theoretical max with all positive components: 25 + 25 + 5 = 55.
    // News in backtest is always 0 (no historical news). ICT array is 0 too
    // (backtest doesn't model ICT structure). So actual cap is 55, well
    // below 100. The Math.min(100) is defensive.
    expect(computeScore({ rawClarity: 20, spreadTight: true })).toBeLessThanOrEqual(100);
  });
});

describe('assignTier — post-2026-04-22 floor', () => {
  it('score 80+ → Tier 1', () => {
    expect(assignTier(80)).toBe(1);
    expect(assignTier(95)).toBe(1);
    expect(assignTier(100)).toBe(1);
  });

  it('score 60-79 → Tier 2', () => {
    expect(assignTier(60)).toBe(2);
    expect(assignTier(70)).toBe(2);
    expect(assignTier(79)).toBe(2);
  });

  it('score 40-59 → Tier 3', () => {
    expect(assignTier(40)).toBe(3);
    expect(assignTier(45)).toBe(3);
    expect(assignTier(50)).toBe(3);
    expect(assignTier(59)).toBe(3);
  });

  it('score 39 → null (below floor)', () => {
    expect(assignTier(39)).toBeNull();
  });

  it('score 0 → null', () => {
    expect(assignTier(0)).toBeNull();
  });

  it('uses the Phase-E 40 floor (history: 50 → 45 → 40)', () => {
    // Pre-2026-04-22 Tier 3 was 50-59; pre-Phase-E it was 45-59;
    // post-Phase-E (2026-05-04) it is 40-59.
    expect(assignTier(40)).toBe(3);
    expect(assignTier(41)).toBe(3);
    expect(assignTier(44)).toBe(3);
  });
});

describe('getKillZone — post-2026-04-29 overlap fix', () => {
  // Live scanner has London Close starting 16:00 (not 15:00) to avoid the
  // 15:00-16:00 overlap with NY Open. The backtest must mirror.

  it('07:00–09:59 UTC → London Open', () => {
    expect(getKillZone('2026-05-04T07:00:00Z').zone).toBe('London Open');
    expect(getKillZone('2026-05-04T08:30:00Z').zone).toBe('London Open');
    expect(getKillZone('2026-05-04T09:59:00Z').zone).toBe('London Open');
  });

  it('13:00–15:59 UTC → NY Open', () => {
    expect(getKillZone('2026-05-04T13:00:00Z').zone).toBe('NY Open');
    expect(getKillZone('2026-05-04T14:30:00Z').zone).toBe('NY Open');
    expect(getKillZone('2026-05-04T15:59:00Z').zone).toBe('NY Open');
  });

  it('15:00 UTC is NY Open (not London Close — overlap fix)', () => {
    // Pre-fix: 15:00-16:00 was double-counted, first match (NY Open) won.
    // The live scanner explicitly fixed this 2026-04-29 by starting London
    // Close at 16:00. Backtest must agree.
    expect(getKillZone('2026-05-04T15:00:00Z').zone).toBe('NY Open');
    expect(getKillZone('2026-05-04T15:30:00Z').zone).toBe('NY Open');
  });

  it('16:00–16:59 UTC → London Close', () => {
    expect(getKillZone('2026-05-04T16:00:00Z').zone).toBe('London Close');
    expect(getKillZone('2026-05-04T16:30:00Z').zone).toBe('London Close');
    expect(getKillZone('2026-05-04T16:59:00Z').zone).toBe('London Close');
  });

  it('17:00 UTC and beyond → outside', () => {
    expect(getKillZone('2026-05-04T17:00:00Z').inKillZone).toBe(false);
    expect(getKillZone('2026-05-04T18:00:00Z').inKillZone).toBe(false);
    expect(getKillZone('2026-05-04T22:00:00Z').inKillZone).toBe(false);
  });

  it('00:00–06:59 UTC → outside', () => {
    expect(getKillZone('2026-05-04T03:00:00Z').inKillZone).toBe(false);
    expect(getKillZone('2026-05-04T06:59:00Z').inKillZone).toBe(false);
  });

  it('10:00–12:59 UTC (London/NY gap) → outside', () => {
    expect(getKillZone('2026-05-04T10:00:00Z').inKillZone).toBe(false);
    expect(getKillZone('2026-05-04T11:30:00Z').inKillZone).toBe(false);
    expect(getKillZone('2026-05-04T12:59:00Z').inKillZone).toBe(false);
  });
});

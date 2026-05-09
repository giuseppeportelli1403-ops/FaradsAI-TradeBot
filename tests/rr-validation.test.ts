// Tests for the R:R floor validator added 2026-05-04 (Phase A1, doc-vs-code
// audit Finding #2) and refactored 2026-05-07 (Phase 2 — 2-TP restructure).
//
// Floors (universal across all modes/tiers/spread classes):
//   TP1 ≥ 1.0R
//   TP2 ≥ 1.3R   — UNIVERSAL (was 1.5R / 2.0R per-mode pre-Phase-2)
//
// `tier`, `ticker`, `isRangeMode` are kept on the input shape for forward-
// compatibility with future per-mode rules and to keep the proposal contract
// stable, but they no longer affect the floors.
//
// The validator is a pure function — no side effects, no async, no DB.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  validateRRFloor,
  isTightSpreadTicker,
  validateOrderSide,
  validateRiskPct,
  computeServerSizing,
} from '../src/agents/trading-agent.js';

describe('isTightSpreadTicker', () => {
  it('returns true for EURUSD, GBPUSD, USDJPY, AUDUSD, GOLD', () => {
    expect(isTightSpreadTicker('EURUSD')).toBe(true);
    expect(isTightSpreadTicker('GBPUSD')).toBe(true);
    expect(isTightSpreadTicker('USDJPY')).toBe(true);
    expect(isTightSpreadTicker('AUDUSD')).toBe(true);
    expect(isTightSpreadTicker('GOLD')).toBe(true);
  });

  it('returns false for SILVER and OIL_CRUDE (medium spread)', () => {
    expect(isTightSpreadTicker('SILVER')).toBe(false);
    expect(isTightSpreadTicker('OIL_CRUDE')).toBe(false);
  });

  it('returns false for unknown tickers', () => {
    expect(isTightSpreadTicker('BTCUSD')).toBe(false);
    expect(isTightSpreadTicker('')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isTightSpreadTicker('eurusd')).toBe(true);
    expect(isTightSpreadTicker('Gold')).toBe(true);
  });
});

describe('validateRRFloor — universal floors (post-2026-05-07 2-TP restructure)', () => {
  // Long EURUSD example: entry 1.1000, SL 1.0980 (20-pip risk)
  // TP1 at 1:1 = 1.1020, TP2 at 1.3:1 = 1.1026
  const longBase = {
    direction: 'long' as const,
    entry: 1.1000,
    sl: 1.0980,
    tp1: 1.1020,    // 1.0R — exactly at TP1 floor
    tp2: 1.1026,    // 1.3R — exactly at TP2 floor
    isRangeMode: false,
  };

  it('accepts a clean Tier 1 trade with R:R 1.0/1.3 on tight-spread instrument', () => {
    const result = validateRRFloor({
      ...longBase,
      tier: 1,
      ticker: 'EURUSD',
    });
    expect(result.ok).toBe(true);
  });

  it('accepts a clean Tier 2 trade with R:R 1.0/1.3 on tight-spread instrument', () => {
    const result = validateRRFloor({
      ...longBase,
      tier: 2,
      ticker: 'EURUSD',
    });
    expect(result.ok).toBe(true);
  });

  it('accepts a Tier 3 trade with R:R 1.0/1.3 on medium-spread instrument', () => {
    // Pre-restructure this would have required TP2 ≥ 2.0 on SILVER T3.
    // Post-restructure: universal 1.3R floor across all spread classes.
    const result = validateRRFloor({
      ...longBase,
      tier: 3,
      ticker: 'SILVER',
    });
    expect(result.ok).toBe(true);
  });

  it('accepts TP1 just at the 1.0R floor (boundary case)', () => {
    // TP1 at exactly 1.0R = 1.1020
    const result = validateRRFloor({
      ...longBase,
      tp1: 1.1020,
      tier: 1,
      ticker: 'EURUSD',
    });
    expect(result.ok).toBe(true);
  });

  it('rejects TP1 just below the 1.0R floor (boundary case, R:R 0.95)', () => {
    // TP1 at 0.95R = 1.1019
    const result = validateRRFloor({
      ...longBase,
      tp1: 1.1019,
      tier: 1,
      ticker: 'EURUSD',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('RR_FLOOR_VIOLATION');
      expect(result.reason).toMatch(/TP1/);
    }
  });

  it('accepts TP2 just at the 1.3R floor (boundary case)', () => {
    // TP2 at exactly 1.3R = 1.1026
    const result = validateRRFloor({
      ...longBase,
      tp2: 1.1026,
      tier: 1,
      ticker: 'EURUSD',
    });
    expect(result.ok).toBe(true);
  });

  it('rejects TP2 just below the 1.3R floor (boundary case, R:R ~1.2)', () => {
    // TP2 at 1.2R = 1.1024
    const result = validateRRFloor({
      ...longBase,
      tp2: 1.1024,
      tier: 1,
      ticker: 'EURUSD',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('RR_FLOOR_VIOLATION');
      expect(result.reason).toMatch(/TP2/);
    }
  });

  it('accepts TP1 at 1.2:1 (the "breathing room" case from strategy.md)', () => {
    // TP1 at 1.2R = 1.1024
    const result = validateRRFloor({
      ...longBase,
      tp1: 1.1024,
      tp2: 1.1030,    // bump TP2 to ~1.5R so it stays above floor
      tier: 1,
      ticker: 'EURUSD',
    });
    expect(result.ok).toBe(true);
  });

  it('accepts TP2 above the floor (R:R 2.0 — was the old trend-mode floor)', () => {
    // Demonstrates that proposals built under the OLD floors still pass.
    const result = validateRRFloor({
      ...longBase,
      tp2: 1.1040,    // 2.0R
      tier: 1,
      ticker: 'EURUSD',
    });
    expect(result.ok).toBe(true);
  });

  it('rejects TP1 R:R 0.8 (clearly below floor)', () => {
    // TP1 at 0.8R = 1.1016
    const result = validateRRFloor({
      ...longBase,
      tp1: 1.1016,
      tier: 1,
      ticker: 'EURUSD',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('RR_FLOOR_VIOLATION');
      expect(result.reason).toMatch(/TP1/);
    }
  });

  it('handles short trades correctly (mirrored math)', () => {
    // Short EURUSD: entry 1.1000, SL 1.1020 (20-pip risk above)
    // TP1 at 1:1 = 1.0980, TP2 at 1.3:1 = 1.0974
    const result = validateRRFloor({
      direction: 'short',
      entry: 1.1000,
      sl: 1.1020,
      tp1: 1.0980,
      tp2: 1.0974,
      tier: 1,
      ticker: 'EURUSD',
      isRangeMode: false,
    });
    expect(result.ok).toBe(true);
  });

  it('range-mode uses the same universal 1.3R floor (no per-mode variation post-restructure)', () => {
    // Same R:R as trend-mode case — pre-restructure range-mode TP2 floor was
    // 1.5R, now it's 1.3R like everything else.
    const result = validateRRFloor({
      direction: 'long',
      entry: 1.1000,
      sl: 1.0980,
      tp1: 1.1020,    // 1:1
      tp2: 1.1026,    // 1.3:1
      tier: 3,
      ticker: 'EURUSD',
      isRangeMode: true,
    });
    expect(result.ok).toBe(true);
  });

  it('range-mode also rejects TP2 below the universal 1.3R floor', () => {
    // TP2 at 1.2R = 1.1024 — below the universal floor
    const result = validateRRFloor({
      direction: 'long',
      entry: 1.1000,
      sl: 1.0980,
      tp1: 1.1020,
      tp2: 1.1024,
      tier: 3,
      ticker: 'EURUSD',
      isRangeMode: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('RR_FLOOR_VIOLATION');
      expect(result.reason).toMatch(/TP2/);
    }
  });

  it('SILVER (medium-spread) range-mode trade — same universal floor applies', () => {
    // Pre-restructure tight-spread carve-out is gone; SILVER and EURUSD
    // both use the 1.3R floor on TP2.
    const result = validateRRFloor({
      direction: 'long',
      entry: 25.00,
      sl: 24.80,
      tp1: 25.20,    // 1:1
      tp2: 25.26,    // 1.3:1
      tier: 3,
      ticker: 'SILVER',
      isRangeMode: true,
    });
    expect(result.ok).toBe(true);
  });
});

describe('validateRRFloor — edge cases', () => {
  it('returns ok:false with INVALID_RISK if entry equals sl (zero risk)', () => {
    const result = validateRRFloor({
      direction: 'long',
      entry: 1.1000,
      sl: 1.1000,
      tp1: 1.1020,
      tp2: 1.1026,
      tier: 1,
      ticker: 'EURUSD',
      isRangeMode: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('INVALID_RISK');
    }
  });

  it('returns INVALID_RISK on non-finite risk (NaN entry/sl)', () => {
    const result = validateRRFloor({
      direction: 'long',
      entry: NaN,
      sl: 1.0980,
      tp1: 1.1020,
      tp2: 1.1026,
      tier: 1,
      ticker: 'EURUSD',
      isRangeMode: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('INVALID_RISK');
    }
  });

  it('reports the violating leg in the reason field', () => {
    // Both TPs below floor — reason should be human-readable and mention TP1
    // (the first failing leg).
    const result = validateRRFloor({
      direction: 'long',
      entry: 1.1000,
      sl: 1.0980,
      tp1: 1.1010,    // 0.5R, below 1.0
      tp2: 1.1015,    // 0.75R, below 1.3
      tier: 1,
      ticker: 'EURUSD',
      isRangeMode: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('RR_FLOOR_VIOLATION');
      // Must mention at least one TP and the actual ratio
      expect(result.reason).toMatch(/TP\d/);
    }
  });
});

describe('validateOrderSide — pre-analyst geometric sanity (2026-05-05, post-2026-05-07 2-TP)', () => {
  // Background: the 2026-05-04 08:31 UTC live failure was a GOLD SHORT
  // proposal with SL=4575 < entry=4576.29 and TPs above entry — geometrically
  // impossible. The analyst rightly rejected it but its long rejection prose
  // truncated the JSON output, dropping the analyst's parse rate to 0/6
  // for ~6 days. This validator catches the malformed proposal BEFORE the
  // analyst LLM call so neither the wasted API spend nor the truncation-
  // by-verbose-rejection cascade can happen.
  //
  // 2026-05-07: tp3 dropped from the input shape (2-TP restructure).

  it('long with correct ordering passes', () => {
    expect(validateOrderSide({
      direction: 'long', entry: 1.10, sl: 1.09, tp1: 1.11, tp2: 1.12,
    }).ok).toBe(true);
  });

  it('long with SL above entry fails', () => {
    const r = validateOrderSide({
      direction: 'long', entry: 1.10, sl: 1.11, tp1: 1.12, tp2: 1.13,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/long.*sl<entry/i);
  });

  it('long with TPs below entry fails', () => {
    const r = validateOrderSide({
      direction: 'long', entry: 1.10, sl: 1.09, tp1: 1.08, tp2: 1.07,
    });
    expect(r.ok).toBe(false);
  });

  it('long with TPs out of order fails (tp2 < tp1)', () => {
    const r = validateOrderSide({
      direction: 'long', entry: 1.10, sl: 1.09, tp1: 1.13, tp2: 1.12,
    });
    expect(r.ok).toBe(false);
  });

  it('short with correct ordering passes', () => {
    expect(validateOrderSide({
      direction: 'short', entry: 1.10, sl: 1.11, tp1: 1.09, tp2: 1.08,
    }).ok).toBe(true);
  });

  it('short with inverted geometry fails (the 2026-05-04 GOLD case)', () => {
    const r = validateOrderSide({
      direction: 'short', entry: 4576.29, sl: 4575.00, tp1: 4577.58, tp2: 4578.87,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/short/i);
      expect(r.reason).toContain('4576.29');
    }
  });

  it('rejects equal levels (degenerate)', () => {
    const r = validateOrderSide({
      direction: 'long', entry: 1.10, sl: 1.10, tp1: 1.11, tp2: 1.12,
    });
    expect(r.ok).toBe(false);
  });

  it('rejects non-finite numbers', () => {
    const r = validateOrderSide({
      direction: 'long', entry: NaN, sl: 1.09, tp1: 1.11, tp2: 1.12,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/finite/i);
  });

  it('rejects non-finite TP', () => {
    const r = validateOrderSide({
      direction: 'short', entry: 1.10, sl: 1.11, tp1: 1.09, tp2: Infinity,
    });
    expect(r.ok).toBe(false);
  });
});

describe('validateRiskPct — tolerance tightened from ±0.05 to ±0.005 (audit A1)', () => {
  // Background: pre-2026-05-05, tolerance was ±0.05 absolute. Tier 3
  // range-mode expected 0.25% so 0.20-0.30% was accepted. At 0.30% the
  // trade takes 20% more risk than intended; multiplied across 3 legs
  // the daily kill-switch trips at 6.67% loss instead of -6%. Tighter
  // tolerance prevents that drift.

  it('accepts exact match for range-mode 0.25%', () => {
    expect(validateRiskPct({ riskPct: 0.25, expectedRiskPct: 0.25 }).ok).toBe(true);
  });

  it('accepts exact match for Tier 3 0.5%, Tier 2 1.0%, Tier 1 1.5%', () => {
    expect(validateRiskPct({ riskPct: 0.5, expectedRiskPct: 0.5 }).ok).toBe(true);
    expect(validateRiskPct({ riskPct: 1.0, expectedRiskPct: 1.0 }).ok).toBe(true);
    expect(validateRiskPct({ riskPct: 1.5, expectedRiskPct: 1.5 }).ok).toBe(true);
  });

  it('rejects 0.30% on range-mode (was: accepted, the 20% overage bug)', () => {
    const r = validateRiskPct({ riskPct: 0.30, expectedRiskPct: 0.25 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/0.005/);
  });

  it('rejects 0.20% on range-mode (under-sizing also rejected)', () => {
    expect(validateRiskPct({ riskPct: 0.20, expectedRiskPct: 0.25 }).ok).toBe(false);
  });

  it('accepts 0.254% on range-mode (well within ±0.005)', () => {
    expect(validateRiskPct({ riskPct: 0.254, expectedRiskPct: 0.25 }).ok).toBe(true);
  });

  it('rejects 0.26% on range-mode (clearly outside ±0.005)', () => {
    expect(validateRiskPct({ riskPct: 0.26, expectedRiskPct: 0.25 }).ok).toBe(false);
  });

  it('absorbs IEEE 754 float artefacts on common decimal arithmetic', () => {
    // 0.1 + 0.15 = 0.24999999999999997 — still within tolerance
    expect(validateRiskPct({ riskPct: 0.1 + 0.15, expectedRiskPct: 0.25 }).ok).toBe(true);
    // 0.5 / 2 = 0.25 exactly in IEEE 754; sanity check
    expect(validateRiskPct({ riskPct: 0.5 / 2, expectedRiskPct: 0.25 }).ok).toBe(true);
  });

  it('rejects non-finite riskPct or expectedRiskPct', () => {
    expect(validateRiskPct({ riskPct: NaN, expectedRiskPct: 0.25 }).ok).toBe(false);
    expect(validateRiskPct({ riskPct: 0.25, expectedRiskPct: Infinity }).ok).toBe(false);
  });
});

// ==================== computeServerSizing — tick-aware 70/30 (2026-05-07 Codex follow-up) ====================
// The Phase 2 follow-up moves leg sizing to the server. The LLM no longer
// computes size_a / size_b — the server derives them deterministically from
// (balance, total_risk_pct, entry, sl, minDealSize). Codex flagged that as
// the deploy blocker on commit 840fa8d. These tests pin the formula and the
// tick-rounding behavior across the universe of tick rules we actually see
// on Capital.com (FX majors min 1000, GOLD min 0.1, SILVER min 0.5).

/**
 * Assert that `value` is an integer multiple of `tick`, robust to IEEE 754
 * representation error. Cannot use `value % tick === 0` because
 * `7.4 % 0.1 = 0.09999999...` even though 7.4 IS 74 ticks of 0.1 — modulo
 * on doubles propagates the representation error of `0.1` itself. The
 * correct check is: ticks-as-float should round cleanly to an integer.
 */
function expectTickAligned(value: number, tick: number): void {
  const ticks = value / tick;
  const rounded = Math.round(ticks);
  // 1e-6 tolerance: any drift larger than this means the value isn't a
  // tick multiple (i.e. the algorithm produced something Capital would
  // reject). Realistic IEEE 754 noise on these magnitudes is ~1e-12.
  expect(Math.abs(ticks - rounded)).toBeLessThan(1e-6);
}

describe('computeServerSizing — tick-aware 70/30 leg split', () => {
  // 2026-05-07 (Codex Round 2 — Finding #7 fix): integer-tick math. Both
  // legs are exact multiples of minDealSize. Algorithm:
  //   total_ticks  = floor(total_qty / minDealSize + 1e-9)
  //   size_b_ticks = floor(total_ticks * 0.30)
  //   size_a_ticks = total_ticks - size_b_ticks
  //   size_a       = size_a_ticks * minDealSize
  //   size_b       = size_b_ticks * minDealSize
  // The 1e-9 epsilon absorbs IEEE 754 noise on clean inputs (e.g. 1000 ×
  // 1% / 0.0020 produces 4999.999... arithmetically; without epsilon it
  // would floor to 4 ticks not 5, undersizing by a full tick).

  describe('FX majors (minDealSize = 1000 contracts)', () => {
    it('$1000 × 1% × 0.0020 SL → total 5000 = 5 ticks → size_a=4000, size_b=1000', () => {
      const r = computeServerSizing({
        balance: 1000,
        totalRiskPct: 1.0,
        entry: 1.1000,
        sl: 1.0980,
        minDealSize: 1000,
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.totalQty).toBeCloseTo(5000, 6);
        // 5 ticks total, size_b = floor(5 * 0.30) = 1 tick = 1000
        expect(r.sizeB).toBe(1000);
        // size_a = 5 - 1 = 4 ticks = 4000
        expect(r.sizeA).toBe(4000);
        // Both legs tick-aligned (the BLOCKER fix from Round 2)
        expectTickAligned(r.sizeA, 1000);
        expectTickAligned(r.sizeB, 1000);
        // Total placed (sum of legs) does not exceed totalQty — rounding loss
        // is at most 1 tick.
        expect(r.sizeA + r.sizeB).toBeLessThanOrEqual(r.totalQty + 1e-6);
      }
    });

    it('total_qty 5333.33 → 5 ticks → size_a=4000, size_b=1000 (rounding loss 333)', () => {
      // total_qty = (10000 * 0.01) / 0.01875 ≈ 5333.33; floor to 5 ticks.
      // size_b_ticks = floor(5*0.30) = 1; size_a_ticks = 4.
      const r = computeServerSizing({
        balance: 10000,
        totalRiskPct: 1.0,
        entry: 1.1000,
        sl: 1.08125,
        minDealSize: 1000,
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.totalQty).toBeCloseTo(5333.33, 1);
        expect(r.sizeB).toBe(1000);
        expect(r.sizeA).toBe(4000);
        expect(r.sizeA + r.sizeB).toBeLessThanOrEqual(r.totalQty + 1e-6);
      }
    });

    it('rejects when total_qty floors to <2 ticks (account too small)', () => {
      // $100 × 1% × 0.0020 SL → total 500. floor(500/1000) = 0 ticks.
      const r = computeServerSizing({
        balance: 100,
        totalRiskPct: 1.0,
        entry: 1.1000,
        sl: 1.0980,
        minDealSize: 1000,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toBe('BELOW_MIN_SIZE');
        expect(r.reason).toMatch(/2 tick/);
      }
    });
  });

  describe('GOLD (minDealSize = 0.1)', () => {
    it('total_qty 10.0 → 100 ticks → size_a=7.0, size_b=3.0 (both tick-aligned)', () => {
      // $5000 × 1% × $5 SL → total qty = 10.0. totalTicks = 100.
      // size_b_ticks = floor(100 * 0.30) = 30 → size_b = 3.0
      // size_a_ticks = 70 → size_a = 7.0
      const r = computeServerSizing({
        balance: 5000,
        totalRiskPct: 1.0,
        entry: 4500,
        sl: 4495,
        minDealSize: 0.1,
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.totalQty).toBeCloseTo(10, 6);
        expect(r.sizeB).toBeCloseTo(3.0, 6);
        expect(r.sizeA).toBeCloseTo(7.0, 6);
        // BLOCKER regression: BOTH legs are integer multiples of 0.1.
        // (Pre-fix Leg A absorbed the raw remainder and could land on
        // 7.45 — a non-tick-aligned size that Capital REJECTS.)
        expectTickAligned(r.sizeA, 0.1);
        expectTickAligned(r.sizeB, 0.1);
      }
    });

    it('total_qty 10.55 → 105 ticks → size_a=7.4, size_b=3.1 (NOT 7.45 + 3.1, the BLOCKER case)', () => {
      // total_qty = 10.55. totalTicks = floor(10.55 / 0.1 + 1e-9) = 105
      // size_b_ticks = floor(105 * 0.30) = 31 → size_b = 3.1
      // size_a_ticks = 74 → size_a = 7.4
      // Total placed = 7.4 + 3.1 = 10.5 — rounding loss = 0.05 (acceptable)
      // Pre-fix algorithm: sizeB=3.1, sizeA = totalQty - sizeB = 7.45 ← BLOCKER.
      // 7.45 is NOT a multiple of 0.1 (7.45/0.1 = 74.5 ticks, not integer).
      const r = computeServerSizing({
        balance: 5275,
        totalRiskPct: 1.0,
        entry: 4500,
        sl: 4495,
        minDealSize: 0.1,
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.totalQty).toBeCloseTo(10.55, 6);
        expect(r.sizeB).toBeCloseTo(3.1, 6);
        expect(r.sizeA).toBeCloseTo(7.4, 6);
        // The critical regression assertion — both legs MUST be tick-aligned.
        expectTickAligned(r.sizeA, 0.1);
        expectTickAligned(r.sizeB, 0.1);
        // Rounding loss is acceptable: total placed ≤ totalQty.
        expect(r.sizeA + r.sizeB).toBeLessThanOrEqual(r.totalQty + 1e-6);
        // And it's at most 1 tick of loss.
        expect(r.totalQty - (r.sizeA + r.sizeB)).toBeLessThan(0.1 + 1e-6);
      }
    });
  });

  describe('SILVER (minDealSize = 0.5)', () => {
    it('total_qty 25.0 → 50 ticks → size_a=17.5, size_b=7.5 (both tick-aligned)', () => {
      // $1000 × 0.5% × 0.20 SL → total = 25.0. totalTicks = 50.
      // size_b_ticks = floor(50*0.30) = 15 → size_b = 7.5
      // size_a_ticks = 35 → size_a = 17.5
      const r = computeServerSizing({
        balance: 1000,
        totalRiskPct: 0.5,
        entry: 25.00,
        sl: 24.80,
        minDealSize: 0.5,
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.totalQty).toBeCloseTo(25, 6);
        expect(r.sizeB).toBeCloseTo(7.5, 6);
        expect(r.sizeA).toBeCloseTo(17.5, 6);
        expectTickAligned(r.sizeA, 0.5);
        expectTickAligned(r.sizeB, 0.5);
      }
    });

    it('total_qty 26.0 → 52 ticks → size_a=18.5, size_b=7.5 (size_b floors to 15 ticks)', () => {
      // total_qty = 26.0. totalTicks = 52. size_b_ticks = floor(52*0.30) = 15.
      // size_a_ticks = 37 → size_a = 18.5. size_b = 7.5.
      // Pre-fix: sizeB=7.5, sizeA=26-7.5=18.5 — happens to be tick-aligned
      // here (18.5 / 0.5 = 37 ticks integer) so this case looked OK pre-fix.
      // The GOLD test above is the canonical BLOCKER demonstration.
      const r = computeServerSizing({
        balance: 1040,
        totalRiskPct: 0.5,
        entry: 25.00,
        sl: 24.80,
        minDealSize: 0.5,
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.totalQty).toBeCloseTo(26, 6);
        expect(r.sizeB).toBeCloseTo(7.5, 6);
        expect(r.sizeA).toBeCloseTo(18.5, 6);
        expectTickAligned(r.sizeA, 0.5);
        expectTickAligned(r.sizeB, 0.5);
      }
    });
  });

  describe('tick-alignment invariant — every successful result has tick-aligned legs (BLOCKER regression guard)', () => {
    // Codex Round 2 Finding #7 / required test #6: explicit assertion that
    // the deploy-blocker scenario can never recur. This sweep tries a range
    // of inputs across all three universe tick sizes and asserts both legs
    // are integer multiples of minDealSize, AND total placed never exceeds
    // totalQty (rounding loss only ever LOSES ticks, never gains them).
    const cases = [
      // FX majors (1000)
      { balance: 1000,  riskPct: 1.0,  entry: 1.1000, sl: 1.0980,  minDealSize: 1000 },
      { balance: 5000,  riskPct: 1.5,  entry: 1.1000, sl: 1.0950,  minDealSize: 1000 },
      { balance: 10000, riskPct: 1.0,  entry: 1.1000, sl: 1.08125, minDealSize: 1000 },
      // GOLD (0.1) — the canonical BLOCKER case
      { balance: 5000,  riskPct: 1.0,  entry: 4500,   sl: 4495,    minDealSize: 0.1 },
      { balance: 5275,  riskPct: 1.0,  entry: 4500,   sl: 4495,    minDealSize: 0.1 },
      { balance: 8000,  riskPct: 1.5,  entry: 4500,   sl: 4493,    minDealSize: 0.1 },
      // SILVER (0.5)
      { balance: 1000,  riskPct: 0.5,  entry: 25.00,  sl: 24.80,   minDealSize: 0.5 },
      { balance: 1040,  riskPct: 0.5,  entry: 25.00,  sl: 24.80,   minDealSize: 0.5 },
      { balance: 2500,  riskPct: 0.25, entry: 25.00,  sl: 24.85,   minDealSize: 0.5 },
      // OIL_CRUDE-shaped (also 0.5) with 0.04 stop
      { balance: 3000,  riskPct: 1.0,  entry: 75.00,  sl: 74.96,   minDealSize: 0.5 },
    ];
    for (const c of cases) {
      it(`tick-aligned: balance=${c.balance} riskPct=${c.riskPct} stop=${(Math.abs(c.entry-c.sl)).toFixed(5)} minDealSize=${c.minDealSize}`, () => {
        const r = computeServerSizing({
          balance: c.balance,
          totalRiskPct: c.riskPct,
          entry: c.entry,
          sl: c.sl,
          minDealSize: c.minDealSize,
        });
        expect(r.ok).toBe(true);
        if (r.ok) {
          // BOTH legs are integer multiples of minDealSize. We can't use the
          // `%` operator directly — IEEE 754 makes `7.4 % 0.1 = 0.0999...`
          // even though 7.4 is exactly 74 ticks of 0.1. expectTickAligned
          // compares `value / minDealSize` to its nearest integer, which
          // is the correct test for tick-alignment under floating-point.
          expectTickAligned(r.sizeA, c.minDealSize);
          expectTickAligned(r.sizeB, c.minDealSize);
          // Total placed ≤ totalQty (rounding loss never gains ticks).
          expect(r.sizeA + r.sizeB).toBeLessThanOrEqual(r.totalQty + 1e-6);
          // Rounding loss bounded by 1 tick (actually less — we lose at
          // most fractional ticks from the totalTicks floor).
          expect(r.totalQty - (r.sizeA + r.sizeB)).toBeLessThan(c.minDealSize + 1e-6);
          // 30% leg never exceeds 30% of totalQty.
          expect(r.sizeB).toBeLessThanOrEqual(0.30 * r.totalQty + 1e-9);
          // Both legs ≥ 1 tick.
          expect(r.sizeA).toBeGreaterThanOrEqual(c.minDealSize);
          expect(r.sizeB).toBeGreaterThanOrEqual(c.minDealSize);
        }
      });
    }
  });

  describe('input validation', () => {
    it('rejects non-finite balance', () => {
      const r = computeServerSizing({
        balance: NaN,
        totalRiskPct: 1.0,
        entry: 1.1,
        sl: 1.098,
        minDealSize: 1000,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('INVALID_INPUT');
    });

    it('rejects non-finite totalRiskPct', () => {
      const r = computeServerSizing({
        balance: 1000,
        totalRiskPct: Infinity,
        entry: 1.1,
        sl: 1.098,
        minDealSize: 1000,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('INVALID_INPUT');
    });

    it('rejects zero / negative balance', () => {
      const r = computeServerSizing({
        balance: 0,
        totalRiskPct: 1.0,
        entry: 1.1,
        sl: 1.098,
        minDealSize: 1000,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('INVALID_INPUT');
    });

    it('rejects entry == sl (zero stop distance)', () => {
      const r = computeServerSizing({
        balance: 1000,
        totalRiskPct: 1.0,
        entry: 1.1,
        sl: 1.1,
        minDealSize: 1000,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toBe('INVALID_INPUT');
        expect(r.reason).toMatch(/stop distance/i);
      }
    });

    it('rejects non-positive minDealSize', () => {
      const r = computeServerSizing({
        balance: 1000,
        totalRiskPct: 1.0,
        entry: 1.1,
        sl: 1.098,
        minDealSize: 0,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('INVALID_INPUT');
    });

    it('shorts and longs produce identical sizes — direction does not matter', () => {
      // sizing depends only on |entry − sl|, not direction
      const longResult = computeServerSizing({
        balance: 1000, totalRiskPct: 1.0,
        entry: 1.1000, sl: 1.0980, minDealSize: 1000,
      });
      const shortResult = computeServerSizing({
        balance: 1000, totalRiskPct: 1.0,
        entry: 1.1000, sl: 1.1020, minDealSize: 1000,
      });
      expect(longResult.ok).toBe(true);
      expect(shortResult.ok).toBe(true);
      if (longResult.ok && shortResult.ok) {
        expect(longResult.sizeA).toBeCloseTo(shortResult.sizeA, 6);
        expect(longResult.sizeB).toBeCloseTo(shortResult.sizeB, 6);
      }
    });
  });
});

// 2026-05-05 (Audit defensive guard): assertUniverseSpreadConsistency
// catches the case where a future PR adds a ticker to the universe without
// updating the tight-spread carve-out classification.
import { assertUniverseSpreadConsistency } from '../src/agents/spread.js';
import { INSTRUMENT_UNIVERSE } from '../src/scanner/index.js';

describe('assertUniverseSpreadConsistency', () => {
  it('passes for the current INSTRUMENT_UNIVERSE (sanity)', () => {
    expect(() => assertUniverseSpreadConsistency(INSTRUMENT_UNIVERSE)).not.toThrow();
  });

  it('throws when a tight-spread carve-out ticker is misclassified as medium in universe', () => {
    const broken = [
      { ticker: 'EURUSD', spread_quality: 'medium' }, // should be 'tight'
    ];
    expect(() => assertUniverseSpreadConsistency(broken)).toThrow(/EURUSD/);
  });

  it('throws when a non-carve-out ticker is misclassified as tight in universe', () => {
    const broken = [
      { ticker: 'OIL_CRUDE', spread_quality: 'tight' }, // should be 'medium'
    ];
    expect(() => assertUniverseSpreadConsistency(broken)).toThrow(/OIL_CRUDE/);
  });

  it('throws on a hypothetical new universe entry not in TIGHT_SPREAD_TICKERS marked tight', () => {
    const broken = [
      { ticker: 'PLATINUM', spread_quality: 'tight' }, // ticker not in TIGHT_SPREAD_TICKERS set
    ];
    expect(() => assertUniverseSpreadConsistency(broken)).toThrow(/PLATINUM/);
  });

  it('passes when a new ticker is correctly classified as medium-spread', () => {
    const ok = [
      { ticker: 'EURUSD', spread_quality: 'tight' },
      { ticker: 'PLATINUM', spread_quality: 'medium' },
    ];
    expect(() => assertUniverseSpreadConsistency(ok)).not.toThrow();
  });

  it('error message lists ALL mismatches (not just the first)', () => {
    const broken = [
      { ticker: 'EURUSD', spread_quality: 'medium' },
      { ticker: 'OIL_CRUDE', spread_quality: 'tight' },
    ];
    try {
      assertUniverseSpreadConsistency(broken);
      throw new Error('should have thrown');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('EURUSD');
      expect(msg).toContain('OIL_CRUDE');
    }
  });
});

// 2026-05-05 audit (B3): critical-section tracking for shutdown drain.
import {
  enterCriticalSection,
  exitCriticalSection,
  getCriticalSectionDepth,
  withCriticalSection,
} from '../src/database/index.js';

describe('Critical-section tracking (B3 shutdown drain)', () => {
  // Ensure clean state — other tests in the suite may have entered without
  // exiting (shouldn't happen, but defensive).
  beforeEach(() => {
    while (getCriticalSectionDepth() > 0) exitCriticalSection();
  });

  it('counter starts at 0', () => {
    expect(getCriticalSectionDepth()).toBe(0);
  });

  it('enter/exit increments and decrements', () => {
    enterCriticalSection();
    expect(getCriticalSectionDepth()).toBe(1);
    enterCriticalSection();
    expect(getCriticalSectionDepth()).toBe(2);
    exitCriticalSection();
    expect(getCriticalSectionDepth()).toBe(1);
    exitCriticalSection();
    expect(getCriticalSectionDepth()).toBe(0);
  });

  it('exit clamps at 0 (cannot go negative)', () => {
    exitCriticalSection();
    exitCriticalSection();
    expect(getCriticalSectionDepth()).toBe(0);
  });

  it('withCriticalSection wrapper increments before fn and decrements after', async () => {
    expect(getCriticalSectionDepth()).toBe(0);
    const promise = withCriticalSection(async () => {
      expect(getCriticalSectionDepth()).toBe(1);
      return 'result';
    });
    const r = await promise;
    expect(r).toBe('result');
    expect(getCriticalSectionDepth()).toBe(0);
  });

  it('withCriticalSection decrements even when fn throws', async () => {
    await expect(
      withCriticalSection(async () => { throw new Error('boom'); }),
    ).rejects.toThrow('boom');
    expect(getCriticalSectionDepth()).toBe(0);
  });
});

// Tests for the R:R floor validator added 2026-05-04 (Phase A1, doc-vs-code
// audit Finding #2) and refactored 2026-05-07 (Phase 2 — 2-TP restructure).
//
// Pre-Phase-2 floors (per-mode / per-tier):
//   Trend-mode: TP1 ≥ 1, TP2 ≥ 2 (T1/T2) or ≥ 1.5 (T3 tight-spread), TP3 ≥ 3
//   Range-mode: TP1 ≥ 1, TP2 ≥ 1.5, TP3 ≥ 2
//
// Post-Phase-2 floors (universal across all modes/tiers/spread classes):
//   TP1 ≥ 1.0R   — same as before
//   TP2 ≥ 1.3R   — UNIVERSAL (lowered from 1.5R / 2.0R per-mode)
//   TP3 — REMOVED (the 3-leg ladder collapsed to 2 legs)
//
// `tier`, `ticker`, `isRangeMode` are kept on the input shape for forward-
// compatibility with future per-mode rules and to keep the proposal contract
// stable, but they no longer affect the floors.
//
// The validator is a pure function — no side effects, no async, no DB.

import { describe, it, expect, beforeEach } from 'vitest';
import { validateRRFloor, isTightSpreadTicker, validateOrderSide, validateRiskPct } from '../src/agents/trading-agent.js';

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

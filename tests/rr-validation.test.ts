// Tests for the R:R floor validator added 2026-05-04 (Phase A1, doc-vs-code
// audit Finding #2).
//
// Pre-fix, place_split_trade only validated order-side (sl<entry<tp1<tp2<tp3
// for longs, opposite for shorts) — there was NO check that the magnitudes
// of TPs respected the strategy's R:R minimums. A hallucinated proposal with
// TP1 1 pip past entry could pass every code gate. Strategy.md Section 7.3
// specifies:
//
//   Trend-mode (triggers 1-4):
//     TP1 ≥ 1:1 (de-risk leg, 1.2:1 acceptable)
//     TP2 ≥ 2:1 for Tier 1 & 2; ≥ 1.5:1 for Tier 3 on tight-spread only
//     TP3 ≥ 3:1
//
//   Range-mode (trigger 5):
//     TP1 ≥ 1:1, TP2 ≥ 1.5:1, TP3 ≥ 2:1
//
// Tight-spread instruments per memory/strategy.md Section 4:
//   EURUSD, GBPUSD, USDJPY, AUDUSD, GOLD
// Medium-spread:
//   SILVER, OIL_CRUDE
//
// The validator is a pure function — no side effects, no async, no DB.

import { describe, it, expect } from 'vitest';
import { validateRRFloor, isTightSpreadTicker } from '../src/agents/trading-agent.js';

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

describe('validateRRFloor — trend-mode (triggers 1-4)', () => {
  // Long EURUSD example: entry 1.1000, SL 1.0980 (20-pip risk)
  // TP1 at 1:1 = 1.1020, TP2 at 2:1 = 1.1040, TP3 at 3:1 = 1.1060
  const longBase = {
    direction: 'long' as const,
    entry: 1.1000,
    sl: 1.0980,
    tp1: 1.1020,
    tp2: 1.1040,
    tp3: 1.1060,
    isRangeMode: false,
  };

  it('accepts a clean Tier 1 trade with R:R 1/2/3 on tight-spread instrument', () => {
    const result = validateRRFloor({
      ...longBase,
      tier: 1,
      ticker: 'EURUSD',
    });
    expect(result.ok).toBe(true);
  });

  it('accepts a clean Tier 2 trade with R:R 1/2/3 on tight-spread instrument', () => {
    const result = validateRRFloor({
      ...longBase,
      tier: 2,
      ticker: 'EURUSD',
    });
    expect(result.ok).toBe(true);
  });

  it('rejects Tier 1 if TP2 R:R is 1.8 (below 2.0 floor)', () => {
    // TP2 at 1.8R = 1.1036 (instead of 1.1040 for 2.0R)
    const result = validateRRFloor({
      ...longBase,
      tp2: 1.1036,
      tier: 1,
      ticker: 'EURUSD',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('RR_FLOOR_VIOLATION');
      expect(result.reason).toMatch(/TP2/);
      expect(result.reason).toMatch(/2/);
    }
  });

  it('accepts Tier 3 on tight-spread with TP2 R:R 1.5 (allowed for tight-spread T3)', () => {
    // TP2 at 1.5R = 1.1030
    const result = validateRRFloor({
      ...longBase,
      tp2: 1.1030,
      tier: 3,
      ticker: 'EURUSD',
    });
    expect(result.ok).toBe(true);
  });

  it('rejects Tier 3 on MEDIUM-spread (SILVER) with TP2 R:R 1.5 (T3 medium needs 2.0)', () => {
    const result = validateRRFloor({
      ...longBase,
      tp2: 1.1030,
      tier: 3,
      ticker: 'SILVER',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('RR_FLOOR_VIOLATION');
      expect(result.reason).toMatch(/TP2/);
    }
  });

  it('rejects Tier 1 if TP1 R:R is 0.8 (below 1.0 floor)', () => {
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

  it('rejects Tier 1 if TP3 R:R is 2.5 (below 3.0 floor)', () => {
    // TP3 at 2.5R = 1.1050
    const result = validateRRFloor({
      ...longBase,
      tp3: 1.1050,
      tier: 1,
      ticker: 'EURUSD',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('RR_FLOOR_VIOLATION');
      expect(result.reason).toMatch(/TP3/);
    }
  });

  it('accepts TP1 at 1.2:1 (the "breathing room" case from strategy.md)', () => {
    // TP1 at 1.2R = 1.1024
    const result = validateRRFloor({
      ...longBase,
      tp1: 1.1024,
      tier: 1,
      ticker: 'EURUSD',
    });
    expect(result.ok).toBe(true);
  });

  it('handles short trades correctly (mirrored math)', () => {
    // Short EURUSD: entry 1.1000, SL 1.1020 (20-pip risk above)
    // TP1 at 1:1 = 1.0980, TP2 at 2:1 = 1.0960, TP3 at 3:1 = 1.0940
    const result = validateRRFloor({
      direction: 'short',
      entry: 1.1000,
      sl: 1.1020,
      tp1: 1.0980,
      tp2: 1.0960,
      tp3: 1.0940,
      tier: 1,
      ticker: 'EURUSD',
      isRangeMode: false,
    });
    expect(result.ok).toBe(true);
  });
});

describe('validateRRFloor — range-mode (trigger 5)', () => {
  // Range-mode floors: TP1 ≥ 1, TP2 ≥ 1.5, TP3 ≥ 2

  it('accepts range-mode with R:R 1/1.5/2', () => {
    const result = validateRRFloor({
      direction: 'long',
      entry: 1.1000,
      sl: 1.0980,
      tp1: 1.1020,    // 1:1
      tp2: 1.1030,    // 1.5:1
      tp3: 1.1040,    // 2:1
      tier: 3,
      ticker: 'EURUSD',
      isRangeMode: true,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects range-mode if TP3 R:R is 1.8 (below 2.0 floor)', () => {
    // TP3 at 1.8R = 1.1036 (instead of 1.1040 for 2.0R)
    const result = validateRRFloor({
      direction: 'long',
      entry: 1.1000,
      sl: 1.0980,
      tp1: 1.1020,
      tp2: 1.1030,
      tp3: 1.1036,
      tier: 3,
      ticker: 'EURUSD',
      isRangeMode: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('RR_FLOOR_VIOLATION');
      expect(result.reason).toMatch(/TP3/);
    }
  });

  it('rejects range-mode if TP2 R:R is 1.3 (below 1.5 floor)', () => {
    // TP2 at 1.3R = 1.1026
    const result = validateRRFloor({
      direction: 'long',
      entry: 1.1000,
      sl: 1.0980,
      tp1: 1.1020,
      tp2: 1.1026,
      tp3: 1.1040,
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

  it('range-mode does NOT apply tight-spread T3 carve-out (always uses range floors)', () => {
    // SILVER (medium spread) range-mode trade — same R:R requirements as
    // EURUSD range-mode. The tight-spread carve-out is a TREND-mode T3
    // concept; range-mode has its own floors that apply uniformly.
    const result = validateRRFloor({
      direction: 'long',
      entry: 25.00,
      sl: 24.80,
      tp1: 25.20,    // 1:1
      tp2: 25.30,    // 1.5:1
      tp3: 25.40,    // 2:1
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
      tp2: 1.1040,
      tp3: 1.1060,
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
    // All three TPs below floor — the validator should report at least
    // one of them, and the reason should be human-readable.
    const result = validateRRFloor({
      direction: 'long',
      entry: 1.1000,
      sl: 1.0980,
      tp1: 1.1010,    // 0.5R, below 1.0
      tp2: 1.1015,    // 0.75R, below 2.0
      tp3: 1.1020,    // 1R, below 3.0
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

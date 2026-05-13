// tests/tier3-floor.test.ts
//
// Regression test for the Tier 3 score-floor constants (PR 1 2026-05-12 — see
// docs/superpowers/specs/2026-05-12-trade-frequency-loosening-design.md).
//
// Before PR 1: tight-spread floor 40, medium-spread floor 45.
// After PR 1: tight-spread floor 30, medium-spread floor 35.
//
// This file is committed in the RED PHASE (T4) BEFORE the threshold change
// lands in src/agents/spread.ts (T5). Tests fail under current production
// values and pass once the green-phase commit lands.

import { describe, it, expect } from 'vitest';
import { tier3FloorFor } from '../src/agents/spread.js';

describe('tier3FloorFor (post-PR-1 loosening 2026-05-12)', () => {
  it('returns 30 for tight-spread FX majors', () => {
    expect(tier3FloorFor('EURUSD')).toBe(30);
    expect(tier3FloorFor('GBPUSD')).toBe(30);
    expect(tier3FloorFor('AUDUSD')).toBe(30);
    expect(tier3FloorFor('USDJPY')).toBe(30);
  });

  it('returns 30 for tight-spread GOLD', () => {
    expect(tier3FloorFor('GOLD')).toBe(30);
  });

  it('returns 35 for medium-spread commodities', () => {
    expect(tier3FloorFor('OIL_CRUDE')).toBe(35);
    expect(tier3FloorFor('SILVER')).toBe(35);
  });

  it('returns the medium-spread floor for unknown tickers (safety default)', () => {
    expect(tier3FloorFor('XAUEUR')).toBe(35); // unknown → defaults to medium
  });
});

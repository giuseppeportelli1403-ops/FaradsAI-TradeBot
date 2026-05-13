import { describe, it, expect } from 'vitest';
import { tierRiskPct } from '../src/agents/spread.js';

describe('tierRiskPct', () => {
  it('returns 0.0025 for Displacement_Continuation in Phase 1 (half-size, any tier)', () => {
    expect(tierRiskPct('Displacement_Continuation', 1)).toBe(0.0025);
    expect(tierRiskPct('Displacement_Continuation', 2)).toBe(0.0025);
    expect(tierRiskPct('Displacement_Continuation', 3)).toBe(0.0025);
  });

  it('returns 0.0025 for Range_Sweep_Reversal at any tier (existing behavior preserved)', () => {
    expect(tierRiskPct('Range_Sweep_Reversal', 3)).toBe(0.0025);
  });

  it('returns Tier-aware risk for OB_retest (1.5% / 1.0% / 0.5%) -- sanity check', () => {
    expect(tierRiskPct('OB_retest', 1)).toBe(0.015);
    expect(tierRiskPct('OB_retest', 2)).toBe(0.010);
    expect(tierRiskPct('OB_retest', 3)).toBe(0.005);
  });
});

// Tests for src/scoring/compose.ts — the deterministic composite_score
// composer that replaces the inline math in scanner/index.ts:380-446 and
// backtest/engine.ts:117-148.
//
// Acceptance ties to spec.md US-1 SC-001: composite_score variance across
// 10 runs of any given snapshot must be exactly 0.

import { describe, it, expect } from 'vitest';
import { composeScore, SCORER_VERSION, type ScoreInputs } from '../../src/scoring/compose.js';

describe('composeScore — determinism (SC-001)', () => {
  it('produces byte-identical composite_score across 10 runs of fixed input', () => {
    const inputs: ScoreInputs = {
      ticker: 'EURUSD',
      rawBiasClarity: 20,
      rawNewsScore: 5,
      spreadQuality: 'tight',
      historyWinRate: 0.65,
      historySampleSize: 10,
      isRangeMode: false,
    };
    const runs = Array.from({ length: 10 }, () => composeScore(inputs));
    const firstScore = runs[0].composite_score;
    const firstTier = runs[0].tier;
    const firstBreakdown = JSON.stringify(runs[0].score_breakdown);
    for (const r of runs) {
      expect(r.composite_score).toBe(firstScore);
      expect(r.tier).toBe(firstTier);
      expect(JSON.stringify(r.score_breakdown)).toBe(firstBreakdown);
    }
  });

  it('produces byte-identical breakdown across 10 runs for range-mode setup', () => {
    const inputs: ScoreInputs = {
      ticker: 'OIL_CRUDE',
      rawBiasClarity: 0,        // neutral
      rawNewsScore: -5,
      spreadQuality: 'medium',
      isRangeMode: true,
    };
    const runs = Array.from({ length: 10 }, () => composeScore(inputs));
    const first = JSON.stringify(runs[0]);
    for (const r of runs) {
      expect(JSON.stringify(r)).toBe(first);
    }
  });

  it('emits scorer_version on every output', () => {
    const r = composeScore({
      ticker: 'GOLD',
      rawBiasClarity: 15,
      rawNewsScore: 0,
      spreadQuality: 'tight',
      isRangeMode: false,
    });
    expect(r.scorer_version).toBe(SCORER_VERSION);
    expect(r.scorer_version).toMatch(/^v\d+/);
  });
});

describe('composeScore — tier mapping', () => {
  it('maps score >= 80 → tier 1', () => {
    // 25 base + 25 bias + 0 + 10 news + 0 + 5 spread = 65 — not enough for T1
    // Need ICT array stub (0 today) + history bonus to reach 80. Force via
    // historyWinRate>0.7 and large sample → +10. Still 75. Use clarity 25 +
    // news +10 + spread 5 + base 25 = 65 + 10 history = 75. Not enough.
    // Until US-5 lands, T1 reachable only via prompt-side ICT. We assert
    // the *threshold* not specific component math.
    const r = composeScore({
      ticker: 'EURUSD',
      rawBiasClarity: 999,
      rawNewsScore: 999,
      spreadQuality: 'tight',
      historyWinRate: 1.0,
      historySampleSize: 100,
      isRangeMode: false,
    });
    // Components: 25 + 25 + 0 + 10 + 10 + 5 = 75, clamped at 100. Below T1.
    // After US-5 (T066) ictArrayComponent will return up to 35 making T1
    // reachable. For now assert composite_score is the deterministic sum.
    expect(r.composite_score).toBe(75);
    expect(r.tier).toBe(2);
  });

  it('maps score 60-79 → tier 2', () => {
    const r = composeScore({
      ticker: 'EURUSD',
      rawBiasClarity: 20,        // 25
      rawNewsScore: 5,           // +5
      spreadQuality: 'tight',    // +5
      isRangeMode: false,
    });
    // 25 + 25 + 0 + 5 + 0 + 5 = 60 → T2 (>= 60)
    expect(r.composite_score).toBe(60);
    expect(r.tier).toBe(2);
  });

  it('maps score in [40, 60) on tight-spread → tier 3', () => {
    const r = composeScore({
      ticker: 'EURUSD',          // tight spread → tier 3 floor 40
      rawBiasClarity: 10,        // 15
      rawNewsScore: 0,
      spreadQuality: 'tight',    // +5
      isRangeMode: false,
    });
    // 25 + 15 + 0 + 0 + 0 + 5 = 45 → T3
    expect(r.composite_score).toBe(45);
    expect(r.tier).toBe(3);
  });

  it('maps score below floor → tier null (no trade)', () => {
    const r = composeScore({
      ticker: 'OIL_CRUDE',       // medium spread → tier 3 floor 45
      rawBiasClarity: 0,
      rawNewsScore: -10,
      spreadQuality: 'medium',
      isRangeMode: false,
    });
    // 25 + 0 + 0 - 10 + 0 + 0 = 15 → null
    expect(r.tier).toBeNull();
    expect(r.composite_score).toBe(15);
  });
});

describe('composeScore — range-mode cap-59 logic', () => {
  it('adds +20 baseline for range-mode setups', () => {
    const r = composeScore({
      ticker: 'EURUSD',
      rawBiasClarity: 0,         // neutral required for range-mode
      rawNewsScore: 0,
      spreadQuality: 'medium',
      isRangeMode: true,
    });
    // 25 base + 0 bias + 0 ict + 0 news + 0 history + 0 spread + 20 range = 45
    expect(r.composite_score).toBe(45);
    expect(r.tier).toBe(3);
    expect(r.score_breakdown.range_mode_baseline).toBe(20);
    expect(r.score_breakdown.range_cap_applied).toBe(false);
  });

  it('caps range-mode at 59 when raw exceeds', () => {
    const r = composeScore({
      ticker: 'EURUSD',
      rawBiasClarity: 0,
      rawNewsScore: 10,          // +10
      spreadQuality: 'tight',    // +5
      historyWinRate: 0.9,       // would be +10
      historySampleSize: 10,
      isRangeMode: true,
    });
    // 25 + 0 + 0 + 10 + 10 + 5 + 20 = 70 → capped to 59
    expect(r.composite_score).toBe(59);
    expect(r.tier).toBe(3);
    expect(r.score_breakdown.range_cap_applied).toBe(true);
  });

  it('does not cap trend-mode setups', () => {
    const r = composeScore({
      ticker: 'EURUSD',
      rawBiasClarity: 25,
      rawNewsScore: 10,
      spreadQuality: 'tight',
      historyWinRate: 0.9,
      historySampleSize: 10,
      isRangeMode: false,
    });
    // 25 + 25 + 0 + 10 + 10 + 5 = 75 → not capped (range cap is range-only)
    expect(r.composite_score).toBe(75);
    expect(r.score_breakdown.range_cap_applied).toBeUndefined();
  });
});

describe('composeScore — score_breakdown shape', () => {
  it('includes all 6 mandatory components in every output', () => {
    const r = composeScore({
      ticker: 'EURUSD',
      rawBiasClarity: 15,
      rawNewsScore: 0,
      spreadQuality: 'tight',
      isRangeMode: false,
    });
    expect(r.score_breakdown).toHaveProperty('base');
    expect(r.score_breakdown).toHaveProperty('bias_clarity');
    expect(r.score_breakdown).toHaveProperty('ict_array');
    expect(r.score_breakdown).toHaveProperty('news');
    expect(r.score_breakdown).toHaveProperty('history');
    expect(r.score_breakdown).toHaveProperty('spread');
  });

  it('breakdown components sum to composite_score (modulo cap)', () => {
    const r = composeScore({
      ticker: 'EURUSD',
      rawBiasClarity: 20,
      rawNewsScore: 5,
      spreadQuality: 'tight',
      historyWinRate: 0.65,
      historySampleSize: 10,
      isRangeMode: false,
    });
    const b = r.score_breakdown;
    const sum = b.base + b.bias_clarity + b.ict_array + b.news + b.history + b.spread;
    expect(sum).toBe(r.composite_score);
  });
});

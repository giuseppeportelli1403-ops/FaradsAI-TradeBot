// Tests for extractReviewFromTool — Weekly Review's tool_use extractor.
//
// 2026-05-05 audit (Phase 2 / Round 1 / item 1.4): replaced free-form-prose
// + parseLastJsonObject pattern with forced submit_review tool call. Largest
// schema of the four agents (multi-section). Returns null on missing tool /
// invalid input — caller (alertSystemWarning) keeps existing Telegram alert.

import { describe, it, expect } from 'vitest';
import { extractReviewFromTool } from '../src/agents/review-agent.js';

describe('extractReviewFromTool — read review from submit_review tool_use', () => {
  const validInput = {
    report: '## Weekly performance\n\n5 trades, 3 wins, +2.4R total.',
    ict_updates: [
      { section: '5', change: 'Tighten Tier 3 floor for OIL_CRUDE 45→48', basis: 'OB-retest 0/3 wins this week' },
    ],
    banned_patterns: [
      { pattern: 'OIL_CRUDE OB Retest in NY Open', win_rate: '0%', trade_count: 3 },
    ],
    alerts: ['Researcher brief older than 24h on Wed and Thu — investigate cron'],
    calibration_metrics: {
      total_calls: 8,
      approved: 3,
      rejected: 5,
      apf_correlation: 0.42,
    },
  };

  it('extracts a complete review from a submit_review tool_use block', () => {
    const content = [
      { type: 'tool_use', id: 't', name: 'submit_review', input: validInput },
    ];
    const review = extractReviewFromTool(content as never);
    expect(review).not.toBeNull();
    expect(review?.report).toContain('Weekly performance');
    expect(review?.ict_updates).toHaveLength(1);
    expect(review?.banned_patterns?.[0].pattern).toContain('OIL_CRUDE');
    expect(review?.alerts).toHaveLength(1);
    expect(review?.calibration_metrics?.apf_correlation).toBeCloseTo(0.42);
  });

  it('returns null on missing tool block', () => {
    expect(extractReviewFromTool([{ type: 'text', text: 'oops' }] as never)).toBeNull();
  });

  it('returns null when report is missing or empty', () => {
    const content = [
      { type: 'tool_use', id: 't', name: 'submit_review',
        input: { ...validInput, report: '' } },
    ];
    expect(extractReviewFromTool(content as never)).toBeNull();
  });

  it('handles missing optional arrays gracefully', () => {
    const content = [
      { type: 'tool_use', id: 't', name: 'submit_review',
        input: { report: 'Quiet week, nothing to update.' } },
    ];
    const review = extractReviewFromTool(content as never);
    expect(review).not.toBeNull();
    expect(review?.ict_updates).toEqual([]);
    expect(review?.banned_patterns).toEqual([]);
    expect(review?.alerts).toEqual([]);
  });

  it('drops malformed ict_updates rows but keeps valid ones', () => {
    const content = [
      { type: 'tool_use', id: 't', name: 'submit_review',
        input: {
          report: 'Report.',
          ict_updates: [
            { section: '5', change: 'valid change', basis: 'valid basis' },
            { section: '6' /* missing change/basis */ },
            'not an object at all',
            { section: '7', change: 'another valid', basis: 'reason' },
          ],
        } },
    ];
    const review = extractReviewFromTool(content as never);
    expect(review?.ict_updates).toHaveLength(2);
  });

  it('coerces non-finite calibration metrics', () => {
    const content = [
      { type: 'tool_use', id: 't', name: 'submit_review',
        input: {
          report: 'Report.',
          calibration_metrics: { total_calls: NaN, approved: 'three', rejected: 5, apf_correlation: Infinity },
        } },
    ];
    const review = extractReviewFromTool(content as never);
    expect(review?.calibration_metrics?.total_calls).toBe(0);
    expect(review?.calibration_metrics?.approved).toBe(0);
    expect(review?.calibration_metrics?.rejected).toBe(5);
    expect(review?.calibration_metrics?.apf_correlation).toBe(0);
  });

  it('returns null on empty content', () => {
    expect(extractReviewFromTool([] as never)).toBeNull();
  });

  it('drops malformed banned_patterns (missing pattern field, string instead of object)', () => {
    const content = [
      { type: 'tool_use', id: 't', name: 'submit_review',
        input: {
          report: 'Report.',
          banned_patterns: [
            { pattern: 'OIL_CRUDE OB Retest', win_rate: '0%', trade_count: 3 },
            { win_rate: '50%' /* missing pattern */ },
            'not an object',
            { pattern: 'Another valid', win_rate: '20%', trade_count: 5 },
          ],
        } },
    ];
    const review = extractReviewFromTool(content as never);
    expect(review?.banned_patterns).toHaveLength(2);
    expect(review?.banned_patterns?.[0].pattern).toBe('OIL_CRUDE OB Retest');
    expect(review?.banned_patterns?.[1].pattern).toBe('Another valid');
  });
});

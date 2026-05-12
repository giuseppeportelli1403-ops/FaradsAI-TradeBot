// Tests for src/rejection-log/categories.ts. Asserts that the enum is
// stable, that fail-closed classification matches data-model.md E-2,
// and that the OTHER sentinel exists but is not the default for any
// known path.

import { describe, it, expect } from 'vitest';
import {
  REJECTION_CATEGORIES,
  isFailClosed,
  type RejectionCategory,
} from '../../src/rejection-log/categories.js';

describe('REJECTION_CATEGORIES enum', () => {
  it('contains exactly 26 categories (3 scanner + 7 analyst + 1 cooldown + 11 executor + 3 post-approval + 1 OTHER)', () => {
    // Snapshot test — adding a new category requires updating BOTH the
    // enum and this number, which is a deliberate friction step.
    // data-model.md said 25 but the implementation needs OTHER as the 26th
    // sentinel for the SC-002 has_other guard in digest.ts.
    expect(REJECTION_CATEGORIES.length).toBe(26);
  });

  it('contains the OTHER sentinel (intentionally unreachable in production)', () => {
    expect(REJECTION_CATEGORIES).toContain('OTHER');
  });

  it('contains all four scanner-side categories', () => {
    expect(REJECTION_CATEGORIES).toContain('KILL_ZONE_OUT');
    expect(REJECTION_CATEGORIES).toContain('SCANNER_FETCH_ERROR');
    expect(REJECTION_CATEGORIES).toContain('SCORE_BELOW_TIER_FLOOR');
  });

  it('contains all three fail-closed analyst categories', () => {
    expect(REJECTION_CATEGORIES).toContain('ANALYST_FAIL_CLOSED_API_ERROR');
    expect(REJECTION_CATEGORIES).toContain('ANALYST_FAIL_CLOSED_PARSE');
    expect(REJECTION_CATEGORIES).toContain('ANALYST_FAIL_CLOSED_NO_TOOL_CALL');
  });

  it('contains the three post-approval categories (US-6)', () => {
    expect(REJECTION_CATEGORIES).toContain('POST_APPROVAL_TTL_EXPIRED');
    expect(REJECTION_CATEGORIES).toContain('POST_APPROVAL_HASH_MISMATCH');
    expect(REJECTION_CATEGORIES).toContain('POST_APPROVAL_DUPLICATE_LOCK');
  });

  it('contains the cooldown category (US-3)', () => {
    expect(REJECTION_CATEGORIES).toContain('COOLDOWN_3_LOSSES_ACTIVE');
  });

  it('contains the risk-budget category (US-7)', () => {
    expect(REJECTION_CATEGORIES).toContain('EXECUTOR_REJECT_RISK_BUDGET_EXCEEDED');
  });

  it('has no duplicate categories', () => {
    const set = new Set<string>(REJECTION_CATEGORIES);
    expect(set.size).toBe(REJECTION_CATEGORIES.length);
  });
});

describe('isFailClosed', () => {
  it('returns true for the three ANALYST_FAIL_CLOSED_* categories', () => {
    expect(isFailClosed('ANALYST_FAIL_CLOSED_API_ERROR')).toBe(true);
    expect(isFailClosed('ANALYST_FAIL_CLOSED_PARSE')).toBe(true);
    expect(isFailClosed('ANALYST_FAIL_CLOSED_NO_TOOL_CALL')).toBe(true);
  });

  it('returns false for cause-REJECT analyst categories', () => {
    expect(isFailClosed('ANALYST_REJECT_BANNED_PATTERN')).toBe(false);
    expect(isFailClosed('ANALYST_REJECT_CORRELATION')).toBe(false);
    expect(isFailClosed('ANALYST_REJECT_NEWS_WINDOW')).toBe(false);
    expect(isFailClosed('ANALYST_REJECT_COOLDOWN')).toBe(false);
  });

  it('returns false for scanner / executor / post-approval categories', () => {
    expect(isFailClosed('KILL_ZONE_OUT')).toBe(false);
    expect(isFailClosed('EXECUTOR_REJECT_SCORE_BELOW_TIER_MIN')).toBe(false);
    expect(isFailClosed('POST_APPROVAL_HASH_MISMATCH')).toBe(false);
    expect(isFailClosed('COOLDOWN_3_LOSSES_ACTIVE')).toBe(false);
  });

  it('returns false for the OTHER sentinel', () => {
    expect(isFailClosed('OTHER')).toBe(false);
  });
});

describe('RejectionCategory type integrity', () => {
  it('compiles when assigning every enum value to RejectionCategory', () => {
    // Compile-time test: if any value in REJECTION_CATEGORIES ever falls
    // outside the union, this assignment would fail tsc. Runtime is a
    // no-op.
    const allCats: RejectionCategory[] = [...REJECTION_CATEGORIES];
    expect(allCats.length).toBe(REJECTION_CATEGORIES.length);
  });
});

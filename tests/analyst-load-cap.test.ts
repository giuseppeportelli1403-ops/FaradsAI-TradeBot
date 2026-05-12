import { describe, it, expect, beforeEach } from 'vitest';
import {
  shouldRejectForAnalystLoadCap,
  recordAnalystCall,
  _resetAnalystLoadTracking,
} from '../src/agents/trading-agent.js';

// Tests for the per-cycle analyst load cap (PR 1 prereq T2, codex finding #3).
// 5 calls in a 5-minute sliding window allowed; 6th rejected. Window resets
// as old calls age out.

describe('shouldRejectForAnalystLoadCap', () => {
  beforeEach(() => {
    _resetAnalystLoadTracking();
  });

  it('returns false when no calls recorded yet', () => {
    expect(shouldRejectForAnalystLoadCap(Date.now())).toBe(false);
  });

  it('allows 5 calls in a row at the same instant', () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      expect(shouldRejectForAnalystLoadCap(now)).toBe(false);
      recordAnalystCall(now);
    }
    // 6th call is rejected
    expect(shouldRejectForAnalystLoadCap(now)).toBe(true);
  });

  it('does NOT count calls older than 5 minutes', () => {
    const now = Date.now();
    const sixMinutesAgo = now - 6 * 60 * 1000;
    // Pre-load 5 stale calls (all older than the window)
    for (let i = 0; i < 5; i++) {
      recordAnalystCall(sixMinutesAgo);
    }
    // At "now", all 5 are stale, so we're back to 0 in the window
    expect(shouldRejectForAnalystLoadCap(now)).toBe(false);
  });

  it('counts only calls within the 5-minute window (sliding)', () => {
    const t0 = 1_700_000_000_000; // arbitrary anchor
    // 3 calls at t0
    for (let i = 0; i < 3; i++) {
      recordAnalystCall(t0);
    }
    // 4 minutes later, add 2 more — total 5 within window
    const t1 = t0 + 4 * 60 * 1000;
    recordAnalystCall(t1);
    recordAnalystCall(t1);
    // At t1, 5 calls in window → 6th rejected
    expect(shouldRejectForAnalystLoadCap(t1)).toBe(true);

    // 6 minutes after t0 — the 3 t0 calls have aged out, only 2 t1 calls remain
    const t2 = t0 + 6 * 60 * 1000 + 1;
    expect(shouldRejectForAnalystLoadCap(t2)).toBe(false);
  });

  it('reset helper clears tracking state', () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) recordAnalystCall(now);
    expect(shouldRejectForAnalystLoadCap(now)).toBe(true);
    _resetAnalystLoadTracking();
    expect(shouldRejectForAnalystLoadCap(now)).toBe(false);
  });
});

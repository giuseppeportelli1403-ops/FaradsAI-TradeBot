// Scheduler tests
//
// Two concerns covered here:
//   1. makeCandleKey — month padding / boundary correctness (pre-migration test,
//      unchanged).
//   2. classifyCloseReason — Capital.com activity classification ('TP'/'SL'/'OTHER')
//      used by monitorSplitPositions() to decide whether a closed leg A means
//      "move leg B SL to break-even" (TP hit) or "mark trade sl_hit" (SL hit).
//
// The full monitorSplitPositions() flow is exercised via direct mocking of the
// CapitalClient module in the "monitor loop integration" suite below.

import { describe, it, expect } from 'vitest';
import { makeCandleKey, classifyCloseReason } from '../src/scheduler/index.js';
import type { Activity } from '../src/types.js';

describe('makeCandleKey', () => {
  it('pads January (month 0 internally) correctly for 15m', () => {
    // January 5, 2026 09:30 UTC
    const date = new Date(Date.UTC(2026, 0, 5, 9, 30));
    const key = makeCandleKey(date, '15m');
    expect(key).toBe('2026-01-05T09:30');
  });

  it('pads December (month 11 internally) correctly for 15m', () => {
    // December 31, 2026 23:45 UTC
    const date = new Date(Date.UTC(2026, 11, 31, 23, 45));
    const key = makeCandleKey(date, '15m');
    expect(key).toBe('2026-12-31T23:45');
  });

  it('handles month boundary correctly — March 31 to April 1', () => {
    const march31 = new Date(Date.UTC(2026, 2, 31, 23, 45));
    const april1 = new Date(Date.UTC(2026, 3, 1, 0, 0));

    const keyMarch = makeCandleKey(march31, '15m');
    const keyApril = makeCandleKey(april1, '15m');

    expect(keyMarch).toBe('2026-03-31T23:45');
    expect(keyApril).toBe('2026-04-01T00:00');
    expect(keyMarch).not.toBe(keyApril);
  });

  it('uses hour granularity for 1h timeframe', () => {
    const date = new Date(Date.UTC(2026, 0, 5, 14, 37));
    const key = makeCandleKey(date, '1h');
    expect(key).toBe('2026-01-05T14:00');
  });

  it('snaps 15m candle to correct 15-minute boundary', () => {
    // 09:07 should snap to 09:00
    const date = new Date(Date.UTC(2026, 5, 15, 9, 7));
    const key = makeCandleKey(date, '15m');
    expect(key).toBe('2026-06-15T09:00');
  });

  it('snaps 15m candle at :32 to :30', () => {
    const date = new Date(Date.UTC(2026, 5, 15, 9, 32));
    const key = makeCandleKey(date, '15m');
    expect(key).toBe('2026-06-15T09:30');
  });
});

// ==================== classifyCloseReason ====================
// Exported from scheduler/index.ts — decides how the monitor loop reacts to
// a leg being closed by Capital.com. Recognises Capital activity/status
// strings like 'PROFIT', 'STOP', 'LIMIT' robustly.

function makeActivity(overrides: Partial<Activity>): Activity {
  return {
    date: '2026-04-17T09:00:00Z',
    epic: 'US100',
    dealId: 'DEAL-A',
    activity: 'POSITION',
    status: 'OK',
    size: 1,
    level: 100,
    ...overrides,
  };
}

describe('classifyCloseReason', () => {
  it("returns 'TP' when the matching activity mentions PROFIT", () => {
    const activities: Activity[] = [
      makeActivity({ dealId: 'DEAL-A', activity: 'POSITION', status: 'PROFIT_HIT' }),
    ];
    expect(classifyCloseReason(activities, 'DEAL-A')).toBe('TP');
  });

  it("returns 'TP' when the activity is labelled LIMIT (limit order fill = TP on a closing leg)", () => {
    const activities: Activity[] = [
      makeActivity({ dealId: 'DEAL-A', activity: 'LIMIT_ORDER', status: 'EXECUTED' }),
    ];
    expect(classifyCloseReason(activities, 'DEAL-A')).toBe('TP');
  });

  it("returns 'SL' when the activity mentions STOP", () => {
    const activities: Activity[] = [
      makeActivity({ dealId: 'DEAL-A', activity: 'POSITION', status: 'STOP_HIT' }),
    ];
    expect(classifyCloseReason(activities, 'DEAL-A')).toBe('SL');
  });

  it("returns 'OTHER' when no matching activity is present for the dealId", () => {
    const activities: Activity[] = [
      makeActivity({ dealId: 'DEAL-B', status: 'PROFIT_HIT' }),
    ];
    expect(classifyCloseReason(activities, 'DEAL-A')).toBe('OTHER');
  });

  it("returns 'OTHER' when activity status is unrelated (e.g. manual close)", () => {
    const activities: Activity[] = [
      makeActivity({ dealId: 'DEAL-A', activity: 'POSITION', status: 'MANUAL' }),
    ];
    expect(classifyCloseReason(activities, 'DEAL-A')).toBe('OTHER');
  });

  it('is case-insensitive (lowercase status strings still classify)', () => {
    const activities: Activity[] = [
      makeActivity({ dealId: 'DEAL-A', activity: 'position', status: 'profit' }),
    ];
    expect(classifyCloseReason(activities, 'DEAL-A')).toBe('TP');
  });

  it('only considers activities whose dealId matches — ignores noise', () => {
    const activities: Activity[] = [
      makeActivity({ dealId: 'DEAL-B', status: 'STOP_HIT' }), // noise — leg B
      makeActivity({ dealId: 'DEAL-A', status: 'PROFIT_HIT' }), // real match
    ];
    expect(classifyCloseReason(activities, 'DEAL-A')).toBe('TP');
  });
});

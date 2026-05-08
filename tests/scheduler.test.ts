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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  makeCandleKey,
  classifyCloseReason,
  monitorSplitPositions,
  pingKeepAlive,
  _resetPingFailureStreak,
  _getPingFailureStreak,
  type MonitorDeps,
} from '../src/scheduler/index.js';
import type { Activity, CapitalPosition, TradeRecord } from '../src/types.js';

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

  // 2026-04-29 audit-3 BUG-S2 regression: pre-fix, the LIMIT-substring check
  // ran BEFORE the STOP-substring check. An activity status like
  // 'STOP_LIMIT_FILLED' matched LIMIT first → was classified as TP → cascaded
  // handleTp1Hit (move B/C SL to BE) on a real STOP-OUT → permanent P&L
  // corruption. Order of checks must be STOP first.
  it("BUG-S2: returns 'SL' when activity contains both STOP and LIMIT (STOP wins)", () => {
    const activities: Activity[] = [
      makeActivity({ dealId: 'DEAL-A', activity: 'POSITION', status: 'STOP_LIMIT_FILLED' }),
    ];
    expect(classifyCloseReason(activities, 'DEAL-A')).toBe('SL');
  });

  it("BUG-S2: returns 'SL' on STOP_LIMIT_TRIGGERED variant", () => {
    const activities: Activity[] = [
      makeActivity({ dealId: 'DEAL-A', activity: 'STOP_LIMIT_TRIGGERED', status: 'EXECUTED' }),
    ];
    expect(classifyCloseReason(activities, 'DEAL-A')).toBe('SL');
  });

  it("BUG-S2: returns 'SL' on WORKING_STOP_LIMIT variant", () => {
    const activities: Activity[] = [
      makeActivity({ dealId: 'DEAL-A', activity: 'WORKING_STOP_LIMIT', status: 'AMENDED' }),
    ];
    expect(classifyCloseReason(activities, 'DEAL-A')).toBe('SL');
  });

  // 2026-04-29 audit-3 r6: live probe of Capital's /history/activity returned
  // type='POSITION'/'WORKING_ORDER' with status='ACCEPTED'/'EXECUTED' — none
  // of which contain TP/SL keywords. Real production data classified as
  // 'OTHER' on Tier 1, requiring Tier 2 (price proximity) to decide.

  it("real Capital data: type=POSITION + status=ACCEPTED falls through to OTHER without trade input", () => {
    const activities: Activity[] = [
      { date: '2026-04-29', epic: 'EURUSD', dealId: 'DEAL-A', type: 'POSITION', status: 'ACCEPTED' },
    ];
    expect(classifyCloseReason(activities, 'DEAL-A')).toBe('OTHER');
  });

  it("real Capital data: type=WORKING_ORDER + status=EXECUTED falls through to OTHER", () => {
    const activities: Activity[] = [
      { date: '2026-04-29', epic: 'EURUSD', dealId: 'DEAL-A', type: 'WORKING_ORDER', status: 'EXECUTED' },
    ];
    expect(classifyCloseReason(activities, 'DEAL-A')).toBe('OTHER');
  });

  it("Tier 2 price-proximity: closePrice closer to SL → returns 'SL'", () => {
    const trade = makeTrade({ entry: 1.10, sl: 1.0900, tp1: 1.1100, tp2: 1.1200, tp3: 1.1300 });
    const activities: Activity[] = [
      { date: '2026-04-29', epic: 'EURUSD', dealId: 'DEAL-A', type: 'POSITION', status: 'ACCEPTED' },
    ];
    // closePrice 1.0905 is 5 pips from SL (1.0900) and 195 pips from TP1 (1.1100)
    expect(classifyCloseReason(activities, 'DEAL-A', trade, 'A', 1.0905)).toBe('SL');
  });

  it("Tier 2 price-proximity: closePrice closer to TP1 → returns 'TP'", () => {
    const trade = makeTrade({ entry: 1.10, sl: 1.0900, tp1: 1.1100, tp2: 1.1200, tp3: 1.1300 });
    const activities: Activity[] = [
      { date: '2026-04-29', epic: 'EURUSD', dealId: 'DEAL-A', type: 'POSITION', status: 'ACCEPTED' },
    ];
    expect(classifyCloseReason(activities, 'DEAL-A', trade, 'A', 1.1095)).toBe('TP');
  });

  it("Tier 2: leg B uses tp2 as its target", () => {
    const trade = makeTrade({ entry: 1.10, sl: 1.0900, tp1: 1.1100, tp2: 1.1200, tp3: 1.1300 });
    const activities: Activity[] = [
      { date: '2026-04-29', epic: 'EURUSD', dealId: 'DEAL-B', type: 'POSITION', status: 'ACCEPTED' },
    ];
    // 1.1199 is closer to tp2 (1.1200) than to sl (1.0900)
    expect(classifyCloseReason(activities, 'DEAL-B', trade, 'B', 1.1199)).toBe('TP');
  });

  it("Tier 2: leg C uses tp3 (or tp2 fallback) as its target", () => {
    const trade = makeTrade({ entry: 1.10, sl: 1.0900, tp1: 1.1100, tp2: 1.1200, tp3: 1.1300 });
    const activities: Activity[] = [
      { date: '2026-04-29', epic: 'EURUSD', dealId: 'DEAL-C', type: 'POSITION', status: 'ACCEPTED' },
    ];
    expect(classifyCloseReason(activities, 'DEAL-C', trade, 'C', 1.1299)).toBe('TP');
  });

  it("Tier 2: equidistant defaults to SL (safer to flag loss than mark a loss as a win)", () => {
    const trade = makeTrade({ entry: 1.10, sl: 1.0900, tp1: 1.1100, tp2: 1.1200, tp3: 1.1300 });
    const activities: Activity[] = [
      { date: '2026-04-29', epic: 'EURUSD', dealId: 'DEAL-A', type: 'POSITION', status: 'ACCEPTED' },
    ];
    // 1.1000 is exactly equidistant from SL (1.0900) and TP1 (1.1100)
    expect(classifyCloseReason(activities, 'DEAL-A', trade, 'A', 1.1000)).toBe('SL');
  });

  it("Tier 2: closePrice undefined → returns 'OTHER' (caller decides fallback)", () => {
    const trade = makeTrade({ entry: 1.10, sl: 1.0900, tp1: 1.1100 });
    const activities: Activity[] = [
      { date: '2026-04-29', epic: 'EURUSD', dealId: 'DEAL-A', type: 'POSITION', status: 'ACCEPTED' },
    ];
    expect(classifyCloseReason(activities, 'DEAL-A', trade, 'A', undefined)).toBe('OTHER');
  });

  it("Tier 1 wins over Tier 2 when activity has SL/TP keywords (back-compat)", () => {
    const trade = makeTrade({ entry: 1.10, sl: 1.0900, tp1: 1.1100 });
    const activities: Activity[] = [
      // PROFIT_HIT keyword in status — Tier 1 wins, returns TP regardless of closePrice
      makeActivity({ dealId: 'DEAL-A', activity: 'POSITION', status: 'PROFIT_HIT' }),
    ];
    // closePrice would say SL (close to 1.0900) but Tier 1 PROFIT_HIT wins
    expect(classifyCloseReason(activities, 'DEAL-A', trade, 'A', 1.0905)).toBe('TP');
  });

  // 2026-05-07 LIVE INCIDENT regression suite — SILVER Leg B TP2 fill was
  // misclassified as 'SL' because Tier 1's blob match found 'STOP' inside
  // a preceding EDIT_STOP_AND_LIMIT activity. handleSlOnLeg early-returned
  // and Leg C's SL was never trailed to TP1. Tier 0 (source field) fixes.
  describe("Tier 0 — Capital's `source` field on the close activity", () => {
    it("LIVE-2026-05-07: source='TP' on close beats preceding EDIT_STOP_AND_LIMIT", () => {
      const activities: Activity[] = [
        // The actual TP fill — Capital tags this with source='TP'
        { date: '2026-05-07T13:24:23', epic: 'SILVER', dealId: 'DEAL-B', type: 'POSITION', status: 'ACCEPTED', source: 'TP' },
        // Earlier today: SL→BE move when TP1 hit (would have triggered the bug)
        { date: '2026-05-07T09:55:00', epic: 'SILVER', dealId: 'DEAL-B', type: 'EDIT_STOP_AND_LIMIT', status: 'ACCEPTED', source: 'USER' },
        // Earlier still: manual recovery PUT
        { date: '2026-05-07T10:30:23', epic: 'SILVER', dealId: 'DEAL-B', type: 'EDIT_STOP_AND_LIMIT', status: 'ACCEPTED', source: 'USER' },
        // Open
        { date: '2026-05-07T09:02:31', epic: 'SILVER', dealId: 'DEAL-B', type: 'POSITION', status: 'ACCEPTED', source: 'USER' },
      ];
      expect(classifyCloseReason(activities, 'DEAL-B')).toBe('TP');
    });

    it("source='SL' on close beats preceding edits — symmetric with TP case", () => {
      const activities: Activity[] = [
        { date: '2026-05-07T13:24:23', epic: 'EURUSD', dealId: 'DEAL-A', type: 'POSITION', status: 'ACCEPTED', source: 'SL' },
        { date: '2026-05-07T10:30:23', epic: 'EURUSD', dealId: 'DEAL-A', type: 'EDIT_STOP_AND_LIMIT', status: 'ACCEPTED', source: 'USER' },
        { date: '2026-05-07T09:02:31', epic: 'EURUSD', dealId: 'DEAL-A', type: 'POSITION', status: 'ACCEPTED', source: 'USER' },
      ];
      expect(classifyCloseReason(activities, 'DEAL-A')).toBe('SL');
    });

    it("source='USER' (manual close) — no Tier 0 match, falls through to Tier 1/2", () => {
      const activities: Activity[] = [
        { date: '2026-05-07T13:24:23', epic: 'EURUSD', dealId: 'DEAL-A', type: 'POSITION', status: 'ACCEPTED', source: 'USER' },
      ];
      // No Tier 1 keyword, no Tier 2 inputs → 'OTHER' (existing behavior)
      expect(classifyCloseReason(activities, 'DEAL-A')).toBe('OTHER');
    });

    it("source='DEALER' — unknown / non-close — falls through to Tier 1/2", () => {
      const activities: Activity[] = [
        { date: '2026-05-07T13:24:23', epic: 'EURUSD', dealId: 'DEAL-A', type: 'POSITION', status: 'ACCEPTED', source: 'DEALER' },
      ];
      expect(classifyCloseReason(activities, 'DEAL-A')).toBe('OTHER');
    });

    it("Tier 0 still uses Tier 2 trade input when source is absent — unchanged behavior", () => {
      const trade = makeTrade({ entry: 1.10, sl: 1.0900, tp1: 1.1100, tp2: 1.1200, tp3: 1.1300 });
      const activities: Activity[] = [
        { date: '2026-04-29', epic: 'EURUSD', dealId: 'DEAL-A', type: 'POSITION', status: 'ACCEPTED' },
      ];
      expect(classifyCloseReason(activities, 'DEAL-A', trade, 'A', 1.1095)).toBe('TP');
    });

    it("BUG-S2 still fixed: source='SL' on STOP_LIMIT-style close returns 'SL' (Tier 0 path)", () => {
      const activities: Activity[] = [
        // Hypothetical STOP_LIMIT order fill — Capital still tags source='SL'
        { date: '2026-05-07T13:24:23', epic: 'EURUSD', dealId: 'DEAL-A', type: 'POSITION', status: 'ACCEPTED', source: 'SL' },
      ];
      expect(classifyCloseReason(activities, 'DEAL-A')).toBe('SL');
    });

    it("Tier 0 wins over Tier 2 — source='TP' overrides closePrice near SL", () => {
      // Edge case: bid retreated below TP level by the time we polled, so
      // Tier 2 mid-price would say SL — but Capital's source='TP' is truth.
      const trade = makeTrade({ entry: 78.03, sl: 78.03, tp1: 79.73, tp2: 80.58, tp3: 81.43 });
      const activities: Activity[] = [
        { date: '2026-05-07T13:24:23', epic: 'SILVER', dealId: 'DEAL-B', type: 'POSITION', status: 'ACCEPTED', source: 'TP' },
      ];
      // closePrice 78.10 is closer to SL (78.03) than to TP2 (80.58) — Tier 2 would say 'SL',
      // but Tier 0 source='TP' wins
      expect(classifyCloseReason(activities, 'DEAL-B', trade, 'B', 78.10)).toBe('TP');
    });

    // Codex review follow-ups (2026-05-07):
    it("Tier 0 wins over Tier 1 — source='TP' overrides a STOP_HIT keyword on the same activity", () => {
      // Hypothetical: Capital reports both a status keyword AND source='TP'.
      // Source is the more authoritative signal — it should win.
      const activities: Activity[] = [
        { date: '2026-05-07T13:24:23', epic: 'EURUSD', dealId: 'DEAL-A', type: 'POSITION', status: 'STOP_HIT', source: 'TP' },
      ];
      expect(classifyCloseReason(activities, 'DEAL-A')).toBe('TP');
    });

    it("activity ordering doesn't matter — close in middle of array still classifies", () => {
      // Capital's /history/activity ordering isn't documented to be stable.
      // Pin that find()-based Tier 0 returns the right answer regardless of
      // where the close sits in the returned list.
      const activities: Activity[] = [
        { date: '2026-05-07T10:30:23', epic: 'SILVER', dealId: 'DEAL-B', type: 'EDIT_STOP_AND_LIMIT', status: 'ACCEPTED', source: 'USER' },
        { date: '2026-05-07T13:24:23', epic: 'SILVER', dealId: 'DEAL-B', type: 'POSITION', status: 'ACCEPTED', source: 'TP' },
        { date: '2026-05-07T09:55:00', epic: 'SILVER', dealId: 'DEAL-B', type: 'EDIT_STOP_AND_LIMIT', status: 'ACCEPTED', source: 'USER' },
      ];
      expect(classifyCloseReason(activities, 'DEAL-B')).toBe('TP');
    });

    it("EDIT_* activity with source='SL' is IGNORED by Tier 0 — only non-EDIT types count as closes", () => {
      // Defensive: if Capital ever tags an amend with source='SL' (e.g. some
      // trailing-stop edit metadata), we must not let it masquerade as a
      // close. Tier 0 must filter EDIT_* types out, falling through to
      // Tier 1 (which would then consume the actual close activity).
      const activities: Activity[] = [
        // Imaginary: an EDIT carrying source='SL' (not seen live, but guarded against)
        { date: '2026-05-07T10:30:23', epic: 'SILVER', dealId: 'DEAL-B', type: 'EDIT_STOP_AND_LIMIT', status: 'ACCEPTED', source: 'SL' },
        // The real TP fill
        { date: '2026-05-07T13:24:23', epic: 'SILVER', dealId: 'DEAL-B', type: 'POSITION', status: 'ACCEPTED', source: 'TP' },
      ];
      // The EDIT must NOT short-circuit Tier 0; the genuine TP close must win.
      expect(classifyCloseReason(activities, 'DEAL-B')).toBe('TP');
    });
  });
});

// ==================== monitorSplitPositions ====================
// Orchestration tests — the full if/else tree that decides whether a closed
// leg A means "move leg B SL to break-even" (TP), "record sl_hit" (SL), or
// "deactivate leg A only" (OTHER), plus the second-pass leg-B promotion.
// Uses the `MonitorDeps` injection parameter added in Blocker 5 A2 so the
// production Capital client, sqlite DB, and Telegram alerters are never
// touched.

type SlTpOrder = ReturnType<MonitorDeps['getActiveSlTpOrders']>[number];

function makeTrade(overrides: Partial<TradeRecord> = {}): TradeRecord {
  return {
    id: 'trade-1',
    strategy_tag: 'ICT_INTRADAY',
    instrument: 'EURUSD',
    instrument_category: 'FX',
    direction: 'long',
    setup_type: 'OB',
    entry: 1.0853,
    sl: 1.0830,
    tp1: 1.0876,
    tp2: 1.0899,
    position_a_id: 'DEAL-A-1',
    position_b_id: 'DEAL-B-1',
    size_a: 0.5,
    size_b: 0.5,
    status: 'open',
    pnl_a: null,
    pnl_b: null,
    pnl_total: null,
    composite_score: 78,
    kill_zone: 'london',
    news_category: 'B',
    analyst_decision: 'approve',
    opened_at: '2026-04-17T08:00:00Z',
    closed_at: null,
    reasoning: 'test',
    ...overrides,
  };
}

function makeOrder(overrides: Partial<SlTpOrder> = {}): SlTpOrder {
  return {
    id: 1,
    trade_id: 'trade-1',
    leg: 'A',
    instrument: 'EURUSD',
    direction: 'long',
    quantity: 0.5,
    sl_price: 1.0830,
    tp_price: 1.0876,
    trailing_stop_distance: null,
    deal_id: 'DEAL-A-1',
    ...overrides,
  };
}

function makeOpenPosition(dealId: string): CapitalPosition {
  return {
    position: {
      dealId,
      dealReference: `REF-${dealId}`,
      direction: 'BUY',
      size: 0.5,
      openLevel: 1.0853,
      stopLevel: 1.0830,
      profitLevel: 1.0876,
      trailingStop: false,
      trailingStopDistance: null,
      guaranteedStop: false,
      createdDateUTC: '2026-04-17T08:00:00Z',
      controlledRisk: false,
    },
    market: {
      instrumentName: 'EUR/USD',
      epic: 'EURUSD',
      bid: 1.0854,
      offer: 1.0855,
      marketStatus: 'TRADEABLE',
    },
  };
}

/** Build a full mocked MonitorDeps bundle. Each field is a vi.fn() so tests
 *  can inspect call counts and arguments. Individual tests override the
 *  relevant mock return values. */
function makeDeps(overrides: Partial<MonitorDeps> = {}): MonitorDeps & {
  _mocks: {
    getOpenPositions: ReturnType<typeof vi.fn>;
    getActivityHistory: ReturnType<typeof vi.fn>;
    updatePosition: ReturnType<typeof vi.fn>;
    safelyAmendPosition: ReturnType<typeof vi.fn>;
    getActiveSlTpOrders: ReturnType<typeof vi.fn>;
    getTradeById: ReturnType<typeof vi.fn>;
    deactivateSlTpOrder: ReturnType<typeof vi.fn>;
    updateTradeStatus: ReturnType<typeof vi.fn>;
    alertTp1Hit: ReturnType<typeof vi.fn>;
    alertTp2Hit: ReturnType<typeof vi.fn>;
    alertSlHit: ReturnType<typeof vi.fn>;
  };
} {
  const getOpenPositions = vi.fn(async () => [] as CapitalPosition[]);
  const getActivityHistory = vi.fn(async () => [] as Activity[]);
  const updatePosition = vi.fn(async () => ({
    dealId: 'X',
    dealReference: 'Y',
    dealStatus: 'ACCEPTED',
    reason: '',
    status: 'AMENDED',
    direction: 'BUY',
    epic: 'EURUSD',
    size: 0.5,
    level: 1.0853,
    stopLevel: 1.0853,
    profitLevel: 1.0876,
    affectedDeals: [],
  }));
  // safelyAmendPosition is the preferred amend method — fetches current state
  // and merges before PUTting, so callers don't need to know existing TP/SL
  // values. Tests assert against THIS, not updatePosition. (The 2026-05-07
  // SL→BE bug came from a partial PUT — see capital-client.ts.)
  const safelyAmendPosition = vi.fn(async () => ({
    dealId: 'X',
    dealReference: 'Y',
    dealStatus: 'ACCEPTED',
    reason: '',
    status: 'AMENDED',
    direction: 'BUY',
    epic: 'EURUSD',
    size: 0.5,
    level: 1.0853,
    stopLevel: 1.0853,
    profitLevel: 1.0876,
    affectedDeals: [],
  }));
  const getActiveSlTpOrders = vi.fn(() => [] as SlTpOrder[]);
  const getTradeById = vi.fn((_id: string) => null as TradeRecord | null);
  const deactivateSlTpOrder = vi.fn((_id: string, _leg: string) => {});
  const updateTradeStatus = vi.fn((_id: string, _status: string) => {});
  const alertTp1Hit = vi.fn(async (_t: TradeRecord) => {});
  const alertTp2Hit = vi.fn(async (_t: TradeRecord) => {});
  const alertSlHit = vi.fn(async (_t: TradeRecord) => {});

  const deps: MonitorDeps = {
    capital: {
      getOpenPositions: getOpenPositions as unknown as MonitorDeps['capital']['getOpenPositions'],
      getActivityHistory:
        getActivityHistory as unknown as MonitorDeps['capital']['getActivityHistory'],
      updatePosition: updatePosition as unknown as MonitorDeps['capital']['updatePosition'],
      safelyAmendPosition:
        safelyAmendPosition as unknown as MonitorDeps['capital']['safelyAmendPosition'],
    },
    getActiveSlTpOrders:
      getActiveSlTpOrders as unknown as MonitorDeps['getActiveSlTpOrders'],
    getTradeById: getTradeById as unknown as MonitorDeps['getTradeById'],
    deactivateSlTpOrder: deactivateSlTpOrder as unknown as MonitorDeps['deactivateSlTpOrder'],
    updateTradeStatus: updateTradeStatus as unknown as MonitorDeps['updateTradeStatus'],
    alertTp1Hit: alertTp1Hit as unknown as MonitorDeps['alertTp1Hit'],
    alertTp2Hit: alertTp2Hit as unknown as MonitorDeps['alertTp2Hit'],
    alertSlHit: alertSlHit as unknown as MonitorDeps['alertSlHit'],
    ...overrides,
  };

  return {
    ...deps,
    _mocks: {
      getOpenPositions,
      getActivityHistory,
      updatePosition,
      safelyAmendPosition,
      getActiveSlTpOrders,
      getTradeById,
      deactivateSlTpOrder,
      updateTradeStatus,
      alertTp1Hit,
      alertTp2Hit,
      alertSlHit,
    },
  };
}

describe('monitorSplitPositions', () => {
  // Silence console noise from the production code paths we're exercising
  // (warnings for missing trades, errors for forced-throw tests, etc.).
  let errSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    errSpy.mockRestore();
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('no active leg-A orders → does not call Capital at all', async () => {
    const deps = makeDeps();
    // getActiveSlTpOrders returns [] by default → no leg-A orders → early return.
    await monitorSplitPositions(deps);

    expect(deps._mocks.getActiveSlTpOrders).toHaveBeenCalledTimes(1);
    expect(deps._mocks.getOpenPositions).not.toHaveBeenCalled();
    expect(deps._mocks.getActivityHistory).not.toHaveBeenCalled();
    expect(deps._mocks.safelyAmendPosition).not.toHaveBeenCalled();
    expect(deps._mocks.updateTradeStatus).not.toHaveBeenCalled();
    expect(deps._mocks.deactivateSlTpOrder).not.toHaveBeenCalled();
  });

  it('leg A still open on Capital → no-op: no classification, no updatePosition, no DB mutations', async () => {
    const deps = makeDeps();
    deps._mocks.getActiveSlTpOrders.mockReturnValue([
      makeOrder({ leg: 'A', deal_id: 'DEAL-A-1' }),
    ]);
    deps._mocks.getOpenPositions.mockResolvedValue([makeOpenPosition('DEAL-A-1')]);

    await monitorSplitPositions(deps);

    expect(deps._mocks.getOpenPositions).toHaveBeenCalledTimes(1);
    expect(deps._mocks.safelyAmendPosition).not.toHaveBeenCalled();
    expect(deps._mocks.updateTradeStatus).not.toHaveBeenCalled();
    expect(deps._mocks.deactivateSlTpOrder).not.toHaveBeenCalled();
    expect(deps._mocks.alertTp1Hit).not.toHaveBeenCalled();
    expect(deps._mocks.alertSlHit).not.toHaveBeenCalled();
  });

  it("leg A closed, activity classifies as TP → moves leg B SL to break-even, marks trade tp1_hit, fires alertTp1Hit", async () => {
    const trade = makeTrade({ id: 'trade-1', entry: 1.0853, position_b_id: 'DEAL-B-1' });
    const deps = makeDeps();
    deps._mocks.getActiveSlTpOrders
      // First call: leg A pass
      .mockReturnValueOnce([makeOrder({ leg: 'A', deal_id: 'DEAL-A-1', trade_id: 'trade-1' })])
      // Second call: leg B second-pass (leg B still open → no action)
      .mockReturnValueOnce([makeOrder({ leg: 'B', deal_id: 'DEAL-B-1', trade_id: 'trade-1' })]);
    // Leg A is closed (not in open positions), but leg B is still open
    deps._mocks.getOpenPositions.mockResolvedValue([makeOpenPosition('DEAL-B-1')]);
    deps._mocks.getActivityHistory.mockResolvedValue([
      {
        date: '2026-04-17T09:00:00Z',
        epic: 'EURUSD',
        dealId: 'DEAL-A-1',
        activity: 'POSITION',
        status: 'PROFIT_HIT',
        size: 0.5,
        level: 1.0876,
      },
    ]);
    deps._mocks.getTradeById.mockReturnValue(trade);

    await monitorSplitPositions(deps);

    // Break-even move: scheduler calls safelyAmendPosition with just the SL change;
    // the helper round-trips the existing profitLevel/trailingStop server-side so
    // Capital.com doesn't strip them. Regression guard for the 2026-05-07 SILVER
    // bug — see fix/sl-be-preserve-tp commit.
    expect(deps._mocks.safelyAmendPosition).toHaveBeenCalledTimes(1);
    expect(deps._mocks.safelyAmendPosition).toHaveBeenCalledWith('DEAL-B-1', {
      stopLevel: 1.0853,
    });

    expect(deps._mocks.updateTradeStatus).toHaveBeenCalledWith('trade-1', 'tp1_hit');
    expect(deps._mocks.deactivateSlTpOrder).toHaveBeenCalledWith('trade-1', 'A');
    expect(deps._mocks.alertTp1Hit).toHaveBeenCalledTimes(1);
    expect(deps._mocks.alertTp1Hit).toHaveBeenCalledWith(trade);

    // Leg B was still open → no leg-B promotion.
    expect(deps._mocks.updateTradeStatus).not.toHaveBeenCalledWith('trade-1', 'complete');
    expect(deps._mocks.alertTp2Hit).not.toHaveBeenCalled();
    expect(deps._mocks.alertSlHit).not.toHaveBeenCalled();
  });

  it("leg A closed, activity classifies as SL → updatePosition NOT called; trade marked sl_hit; alertSlHit fired", async () => {
    const trade = makeTrade({ id: 'trade-1', entry: 1.0853 });
    const deps = makeDeps();
    deps._mocks.getActiveSlTpOrders
      .mockReturnValueOnce([makeOrder({ leg: 'A', deal_id: 'DEAL-A-1', trade_id: 'trade-1' })])
      .mockReturnValueOnce([]); // no leg-B rows
    deps._mocks.getOpenPositions.mockResolvedValue([]); // both legs gone
    deps._mocks.getActivityHistory.mockResolvedValue([
      {
        date: '2026-04-17T09:00:00Z',
        epic: 'EURUSD',
        dealId: 'DEAL-A-1',
        activity: 'POSITION',
        status: 'STOP_HIT',
        size: 0.5,
        level: 1.0830,
      },
    ]);
    deps._mocks.getTradeById.mockReturnValue(trade);

    await monitorSplitPositions(deps);

    expect(deps._mocks.safelyAmendPosition).not.toHaveBeenCalled();
    expect(deps._mocks.updateTradeStatus).toHaveBeenCalledWith('trade-1', 'sl_hit');
    expect(deps._mocks.deactivateSlTpOrder).toHaveBeenCalledWith('trade-1', 'A');
    expect(deps._mocks.alertSlHit).toHaveBeenCalledTimes(1);
    expect(deps._mocks.alertTp1Hit).not.toHaveBeenCalled();
  });

  it("leg A closed, activity classifies as OTHER → updatePosition NOT called, trade status untouched, leg A deactivated", async () => {
    const trade = makeTrade({ id: 'trade-1' });
    const deps = makeDeps();
    deps._mocks.getActiveSlTpOrders
      .mockReturnValueOnce([makeOrder({ leg: 'A', deal_id: 'DEAL-A-1', trade_id: 'trade-1' })])
      .mockReturnValueOnce([]);
    deps._mocks.getOpenPositions.mockResolvedValue([]);
    deps._mocks.getActivityHistory.mockResolvedValue([
      {
        date: '2026-04-17T09:00:00Z',
        epic: 'EURUSD',
        dealId: 'DEAL-A-1',
        activity: 'POSITION',
        status: 'MANUAL_CLOSE', // doesn't match TP or SL keywords
        size: 0.5,
        level: 1.0860,
      },
    ]);
    deps._mocks.getTradeById.mockReturnValue(trade);

    await monitorSplitPositions(deps);

    expect(deps._mocks.safelyAmendPosition).not.toHaveBeenCalled();
    expect(deps._mocks.updateTradeStatus).not.toHaveBeenCalled();
    expect(deps._mocks.deactivateSlTpOrder).toHaveBeenCalledWith('trade-1', 'A');
    expect(deps._mocks.alertTp1Hit).not.toHaveBeenCalled();
    expect(deps._mocks.alertSlHit).not.toHaveBeenCalled();
  });

  it('leg A closed but getTradeById returns null → deactivate leg A, no updatePosition, warning logged', async () => {
    const deps = makeDeps();
    deps._mocks.getActiveSlTpOrders
      .mockReturnValueOnce([makeOrder({ leg: 'A', deal_id: 'DEAL-A-1', trade_id: 'missing' })])
      .mockReturnValueOnce([]);
    deps._mocks.getOpenPositions.mockResolvedValue([]);
    deps._mocks.getActivityHistory.mockResolvedValue([]);
    deps._mocks.getTradeById.mockReturnValue(null);

    await expect(monitorSplitPositions(deps)).resolves.toBeUndefined();

    expect(deps._mocks.safelyAmendPosition).not.toHaveBeenCalled();
    expect(deps._mocks.updateTradeStatus).not.toHaveBeenCalled();
    expect(deps._mocks.deactivateSlTpOrder).toHaveBeenCalledWith('missing', 'A');
    expect(warnSpy).toHaveBeenCalled();
  });

  it('capital.safelyAmendPosition throws (Capital rejects BE move) → error caught, DB still updated, alert still attempted', async () => {
    const trade = makeTrade({ id: 'trade-1', entry: 1.0853, position_b_id: 'DEAL-B-1' });
    const deps = makeDeps();
    deps._mocks.getActiveSlTpOrders
      .mockReturnValueOnce([makeOrder({ leg: 'A', deal_id: 'DEAL-A-1', trade_id: 'trade-1' })])
      // Leg B still open → no second-pass action
      .mockReturnValueOnce([makeOrder({ leg: 'B', deal_id: 'DEAL-B-1', trade_id: 'trade-1' })]);
    deps._mocks.getOpenPositions.mockResolvedValue([makeOpenPosition('DEAL-B-1')]);
    deps._mocks.getActivityHistory.mockResolvedValue([
      {
        date: '2026-04-17T09:00:00Z',
        epic: 'EURUSD',
        dealId: 'DEAL-A-1',
        activity: 'POSITION',
        status: 'PROFIT_HIT',
        size: 0.5,
        level: 1.0876,
      },
    ]);
    deps._mocks.getTradeById.mockReturnValue(trade);
    deps._mocks.safelyAmendPosition.mockRejectedValueOnce(new Error('Capital API 500'));

    // Should resolve (not throw) despite the Capital failure.
    await expect(monitorSplitPositions(deps)).resolves.toBeUndefined();

    // BE move was attempted with the right args, even though it failed.
    expect(deps._mocks.safelyAmendPosition).toHaveBeenCalledWith('DEAL-B-1', {
      stopLevel: 1.0853,
    });
    // DB still updated — the monitor does NOT roll back on Capital failure.
    expect(deps._mocks.updateTradeStatus).toHaveBeenCalledWith('trade-1', 'tp1_hit');
    expect(deps._mocks.deactivateSlTpOrder).toHaveBeenCalledWith('trade-1', 'A');
    // Alert was still fired.
    expect(deps._mocks.alertTp1Hit).toHaveBeenCalledTimes(1);
    // Error was logged rather than propagated.
    expect(errSpy).toHaveBeenCalled();
  });

  it('leg B closed at TP on a legacy 2-leg trade (no position_c_id) → trade marked complete, alertTp2Hit fired', async () => {
    // Legacy-compat: a trade without position_c_id (i.e. created before the
    // 3-leg upgrade) behaves like the old 2-leg world when Leg B hits TP:
    // trade finalises to 'complete' immediately, alertTp2Hit is the "full
    // complete" message (the alert function picks via trade.closed_at).
    const trade = makeTrade({ id: 'trade-1', status: 'tp1_hit' });
    const deps = makeDeps();
    // Single top-level fetch now — mock returns both Leg A (still open on
    // Capital, no action) + Leg B (closed, triggers handleTp2Hit) in one array.
    deps._mocks.getActiveSlTpOrders.mockReturnValueOnce([
      makeOrder({ leg: 'A', deal_id: 'DEAL-A-STILL-OPEN', trade_id: 'other-trade' }),
      makeOrder({ leg: 'B', deal_id: 'DEAL-B-1', trade_id: 'trade-1' }),
    ]);
    deps._mocks.getOpenPositions.mockResolvedValue([makeOpenPosition('DEAL-A-STILL-OPEN')]);
    deps._mocks.getActivityHistory.mockResolvedValue([
      {
        date: '2026-04-17T09:30:00Z',
        epic: 'EURUSD',
        dealId: 'DEAL-B-1',
        activity: 'POSITION',
        status: 'PROFIT_HIT',
        size: 0.5,
        level: 1.0899,
      },
    ]);
    deps._mocks.getTradeById.mockReturnValue(trade);

    await monitorSplitPositions(deps);

    expect(deps._mocks.updateTradeStatus).toHaveBeenCalledWith('trade-1', 'complete');
    expect(deps._mocks.deactivateSlTpOrder).toHaveBeenCalledWith('trade-1', 'B');
    expect(deps._mocks.alertTp2Hit).toHaveBeenCalledTimes(1);
    expect(deps._mocks.alertTp2Hit).toHaveBeenCalledWith(trade);
    expect(deps._mocks.alertSlHit).not.toHaveBeenCalled();
  });

  it('leg B SL\'d at BE on a 2-leg trade where A already TP\'d → partial-win finalisation: status=complete, alertTp2Hit (NOT alertSlHit)', async () => {
    // Scenario: A hit TP1 earlier (trade.status already 'tp1_hit'), then
    // B stopped out at its break-even SL. That's a PARTIAL WIN — realized
    // profit on A, zero on B. Per 3-leg semantics (handleSlOnLeg), finalise
    // as 'complete' with the alertTp2Hit variant. Previously (2-leg world)
    // this was wrongly marked 'sl_hit' + alertSlHit — misleading since the
    // trade was actually profitable.
    const trade = makeTrade({ id: 'trade-1', status: 'tp1_hit' });
    const deps = makeDeps();
    deps._mocks.getActiveSlTpOrders.mockReturnValueOnce([
      makeOrder({ leg: 'A', deal_id: 'DEAL-A-STILL-OPEN', trade_id: 'other-trade' }),
      makeOrder({ leg: 'B', deal_id: 'DEAL-B-1', trade_id: 'trade-1' }),
    ]);
    deps._mocks.getOpenPositions.mockResolvedValue([makeOpenPosition('DEAL-A-STILL-OPEN')]);
    deps._mocks.getActivityHistory.mockResolvedValue([
      {
        date: '2026-04-17T09:30:00Z',
        epic: 'EURUSD',
        dealId: 'DEAL-B-1',
        activity: 'POSITION',
        status: 'STOP_HIT',
        size: 0.5,
        level: 1.0853,
      },
    ]);
    deps._mocks.getTradeById.mockReturnValue(trade);

    await monitorSplitPositions(deps);

    // Partial-win close → trade is complete, not sl_hit.
    expect(deps._mocks.updateTradeStatus).toHaveBeenCalledWith('trade-1', 'complete');
    expect(deps._mocks.deactivateSlTpOrder).toHaveBeenCalledWith('trade-1', 'B');
    // Alert variant is the "trade complete" message, not the SL-hit one.
    expect(deps._mocks.alertTp2Hit).toHaveBeenCalledTimes(1);
    expect(deps._mocks.alertSlHit).not.toHaveBeenCalled();
  });

  // ========================================================
  // 2-leg split-position (post-2026-05-07 restructure): TP1 moves Leg B SL
  // to entry, TP2 finalises. Legacy 3-leg trades (with position_c_id) still
  // covered by the legacy section below — those rows don't go away when
  // Phase 2 ships, so the legacy paths must keep working until they all
  // close out organically.
  // ========================================================

  it('2-leg (NEW NORM): Leg A TP → handleTp1Hit moves ONLY Position B SL to entry (no Leg C amend)', async () => {
    // Post-2026-05-07: place_split_trade persists position_c_id=null. The
    // scheduler's handleTp1Hit must amend only Leg B; the `if (trade.position_c_id)`
    // branch for Leg C must NOT fire. This is the explicit no-Leg-C-amend
    // guard for the new 2-leg path.
    const trade = makeTrade({
      id: 'trade-2leg',
      entry: 1.0853,
      position_b_id: 'DEAL-B-1',
      position_c_id: null,    // EXPLICIT: 2-leg trade has no Leg C
      size_c: null,
      tp3: null,
    });
    const deps = makeDeps();
    deps._mocks.getActiveSlTpOrders.mockReturnValueOnce([
      makeOrder({ leg: 'A', deal_id: 'DEAL-A-1', trade_id: 'trade-2leg' }),
      makeOrder({ leg: 'B', deal_id: 'DEAL-B-1', trade_id: 'trade-2leg' }),
    ]);
    // A closed, B still open. No Leg C ever existed.
    deps._mocks.getOpenPositions.mockResolvedValue([makeOpenPosition('DEAL-B-1')]);
    deps._mocks.getActivityHistory.mockResolvedValue([
      { date: 't', epic: 'EURUSD', dealId: 'DEAL-A-1', activity: 'POSITION', status: 'PROFIT_HIT', size: 0.5, level: 1.0876 },
    ]);
    deps._mocks.getTradeById.mockReturnValue(trade);

    await monitorSplitPositions(deps);

    // EXACTLY ONE amend (Leg B → entry). No Leg C amend.
    expect(deps._mocks.safelyAmendPosition).toHaveBeenCalledTimes(1);
    expect(deps._mocks.safelyAmendPosition).toHaveBeenCalledWith('DEAL-B-1', {
      stopLevel: 1.0853,
    });
    expect(deps._mocks.updateTradeStatus).toHaveBeenCalledWith('trade-2leg', 'tp1_hit');
    expect(deps._mocks.deactivateSlTpOrder).toHaveBeenCalledWith('trade-2leg', 'A');
    expect(deps._mocks.alertTp1Hit).toHaveBeenCalledTimes(1);
  });

  // ========================================================
  // Legacy 3-leg split-position (pre-2026-05-07): TP1 moves B+C SL to BE,
  // TP2 moves C SL to TP1 level, TP3 finalises the trade. These cover the
  // legacy handlers retained for in-flight 3-leg trades that pre-date the
  // 2-TP restructure (e.g. the SILVER trade-a8a0eb21 still riding legacy
  // logic to its original TPs).
  // ========================================================

  it('3-leg: Leg A TP → handleTp1Hit moves BOTH Position B AND Position C SL to entry', async () => {
    const trade = makeTrade({
      id: 'trade-3leg',
      entry: 1.0853,
      position_b_id: 'DEAL-B-1',
      position_c_id: 'DEAL-C-1',
      size_c: 0.33,
      tp3: 1.0922,
    });
    const deps = makeDeps();
    deps._mocks.getActiveSlTpOrders.mockReturnValueOnce([
      makeOrder({ leg: 'A', deal_id: 'DEAL-A-1', trade_id: 'trade-3leg' }),
      makeOrder({ leg: 'B', deal_id: 'DEAL-B-1', trade_id: 'trade-3leg' }),
      makeOrder({ leg: 'C', deal_id: 'DEAL-C-1', trade_id: 'trade-3leg' }),
    ]);
    // A closed, B + C still open.
    deps._mocks.getOpenPositions.mockResolvedValue([
      makeOpenPosition('DEAL-B-1'),
      makeOpenPosition('DEAL-C-1'),
    ]);
    deps._mocks.getActivityHistory.mockResolvedValue([
      { date: 't', epic: 'EURUSD', dealId: 'DEAL-A-1', activity: 'POSITION', status: 'PROFIT_HIT', size: 0.5, level: 1.0876 },
    ]);
    deps._mocks.getTradeById.mockReturnValue(trade);

    await monitorSplitPositions(deps);

    // BE moves fired on BOTH B and C via safelyAmendPosition — the helper
    // round-trips broker-side stopLevel/profitLevel/trailingStop so Capital.com
    // doesn't strip the existing TPs (regression guard for the 2026-05-07 SILVER
    // bug — see fix/sl-be-preserve-tp commit).
    expect(deps._mocks.safelyAmendPosition).toHaveBeenCalledTimes(2);
    expect(deps._mocks.safelyAmendPosition).toHaveBeenCalledWith('DEAL-B-1', {
      stopLevel: 1.0853,
    });
    expect(deps._mocks.safelyAmendPosition).toHaveBeenCalledWith('DEAL-C-1', {
      stopLevel: 1.0853,
    });
    expect(deps._mocks.updateTradeStatus).toHaveBeenCalledWith('trade-3leg', 'tp1_hit');
    expect(deps._mocks.deactivateSlTpOrder).toHaveBeenCalledWith('trade-3leg', 'A');
    expect(deps._mocks.alertTp1Hit).toHaveBeenCalledTimes(1);
  });

  it('3-leg: Leg B TP (after A already TP\'d) → handleTp2Hit moves Position C SL to TP1, status=tp2_hit (NOT complete)', async () => {
    // trade is in 'tp1_hit' state from a prior tick. B just closed at TP2.
    const trade = makeTrade({
      id: 'trade-3leg',
      status: 'tp1_hit',
      entry: 1.0853,
      tp1: 1.0876,
      tp2: 1.0899,
      tp3: 1.0922,
      position_b_id: 'DEAL-B-1',
      position_c_id: 'DEAL-C-1',
      size_c: 0.33,
    });
    const deps = makeDeps();
    deps._mocks.getActiveSlTpOrders.mockReturnValueOnce([
      makeOrder({ leg: 'B', deal_id: 'DEAL-B-1', trade_id: 'trade-3leg' }),
      makeOrder({ leg: 'C', deal_id: 'DEAL-C-1', trade_id: 'trade-3leg' }),
    ]);
    // B closed, C still open.
    deps._mocks.getOpenPositions.mockResolvedValue([makeOpenPosition('DEAL-C-1')]);
    deps._mocks.getActivityHistory.mockResolvedValue([
      { date: 't', epic: 'EURUSD', dealId: 'DEAL-B-1', activity: 'POSITION', status: 'PROFIT_HIT', size: 0.5, level: 1.0899 },
    ]);
    deps._mocks.getTradeById.mockReturnValue(trade);

    await monitorSplitPositions(deps);

    // Key 3-leg behaviour: C SL now trails to TP1 (1.0876), not entry. The helper
    // preserves broker-side TP3 automatically — scheduler just sends the SL change.
    expect(deps._mocks.safelyAmendPosition).toHaveBeenCalledTimes(1);
    expect(deps._mocks.safelyAmendPosition).toHaveBeenCalledWith('DEAL-C-1', {
      stopLevel: 1.0876,
    });
    // Status is the intermediate 'tp2_hit' — trade still running on Leg C.
    expect(deps._mocks.updateTradeStatus).toHaveBeenCalledWith('trade-3leg', 'tp2_hit');
    expect(deps._mocks.updateTradeStatus).not.toHaveBeenCalledWith('trade-3leg', 'complete');
    expect(deps._mocks.deactivateSlTpOrder).toHaveBeenCalledWith('trade-3leg', 'B');
    expect(deps._mocks.alertTp2Hit).toHaveBeenCalledTimes(1);
  });

  it('3-leg: Leg C TP → handleTp3Hit marks trade complete + fires alertTp3Hit', async () => {
    const trade = makeTrade({
      id: 'trade-3leg',
      status: 'tp2_hit',
      tp3: 1.0922,
      position_c_id: 'DEAL-C-1',
      size_c: 0.33,
    });
    const deps = makeDeps();
    const alertTp3Hit = vi.fn(async (_t: TradeRecord) => {});
    deps.alertTp3Hit = alertTp3Hit as unknown as MonitorDeps['alertTp3Hit'];
    deps._mocks.getActiveSlTpOrders.mockReturnValueOnce([
      makeOrder({ leg: 'C', deal_id: 'DEAL-C-1', trade_id: 'trade-3leg' }),
    ]);
    // C closed, nothing else open.
    deps._mocks.getOpenPositions.mockResolvedValue([]);
    deps._mocks.getActivityHistory.mockResolvedValue([
      { date: 't', epic: 'EURUSD', dealId: 'DEAL-C-1', activity: 'POSITION', status: 'PROFIT_HIT', size: 0.33, level: 1.0922 },
    ]);
    deps._mocks.getTradeById.mockReturnValue(trade);

    await monitorSplitPositions(deps);

    expect(deps._mocks.updateTradeStatus).toHaveBeenCalledWith('trade-3leg', 'complete');
    expect(deps._mocks.deactivateSlTpOrder).toHaveBeenCalledWith('trade-3leg', 'C');
    expect(alertTp3Hit).toHaveBeenCalledTimes(1);
    expect(alertTp3Hit).toHaveBeenCalledWith(trade);
    // alertTp2Hit is NOT used for the TP3 fire.
    expect(deps._mocks.alertTp2Hit).not.toHaveBeenCalled();
  });

  it('leg B SL\'d BEFORE any TP (trade.status still open) → true loss: status=sl_hit, alertSlHit fired', async () => {
    // Adversarial case: B closes (SL) while trade is still in 'open' state.
    // handleSlOnLeg deactivates B, no other legs active, trade.status was
    // 'open' → no TP was hit → finalise as sl_hit + alertSlHit.
    const trade = makeTrade({ id: 'trade-1', status: 'open' });
    const deps = makeDeps();
    deps._mocks.getActiveSlTpOrders.mockReturnValueOnce([
      makeOrder({ leg: 'A', deal_id: 'DEAL-A-STILL-OPEN', trade_id: 'other-trade' }),
      makeOrder({ leg: 'B', deal_id: 'DEAL-B-1', trade_id: 'trade-1' }),
    ]);
    deps._mocks.getOpenPositions.mockResolvedValue([makeOpenPosition('DEAL-A-STILL-OPEN')]);
    deps._mocks.getActivityHistory.mockResolvedValue([
      {
        date: '2026-04-17T09:30:00Z',
        epic: 'EURUSD',
        dealId: 'DEAL-B-1',
        activity: 'POSITION',
        status: 'STOP_HIT',
        size: 0.5,
        level: 1.0830,
      },
    ]);
    deps._mocks.getTradeById.mockReturnValue(trade);

    await monitorSplitPositions(deps);

    expect(deps._mocks.updateTradeStatus).toHaveBeenCalledWith('trade-1', 'sl_hit');
    expect(deps._mocks.deactivateSlTpOrder).toHaveBeenCalledWith('trade-1', 'B');
    expect(deps._mocks.alertSlHit).toHaveBeenCalledTimes(1);
    expect(deps._mocks.alertTp2Hit).not.toHaveBeenCalled();
  });
});

// ==================== pingKeepAlive (Blocker 6) ====================

describe('pingKeepAlive', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    _resetPingFailureStreak();
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    _resetPingFailureStreak();
  });

  it('happy path: calls capital.ping(), does NOT alert, leaves streak at 0', async () => {
    const ping = vi.fn().mockResolvedValue(undefined);
    const alertSystemWarning = vi.fn().mockResolvedValue(undefined);

    await pingKeepAlive({ capital: { ping }, alertSystemWarning });

    expect(ping).toHaveBeenCalledTimes(1);
    expect(alertSystemWarning).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(_getPingFailureStreak()).toBe(0);
  });

  it('on first ping failure: logs but does NOT alert (streak below threshold)', async () => {
    const pingError = new Error('HTTP 401 error.invalid.session');
    const ping = vi.fn().mockRejectedValue(pingError);
    const alertSystemWarning = vi.fn().mockResolvedValue(undefined);

    await expect(
      pingKeepAlive({ capital: { ping }, alertSystemWarning }),
    ).resolves.toBeUndefined();

    expect(ping).toHaveBeenCalledTimes(1);
    expect(alertSystemWarning).not.toHaveBeenCalled();
    expect(_getPingFailureStreak()).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[Scheduler] Capital ping failed (streak 1):'),
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('HTTP 401 error.invalid.session'),
    );
    expect(consoleErrorSpy.mock.calls[0]).toHaveLength(1);
  });

  it('alerts exactly once when failure streak reaches threshold (3 consecutive)', async () => {
    const ping = vi.fn().mockRejectedValue(new Error('ECONNABORTED timeout'));
    const alertSystemWarning = vi.fn().mockResolvedValue(undefined);

    // 3 consecutive failures
    await pingKeepAlive({ capital: { ping }, alertSystemWarning });
    await pingKeepAlive({ capital: { ping }, alertSystemWarning });
    await pingKeepAlive({ capital: { ping }, alertSystemWarning });

    expect(ping).toHaveBeenCalledTimes(3);
    expect(alertSystemWarning).toHaveBeenCalledTimes(1);
    expect(alertSystemWarning).toHaveBeenCalledWith(
      expect.stringContaining('Capital.com ping failed 3 consecutive times'),
    );
    expect(alertSystemWarning).toHaveBeenCalledWith(
      expect.stringContaining('ECONNABORTED timeout'),
    );
    expect(_getPingFailureStreak()).toBe(3);
  });

  it('does NOT re-alert on continued failures past threshold (4th, 5th, ...)', async () => {
    const ping = vi.fn().mockRejectedValue(new Error('still down'));
    const alertSystemWarning = vi.fn().mockResolvedValue(undefined);

    // 5 consecutive failures
    for (let i = 0; i < 5; i++) {
      await pingKeepAlive({ capital: { ping }, alertSystemWarning });
    }

    // Alert fired on the 3rd, not on 4th or 5th.
    expect(alertSystemWarning).toHaveBeenCalledTimes(1);
    expect(_getPingFailureStreak()).toBe(5);
  });

  it('successful ping resets the streak (one alert per outage, not per cron)', async () => {
    const ping = vi.fn()
      .mockRejectedValueOnce(new Error('blip 1'))
      .mockRejectedValueOnce(new Error('blip 2'))
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('blip 3'));
    const alertSystemWarning = vi.fn().mockResolvedValue(undefined);

    await pingKeepAlive({ capital: { ping }, alertSystemWarning }); // streak=1
    await pingKeepAlive({ capital: { ping }, alertSystemWarning }); // streak=2
    await pingKeepAlive({ capital: { ping }, alertSystemWarning }); // success — streak=0
    await pingKeepAlive({ capital: { ping }, alertSystemWarning }); // streak=1

    // Threshold never reached — no alerts fired.
    expect(alertSystemWarning).not.toHaveBeenCalled();
    expect(_getPingFailureStreak()).toBe(1);
  });

  it('if alertSystemWarning throws when threshold crossed, swallows + logs cascaded failure', async () => {
    const ping = vi.fn().mockRejectedValue(new Error('ping died'));
    const alertSystemWarning = vi.fn().mockRejectedValue(new Error('telegram died'));

    // 3 consecutive — alert fires on the 3rd and itself fails.
    await pingKeepAlive({ capital: { ping }, alertSystemWarning });
    await pingKeepAlive({ capital: { ping }, alertSystemWarning });
    await expect(
      pingKeepAlive({ capital: { ping }, alertSystemWarning }),
    ).resolves.toBeUndefined();

    expect(ping).toHaveBeenCalledTimes(3);
    expect(alertSystemWarning).toHaveBeenCalledTimes(1);
    // 3 ping-failure logs + 1 cascaded telegram log = 4 total.
    expect(consoleErrorSpy).toHaveBeenCalledTimes(4);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Telegram alert for ping failure also failed'),
    );
  });

  it('handles non-Error thrown values (e.g. string) without crashing', async () => {
    const ping = vi.fn().mockRejectedValue('some string not-an-Error');
    const alertSystemWarning = vi.fn().mockResolvedValue(undefined);

    await expect(
      pingKeepAlive({ capital: { ping }, alertSystemWarning }),
    ).resolves.toBeUndefined();

    // First failure — alert NOT fired (streak below threshold).
    expect(alertSystemWarning).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('some string not-an-Error'),
    );
  });

  it('overlap guard: a 2nd invocation while one is in-flight is a no-op', async () => {
    // Realistic overlap case: capital.ping() hangs (dead TCP socket on a
    // dead session) past the 8-min cron cadence, so the next tick fires
    // while the previous one is still awaiting. Without the guard, two
    // concurrent ticks race on pingFailureStreak.
    let resolveFirstPing: () => void = () => {};
    const firstPingPromise = new Promise<void>((r) => { resolveFirstPing = r; });
    const ping = vi.fn()
      .mockImplementationOnce(() => firstPingPromise)
      .mockResolvedValue(undefined);
    const alertSystemWarning = vi.fn().mockResolvedValue(undefined);

    // Kick off the first invocation but don't await yet — it's hung on the
    // pending promise.
    const firstCall = pingKeepAlive({ capital: { ping }, alertSystemWarning });
    // Second invocation arrives while the first is still in-flight. This
    // should be a no-op — capital.ping() must NOT be called a second time.
    await pingKeepAlive({ capital: { ping }, alertSystemWarning });

    expect(ping).toHaveBeenCalledTimes(1);

    // Now resolve the first one and let it complete.
    resolveFirstPing();
    await firstCall;
    expect(ping).toHaveBeenCalledTimes(1);
    expect(alertSystemWarning).not.toHaveBeenCalled();
  });

  it('threshold gate uses >=: race-overshoot still triggers alert exactly once', async () => {
    // Even if a hypothetical race jumped streak from 2 → 4 (skipping 3),
    // the alert must still fire and only once. We simulate this by directly
    // priming the streak via repeated failures and confirming the alerted
    // flag suppresses re-alerts on subsequent failures.
    const ping = vi.fn().mockRejectedValue(new Error('still down'));
    const alertSystemWarning = vi.fn().mockResolvedValue(undefined);

    for (let i = 0; i < 6; i++) {
      await pingKeepAlive({ capital: { ping }, alertSystemWarning });
    }

    expect(alertSystemWarning).toHaveBeenCalledTimes(1);
    expect(_getPingFailureStreak()).toBe(6);
  });
});

// 2026-05-05 audit (Phase 2 / Round 3 / item 3.1): single-slot overlap queue
// for ICT cycles. Pre-fix: a 15m candle close arriving while ICT is in-flight
// was silently dropped. Post-fix: queue the most recent close, and after the
// in-flight cycle finishes, fire a follow-up cycle if still inside the kill
// zone (and the queued close is < 15 min old).
import {
  makeOverlapQueueState,
  queueOverlap,
  drainOverlap,
} from '../src/scheduler/index.js';

describe('OverlapQueue — single-slot queue for missed candle closes', () => {
  it('starts empty', () => {
    const state = makeOverlapQueueState();
    expect(drainOverlap(state, 1000, 15 * 60_000)).toBeNull();
  });

  it('queues a single overlap and drains it when fresh', () => {
    const state = makeOverlapQueueState();
    queueOverlap(state, 'new 15m candle close', 1000);
    const drained = drainOverlap(state, 1500, 15 * 60_000);
    expect(drained).not.toBeNull();
    expect(drained?.reason).toBe('new 15m candle close');
    expect(drained?.queuedAt).toBe(1000);
  });

  it('drain returns null after first call (queue is empty after drain)', () => {
    const state = makeOverlapQueueState();
    queueOverlap(state, 'r1', 1000);
    drainOverlap(state, 1500, 15 * 60_000);
    expect(drainOverlap(state, 2000, 15 * 60_000)).toBeNull();
  });

  it('newer queue replaces older — single-slot semantics', () => {
    const state = makeOverlapQueueState();
    queueOverlap(state, 'old close', 1000);
    queueOverlap(state, 'newer close', 5000);
    const drained = drainOverlap(state, 6000, 15 * 60_000);
    expect(drained?.reason).toBe('newer close');
    expect(drained?.queuedAt).toBe(5000);
  });

  it('returns null when queued entry is older than maxAgeMs (stale)', () => {
    const state = makeOverlapQueueState();
    queueOverlap(state, 'stale close', 1000);
    const drained = drainOverlap(state, 1000 + 16 * 60_000, 15 * 60_000);
    expect(drained).toBeNull();
  });

  it('clears the queue even when stale (no zombie state)', () => {
    const state = makeOverlapQueueState();
    queueOverlap(state, 'stale', 1000);
    drainOverlap(state, 1000 + 16 * 60_000, 15 * 60_000);
    queueOverlap(state, 'fresh', 2_000_000);
    const drained = drainOverlap(state, 2_000_001, 15 * 60_000);
    expect(drained?.reason).toBe('fresh');
  });

  it('drain on empty state is idempotent', () => {
    const state = makeOverlapQueueState();
    expect(drainOverlap(state, 1000, 15 * 60_000)).toBeNull();
    expect(drainOverlap(state, 2000, 15 * 60_000)).toBeNull();
  });
});

// 2026-05-05 audit (Phase 2 / Round 3 / item 3.2): decideReflectionQueue
// extracted from the closure in monitorSplitPositions. The optional
// postHandlerStatus parameter lets callers skip the DB re-query when they
// already know the status (e.g. handleTp3Hit always sets 'complete').
import { decideReflectionQueue } from '../src/scheduler/index.js';

describe('decideReflectionQueue', () => {
  function mkDeps(opts?: {
    trade?: TradeRecord | null;
    onSchedule?: (fn: () => void) => void;
  }) {
    const scheduled: Array<() => void> = [];
    const ranTradeIds: string[] = [];
    return {
      scheduled,
      ranTradeIds,
      deps: {
        getTradeById: () => opts?.trade ?? null,
        runReflection: async (id: string) => { ranTradeIds.push(id); },
        schedule: (fn: () => void, _ms: number) => {
          scheduled.push(fn);
          opts?.onSchedule?.(fn);
        },
      },
    };
  }

  const finalisedTrade = { id: 't', status: 'complete' } as TradeRecord;
  const interimTrade = { id: 't', status: 'tp1_hit' } as TradeRecord;

  it('queues when explicit postHandlerStatus is finalised — DB never queried', () => {
    let dbCalls = 0;
    const deps = {
      getTradeById: () => { dbCalls++; return null; },
      runReflection: async () => {},
      schedule: () => {},
    };
    const queued = decideReflectionQueue('t', 'complete', deps);
    expect(queued).toBe(true);
    expect(dbCalls).toBe(0); // DB skip — explicit status used
  });

  it('queues when explicit postHandlerStatus is sl_hit', () => {
    const { deps } = mkDeps();
    expect(decideReflectionQueue('t', 'sl_hit', deps)).toBe(true);
  });

  it('queues when explicit postHandlerStatus is closed_early', () => {
    const { deps } = mkDeps();
    expect(decideReflectionQueue('t', 'closed_early', deps)).toBe(true);
  });

  it('does NOT queue when explicit postHandlerStatus is interim (tp1_hit)', () => {
    const { deps, scheduled } = mkDeps();
    expect(decideReflectionQueue('t', 'tp1_hit', deps)).toBe(false);
    expect(scheduled).toHaveLength(0);
  });

  it('falls back to DB re-query when no postHandlerStatus given (finalised case)', () => {
    const { deps, scheduled } = mkDeps({ trade: finalisedTrade });
    expect(decideReflectionQueue('t', undefined, deps)).toBe(true);
    expect(scheduled).toHaveLength(1);
  });

  it('falls back to DB re-query (interim case — no queue)', () => {
    const { deps, scheduled } = mkDeps({ trade: interimTrade });
    expect(decideReflectionQueue('t', undefined, deps)).toBe(false);
    expect(scheduled).toHaveLength(0);
  });

  it('returns false when DB has no trade (and no explicit status)', () => {
    const { deps } = mkDeps({ trade: null });
    expect(decideReflectionQueue('t', undefined, deps)).toBe(false);
  });

  it('schedule callback invokes runReflection with the right trade id', async () => {
    const { deps, ranTradeIds, scheduled } = mkDeps();
    decideReflectionQueue('trade-xyz', 'complete', deps);
    expect(scheduled).toHaveLength(1);
    scheduled[0]();
    // give the catch a microtask to settle (no-op promise)
    await Promise.resolve();
    expect(ranTradeIds).toEqual(['trade-xyz']);
  });
});

// 2026-05-05 audit (Phase 2 / Round 3 / item 3.3): initial-RSS-poll retry.
import { pollWithRetry } from '../src/scheduler/index.js';

describe('pollWithRetry — initial RSS poll retry-with-backoff', () => {
  const noSleep = async (_ms: number) => { /* instant */ };

  it('succeeds on first attempt — no retry, no alert', async () => {
    let pollCalls = 0;
    let alertCalls = 0;
    await pollWithRetry(
      async () => { pollCalls++; },
      async () => { alertCalls++; },
      [1, 1, 1],
      noSleep,
    );
    expect(pollCalls).toBe(1);
    expect(alertCalls).toBe(0);
  });

  it('retries after first failure and succeeds on second attempt', async () => {
    let pollCalls = 0;
    let alertCalls = 0;
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await pollWithRetry(
      async () => {
        pollCalls++;
        if (pollCalls === 1) throw new Error('first transient blip');
      },
      async () => { alertCalls++; },
      [1, 1, 1],
      noSleep,
    );
    expect(pollCalls).toBe(2);
    expect(alertCalls).toBe(0);
    consoleWarnSpy.mockRestore();
  });

  it('exhausts all attempts then alerts', async () => {
    let pollCalls = 0;
    const alertMessages: string[] = [];
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await pollWithRetry(
      async () => {
        pollCalls++;
        throw new Error('persistent network down');
      },
      async (m) => { alertMessages.push(m); },
      [1, 1, 1],
      noSleep,
    );
    expect(pollCalls).toBe(4); // 1 initial + 3 retries
    expect(alertMessages).toHaveLength(1);
    expect(alertMessages[0]).toMatch(/BOOT/);
    expect(alertMessages[0]).toMatch(/persistent network down/);
    consoleWarnSpy.mockRestore();
    consoleErrSpy.mockRestore();
  });

  it('alert failure does not block boot', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      pollWithRetry(
        async () => { throw new Error('always fails'); },
        async () => { throw new Error('telegram down too'); },
        [1, 1, 1],
        noSleep,
      ),
    ).resolves.toBeUndefined();
    consoleWarnSpy.mockRestore();
    consoleErrSpy.mockRestore();
  });

  it('respects custom delays array (length controls retry count)', async () => {
    let pollCalls = 0;
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await pollWithRetry(
      async () => { pollCalls++; throw new Error('fail'); },
      async () => {},
      [1], // only 1 retry
      noSleep,
    );
    expect(pollCalls).toBe(2); // 1 initial + 1 retry
    consoleWarnSpy.mockRestore();
    consoleErrSpy.mockRestore();
  });
});

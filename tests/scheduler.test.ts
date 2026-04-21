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
    expect(deps._mocks.updatePosition).not.toHaveBeenCalled();
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
    expect(deps._mocks.updatePosition).not.toHaveBeenCalled();
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

    // Break-even move: exact numeric match on entry.
    expect(deps._mocks.updatePosition).toHaveBeenCalledTimes(1);
    expect(deps._mocks.updatePosition).toHaveBeenCalledWith('DEAL-B-1', { stopLevel: 1.0853 });

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

    expect(deps._mocks.updatePosition).not.toHaveBeenCalled();
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

    expect(deps._mocks.updatePosition).not.toHaveBeenCalled();
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

    expect(deps._mocks.updatePosition).not.toHaveBeenCalled();
    expect(deps._mocks.updateTradeStatus).not.toHaveBeenCalled();
    expect(deps._mocks.deactivateSlTpOrder).toHaveBeenCalledWith('missing', 'A');
    expect(warnSpy).toHaveBeenCalled();
  });

  it('capital.updatePosition throws (Capital rejects BE move) → error caught, DB still updated, alert still attempted', async () => {
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
    deps._mocks.updatePosition.mockRejectedValueOnce(new Error('Capital API 500'));

    // Should resolve (not throw) despite the Capital failure.
    await expect(monitorSplitPositions(deps)).resolves.toBeUndefined();

    // BE move was attempted with the right args, even though it failed.
    expect(deps._mocks.updatePosition).toHaveBeenCalledWith('DEAL-B-1', { stopLevel: 1.0853 });
    // DB still updated — the monitor does NOT roll back on Capital failure.
    expect(deps._mocks.updateTradeStatus).toHaveBeenCalledWith('trade-1', 'tp1_hit');
    expect(deps._mocks.deactivateSlTpOrder).toHaveBeenCalledWith('trade-1', 'A');
    // Alert was still fired.
    expect(deps._mocks.alertTp1Hit).toHaveBeenCalledTimes(1);
    // Error was logged rather than propagated.
    expect(errSpy).toHaveBeenCalled();
  });

  it('second pass: leg B gone from Capital, activity TP → trade marked complete, alertTp2Hit fired', async () => {
    const trade = makeTrade({ id: 'trade-1', status: 'tp1_hit' });
    const deps = makeDeps();
    // First call: no leg A active (already deactivated on TP1 hit earlier).
    // But monitorSplitPositions early-returns if legAOrders is empty — we need
    // at least one leg-A entry present to reach the Capital calls + leg-B pass.
    // Provide a leg-A row that is STILL OPEN on Capital so the leg-A branch no-ops,
    // letting the second pass execute against the leg-B row.
    deps._mocks.getActiveSlTpOrders
      .mockReturnValueOnce([
        makeOrder({ leg: 'A', deal_id: 'DEAL-A-STILL-OPEN', trade_id: 'other-trade' }),
      ])
      .mockReturnValueOnce([
        makeOrder({ leg: 'B', deal_id: 'DEAL-B-1', trade_id: 'trade-1' }),
      ]);
    // A-open keeps leg-A branch as no-op; B-missing triggers second-pass promotion.
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

  it('second pass: leg B gone from Capital, activity SL → trade marked sl_hit, alertSlHit fired', async () => {
    const trade = makeTrade({ id: 'trade-1', status: 'tp1_hit' });
    const deps = makeDeps();
    deps._mocks.getActiveSlTpOrders
      .mockReturnValueOnce([
        makeOrder({ leg: 'A', deal_id: 'DEAL-A-STILL-OPEN', trade_id: 'other-trade' }),
      ])
      .mockReturnValueOnce([
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
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('happy path: calls capital.ping() and does NOT fire a Telegram alert', async () => {
    const ping = vi.fn().mockResolvedValue(undefined);
    const alertSystemWarning = vi.fn().mockResolvedValue(undefined);

    await pingKeepAlive({ capital: { ping }, alertSystemWarning });

    expect(ping).toHaveBeenCalledTimes(1);
    expect(alertSystemWarning).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('on ping failure: logs, fires alertSystemWarning with the error message, and does NOT re-throw', async () => {
    const pingError = new Error('HTTP 401 error.invalid.session');
    const ping = vi.fn().mockRejectedValue(pingError);
    const alertSystemWarning = vi.fn().mockResolvedValue(undefined);

    // Must not throw — cron wrapper assumes this is safe to await.
    await expect(
      pingKeepAlive({ capital: { ping }, alertSystemWarning }),
    ).resolves.toBeUndefined();

    expect(ping).toHaveBeenCalledTimes(1);
    expect(alertSystemWarning).toHaveBeenCalledTimes(1);
    expect(alertSystemWarning).toHaveBeenCalledWith(
      expect.stringContaining('HTTP 401 error.invalid.session'),
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[Scheduler] Capital ping failed:',
      pingError,
    );
  });

  it('if BOTH ping and alertSystemWarning fail, swallows both and logs each — never re-throws', async () => {
    const ping = vi.fn().mockRejectedValue(new Error('ping died'));
    const alertSystemWarning = vi.fn().mockRejectedValue(new Error('telegram died'));

    await expect(
      pingKeepAlive({ capital: { ping }, alertSystemWarning }),
    ).resolves.toBeUndefined();

    expect(ping).toHaveBeenCalledTimes(1);
    expect(alertSystemWarning).toHaveBeenCalledTimes(1);
    // One log for ping failure, one for the cascaded alert failure.
    expect(consoleErrorSpy).toHaveBeenCalledTimes(2);
  });

  it('handles non-Error thrown values (e.g. string) without crashing', async () => {
    const ping = vi.fn().mockRejectedValue('some string not-an-Error');
    const alertSystemWarning = vi.fn().mockResolvedValue(undefined);

    await expect(
      pingKeepAlive({ capital: { ping }, alertSystemWarning }),
    ).resolves.toBeUndefined();

    expect(alertSystemWarning).toHaveBeenCalledWith(
      expect.stringContaining('some string not-an-Error'),
    );
  });
});

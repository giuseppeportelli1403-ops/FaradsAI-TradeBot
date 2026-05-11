// tests/daily-pnl-aggregator.test.ts
// Tests for aggregateAndUpsertDailyPnl and getTradesWithMissingPnl.
//
// The mixed-format tests (ISO-Z vs space-separator closed_at) directly
// reflect the two production code paths that write closed_at:
//   - updateTradeStatus()    → new Date().toISOString() → '2026-05-07T13:35:01.106Z'
//   - markTradeClosedEarly() → datetime('now')          → '2026-05-06 15:16:43'
// Both must aggregate correctly under SQLite's date() function.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  initDbForTests,
  insertTrade,
  setTradePnl,
  setTradeStatusAndClosedAt,
  aggregateAndUpsertDailyPnl,
  getDailyPnl,
  getTradesWithMissingPnl,
} from '../src/database/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Inserts a closed trade with a controlled closed_at string. Bypasses
 * updateTradeStatus auto-stamping via the test-only setTradeStatusAndClosedAt
 * helper so we can control both the date format and the exact timestamp.
 */
function seedClosedTradeRaw(id: string, pnlTotal: number, closedAt: string): void {
  insertTrade({
    id,
    strategy_tag: 'ICT_INTRADAY',
    instrument: 'GOLD',
    instrument_category: 'COMMODITY',
    direction: 'long',
    setup_type: 'OB_RETEST',
    entry: 4735,
    sl: 4723,
    tp1: 4748,
    tp2: 4760,
    position_a_id: `${id}-A`,
    position_b_id: `${id}-B`,
    size_a: 0.5,
    size_b: 0.3,
    status: 'tp1_hit',
    composite_score: 65,
    kill_zone: 'NY_OPEN',
    news_category: null,
    analyst_decision: 'APPROVE',
    reasoning: '',
    closure_reason: null,
    opened_at: '2026-05-05T07:00:00.000Z',
  } as never);
  // Direct SQL bypass to stamp the exact closed_at format we're testing.
  setTradeStatusAndClosedAt(id, 'complete', closedAt);
  setTradePnl(id, { pnlTotalOverride: pnlTotal });
}

/**
 * Inserts a closed trade with pnl_total = null (i.e. no setTradePnl call).
 * Used by getTradesWithMissingPnl tests.
 */
function seedClosedTradeNoPnl(id: string, closedAt: string): void {
  insertTrade({
    id,
    strategy_tag: 'ICT_INTRADAY',
    instrument: 'GOLD',
    instrument_category: 'COMMODITY',
    direction: 'long',
    setup_type: 'OB_RETEST',
    entry: 4735,
    sl: 4723,
    tp1: 4748,
    tp2: 4760,
    position_a_id: `${id}-A`,
    position_b_id: `${id}-B`,
    size_a: 0.5,
    size_b: 0.3,
    status: 'tp1_hit',
    composite_score: 65,
    kill_zone: 'NY_OPEN',
    news_category: null,
    analyst_decision: 'APPROVE',
    reasoning: '',
    closure_reason: null,
    opened_at: '2026-05-05T07:00:00.000Z',
  } as never);
  setTradeStatusAndClosedAt(id, 'complete', closedAt);
  // Intentionally no setTradePnl call — pnl_total stays NULL.
}

// ---------------------------------------------------------------------------
// aggregateAndUpsertDailyPnl
// ---------------------------------------------------------------------------

describe('aggregateAndUpsertDailyPnl', () => {
  beforeEach(async () => {
    await initDbForTests();
  });

  it('sums pnl_total for all closed trades on the target date', () => {
    // Two trades on 2026-05-07, one on a different day.
    seedClosedTradeRaw('t1', 12.5, '2026-05-07T13:35:01.106Z');
    seedClosedTradeRaw('t2', 6.72, '2026-05-07T07:20:00.000Z');
    seedClosedTradeRaw('t3', -3.21, '2026-05-08T09:00:00.000Z'); // different day — excluded

    aggregateAndUpsertDailyPnl('2026-05-07', 5000);
    const row = getDailyPnl('2026-05-07');
    expect(row?.realised_pnl).toBeCloseTo(19.22);
    expect(row?.equity).toBe(5000);
  });

  it('writes 0 when no trades closed on the date', () => {
    aggregateAndUpsertDailyPnl('2026-05-11', 5000);
    const row = getDailyPnl('2026-05-11');
    expect(row?.realised_pnl).toBe(0);
    expect(row?.equity).toBe(5000);
  });

  it('aggregates trades whose closed_at uses ISO-Z format', () => {
    // Production path: updateTradeStatus() → new Date().toISOString()
    // Produces: '2026-05-07T13:35:01.106Z'
    seedClosedTradeRaw('iso-1', 4.50, '2026-05-07T13:35:01.106Z');
    seedClosedTradeRaw('iso-2', 6.00, '2026-05-07T07:20:00.000Z');
    aggregateAndUpsertDailyPnl('2026-05-07', 5000);
    expect(getDailyPnl('2026-05-07')?.realised_pnl).toBeCloseTo(10.5);
  });

  it('aggregates trades whose closed_at uses space-separator format', () => {
    // Production path: markTradeClosedEarly() → datetime('now')
    // Produces: '2026-05-06 15:16:43'
    seedClosedTradeRaw('space-1', 3.21, '2026-05-06 15:16:43');
    seedClosedTradeRaw('space-2', 1.79, '2026-05-06 09:02:34');
    aggregateAndUpsertDailyPnl('2026-05-06', 5000);
    expect(getDailyPnl('2026-05-06')?.realised_pnl).toBeCloseTo(5.0);
  });

  it('aggregates mixed ISO-Z + space-separator format trades on the same date', () => {
    // Both production paths writing to the same date: the aggregator must
    // handle both timestamp flavours in a single SUM query.
    seedClosedTradeRaw('mix-iso',   2.50, '2026-05-05T08:15:00.000Z');
    seedClosedTradeRaw('mix-space', 4.00, '2026-05-05 14:30:22');
    aggregateAndUpsertDailyPnl('2026-05-05', 5000);
    expect(getDailyPnl('2026-05-05')?.realised_pnl).toBeCloseTo(6.5);
  });
});

// ---------------------------------------------------------------------------
// getTradesWithMissingPnl
// ---------------------------------------------------------------------------

describe('getTradesWithMissingPnl', () => {
  beforeEach(async () => {
    await initDbForTests();
  });

  it('returns trades with pnl_total = NULL', () => {
    // Use today's date so they fall within any sinceDays >= 1 window.
    const today = new Date().toISOString().substring(0, 10);
    seedClosedTradeNoPnl('null-pnl-1', `${today}T10:00:00.000Z`);
    seedClosedTradeNoPnl('null-pnl-2', `${today}T11:00:00.000Z`);

    const results = getTradesWithMissingPnl(7);
    const ids = results.map(r => r.id);
    expect(ids).toContain('null-pnl-1');
    expect(ids).toContain('null-pnl-2');
  });

  it('returns trades with pnl_total = 0', () => {
    const today = new Date().toISOString().substring(0, 10);
    // Seed with explicit 0 override.
    seedClosedTradeRaw('zero-pnl', 0, `${today}T12:00:00.000Z`);

    const results = getTradesWithMissingPnl(7);
    const ids = results.map(r => r.id);
    expect(ids).toContain('zero-pnl');
  });

  it('filters by date(closed_at) within the sinceDays window', () => {
    const today = new Date().toISOString().substring(0, 10);
    const farPast = '2020-01-01'; // well outside any reasonable sinceDays

    seedClosedTradeNoPnl('in-window',   `${today}T10:00:00.000Z`);
    seedClosedTradeNoPnl('out-window',  `${farPast}T10:00:00.000Z`);

    const results = getTradesWithMissingPnl(7);
    const ids = results.map(r => r.id);
    expect(ids).toContain('in-window');
    expect(ids).not.toContain('out-window');
  });

  it('excludes trades that are still open (status = open or tp1_hit)', () => {
    const today = new Date().toISOString().substring(0, 10);

    // Insert a trade that stays at 'tp1_hit' — not yet terminal.
    insertTrade({
      id: 'open-trade',
      strategy_tag: 'ICT_INTRADAY',
      instrument: 'GOLD',
      instrument_category: 'COMMODITY',
      direction: 'long',
      setup_type: 'OB_RETEST',
      entry: 4735,
      sl: 4723,
      tp1: 4748,
      tp2: 4760,
      position_a_id: 'open-A',
      position_b_id: 'open-B',
      size_a: 0.5,
      size_b: 0.3,
      status: 'tp1_hit',
      composite_score: 65,
      kill_zone: 'NY_OPEN',
      news_category: null,
      analyst_decision: 'APPROVE',
      reasoning: '',
      closure_reason: null,
      opened_at: `${today}T07:00:00.000Z`,
    } as never);
    // Don't call setTradeStatusAndClosedAt → status stays 'tp1_hit', closed_at is NULL.

    const results = getTradesWithMissingPnl(7);
    const ids = results.map(r => r.id);
    expect(ids).not.toContain('open-trade');
  });
});

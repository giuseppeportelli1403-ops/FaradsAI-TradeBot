// Tests for getLessonWinRate SQL fix + sl_tp_orders.deal_id column
// (added for the Capital.com migration — dealId is how we reference a
// position in Capital's PUT/DELETE endpoints).
import { describe, it, expect, beforeAll } from 'vitest';
import {
  initDatabaseAsync,
  insertLesson,
  insertTrade,
  getTradeById,
  getLessonWinRate,
  createSlTpOrder,
  getActiveSlTpOrders,
} from '../src/database/index.js';
import type { Lesson } from '../src/types.js';

function makLesson(overrides: Partial<Lesson>): Lesson {
  return {
    lesson_id: `lesson-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    strategy_tag: 'ICT_INTRADAY',
    instrument: 'EURUSD',
    instrument_category: 'forex',
    direction: 'long',
    setup_type: 'FVG',
    kill_zone: 'london',
    hold_duration: '1h',
    news_category: 'C',
    news_description: '',
    composite_score: 70,
    analyst_decision: 'APPROVE',
    position_a_outcome: 'tp1_hit',
    position_b_outcome: 'tp2_hit',
    pnl_a_r: 1.0,
    pnl_b_r: 2.0,
    pnl_total_r: 3.0,
    was_bias_correct: true,
    was_trigger_valid: true,
    was_news_correctly_weighted: true,
    was_split_execution_clean: true,
    score_accuracy_notes: '',
    lesson: 'Test lesson',
    rule_suggestion: '',
    ...overrides,
  };
}

describe('getLessonWinRate', () => {
  // Unique setup/kill-zone tags per test run so the assertions don't collide
  // with stale rows persisted in data/trading-bot.db from prior runs
  // (sql.js has no in-memory isolation for this suite).
  const suiteId = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const SETUP_A = `FVG-${suiteId}`;
  const SETUP_B = `OB-${suiteId}`;
  const KZ_A = `london-${suiteId}`;
  const KZ_B = `ny-${suiteId}`;

  beforeAll(async () => {
    await initDatabaseAsync();

    // Insert 3 winning lessons (pnl_total_r > 0) and 2 losing — all with
    // suite-scoped lesson_ids and setup/kill_zone tags so the assertions
    // count only rows from THIS test run even if the DB file is reused.
    insertLesson(makLesson({ lesson_id: `${suiteId}-win-1`, pnl_total_r: 2.5, setup_type: SETUP_A, kill_zone: KZ_A, strategy_tag: 'ICT_INTRADAY' }));
    insertLesson(makLesson({ lesson_id: `${suiteId}-win-2`, pnl_total_r: 1.0, setup_type: SETUP_A, kill_zone: KZ_A, strategy_tag: 'ICT_INTRADAY' }));
    insertLesson(makLesson({ lesson_id: `${suiteId}-win-3`, pnl_total_r: 0.5, setup_type: SETUP_B, kill_zone: KZ_B, strategy_tag: 'SWING' }));
    insertLesson(makLesson({ lesson_id: `${suiteId}-loss-1`, pnl_total_r: -1.0, setup_type: SETUP_A, kill_zone: KZ_A, strategy_tag: 'ICT_INTRADAY' }));
    insertLesson(makLesson({ lesson_id: `${suiteId}-loss-2`, pnl_total_r: -2.0, setup_type: SETUP_B, kill_zone: KZ_B, strategy_tag: 'SWING' }));
  });

  it('returns correct win rate with 1 filter (suite-scoped)', () => {
    const result = getLessonWinRate({ setup_type: SETUP_A });
    expect(result.total).toBe(3);
    expect(result.wins).toBe(2);
    expect(result.win_rate).toBeCloseTo(66.7, 0);
  });

  it('returns correct win rate with 3 filters (suite-scoped)', () => {
    const result = getLessonWinRate({ setup_type: SETUP_A, kill_zone: KZ_A, strategy_tag: 'ICT_INTRADAY' });
    expect(result.total).toBe(3);
    expect(result.wins).toBe(2);
    expect(result.win_rate).toBeCloseTo(66.7, 0);
  });

  it('returns correct win rate across both suite setups combined', () => {
    // Querying both scoped setups together should return exactly our 5 rows:
    // 3 wins + 2 losses → 60%.
    const a = getLessonWinRate({ setup_type: SETUP_A });
    const b = getLessonWinRate({ setup_type: SETUP_B });
    const total = a.total + b.total;
    const wins = a.wins + b.wins;
    expect(total).toBe(5);
    expect(wins).toBe(3);
    const rate = (wins / total) * 100;
    expect(rate).toBe(60);
  });
});

describe('sl_tp_orders.deal_id column (Capital.com migration)', () => {
  beforeAll(async () => {
    await initDatabaseAsync();
  });

  it('persists and reads back the deal_id when creating an sl_tp_orders row', () => {
    const tradeId = `trade-deal-${Date.now().toString(36)}${Math.random()
      .toString(36)
      .slice(2, 6)}`;
    const dealId = `CAPITAL-DEAL-${tradeId}`;

    createSlTpOrder({
      trade_id: tradeId,
      leg: 'A',
      instrument: 'US100',
      direction: 'long',
      quantity: 1,
      sl_price: 14950,
      tp_price: 15100,
      deal_id: dealId,
    });

    const active = getActiveSlTpOrders();
    const row = active.find((o) => o.trade_id === tradeId);
    expect(row).toBeDefined();
    expect(row?.deal_id).toBe(dealId);
  });

  it('allows null deal_id for legacy rows (backwards compatible)', () => {
    const tradeId = `trade-legacy-${Date.now().toString(36)}${Math.random()
      .toString(36)
      .slice(2, 6)}`;

    createSlTpOrder({
      trade_id: tradeId,
      leg: 'B',
      instrument: 'US100',
      direction: 'long',
      quantity: 1,
      // deal_id intentionally omitted
    });

    const active = getActiveSlTpOrders();
    const row = active.find((o) => o.trade_id === tradeId);
    expect(row).toBeDefined();
    expect(row?.deal_id).toBeNull();
  });
});

describe('insertTrade defensive normalization (regression for 2026-04-21 log_trade crash)', () => {
  // On 2026-04-21 12:58 UTC the bot placed its first real trade (GBPUSD SHORT
  // split-pair on Capital.com demo). But `log_trade` crashed 3 times with
  //   "Wrong API use : tried to bind a value of an unknown type (undefined)"
  // because the Claude agent's JSON payload omitted optional fields. The
  // trade went to Capital.com but never made it to the local DB — orphan
  // state. insertTrade now normalises undefined → null/default before bind.
  beforeAll(async () => {
    await initDatabaseAsync();
  });

  function makeMinimalTrade(overrides: Record<string, unknown> = {}) {
    const uid = `t-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    return {
      id: uid,
      strategy_tag: 'ICT_INTRADAY' as const,
      instrument: 'GBPUSD',
      direction: 'short' as const,
      entry: 1.35146,
      sl: 1.3526,
      tp1: 1.34844,
      tp2: 1.34700,
      size_a: 1700,
      size_b: 1700,
      position_a_id: 'DEAL-A-1',
      position_b_id: 'DEAL-B-1',
      composite_score: 65,
      ...overrides,
    };
  }

  it('accepts a trade with every optional string field omitted (the exact 2026-04-21 failure mode)', () => {
    const trade = makeMinimalTrade();
    // Explicitly don't set: instrument_category, setup_type, status, kill_zone,
    //                      news_category, analyst_decision, reasoning, opened_at
    expect(() => insertTrade(trade as never)).not.toThrow();

    const row = getTradeById(trade.id);
    expect(row).not.toBeNull();
    expect(row?.instrument).toBe('GBPUSD');
    expect(row?.direction).toBe('short');
    expect(row?.kill_zone).toBeNull();        // was undefined → null
    expect(row?.news_category).toBeNull();    // was undefined → null
    expect(row?.analyst_decision).toBeNull(); // was undefined → null
    expect(row?.reasoning).toBeNull();        // was undefined → null
    expect(row?.status).toBe('open');         // default
    expect(row?.instrument_category).toBe('unknown');  // default sentinel
    expect(row?.setup_type).toBe('unspecified');       // default sentinel
    expect(row?.opened_at).toBeTruthy();               // auto-set to now
  });

  it('preserves provided values and does NOT override them with defaults', () => {
    const trade = makeMinimalTrade({
      instrument_category: 'forex',
      setup_type: 'FVG',
      kill_zone: 'NY Open',
      news_category: 'A',
      analyst_decision: 'APPROVE',
      reasoning: 'bearish OB mitigation',
      composite_score: 75,
      status: 'open',
      opened_at: '2026-04-21T12:58:42.000Z',
    });
    insertTrade(trade as never);
    const row = getTradeById(trade.id);
    expect(row?.instrument_category).toBe('forex');
    expect(row?.setup_type).toBe('FVG');
    expect(row?.kill_zone).toBe('NY Open');
    expect(row?.news_category).toBe('A');
    expect(row?.analyst_decision).toBe('APPROVE');
    expect(row?.reasoning).toBe('bearish OB mitigation');
    expect(row?.composite_score).toBe(75);
    expect(row?.opened_at).toBe('2026-04-21T12:58:42.000Z');
  });

  it('throws a clear, actionable error when required fields are missing', () => {
    const broken = { instrument: 'EURUSD', direction: 'long' } as never;
    expect(() => insertTrade(broken)).toThrowError(/required field\(s\) missing: id, strategy_tag/);
  });

  it('null-coerces undefined position_a_id / position_b_id (nullable columns)', () => {
    const trade = makeMinimalTrade({ position_a_id: undefined, position_b_id: undefined });
    expect(() => insertTrade(trade as never)).not.toThrow();
    const row = getTradeById(trade.id);
    expect(row?.position_a_id).toBeNull();
    expect(row?.position_b_id).toBeNull();
  });

  it('defaults numeric NOT-NULL columns to 0 rather than throwing bind-undefined', () => {
    const trade = makeMinimalTrade({
      entry: undefined,  // these would be 0 in DB — weird but inspectable
      sl: undefined,
      tp1: undefined,
      tp2: undefined,
      composite_score: undefined,
    });
    expect(() => insertTrade(trade as never)).not.toThrow();
    const row = getTradeById(trade.id);
    expect(row?.entry).toBe(0);
    expect(row?.sl).toBe(0);
    expect(row?.composite_score).toBe(0);
  });

  it('accepts closed_early status + closure_reason (regression for 2026-04-22 log_trade failure)', () => {
    // On 2026-04-22 14:21 UTC the ICT agent tried to log a USDJPY short
    // that was closed immediately after entry because fill slippage (14.6
    // pips) reduced R:R to TP2 below the 1.5:1 minimum. The CHECK constraint
    // rejected status='closed_rr_violation'. Post-fix, agents can send any
    // closed_* status and the log_trade wrapper normalises to closed_early
    // with the original reason captured in closure_reason.
    const trade = makeMinimalTrade({
      status: 'closed_early',
      closure_reason: 'closed_rr_violation: Fill slippage 14.6 pips reduced R:R below 1.5:1',
    });
    expect(() => insertTrade(trade as never)).not.toThrow();
    const row = getTradeById(trade.id);
    expect(row?.status).toBe('closed_early');
    expect(row?.closure_reason).toContain('closed_rr_violation');
    expect(row?.closure_reason).toContain('14.6 pips');
  });

  it('rejects statuses still outside the CHECK enum (insertTrade does not auto-normalise)', () => {
    // insertTrade is the DB-bind layer. Normalisation of agent-supplied
    // non-canonical statuses happens in the log_trade MCP wrapper
    // (normaliseTradePayload), tested separately. insertTrade itself must
    // still throw on unknown statuses so a direct misuse surfaces clearly.
    const trade = makeMinimalTrade({ status: 'definitely_not_a_status' });
    expect(() => insertTrade(trade as never)).toThrowError();
  });
});

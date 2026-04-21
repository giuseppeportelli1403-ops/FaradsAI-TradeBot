// Tests for getLessonWinRate SQL fix + sl_tp_orders.deal_id column
// (added for the Capital.com migration — dealId is how we reference a
// position in Capital's PUT/DELETE endpoints).
import { describe, it, expect, beforeAll } from 'vitest';
import {
  initDatabaseAsync,
  insertLesson,
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

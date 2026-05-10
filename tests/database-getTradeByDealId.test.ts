// Tests for getTradeByDealId — Phase 2 schema (no position_c_id column)
//
// Background: the 2026-05-09 Phase 2 3-leg-removal migration
// (src/database/index.ts:191-261) dropped the position_c_id column from
// trades. But getTradeByDealId still SELECT-ed `position_c_id`, so the
// next call from the position monitor's close path would have crashed
// with `no such column: position_c_id`. These tests pin down the post-fix
// 2-leg behaviour.
import { describe, it, expect, beforeAll } from 'vitest';
import {
  initDatabaseAsync,
  insertTrade,
  getTradeByDealId,
} from '../src/database/index.js';

describe('getTradeByDealId — Phase 2 schema (no position_c_id column)', () => {
  // Suite-scoped tag so the assertions don't collide with stale rows
  // persisted in data/trading-bot.db from prior runs (sql.js has no
  // in-memory isolation for this suite — same convention as the existing
  // database.test.ts).
  const suiteId = `dealid-${Date.now().toString(36)}${Math.random()
    .toString(36)
    .slice(2, 6)}`;

  beforeAll(async () => {
    await initDatabaseAsync();
  });

  it('finds trade by leg A dealId', () => {
    const tradeId = `${suiteId}-A`;
    const dealA = `${suiteId}-DEAL-A`;
    const dealB = `${suiteId}-DEAL-B`;
    insertTrade({
      id: tradeId,
      strategy_tag: 'ICT_INTRADAY',
      instrument: 'SILVER',
      instrument_category: 'commodity',
      direction: 'long',
      setup_type: 'IFC_LongTrigger',
      entry: 30,
      sl: 29.22,
      tp1: 30.78,
      tp2: 31.02,
      position_a_id: dealA,
      position_b_id: dealB,
      size_a: 7,
      size_b: 3,
      status: 'open',
      composite_score: 78,
      kill_zone: 'NY_OPEN',
      news_category: null,
      analyst_decision: 'APPROVE',
      reasoning: 'test',
    });
    expect(getTradeByDealId(dealA)?.id).toBe(tradeId);
  });

  it('finds trade by leg B dealId', () => {
    const tradeId = `${suiteId}-B`;
    const dealA = `${suiteId}-DEAL-A2`;
    const dealB = `${suiteId}-DEAL-B2`;
    insertTrade({
      id: tradeId,
      strategy_tag: 'ICT_INTRADAY',
      instrument: 'SILVER',
      instrument_category: 'commodity',
      direction: 'long',
      setup_type: 'IFC_LongTrigger',
      entry: 30,
      sl: 29.22,
      tp1: 30.78,
      tp2: 31.02,
      position_a_id: dealA,
      position_b_id: dealB,
      size_a: 7,
      size_b: 3,
      status: 'open',
      composite_score: 78,
      kill_zone: 'NY_OPEN',
      news_category: null,
      analyst_decision: 'APPROVE',
      reasoning: 'test',
    });
    expect(getTradeByDealId(dealB)?.id).toBe(tradeId);
  });

  it('does not throw "no such column: position_c_id" on Phase 2 schema', () => {
    expect(() => getTradeByDealId(`${suiteId}-DEAL-MISSING`)).not.toThrow();
    expect(getTradeByDealId(`${suiteId}-DEAL-MISSING`)).toBeNull();
  });
});

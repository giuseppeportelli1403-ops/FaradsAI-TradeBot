// tests/db-set-trade-pnl.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, insertTrade, getTradeById, setTradePnl } from '../src/database/index.js';

describe('setTradePnl', () => {
  beforeEach(async () => { await initDb(':memory:'); });

  it('writes pnl_a, pnl_b, and derives pnl_total when both legs provided', () => {
    insertTrade({
      id: 'trade-A', strategy_tag: 'ICT_INTRADAY', instrument: 'GOLD',
      instrument_category: 'COMMODITY', direction: 'long', setup_type: 'OB_RETEST',
      entry: 4735, sl: 4723, tp1: 4748, tp2: 4760,
      position_a_id: 'D-A', position_b_id: 'D-B', size_a: 0.5, size_b: 0.3,
      status: 'complete', composite_score: 65, kill_zone: 'NY_OPEN',
      news_category: null, analyst_decision: 'APPROVE', reasoning: '',
      closure_reason: null, opened_at: '2026-05-07T13:16:50.502Z',
    } as never);
    setTradePnl('trade-A', { pnlA: 10.5, pnlB: 8.72 });
    const t = getTradeById('trade-A');
    expect(t?.pnl_a).toBeCloseTo(10.5);
    expect(t?.pnl_b).toBeCloseTo(8.72);
    expect(t?.pnl_total).toBeCloseTo(19.22);
  });

  it('writes pnl_total override when leg pnls unknown', () => {
    insertTrade({
      id: 'trade-B', strategy_tag: 'ICT_INTRADAY', instrument: 'GOLD',
      instrument_category: 'COMMODITY', direction: 'long', setup_type: 'OB_RETEST',
      entry: 4735, sl: 4723, tp1: 4748, tp2: 4760,
      position_a_id: 'D-A', position_b_id: 'D-B', size_a: 0.5, size_b: 0.5,
      status: 'complete', composite_score: 65, kill_zone: 'NY_OPEN',
      news_category: null, analyst_decision: 'APPROVE', reasoning: '',
      closure_reason: null, opened_at: '2026-05-07T13:16:50.502Z',
    } as never);
    setTradePnl('trade-B', { pnlTotalOverride: 12.01 });
    const t = getTradeById('trade-B');
    expect(t?.pnl_a).toBeNull();
    expect(t?.pnl_b).toBeNull();
    expect(t?.pnl_total).toBeCloseTo(12.01);
  });

  it('is idempotent: re-applying the same values is a no-op', () => {
    insertTrade({
      id: 'trade-C', strategy_tag: 'ICT_INTRADAY', instrument: 'GOLD',
      instrument_category: 'COMMODITY', direction: 'long', setup_type: 'OB_RETEST',
      entry: 4735, sl: 4723, tp1: 4748, tp2: 4760,
      position_a_id: 'D-A', position_b_id: 'D-B', size_a: 0.5, size_b: 0.3,
      status: 'complete', composite_score: 65, kill_zone: 'NY_OPEN',
      news_category: null, analyst_decision: 'APPROVE', reasoning: '',
      closure_reason: null, opened_at: '2026-05-07T13:16:50.502Z',
    } as never);
    setTradePnl('trade-C', { pnlA: 10.5, pnlB: 8.72 });
    setTradePnl('trade-C', { pnlA: 10.5, pnlB: 8.72 });
    const t = getTradeById('trade-C');
    expect(t?.pnl_total).toBeCloseTo(19.22);
  });
});

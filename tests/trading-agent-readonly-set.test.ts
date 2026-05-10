import { describe, it, expect } from 'vitest';
import { READ_ONLY_TOOLS } from '../src/agents/trading-agent.js';

describe('READ_ONLY_TOOLS membership (Spec 1 L1 split + 2026-05-10 P2.1)', () => {
  it('does NOT include get_daily_pnl (it upserts daily_pnl_log)', () => {
    expect(READ_ONLY_TOOLS.has('get_daily_pnl')).toBe(false);
  });

  it('includes the actual read-only tools', () => {
    expect(READ_ONLY_TOOLS.has('get_portfolio')).toBe(true);
    expect(READ_ONLY_TOOLS.has('get_ranked_instruments')).toBe(true);
    expect(READ_ONLY_TOOLS.has('get_prices')).toBe(true);
    expect(READ_ONLY_TOOLS.has('get_news_context')).toBe(true);
    expect(READ_ONLY_TOOLS.has('get_economic_calendar')).toBe(true);
    expect(READ_ONLY_TOOLS.has('get_lessons')).toBe(true);
  });
});

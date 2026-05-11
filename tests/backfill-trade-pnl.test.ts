// Smoke tests for scripts/backfill-trade-pnl.ts
//
// Tests the exported pure helpers — no DB init, no Capital API calls.
// The module uses an isMain guard so importing it here does NOT call main().

import { describe, it, expect } from 'vitest';
import {
  filterCandidates,
  isPm2BotRunning,
  FROM,
  TO,
} from '../scripts/backfill-trade-pnl.js';
import type { TradeRecord } from '../src/types.js';

// ==================== HELPERS ====================

function makeTrade(overrides: Partial<TradeRecord>): TradeRecord {
  return {
    id: 'test-id',
    strategy_tag: 'ICT_INTRADAY',
    instrument: 'GOLD',
    instrument_category: 'COMMODITY',
    direction: 'long',
    setup_type: 'OB_RETEST',
    entry: 3000,
    sl: 2990,
    tp1: 3010,
    tp2: 3020,
    position_a_id: 'A',
    position_b_id: 'B',
    size_a: 0.5,
    size_b: 0.3,
    status: 'complete',
    pnl_a: null,
    pnl_b: null,
    pnl_total: null,
    composite_score: 70,
    kill_zone: 'NY_OPEN',
    news_category: null,
    analyst_decision: 'APPROVE',
    reasoning: '',
    closure_reason: null,
    opened_at: '2026-04-25T07:00:00.000Z',
    closed_at: '2026-04-25T08:30:00.000Z',
    ...overrides,
  } as TradeRecord;
}

// ==================== TESTS ====================

describe('filterCandidates', () => {
  it('includes a trade with null pnl_total inside the window', () => {
    const t = makeTrade({ pnl_total: null, closed_at: '2026-04-25T08:30:00.000Z' });
    expect(filterCandidates([t], FROM, TO)).toHaveLength(1);
  });

  it('includes a trade with pnl_total = 0 inside the window', () => {
    const t = makeTrade({ pnl_total: 0, closed_at: '2026-04-26T10:00:00.000Z' });
    expect(filterCandidates([t], FROM, TO)).toHaveLength(1);
  });

  it('includes a trade closed on the last day of the window (2026-05-08)', () => {
    const t = makeTrade({ pnl_total: null, closed_at: '2026-05-08T22:59:59.000Z' });
    expect(filterCandidates([t], FROM, TO)).toHaveLength(1);
  });

  it('excludes a trade closed before FROM', () => {
    const t = makeTrade({ pnl_total: null, closed_at: '2026-04-20T23:59:59.000Z' });
    expect(filterCandidates([t], FROM, TO)).toHaveLength(0);
  });

  it('excludes a trade closed on or after TO (exclusive upper bound)', () => {
    const afterTO = makeTrade({ pnl_total: null, closed_at: '2026-05-09T00:00:00.000Z' });
    expect(filterCandidates([afterTO], FROM, TO)).toHaveLength(0);
  });

  it('excludes a trade with a real pnl_total', () => {
    const t = makeTrade({ pnl_total: 12.5, closed_at: '2026-04-25T08:30:00.000Z' });
    expect(filterCandidates([t], FROM, TO)).toHaveLength(0);
  });

  it('excludes a trade with non-terminal status (open)', () => {
    const t = makeTrade({ status: 'open', pnl_total: null, closed_at: '2026-04-25T08:30:00.000Z' });
    expect(filterCandidates([t], FROM, TO)).toHaveLength(0);
  });

  it('includes sl_hit and closed_early terminal statuses', () => {
    const sl = makeTrade({ status: 'sl_hit', pnl_total: null, closed_at: '2026-04-27T09:00:00.000Z' });
    const ce = makeTrade({ id: 'ce-id', status: 'closed_early', pnl_total: null, closed_at: '2026-04-28T11:00:00.000Z' });
    expect(filterCandidates([sl, ce], FROM, TO)).toHaveLength(2);
  });

  it('excludes a trade with null closed_at', () => {
    const t = makeTrade({ pnl_total: null, closed_at: null });
    expect(filterCandidates([t], FROM, TO)).toHaveLength(0);
  });
});

describe('isPm2BotRunning', () => {
  it('returns false when pm2 is not installed or unavailable (safe default)', () => {
    // This test runs in CI / dev environments where pm2 is NOT present
    // (Windows laptop, GitHub Actions). The function MUST swallow the
    // ENOENT / "command not found" from execSync and return false so
    // --apply isn't blocked in environments where there's no live bot.
    expect(isPm2BotRunning()).toBe(false);
  });
});

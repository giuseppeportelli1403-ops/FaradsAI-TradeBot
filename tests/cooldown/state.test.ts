// Tests for src/cooldown/state.ts. Covers spec.md US-3 acceptance
// scenarios: 3 losses -> active, LLW -> inactive, 25h elapsed clears.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  initDatabaseAsync,
  getDb,
  setPmState,
} from '../../src/database/index.js';
import {
  getCooldownState,
  isCooldownActive,
} from '../../src/cooldown/state.js';

async function freshDb(): Promise<void> {
  await initDatabaseAsync();
  const db = getDb();
  db.run('DELETE FROM trades');
  // Reset cooldown config to spec defaults
  setPmState('cooldown_max_consecutive_losses', '3');
  setPmState('cooldown_clear_after_hours', '24');
}

/**
 * Insert a closed trade. status='sl_hit' = loss. status='complete' with
 * positive pnl = win. closed_at minutes-ago controls ordering.
 */
function plantClosedTrade(opts: {
  id: string;
  status: 'sl_hit' | 'complete' | 'closed_early';
  pnl_total: number;
  closed_minutes_ago: number;
}): void {
  const db = getDb();
  const closedAt = new Date(Date.now() - opts.closed_minutes_ago * 60 * 1000).toISOString();
  // opened_at must be earlier than closed_at; use 60min before closed_at.
  const openedAt = new Date(Date.parse(closedAt) - 60 * 60 * 1000).toISOString();
  db.run(
    `INSERT INTO trades
       (id, strategy_tag, instrument, instrument_category, direction,
        setup_type, entry, sl, tp1, tp2, size_a, size_b, status,
        composite_score, opened_at, closed_at, pnl_total)
     VALUES (?, 'ICT_INTRADAY', 'EURUSD', 'fx_major', 'long',
             'OB_Retest', 1.0, 0.99, 1.01, 1.02, 1, 1, ?, 65, ?, ?, ?)`,
    [opts.id, opts.status, openedAt, closedAt, opts.pnl_total],
  );
}

describe('getCooldownState — loss streak detection', () => {
  beforeEach(async () => {
    await freshDb();
  });

  it('returns inactive on a clean DB (no trades)', () => {
    const s = getCooldownState();
    expect(s.active).toBe(false);
    expect(s.consecutive_losses).toBe(0);
    expect(s.last_loss_closed_at).toBeNull();
    expect(s.clears_at).toBeNull();
  });

  it('returns inactive after 1 loss (max=3)', () => {
    plantClosedTrade({ id: 't1', status: 'sl_hit', pnl_total: -1, closed_minutes_ago: 60 });
    const s = getCooldownState();
    expect(s.consecutive_losses).toBe(1);
    expect(s.active).toBe(false);
  });

  it('returns inactive after 2 losses (max=3)', () => {
    plantClosedTrade({ id: 't1', status: 'sl_hit', pnl_total: -1, closed_minutes_ago: 120 });
    plantClosedTrade({ id: 't2', status: 'sl_hit', pnl_total: -1, closed_minutes_ago: 60 });
    const s = getCooldownState();
    expect(s.consecutive_losses).toBe(2);
    expect(s.active).toBe(false);
  });

  it('returns ACTIVE after 3 consecutive losses (US-3 acceptance scenario 1)', () => {
    plantClosedTrade({ id: 't1', status: 'sl_hit', pnl_total: -1, closed_minutes_ago: 180 });
    plantClosedTrade({ id: 't2', status: 'sl_hit', pnl_total: -1, closed_minutes_ago: 120 });
    plantClosedTrade({ id: 't3', status: 'sl_hit', pnl_total: -1, closed_minutes_ago: 60 });
    const s = getCooldownState();
    expect(s.consecutive_losses).toBe(3);
    expect(s.active).toBe(true);
    expect(s.last_loss_closed_at).not.toBeNull();
    expect(s.clears_at).not.toBeNull();
  });

  it('streak broken by intervening win (LLW pattern, US-3 acceptance scenario 2)', () => {
    // Order by closed_at DESC: t3 (loss, newest) → t2 (win) → t1 (loss).
    // The streak from the front is just 1 loss before the win.
    plantClosedTrade({ id: 't1', status: 'sl_hit', pnl_total: -1, closed_minutes_ago: 180 });
    plantClosedTrade({ id: 't2', status: 'complete', pnl_total: 1.09, closed_minutes_ago: 120 });
    plantClosedTrade({ id: 't3', status: 'sl_hit', pnl_total: -1, closed_minutes_ago: 60 });
    const s = getCooldownState();
    expect(s.consecutive_losses).toBe(1);
    expect(s.active).toBe(false);
  });

  it('clears 25h after the 3rd loss closed (US-3 acceptance scenario 3)', () => {
    // Plant 3 losses where the most recent closed 25h ago.
    plantClosedTrade({ id: 't1', status: 'sl_hit', pnl_total: -1, closed_minutes_ago: 27 * 60 });
    plantClosedTrade({ id: 't2', status: 'sl_hit', pnl_total: -1, closed_minutes_ago: 26 * 60 });
    plantClosedTrade({ id: 't3', status: 'sl_hit', pnl_total: -1, closed_minutes_ago: 25 * 60 });
    const s = getCooldownState();
    expect(s.consecutive_losses).toBe(3);
    expect(s.active).toBe(false);  // 25h > 24h clear window
  });

  it('still active 23h after the 3rd loss closed', () => {
    plantClosedTrade({ id: 't1', status: 'sl_hit', pnl_total: -1, closed_minutes_ago: 25 * 60 });
    plantClosedTrade({ id: 't2', status: 'sl_hit', pnl_total: -1, closed_minutes_ago: 24 * 60 });
    plantClosedTrade({ id: 't3', status: 'sl_hit', pnl_total: -1, closed_minutes_ago: 23 * 60 });
    const s = getCooldownState();
    expect(s.consecutive_losses).toBe(3);
    expect(s.active).toBe(true);   // 23h < 24h clear window
  });

  it('treats negative pnl_total as loss even when status=closed_early', () => {
    plantClosedTrade({ id: 't1', status: 'closed_early', pnl_total: -0.4, closed_minutes_ago: 180 });
    plantClosedTrade({ id: 't2', status: 'closed_early', pnl_total: -0.3, closed_minutes_ago: 120 });
    plantClosedTrade({ id: 't3', status: 'closed_early', pnl_total: -0.2, closed_minutes_ago: 60 });
    const s = getCooldownState();
    expect(s.consecutive_losses).toBe(3);
    expect(s.active).toBe(true);
  });

  it('treats break-even closed_early (pnl=0) as NOT a loss', () => {
    plantClosedTrade({ id: 't1', status: 'sl_hit', pnl_total: -1, closed_minutes_ago: 180 });
    plantClosedTrade({ id: 't2', status: 'closed_early', pnl_total: 0, closed_minutes_ago: 120 });
    plantClosedTrade({ id: 't3', status: 'sl_hit', pnl_total: -1, closed_minutes_ago: 60 });
    const s = getCooldownState();
    // Most recent is loss (1), then BE breaks the streak.
    expect(s.consecutive_losses).toBe(1);
    expect(s.active).toBe(false);
  });

  it('respects max=2 from pm_state config', () => {
    setPmState('cooldown_max_consecutive_losses', '2');
    plantClosedTrade({ id: 't1', status: 'sl_hit', pnl_total: -1, closed_minutes_ago: 120 });
    plantClosedTrade({ id: 't2', status: 'sl_hit', pnl_total: -1, closed_minutes_ago: 60 });
    const s = getCooldownState();
    expect(s.active).toBe(true);
  });

  it('respects clearAfterHours=1 from pm_state config', () => {
    setPmState('cooldown_clear_after_hours', '1');
    plantClosedTrade({ id: 't1', status: 'sl_hit', pnl_total: -1, closed_minutes_ago: 90 });   // 1.5h
    plantClosedTrade({ id: 't2', status: 'sl_hit', pnl_total: -1, closed_minutes_ago: 80 });
    plantClosedTrade({ id: 't3', status: 'sl_hit', pnl_total: -1, closed_minutes_ago: 70 });   // most recent 70min ago
    const s = getCooldownState();
    expect(s.consecutive_losses).toBe(3);
    expect(s.active).toBe(false);  // 70min > 60min clear window
  });

  it('isCooldownActive() matches getCooldownState().active', () => {
    plantClosedTrade({ id: 't1', status: 'sl_hit', pnl_total: -1, closed_minutes_ago: 180 });
    plantClosedTrade({ id: 't2', status: 'sl_hit', pnl_total: -1, closed_minutes_ago: 120 });
    plantClosedTrade({ id: 't3', status: 'sl_hit', pnl_total: -1, closed_minutes_ago: 60 });
    expect(isCooldownActive()).toBe(true);
  });
});

describe('getCooldownState — clock injection', () => {
  beforeEach(async () => {
    await freshDb();
  });

  it('respects an injected `now` for deterministic time-window tests', () => {
    plantClosedTrade({ id: 't1', status: 'sl_hit', pnl_total: -1, closed_minutes_ago: 180 });
    plantClosedTrade({ id: 't2', status: 'sl_hit', pnl_total: -1, closed_minutes_ago: 120 });
    plantClosedTrade({ id: 't3', status: 'sl_hit', pnl_total: -1, closed_minutes_ago: 60 });

    // With now=actual now, cooldown is active (60min < 24h).
    expect(isCooldownActive()).toBe(true);

    // With now advanced 25h forward, cooldown should have cleared.
    const future = new Date(Date.now() + 25 * 60 * 60 * 1000);
    expect(isCooldownActive({ now: future })).toBe(false);
  });
});

// Tests for src/risk-budget/policy.ts. Covers spec.md US-7 acceptance
// scenarios: budget=2.5% allows T2+T2; +T1 rejected; budget=0 preserves
// single-trade behaviour; composes with analyst CHECK 4 (separate concern).

import { describe, it, expect, beforeEach } from 'vitest';
import {
  initDatabaseAsync,
  getDb,
  setPmState,
} from '../../src/database/index.js';
import {
  getRiskBudgetState,
  wouldExceed,
} from '../../src/risk-budget/policy.js';

async function freshDb(): Promise<void> {
  await initDatabaseAsync();
  const db = getDb();
  db.run('DELETE FROM trades');
  setPmState('max_total_risk_pct', '0.0');  // default
}

/**
 * Insert an OPEN trade (closed_at IS NULL) so getOpenTradesRiskPctSum
 * picks it up. composite_score determines tier-mapped risk_pct in the
 * sum helper: 80+ = 1.5%, 60-79 = 1.0%, else 0.5% (range = 0.25%).
 */
function plantOpenTrade(opts: {
  id: string;
  instrument: string;
  composite_score: number;
  setup_type?: string;
}): void {
  const db = getDb();
  const openedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  db.run(
    `INSERT INTO trades
       (id, strategy_tag, instrument, instrument_category, direction,
        setup_type, entry, sl, tp1, tp2, size_a, size_b, status,
        composite_score, opened_at)
     VALUES (?, 'ICT_INTRADAY', ?, 'fx_major', 'long',
             ?, 1.0, 0.99, 1.01, 1.02, 1, 1, 'open', ?, ?)`,
    [opts.id, opts.instrument, opts.setup_type ?? 'OB_Retest', opts.composite_score, openedAt],
  );
}

describe('getRiskBudgetState', () => {
  beforeEach(async () => {
    await freshDb();
  });

  it('returns zero open_risk on a clean DB', () => {
    const s = getRiskBudgetState();
    expect(s.open_risk_pct).toBe(0);
    expect(s.max_total_risk_pct).toBe(0);
  });

  it('reads max_total_risk_pct from pm_state', () => {
    setPmState('max_total_risk_pct', '2.5');
    const s = getRiskBudgetState();
    expect(s.max_total_risk_pct).toBe(2.5);
  });

  it('sums tier-mapped risk across all open trades', () => {
    plantOpenTrade({ id: 't1', instrument: 'EURUSD', composite_score: 70 }); // T2 = 1.0%
    plantOpenTrade({ id: 't2', instrument: 'GBPUSD', composite_score: 85 }); // T1 = 1.5%
    const s = getRiskBudgetState();
    expect(s.open_risk_pct).toBe(2.5);
  });

  it('treats range-mode setups as 0.25% (half-size)', () => {
    plantOpenTrade({
      id: 't1',
      instrument: 'EURUSD',
      composite_score: 55,
      setup_type: 'Range_Sweep_Reversal',
    });
    const s = getRiskBudgetState();
    expect(s.open_risk_pct).toBe(0.25);
  });
});

describe('wouldExceed — budget logic', () => {
  beforeEach(async () => {
    await freshDb();
  });

  it('returns false when max_total_risk_pct=0 (legacy mode, no budget cap)', () => {
    setPmState('max_total_risk_pct', '0.0');
    plantOpenTrade({ id: 't1', instrument: 'EURUSD', composite_score: 70 }); // 1.0% open
    expect(wouldExceed(99.9)).toBe(false);  // no budget = nothing exceeds
  });

  it('budget=2.5%: open T2 (1.0%) + proposed T2 (1.0%) = 2.0% → does NOT exceed (US-7 scenario 1)', () => {
    setPmState('max_total_risk_pct', '2.5');
    plantOpenTrade({ id: 't1', instrument: 'EURUSD', composite_score: 70 });
    expect(wouldExceed(1.0)).toBe(false);
  });

  it('budget=2.5%: open T2+T2 (2.0%) + proposed T1 (1.5%) = 3.5% → EXCEEDS (US-7 scenario 2)', () => {
    setPmState('max_total_risk_pct', '2.5');
    plantOpenTrade({ id: 't1', instrument: 'EURUSD', composite_score: 70 });
    plantOpenTrade({ id: 't2', instrument: 'GBPUSD', composite_score: 70 });
    expect(wouldExceed(1.5)).toBe(true);
  });

  it('budget=2.5%: open exactly equal proposed → does NOT exceed (boundary)', () => {
    setPmState('max_total_risk_pct', '2.5');
    plantOpenTrade({ id: 't1', instrument: 'EURUSD', composite_score: 70 }); // 1.0%
    expect(wouldExceed(1.5)).toBe(false);  // 1.0 + 1.5 = 2.5, NOT >
  });

  it('budget=2.5%: would exceed by 0.01 fires gate', () => {
    setPmState('max_total_risk_pct', '2.5');
    plantOpenTrade({ id: 't1', instrument: 'EURUSD', composite_score: 70 }); // 1.0%
    expect(wouldExceed(1.51)).toBe(true);  // 1.0 + 1.51 = 2.51 > 2.5
  });

  it('accepts a pre-computed state arg to avoid re-querying the DB', () => {
    const customState = { open_risk_pct: 1.0, max_total_risk_pct: 2.5 };
    expect(wouldExceed(1.5, customState)).toBe(false);  // 2.5, NOT >
    expect(wouldExceed(1.6, customState)).toBe(true);   // 2.6 > 2.5
  });
});

describe('US-7 backward compat — budget=0 preserves legacy single-trade-per-instrument', () => {
  beforeEach(async () => {
    await freshDb();
  });

  it('zero budget makes wouldExceed unreachable so the per-instrument lock alone governs', () => {
    setPmState('max_total_risk_pct', '0.0');
    // Even a wildly oversized proposed trade returns false at the
    // budget gate; rejection (if any) comes from per-instrument lock
    // downstream, NOT from this gate.
    expect(wouldExceed(50.0)).toBe(false);
    plantOpenTrade({ id: 't1', instrument: 'EURUSD', composite_score: 90 });
    expect(wouldExceed(50.0)).toBe(false);
  });
});

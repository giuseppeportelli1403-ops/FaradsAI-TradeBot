// Tests for proposalHash — the canonical 14-field projection used as the
// analyst_token. The 2026-04-29 audit added instrument + instrument_category
// + kill_zone to the canonical projection (P0-TA2): pre-fix the hash anchored
// only on `epic`, but downstream code used `instrument` for the coordination
// lock + DB key. If they ever diverged, the LLM could swap them between
// approval and placement undetectably.
import { describe, it, expect } from 'vitest';
import { proposalHash } from '../src/agents/trading-agent.js';
import type { TradeProposal } from '../src/agents/analyst-agent.js';

function mkProposal(overrides: Partial<TradeProposal> = {}): Omit<TradeProposal, 'trade_id'> {
  return {
    strategy_tag: 'ICT_INTRADAY',
    instrument: 'EURUSD',
    epic: 'EURUSD',
    instrument_category: 'fx',
    direction: 'long',
    entry: 1.0850,
    sl: 1.0830,
    tp1: 1.0890,
    tp2: 1.0920,
    tp3: 1.0960,
    size_a: 0.34,
    size_b: 0.33,
    size_c: 0.33,
    total_risk_pct: 1.0,
    composite_score: 65,
    tier: 2,
    setup_type: 'OB_retest',
    kill_zone: 'London Open',
    reasoning: 'free-text reasoning',
    ...overrides,
  };
}

describe('proposalHash', () => {
  it('produces a 16-char hex hash', () => {
    const h = proposalHash(mkProposal());
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic for the same proposal', () => {
    expect(proposalHash(mkProposal())).toBe(proposalHash(mkProposal()));
  });

  it('changes when entry price changes', () => {
    expect(proposalHash(mkProposal())).not.toBe(proposalHash(mkProposal({ entry: 1.0851 })));
  });

  it('changes when sl price changes', () => {
    expect(proposalHash(mkProposal())).not.toBe(proposalHash(mkProposal({ sl: 1.0829 })));
  });

  it('changes when any size changes', () => {
    expect(proposalHash(mkProposal())).not.toBe(proposalHash(mkProposal({ size_a: 0.35 })));
  });

  it('changes when composite_score changes', () => {
    expect(proposalHash(mkProposal())).not.toBe(proposalHash(mkProposal({ composite_score: 70 })));
  });

  it('changes when tier changes', () => {
    expect(proposalHash(mkProposal())).not.toBe(proposalHash(mkProposal({ tier: 1 })));
  });

  it('changes when total_risk_pct changes', () => {
    expect(proposalHash(mkProposal())).not.toBe(proposalHash(mkProposal({ total_risk_pct: 1.5 })));
  });

  it('changes when direction flips', () => {
    expect(proposalHash(mkProposal())).not.toBe(proposalHash(mkProposal({ direction: 'short' })));
  });

  it('changes when instrument changes (audit P0-TA2 — was missing pre-fix)', () => {
    expect(proposalHash(mkProposal())).not.toBe(proposalHash(mkProposal({ instrument: 'GBPUSD' })));
  });

  it('changes when instrument_category changes (audit P0-TA2)', () => {
    expect(proposalHash(mkProposal())).not.toBe(proposalHash(mkProposal({ instrument_category: 'commodity' })));
  });

  it('changes when kill_zone changes (audit P0-TA2)', () => {
    expect(proposalHash(mkProposal())).not.toBe(proposalHash(mkProposal({ kill_zone: 'NY Open' })));
  });

  it('does NOT change when reasoning text changes (free-text, ignored)', () => {
    expect(proposalHash(mkProposal())).toBe(proposalHash(mkProposal({ reasoning: 'totally different prose' })));
  });

  it('is case-insensitive on instrument / epic (canonicalises to upper)', () => {
    expect(proposalHash(mkProposal({ instrument: 'EURUSD', epic: 'EURUSD' })))
      .toBe(proposalHash(mkProposal({ instrument: 'eurusd', epic: 'eurusd' })));
  });

  it('is case-insensitive on setup_type / kill_zone (canonicalises to lower)', () => {
    expect(proposalHash(mkProposal({ setup_type: 'OB_retest', kill_zone: 'London Open' })))
      .toBe(proposalHash(mkProposal({ setup_type: 'ob_retest', kill_zone: 'london open' })));
  });

  it('rounds composite_score before hashing (so 65 vs 65.4 are the same)', () => {
    expect(proposalHash(mkProposal({ composite_score: 65 })))
      .toBe(proposalHash(mkProposal({ composite_score: 65.4 })));
    expect(proposalHash(mkProposal({ composite_score: 65 })))
      .not.toBe(proposalHash(mkProposal({ composite_score: 66 })));
  });
});

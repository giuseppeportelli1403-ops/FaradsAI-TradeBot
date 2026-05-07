// Tests for proposalHash — the canonical projection used as the analyst_token.
// History:
//   - 2026-04-29 audit (P0-TA2): added instrument + instrument_category +
//     kill_zone. Pre-fix the hash anchored only on `epic`, but downstream code
//     used `instrument` for the coordination lock + DB key.
//   - 2026-05-07 (Phase 2 — 2-TP restructure): tp3 + size_c removed.
//   - 2026-05-07 (Codex follow-up): size_a + size_b ALSO removed. Sizing is
//     now server-computed from total_risk_pct + balance + minDealSize; the
//     LLM-supplied size_a/size_b values are ignored on the placement path,
//     so they MUST NOT affect hash identity.
import { describe, it, expect } from 'vitest';
import { proposalHash } from '../src/agents/trading-agent.js';
import type { TradeProposal } from '../src/agents/analyst-agent.js';

function mkProposal(overrides: Partial<TradeProposal> = {}): Omit<TradeProposal, 'trade_id'> {
  // 2026-05-07: tp3 / size_c are nullable on the new TradeProposal type and
  // size_a / size_b are no longer part of the canonical hash. The values
  // below are placeholders — see the 'IGNORED fields' test for proof.
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
    tp3: null,
    size_a: 0.7,
    size_b: 0.3,
    size_c: null,
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

  it('does NOT change when size_a or size_b changes (sizing is server-computed post-Codex-follow-up)', () => {
    // 2026-05-07 Codex follow-up: sizing is server-computed from
    // total_risk_pct + balance + minDealSize. The LLM's size_a/size_b inputs
    // are IGNORED on the placement path, so they must not affect hash
    // identity — otherwise the server-side override at place_split_trade
    // would always trip PROPOSAL_HASH_MISMATCH against the LLM-hashed values
    // from request_analyst_review.
    const base = proposalHash(mkProposal());
    expect(proposalHash(mkProposal({ size_a: 0.35 }))).toBe(base);
    expect(proposalHash(mkProposal({ size_b: 999 }))).toBe(base);
    expect(proposalHash(mkProposal({ size_a: 1, size_b: 1 }))).toBe(base);
  });

  it('does NOT change when tp3 or size_c changes (post-2026-05-07 2-TP restructure ignores legacy 3-leg fields)', () => {
    // 2026-05-07 (Phase 2): the 3-leg ladder collapsed to 2 legs. The hash
    // canonical projection drops tp3 + size_c so any value in those fields
    // (null, 0, a stale 3-leg number from a hand-typed request) hashes the
    // same. Defensive guard for back-compat with proposal payloads that
    // still carry legacy fields.
    const base = proposalHash(mkProposal());
    expect(proposalHash(mkProposal({ tp3: 999 }))).toBe(base);
    expect(proposalHash(mkProposal({ size_c: 999 }))).toBe(base);
    expect(proposalHash(mkProposal({ tp3: 1.0960, size_c: 0.33 }))).toBe(base);
    // null vs number on tp3/size_c also doesn't matter (the canonical
    // projection ignores them entirely).
    expect(proposalHash(mkProposal({ tp3: null }))).toBe(base);
    expect(proposalHash(mkProposal({ tp3: 1.0960 }))).toBe(base);
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

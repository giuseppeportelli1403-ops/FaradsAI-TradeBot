// Tests for normaliseTradePayload — the bridge between the Claude agent's
// log_trade JSON and the insertTrade schema.
//
// Regression context (2026-04-22 14:21 UTC): ICT agent attempted to log a
// USDJPY short that was closed pre-TP due to fill slippage (14.6 pips).
// Three failures cascaded:
//   (1) payload had `strategy: 'ICT_INTRADAY'` but schema expects `strategy_tag`
//   (2) no `id` field at all
//   (3) `status: 'closed_rr_violation'` violated the CHECK enum
// The trade executed on Capital.com but the DB row never persisted — orphan
// audit trail. This suite locks in the three fixes.

import { describe, it, expect, vi } from 'vitest';
import {
  _normaliseTradePayload,
  _placeOrderInputSchema,
  _placeOrderHandler,
  _assertTwoLegOnly,
} from '../src/mcp-server/tools/trading-tools.js';

describe('normaliseTradePayload (log_trade MCP wrapper)', () => {
  it('auto-generates id when the agent omits one', () => {
    const out = _normaliseTradePayload({
      strategy_tag: 'ICT_INTRADAY',
      instrument: 'USDJPY',
      direction: 'short',
    });
    expect(typeof out.id).toBe('string');
    // RFC 4122 UUID v4 shape — 8-4-4-4-12 hex digits
    expect(out.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('preserves a caller-supplied id', () => {
    const out = _normaliseTradePayload({ id: 'agent-supplied-123', instrument: 'GBPUSD', direction: 'long' });
    expect(out.id).toBe('agent-supplied-123');
  });

  it('maps `strategy` → `strategy_tag` when strategy_tag is absent', () => {
    const out = _normaliseTradePayload({
      id: 't-1',
      strategy: 'ICT_INTRADAY',
      instrument: 'USDJPY',
      direction: 'short',
    });
    expect(out.strategy_tag).toBe('ICT_INTRADAY');
  });

  it('does not overwrite an existing strategy_tag with a conflicting `strategy`', () => {
    const out = _normaliseTradePayload({
      id: 't-1',
      strategy: 'SWING',
      strategy_tag: 'ICT_INTRADAY',
      instrument: 'USDJPY',
      direction: 'short',
    });
    expect(out.strategy_tag).toBe('ICT_INTRADAY');
  });

  it('ignores `strategy` values outside the canonical set (no silent coercion of typos)', () => {
    const out = _normaliseTradePayload({
      id: 't-1',
      strategy: 'DAY_TRADE',  // not a valid StrategyTag
      instrument: 'USDJPY',
      direction: 'short',
    });
    expect(out.strategy_tag).toBeUndefined();
  });

  it('derives `entry` from `actual_entry` when the agent uses the split-leg shape', () => {
    const out = _normaliseTradePayload({
      id: 't-1',
      instrument: 'USDJPY',
      direction: 'short',
      actual_entry: 159.187,
      intended_entry: 159.333,
    });
    expect(out.entry).toBe(159.187);
  });

  it('falls back to `intended_entry` when neither `entry` nor `actual_entry` is present', () => {
    const out = _normaliseTradePayload({
      id: 't-1',
      instrument: 'USDJPY',
      direction: 'short',
      intended_entry: 159.333,
    });
    expect(out.entry).toBe(159.333);
  });

  it('preserves an explicit `entry` over actual/intended variants', () => {
    const out = _normaliseTradePayload({
      id: 't-1',
      instrument: 'USDJPY',
      direction: 'short',
      entry: 160.0,
      actual_entry: 159.187,
    });
    expect(out.entry).toBe(160.0);
  });

  it('normalises `closed_rr_violation` → `closed_early` with the original in closure_reason', () => {
    // Exact 2026-04-22 payload shape.
    const out = _normaliseTradePayload({
      id: 't-1',
      instrument: 'USDJPY',
      direction: 'short',
      status: 'closed_rr_violation',
    });
    expect(out.status).toBe('closed_early');
    expect(out.closure_reason).toBe('closed_rr_violation');
  });

  it('prepends the original status to an existing closure_reason (preserves both)', () => {
    const out = _normaliseTradePayload({
      id: 't-1',
      instrument: 'USDJPY',
      direction: 'short',
      status: 'closed_slippage',
      closure_reason: 'Fill slippage 14.6 pips reduced R:R to TP2 below 1.5:1',
    });
    expect(out.status).toBe('closed_early');
    expect(out.closure_reason).toBe('closed_slippage: Fill slippage 14.6 pips reduced R:R to TP2 below 1.5:1');
  });

  it('leaves canonical statuses untouched (no spurious closure_reason)', () => {
    for (const status of ['open', 'tp1_hit', 'tp2_hit', 'complete', 'sl_hit', 'closed_early']) {
      const out = _normaliseTradePayload({
        id: 't-1',
        instrument: 'USDJPY',
        direction: 'short',
        status,
      });
      expect(out.status).toBe(status);
      expect(out.closure_reason).toBeUndefined();
    }
  });

  it('handles the full 2026-04-22 failure payload end-to-end', () => {
    // Literal subset of the payload that failed three times that afternoon.
    const agentPayload = {
      timestamp: '2026-04-22T14:21:19Z',
      strategy: 'ICT_INTRADAY',
      instrument: 'USDJPY',
      direction: 'short',
      tier: 2,
      composite_score: 70,
      kill_zone: 'NY_Open',
      setup_type: 'OB_retest',
      position_a_id: '000154c4-0029-065e-0000-000080e2f5eb',
      position_b_id: '000154c4-0029-065e-0000-000080e2f5ed',
      position_c_id: '000154c4-0029-065e-0000-000080e2f5ef',
      intended_entry: 159.333,
      actual_entry: 159.187,
      sl: 159.42,
      tp1: 159.15,
      tp2: 159.07,
      tp3: 158.99,
      size_a: 6200,
      size_b: 6000,
      size_c: 6000,
      status: 'closed_rr_violation',
      closure_reason: 'Fill slippage of 14.6 pips from analyzed entry to actual fill',
    };
    const out = _normaliseTradePayload(agentPayload);

    // All three original failure modes now cleared:
    expect(out.id).toBeTruthy();                                      // (1) fixed: auto-generated
    expect(out.strategy_tag).toBe('ICT_INTRADAY');                    // (2) fixed: mapped from `strategy`
    expect(out.status).toBe('closed_early');                          // (3) fixed: normalised
    expect(out.closure_reason).toContain('closed_rr_violation');      // original captured
    expect(out.closure_reason).toContain('14.6 pips');                // agent's reason preserved
    expect(out.entry).toBe(159.187);                                  // bonus: derived from actual_entry
  });
});

// ==================== P1 — place_order as LIMIT ====================
//
// Context: ict-agent.md:212 documents "Entry: ... or limit at OB/FVG
// midpoint if price has moved" but pre-P1 the place_order tool was
// market-only and ignored the agent's limit intent. The 2026-04-22
// USDJPY fill demonstrated the cost: 14.6 pips of entry slippage
// gutted R:R from 1.7:1 to 0.5:1. P1 makes place_order limit-only
// with a required entry_price parameter.

describe('place_order tool (P1 — limit-only)', () => {
  it('requires entry_price at the Zod schema level', () => {
    const withoutEntryPrice = {
      epic: 'EURUSD',
      direction: 'long',
      size: 1000,
      sl: 1.08400,
      tp: 1.08800,
      label: 'ICT-EURUSD-A-123',
    };
    const result = _placeOrderInputSchema.safeParse(withoutEntryPrice);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('entry_price'))).toBe(true);
    }
  });

  it('accepts the full schema with a valid entry_price', () => {
    const full = {
      epic: 'EURUSD',
      direction: 'long' as const,
      size: 1000,
      entry_price: 1.08523,
      sl: 1.08400,
      tp: 1.08800,
      label: 'ICT-EURUSD-A-123',
    };
    const result = _placeOrderInputSchema.safeParse(full);
    expect(result.success).toBe(true);
  });

  it('handler dispatches to createWorkingOrder with LIMIT + 15-min goodTillDate', async () => {
    const mockClient = {
      createWorkingOrder: vi.fn().mockResolvedValue({
        dealReference: 'REF-P1',
        dealId: 'WO-P1',
        dealStatus: 'ACCEPTED',
        status: 'ACCEPTED',
        direction: 'BUY',
        epic: 'EURUSD',
        size: 1000,
      }),
    };
    const t0 = Date.now();
    const response = await _placeOrderHandler(mockClient, {
      epic: 'EURUSD',
      direction: 'long',
      size: 1000,
      entry_price: 1.08523,
      sl: 1.08400,
      tp: 1.08800,
      label: 'ICT-EURUSD-A-123',
    });

    expect(mockClient.createWorkingOrder).toHaveBeenCalledTimes(1);
    const callParams = mockClient.createWorkingOrder.mock.calls[0][0];
    expect(callParams.direction).toBe('BUY');
    expect(callParams.epic).toBe('EURUSD');
    expect(callParams.size).toBe(1000);
    expect(callParams.level).toBe(1.08523);
    expect(callParams.type).toBe('LIMIT');
    expect(callParams.timeInForce).toBe('GOOD_TILL_DATE');
    expect(callParams.stopLevel).toBe(1.08400);
    expect(callParams.profitLevel).toBe(1.08800);
    expect(callParams.guaranteedStop).toBe(false);
    expect(callParams.label).toBe('ICT-EURUSD-A-123');

    // Assert goodTillDate is ~15 min from now (±10 sec tolerance).
    // Capital expects ISO-seconds without Z suffix; we append Z for parsing.
    const gtdMs = new Date(callParams.goodTillDate + 'Z').getTime();
    const expectedMs = t0 + 15 * 60 * 1000;
    expect(Math.abs(gtdMs - expectedMs)).toBeLessThan(10_000);

    // Assert response JSON shape.
    const body = JSON.parse(response.content[0].text);
    expect(body.orderType).toBe('LIMIT');
    expect(body.entry_price).toBe(1.08523);
    expect(body.expires_at).toBe(callParams.goodTillDate);
    expect(body.workingOrderId).toBe('WO-P1');
    expect(body.dealReference).toBe('REF-P1');
    expect(body.note).toContain('auto-cancel');
  });
});

// ==================== Phase 1 — 3-leg placement runtime guard ====================
//
// Context: 2026-05-08 Phase 1 of the 3-leg removal. Even after the analyst
// prompt was reduced to a 2-leg ladder (Phase 2, 2026-05-07), the MCP
// placement surface still happily creates a Leg C if any caller passes
// `size_c + tp3`. A stale prompt revision, a hand-rolled MCP request, or an
// LLM regression could re-introduce a 3-leg trade. This guard fails loudly
// at the top of the executor before any other logic.
//
// The fixture builder mirrors the codebase's existing pattern of testing
// exported pure functions (`_placeOrderHandler`, `_normaliseTradePayload`)
// rather than booting an MCP server. `_assertTwoLegOnly` is the guard —
// the executor calls it first, then proceeds to schema parsing / DB binds.

function makePlaceSplitTradeTool(): { executor: (args: Record<string, unknown>) => Promise<unknown> } {
  return {
    executor: async (args) => {
      _assertTwoLegOnly(args);
      // Past the guard → in a real executor, the rest (schema parse,
      // broker call, DB write) would run. Tests for the guard short-circuit
      // here; the third "proceeds normally" case asserts the error
      // message did NOT match, regardless of any downstream throw.
      return { ok: true };
    },
  };
}

describe('place_split_trade — Phase 1 3-leg guard', () => {
  it('throws when size_c is non-null', async () => {
    const tool = makePlaceSplitTradeTool();
    await expect(
      tool.executor({
        instrument: 'GOLD', direction: 'long',
        entry: 4735, sl: 4723, tp1: 4748, tp2: 4751,
        size_a: 0.56, size_b: 0.24,
        size_c: 0.1, // <-- triggers guard
      } as any),
    ).rejects.toThrow(/3-leg placement is no longer supported/);
  });

  it('throws when tp3 is non-null', async () => {
    const tool = makePlaceSplitTradeTool();
    await expect(
      tool.executor({
        instrument: 'GOLD', direction: 'long',
        entry: 4735, sl: 4723, tp1: 4748, tp2: 4751,
        size_a: 0.56, size_b: 0.24,
        tp3: 4760, // <-- triggers guard
      } as any),
    ).rejects.toThrow(/3-leg placement is no longer supported/);
  });

  it('proceeds normally when size_c and tp3 are null/undefined', async () => {
    const tool = makePlaceSplitTradeTool();
    let err: unknown;
    try {
      await tool.executor({
        instrument: 'GOLD', direction: 'long',
        entry: 4735, sl: 4723, tp1: 4748, tp2: 4751,
        size_a: 0.56, size_b: 0.24,
      } as any);
    } catch (e) { err = e; }
    if (err) {
      expect(String(err)).not.toMatch(/3-leg placement is no longer supported/);
    }
  });
});

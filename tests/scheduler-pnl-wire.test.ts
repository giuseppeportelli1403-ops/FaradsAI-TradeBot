// tests/scheduler-pnl-wire.test.ts
// Integration tests: verify that each close path (TP1 partial, TP2 terminal,
// SL terminal, close_position terminal) persists realised P&L after the handler.
//
// Strategy: seed a real in-memory DB via initDbForTests + insertTrade; inject
// vi.fn() stubs for capturePnl and setTradePnl into MonitorDeps (no Capital
// I/O); assert the stubs were called with the right arguments.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  initDbForTests,
  insertTrade,
  getTradeById,
  getActiveSlTpOrders,
  createSlTpOrder,
  deactivateSlTpOrder as realDeactivateSlTpOrder,
} from '../src/database/index.js';
import {
  handleTp1Hit,
  handleTp2Hit,
  handleSlOnLeg,
} from '../src/scheduler/index.js';
import type { PnlCaptureResult } from '../src/scheduler/pnl-capture.js';

// ---------------------------------------------------------------------------
// Shared seed helpers
// ---------------------------------------------------------------------------
const seedTrade = (id: string, status: 'open' | 'tp1_hit' = 'open') =>
  insertTrade({
    id,
    strategy_tag: 'ICT_INTRADAY',
    instrument: 'GOLD',
    instrument_category: 'COMMODITY',
    direction: 'long',
    setup_type: 'OB_RETEST',
    entry: 4735,
    sl: 4723,
    tp1: 4748,
    tp2: 4760,
    position_a_id: 'D-A',
    position_b_id: 'D-B',
    size_a: 0.5,
    size_b: 0.3,
    status,
    composite_score: 65,
    kill_zone: 'NY_OPEN',
    news_category: null,
    analyst_decision: 'APPROVE',
    reasoning: '',
    closure_reason: null,
    opened_at: '2026-05-07T13:16:50.502Z',
  } as never);

/** Register active sl_tp_orders rows for both legs of a trade. */
const seedOrders = (tradeId: string) => {
  createSlTpOrder({
    trade_id: tradeId,
    deal_id: 'D-A',
    leg: 'A',
    instrument: 'GOLD',
    direction: 'long',
    quantity: 0.5,
  });
  createSlTpOrder({
    trade_id: tradeId,
    deal_id: 'D-B',
    leg: 'B',
    instrument: 'GOLD',
    direction: 'long',
    quantity: 0.3,
  });
};

/** Register only leg A sl_tp_order (for terminal SL test). */
const seedLegA = (tradeId: string) => {
  createSlTpOrder({
    trade_id: tradeId,
    deal_id: 'D-A',
    leg: 'A',
    instrument: 'GOLD',
    direction: 'long',
    quantity: 0.5,
  });
};

/** Capital mock — never called in these scheduler unit tests. */
const mockCapital = {
  getOpenPositions: async () => [],
  getActivityHistory: async () => [],
  updatePosition: async () => ({} as never),
  safelyAmendPosition: async () => ({} as never),
  getMarketDetails: async () => ({} as never),
} as never;

/** Build a deterministic PnlCaptureResult stub. */
const foundResult = (overrides?: Partial<PnlCaptureResult>): PnlCaptureResult => ({
  pnlA: 10.5,
  pnlB: 8.72,
  pnlTotal: 19.22,
  matched: 2,
  unmatched: 0,
  note: '',
  found: true,
  ...overrides,
});

// ---------------------------------------------------------------------------
// PATH 1 — TP1 partial (leg A closes, leg B still live)
// ---------------------------------------------------------------------------
describe('handleTp1Hit + P&L capture (TP1 partial)', () => {
  beforeEach(async () => {
    await initDbForTests();
  });

  it('writes pnl_a after TP1 leg-A close', async () => {
    seedTrade('trade-tp1');
    seedOrders('trade-tp1');
    const trade = getTradeById('trade-tp1')!;

    const setTradePnlStub = vi.fn();
    const capturePnl = vi.fn().mockResolvedValue(
      foundResult({ pnlB: null, pnlTotal: 10.5, matched: 1, unmatched: 0 }),
    );

    await handleTp1Hit(trade, 'trade-tp1', {
      capital: mockCapital,
      getActiveSlTpOrders,
      getTradeById,
      deactivateSlTpOrder: () => {},
      updateTradeStatus: () => {},
      alertTp1Hit: async () => {},
      alertTp2Hit: async () => {},
      alertSlHit: async () => {},
      capturePnl,
      setTradePnl: setTradePnlStub,
    } as never);

    expect(capturePnl).toHaveBeenCalledOnce();
    // windowMode must be 'partial' for TP1
    expect(capturePnl.mock.calls[0][1]).toBe('partial');
    // setTradePnl must be called with pnlA only (no pnlB)
    expect(setTradePnlStub).toHaveBeenCalledWith('trade-tp1', { pnlA: 10.5 });
  });

  it('falls back to pnlTotalOverride when pnlA is null (ambiguous leg sizes)', async () => {
    seedTrade('trade-tp1-ambig');
    seedOrders('trade-tp1-ambig');
    const trade = getTradeById('trade-tp1-ambig')!;

    const setTradePnlStub = vi.fn();
    // pnlA is null — ambiguous sizes scenario
    const capturePnl = vi.fn().mockResolvedValue(
      foundResult({ pnlA: null, pnlB: null, pnlTotal: 10.5, matched: 1 }),
    );

    await handleTp1Hit(trade, 'trade-tp1-ambig', {
      capital: mockCapital,
      getActiveSlTpOrders,
      getTradeById,
      deactivateSlTpOrder: () => {},
      updateTradeStatus: () => {},
      alertTp1Hit: async () => {},
      alertTp2Hit: async () => {},
      alertSlHit: async () => {},
      capturePnl,
      setTradePnl: setTradePnlStub,
    } as never);

    expect(setTradePnlStub).toHaveBeenCalledWith('trade-tp1-ambig', { pnlTotalOverride: 10.5 });
  });
});

// ---------------------------------------------------------------------------
// PATH 2 — TP2 terminal
// ---------------------------------------------------------------------------
describe('handleTp2Hit + P&L capture (TP2 terminal)', () => {
  beforeEach(async () => {
    await initDbForTests();
  });

  it('writes pnl_a and pnl_b after TP2 terminal close', async () => {
    seedTrade('trade-tp2', 'tp1_hit');
    seedOrders('trade-tp2');
    const trade = getTradeById('trade-tp2')!;

    const setTradePnlStub = vi.fn();
    const capturePnl = vi.fn().mockResolvedValue(foundResult());

    await handleTp2Hit(trade, 'trade-tp2', {
      capital: mockCapital,
      getActiveSlTpOrders,
      getTradeById,
      deactivateSlTpOrder: () => {},
      updateTradeStatus: () => {},
      alertTp1Hit: async () => {},
      alertTp2Hit: async () => {},
      alertSlHit: async () => {},
      capturePnl,
      setTradePnl: setTradePnlStub,
    } as never);

    expect(capturePnl).toHaveBeenCalledOnce();
    // windowMode must be 'terminal' for TP2
    expect(capturePnl.mock.calls[0][1]).toBe('terminal');
    expect(setTradePnlStub).toHaveBeenCalledWith('trade-tp2', { pnlA: 10.5, pnlB: 8.72 });
  });

  it('uses pnlTotalOverride when pnlA and pnlB are both null (ambiguous sizes)', async () => {
    seedTrade('trade-tp2-ambig', 'tp1_hit');
    const trade = getTradeById('trade-tp2-ambig')!;

    const setTradePnlStub = vi.fn();
    const capturePnl = vi.fn().mockResolvedValue(
      foundResult({ pnlA: null, pnlB: null, pnlTotal: 19.22 }),
    );

    await handleTp2Hit(trade, 'trade-tp2-ambig', {
      capital: mockCapital,
      getActiveSlTpOrders,
      getTradeById,
      deactivateSlTpOrder: () => {},
      updateTradeStatus: () => {},
      alertTp1Hit: async () => {},
      alertTp2Hit: async () => {},
      alertSlHit: async () => {},
      capturePnl,
      setTradePnl: setTradePnlStub,
    } as never);

    expect(setTradePnlStub).toHaveBeenCalledWith('trade-tp2-ambig', { pnlTotalOverride: 19.22 });
  });
});

// ---------------------------------------------------------------------------
// PATH 3 — SL terminal
// ---------------------------------------------------------------------------
describe('handleSlOnLeg + P&L capture (SL terminal)', () => {
  beforeEach(async () => {
    await initDbForTests();
  });

  it('writes pnl_a and pnl_b after terminal SL close (uses real deactivateSlTpOrder)', async () => {
    seedTrade('trade-sl-term');
    // Seed only leg A — so after deactivation, stillActive will be empty → terminal branch fires.
    seedLegA('trade-sl-term');
    const trade = getTradeById('trade-sl-term')!;

    const setTradePnlStub = vi.fn();
    const capturePnl = vi.fn().mockResolvedValue(foundResult());

    await handleSlOnLeg(trade, 'trade-sl-term', 'A', {
      capital: mockCapital,
      getActiveSlTpOrders,
      getTradeById,
      deactivateSlTpOrder: realDeactivateSlTpOrder,
      updateTradeStatus: () => {},
      alertTp1Hit: async () => {},
      alertTp2Hit: async () => {},
      alertSlHit: async () => {},
      capturePnl,
      setTradePnl: setTradePnlStub,
    } as never);

    expect(capturePnl).toHaveBeenCalledOnce();
    // windowMode must be 'terminal' for SL terminal
    expect(capturePnl.mock.calls[0][1]).toBe('terminal');
    expect(setTradePnlStub).toHaveBeenCalledWith('trade-sl-term', { pnlA: 10.5, pnlB: 8.72 });
  });
});

// ---------------------------------------------------------------------------
// NEGATIVE TESTS (scheduler paths)
// ---------------------------------------------------------------------------
describe('P&L capture error handling (scheduler)', () => {
  beforeEach(async () => {
    await initDbForTests();
  });

  it('capture failure does NOT block the status update (TP2)', async () => {
    seedTrade('trade-fail', 'tp1_hit');
    const trade = getTradeById('trade-fail')!;

    let statusWasUpdated = false;
    const capturePnl = vi.fn().mockRejectedValue(new Error('broker timeout'));
    const setTradePnlStub = vi.fn();

    await handleTp2Hit(trade, 'trade-fail', {
      capital: mockCapital,
      getActiveSlTpOrders,
      getTradeById,
      deactivateSlTpOrder: () => {},
      updateTradeStatus: () => {
        statusWasUpdated = true;
      },
      alertTp1Hit: async () => {},
      alertTp2Hit: async () => {},
      alertSlHit: async () => {},
      capturePnl,
      setTradePnl: setTradePnlStub,
    } as never);

    // Status update must have fired even though capturePnl threw.
    expect(statusWasUpdated).toBe(true);
    // setTradePnl must NOT have been called (capture failed before result).
    expect(setTradePnlStub).not.toHaveBeenCalled();
  });

  it('found=false leaves pnl_total null — no DB write (TP2 path)', async () => {
    seedTrade('trade-notfound', 'tp1_hit');
    const trade = getTradeById('trade-notfound')!;

    const setTradePnlStub = vi.fn();
    const capturePnl = vi.fn().mockResolvedValue({
      pnlA: null,
      pnlB: null,
      pnlTotal: 0,
      matched: 0,
      unmatched: 0,
      note: 'no transactions in window',
      found: false,
    } satisfies PnlCaptureResult);

    await handleTp2Hit(trade, 'trade-notfound', {
      capital: mockCapital,
      getActiveSlTpOrders,
      getTradeById,
      deactivateSlTpOrder: () => {},
      updateTradeStatus: () => {},
      alertTp1Hit: async () => {},
      alertTp2Hit: async () => {},
      alertSlHit: async () => {},
      capturePnl,
      setTradePnl: setTradePnlStub,
    } as never);

    // capturePnl was called but found=false → no write.
    expect(capturePnl).toHaveBeenCalledOnce();
    expect(setTradePnlStub).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// PATH 4 — close_position terminal (trading-agent executeTool)
// Test via vi.spyOn on the pnl-capture and database modules. The trading-agent
// uses module-level imports (no DI surface), so we spy on the real exports.
// ---------------------------------------------------------------------------
describe('close_position + P&L capture (terminal)', () => {
  beforeEach(async () => {
    await initDbForTests();
  });

  it('calls capturePnlForTrade with windowMode=terminal and setTradePnl after markTradeClosedEarly', async () => {
    seedTrade('trade-ce');
    seedLegA('trade-ce');

    const pnlCapture = await import('../src/scheduler/pnl-capture.js');
    const dbModule = await import('../src/database/index.js');

    const captureSpy = vi.spyOn(pnlCapture, 'capturePnlForTrade').mockResolvedValue(
      foundResult({ pnlB: null, pnlTotal: 10.5, matched: 1, unmatched: 0 }),
    );
    const setPnlSpy = vi.spyOn(dbModule, 'setTradePnl');

    // Stub the capital singleton used by trading-agent
    const capitalModule = await import('../src/mcp-server/capital-singleton.js');
    const capitalSpy = vi.spyOn(capitalModule, 'capital', 'get').mockReturnValue({
      closePosition: async () => ({ status: 'CLOSED', dealId: 'D-A' }),
    } as never);

    const { executeTool } = await import('../src/agents/trading-agent.js');
    await executeTool('close_position', { dealId: 'D-A', reason: 'manual test' });

    expect(captureSpy).toHaveBeenCalledOnce();
    expect(captureSpy.mock.calls[0][0]).toMatchObject({ windowMode: 'terminal' });
    expect(setPnlSpy).toHaveBeenCalled();

    captureSpy.mockRestore();
    setPnlSpy.mockRestore();
    capitalSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// PATH 5 — close_position partial (codex plan-review amendment, mandated test)
//
// Trigger: agent closes one leg via close_position while the OTHER leg's
// sl_tp_order is still active. The handler must:
//   (a) deactivate only the matched leg's order (not markTradeClosedEarly)
//   (b) call capturePnlForTrade with windowMode='partial'
//   (c) write setTradePnl({ pnlA: x }) when the matched leg is 'A', else { pnlB: x }
//   (d) leave the trade's status untouched (still 'open' or whatever it was)
//
// We use the same vi.spyOn pattern as the terminal test — seeding BOTH legs
// in sl_tp_orders is what makes remainingActive.length > 0 → partial branch.
// ---------------------------------------------------------------------------
describe('close_position + P&L capture (partial)', () => {
  beforeEach(async () => {
    await initDbForTests();
  });

  it('captures partial P&L for the just-closed leg when other legs remain active', async () => {
    seedTrade('trade-partial');
    // BOTH legs active → closing leg A leaves leg B running → partial branch.
    seedOrders('trade-partial');

    const pnlCapture = await import('../src/scheduler/pnl-capture.js');
    const dbModule = await import('../src/database/index.js');

    const captureSpy = vi.spyOn(pnlCapture, 'capturePnlForTrade').mockResolvedValue(
      foundResult({ pnlA: 10.5, pnlB: null, pnlTotal: 10.5, matched: 1, unmatched: 0 }),
    );
    const setPnlSpy = vi.spyOn(dbModule, 'setTradePnl');

    const capitalModule = await import('../src/mcp-server/capital-singleton.js');
    const capitalSpy = vi.spyOn(capitalModule, 'capital', 'get').mockReturnValue({
      closePosition: async () => ({ status: 'CLOSED', dealId: 'D-A' }),
    } as never);

    const { executeTool } = await import('../src/agents/trading-agent.js');
    const resultJson = await executeTool('close_position', { dealId: 'D-A', reason: 'manual partial' });
    const result = JSON.parse(resultJson);

    // (a) capturePnlForTrade was called with windowMode='partial'
    expect(captureSpy).toHaveBeenCalledOnce();
    expect(captureSpy.mock.calls[0][0]).toMatchObject({ windowMode: 'partial' });

    // (b) setTradePnl was called with pnlA only (matched leg = A)
    expect(setPnlSpy).toHaveBeenCalledWith('trade-partial', { pnlA: 10.5 });

    // (c) trade is NOT closed_early — leg B still active
    expect(result.trade_status).not.toBe('closed_early');
    expect(result.remaining_legs).toBe(1);
    const trade = getTradeById('trade-partial');
    expect(trade?.status).toBe('open');

    captureSpy.mockRestore();
    setPnlSpy.mockRestore();
    capitalSpy.mockRestore();
  });

  it('attributes P&L to leg B when matched leg is B', async () => {
    seedTrade('trade-partial-b');
    seedOrders('trade-partial-b');

    const pnlCapture = await import('../src/scheduler/pnl-capture.js');
    const dbModule = await import('../src/database/index.js');

    const captureSpy = vi.spyOn(pnlCapture, 'capturePnlForTrade').mockResolvedValue(
      foundResult({ pnlA: null, pnlB: 8.72, pnlTotal: 8.72, matched: 1, unmatched: 0 }),
    );
    const setPnlSpy = vi.spyOn(dbModule, 'setTradePnl');

    const capitalModule = await import('../src/mcp-server/capital-singleton.js');
    const capitalSpy = vi.spyOn(capitalModule, 'capital', 'get').mockReturnValue({
      closePosition: async () => ({ status: 'CLOSED', dealId: 'D-B' }),
    } as never);

    const { executeTool } = await import('../src/agents/trading-agent.js');
    await executeTool('close_position', { dealId: 'D-B', reason: 'manual partial leg B' });

    expect(captureSpy.mock.calls[0][0]).toMatchObject({ windowMode: 'partial' });
    expect(setPnlSpy).toHaveBeenCalledWith('trade-partial-b', { pnlB: 8.72 });

    captureSpy.mockRestore();
    setPnlSpy.mockRestore();
    capitalSpy.mockRestore();
  });
});

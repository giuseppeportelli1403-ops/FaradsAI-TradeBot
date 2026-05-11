// Defense-in-depth tests for the 2026-05-11 analyst_token hardening:
// request_analyst_review must return empty-string analyst_token on any
// non-APPROVE decision so that a caller which ignores the `decision`
// field and forwards the token to place_split_trade hits the token
// validation gate and fails closed.
//
// Mocks pattern adapted from tests/scanner-min-deal-size.test.ts and
// tests/trading-agent-loop.test.ts. We mock every external dep that
// executeTool('request_analyst_review', …) touches so the test runs
// hermetically.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock factories are hoisted above imports. Use vi.hoisted() to share refs.
const {
  mockRunAnalystAgent,
  mockGetAccounts,
  mockGetMarketDetails,
  mockLoadPrompt,
  mockLoadPromptWithDemoContext,
  mockLoadStrategy,
  mockLoadRecentJournal,
  mockGetLatestBrief,
  mockCountOpenPositions,
  mockGetOpenTradesByInstrument,
  mockGetRealisedPnlSince,
  mockLogAnalystDecision,
  mockFetchForexFactoryCalendar,
} = vi.hoisted(() => ({
  mockRunAnalystAgent: vi.fn(),
  mockGetAccounts: vi.fn(),
  mockGetMarketDetails: vi.fn(),
  mockLoadPrompt: vi.fn().mockReturnValue('mock prompt'),
  mockLoadPromptWithDemoContext: vi.fn().mockReturnValue('mock prompt'),
  mockLoadStrategy: vi.fn().mockReturnValue('mock strategy'),
  mockLoadRecentJournal: vi.fn().mockReturnValue(null),
  mockGetLatestBrief: vi.fn().mockReturnValue(null),
  mockCountOpenPositions: vi.fn().mockReturnValue(0),
  mockGetOpenTradesByInstrument: vi.fn().mockReturnValue([]),
  mockGetRealisedPnlSince: vi.fn().mockReturnValue(0),
  mockLogAnalystDecision: vi.fn(),
  mockFetchForexFactoryCalendar: vi.fn().mockResolvedValue([]),
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: vi.fn() };
  },
}));

vi.mock('../src/agents/analyst-agent.js', () => ({
  runAnalystAgent: mockRunAnalystAgent,
}));

vi.mock('../src/agents/load-prompt.js', () => ({
  loadPrompt: mockLoadPrompt,
  loadPromptWithDemoContext: mockLoadPromptWithDemoContext,
  loadStrategy: mockLoadStrategy,
}));

vi.mock('../src/agents/eod-journal-agent.js', () => ({
  loadRecentJournal: mockLoadRecentJournal,
}));

vi.mock('../src/notifications/telegram.js', () => ({
  alertSystemWarning: vi.fn().mockResolvedValue(undefined),
  alertTradePlaced: vi.fn().mockResolvedValue(undefined),
  alertOrphanPositions: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/mcp-server/capital-singleton.js', () => ({
  capital: {
    getAccounts: mockGetAccounts,
    getMarketDetails: mockGetMarketDetails,
    getOpenPositions: vi.fn().mockResolvedValue([]),
    openPosition: vi.fn(),
    closePosition: vi.fn(),
    safelyAmendPosition: vi.fn(),
  },
}));

vi.mock('../src/scanner/index.js', () => ({
  getRankedInstruments: vi.fn().mockResolvedValue([]),
  INSTRUMENT_UNIVERSE: [
    { ticker: 'EURUSD', epic: 'EURUSD', name: 'EUR/USD', category: 'fx', spread_quality: 'tight' },
  ],
}));

vi.mock('../src/scheduler/pnl-capture.js', () => ({
  capturePnlForTrade: vi.fn(),
  captureAndPersistPnl: vi.fn(),
}));

vi.mock('../src/news/calendar-veto.js', () => ({
  instrumentToCurrencies: vi.fn().mockReturnValue([]),
  shouldVetoOrderForCalendar: vi.fn().mockReturnValue(false),
}));

vi.mock('../src/news/forex-factory-calendar.js', () => ({
  fetchForexFactoryCalendar: mockFetchForexFactoryCalendar,
}));

vi.mock('../src/database/index.js', () => ({
  getLatestBrief: mockGetLatestBrief,
  countOpenPositions: mockCountOpenPositions,
  getOpenTradesByInstrument: mockGetOpenTradesByInstrument,
  getRealisedPnlSince: mockGetRealisedPnlSince,
  logAnalystDecision: mockLogAnalystDecision,
  setTradePnl: vi.fn(),
}));

// Import after all mocks are wired.
import { executeTool, _resetAnalystApprovals } from '../src/agents/trading-agent.js';

// Standard valid proposal input shape for request_analyst_review.
// EURUSD long entry 1.0850, SL 1.0800, TP1 1.0900, TP2 1.0950 — 50-pip SL,
// 50/100-pip targets → R:R 1.0/2.0 (passes 1.5R total floor on tier 1).
const validProposalInput: Record<string, unknown> = {
  instrument: 'EURUSD',
  epic: 'EURUSD',
  direction: 'long',
  entry: 1.0850,
  sl: 1.0800,
  tp1: 1.0900,
  tp2: 1.0950,
  composite_score: 80,
  tier: 1,
  total_risk_pct: 1.0,
  setup_type: 'OB Retest',
  kill_zone: 'London Open',
};

describe('request_analyst_review — analyst_token hardening (2026-05-11)', () => {
  beforeEach(() => {
    mockRunAnalystAgent.mockReset();
    mockLogAnalystDecision.mockReset();
    mockGetAccounts.mockReset().mockResolvedValue([
      { accountId: 'a', preferred: true, balance: { balance: 10000, deposit: 10000, profitLoss: 0, available: 10000 } },
    ]);
    mockGetMarketDetails.mockReset().mockResolvedValue({
      dealingRules: { minDealSize: { value: 1000 } },
    });
    _resetAnalystApprovals();
  });

  it('returns empty analyst_token on REJECT (defense-in-depth against caller misinterpretation)', async () => {
    mockRunAnalystAgent.mockResolvedValueOnce({
      decision: 'REJECT',
      reason: 'banned pattern',
      confidence: 0.95,
    });

    const result = await executeTool('request_analyst_review', validProposalInput);
    const parsed = JSON.parse(result);

    expect(parsed.decision).toBe('REJECT');
    expect(parsed.analyst_token).toBe('');
    // hash still returned for log correlation
    expect(typeof parsed.proposal_hash).toBe('string');
    expect(parsed.proposal_hash.length).toBeGreaterThan(0);
    // Defense against a future pre-check short-circuit that would silently
    // bypass the analyst call and still return the shape we assert above.
    expect(mockRunAnalystAgent).toHaveBeenCalledTimes(1);
  });

  it('returns hash as analyst_token on APPROVE', async () => {
    mockRunAnalystAgent.mockResolvedValueOnce({
      decision: 'APPROVE',
      reason: 'all good',
      confidence: 0.85,
    });

    const result = await executeTool('request_analyst_review', validProposalInput);
    const parsed = JSON.parse(result);

    expect(parsed.decision).toBe('APPROVE');
    expect(parsed.analyst_token).toBe(parsed.proposal_hash);
    expect(parsed.analyst_token.length).toBeGreaterThan(0);
    expect(mockRunAnalystAgent).toHaveBeenCalledTimes(1);
  });

  // Codex finding #5 (2026-05-11): integration test through the real
  // request_analyst_review handler for the rogue-MODIFY case. The bug
  // surface is the real handler path; token-hardening tests above use
  // isolated REJECT/APPROVE mocks. This test simulates a future
  // regression where the analyst emits MODIFY despite the new binary
  // schema (prompt drift / model drift / partial-rollback). The mock
  // here bypasses the parser coercion (which lives INSIDE runAnalystAgent
  // — and is tested separately in analyst-parse.test.ts and analyst.test.ts).
  // What this asserts is the HANDLER's defense-in-depth: the strict
  // `decision.decision === 'APPROVE'` check at trading-agent.ts:1042
  // rejects any non-APPROVE value and emits an empty token. No path to
  // place_split_trade survives MODIFY even if the upstream coercion is
  // somehow disabled.
  it('coerces rogue MODIFY through the handler — analyst_token stays empty (defense-in-depth)', async () => {
    mockRunAnalystAgent.mockResolvedValueOnce({
      // bypass the AnalystDecision type to simulate runtime drift
      decision: 'MODIFY' as never,
      reason: 'imagined caveat',
      confidence: 0.8,
    });

    const result = await executeTool('request_analyst_review', validProposalInput);
    const parsed = JSON.parse(result);

    // Handler returns the decision string verbatim (no second coercion at
    // this layer — that's already done upstream). What matters: token is
    // empty for any non-APPROVE decision, so place_split_trade fails closed.
    expect(parsed.analyst_token).toBe('');
    expect(typeof parsed.proposal_hash).toBe('string');
    expect(parsed.proposal_hash.length).toBeGreaterThan(0);
    expect(mockRunAnalystAgent).toHaveBeenCalledTimes(1);
  });

  // Codex finding #5 (2026-05-11): integration test for malformed/failed
  // analyst output. In production, runAnalystAgent has internal try/catch
  // around the Anthropic API call that converts failures to a fail-closed
  // AnalystDecision { decision: 'REJECT', confidence: 0 } — see
  // analyst-agent.ts:326-341. So a rejection BUBBLING OUT of runAnalystAgent
  // is not a real scenario today; it would only happen if a future refactor
  // removed that internal try/catch.
  //
  // This test pins the CURRENT contract: the executeTool handler does NOT
  // wrap runAnalystAgent in its own try/catch (trading-agent.ts:1020), so
  // an unexpected rejection propagates up to the caller. The trading-loop
  // catches it at the tool-dispatch boundary. If a future change adds a
  // handler-local try/catch that converts rejections to a JSON response
  // here, this test will fail loudly — at which point the test should be
  // updated to assert the new safe-fallback shape (empty token, REJECT
  // decision). Document-as-test: this is the gap codex flagged.
  it('handler propagates runAnalystAgent rejection — defense gap is in runAnalystAgent internal try/catch, not handler', async () => {
    mockRunAnalystAgent.mockRejectedValueOnce(new Error('Anthropic API timeout'));

    // Current behavior: executeTool does not wrap runAnalystAgent; the
    // rejection bubbles up. The outer trading-loop boundary catches it.
    // If a future refactor adds handler-local try/catch, swap this for
    // an assertion on the safe-fallback JSON shape.
    await expect(
      executeTool('request_analyst_review', validProposalInput),
    ).rejects.toThrow(/Anthropic API timeout/);

    expect(mockRunAnalystAgent).toHaveBeenCalledTimes(1);
  });
});

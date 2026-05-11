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
});

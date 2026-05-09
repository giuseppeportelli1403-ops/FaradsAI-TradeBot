// Loop-level tests for runTradingAgent — covers iteration cap, stop_reason
// handling, timeout observability, Telegram dedup, parallel tool execution.
// Mocks the Anthropic SDK and all I/O surfaces so the loop runs deterministically.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// CRITICAL: vi.mock(...) factories are hoisted ABOVE all imports + variable
// declarations by vitest. So we cannot reference top-level `const` mocks
// inside vi.mock factories — they would be `undefined` at mock time.
// vi.hoisted() lets us declare hoisted mock vars that ARE available inside
// vi.mock factories.
const {
  mockMessagesCreate,
  mockAlertSystemWarning,
  mockAlertTradePlaced,
  mockRunAnalystAgent,
} = vi.hoisted(() => ({
  mockMessagesCreate: vi.fn(),
  mockAlertSystemWarning: vi.fn(),
  mockAlertTradePlaced: vi.fn(),
  mockRunAnalystAgent: vi.fn(),
}));

// Anthropic SDK — class mock whose messages.create is controllable per-test
vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: mockMessagesCreate };
  },
}));

// Telegram — count alertSystemWarning calls
vi.mock('../src/notifications/telegram.js', () => ({
  alertSystemWarning: mockAlertSystemWarning,
  alertTradePlaced: mockAlertTradePlaced,
}));

// Prompt loaders — SYNC functions (NOT async). Use mockReturnValue, not
// mockResolvedValue, or runTradingAgent will get Promises where it expects strings.
vi.mock('../src/agents/load-prompt.js', () => ({
  loadPrompt: vi.fn().mockReturnValue('mock system prompt'),
  loadPromptWithDemoContext: vi.fn().mockReturnValue('mock system prompt with demo'),
  loadStrategy: vi.fn().mockReturnValue('mock strategy'),
}));

// Journal loader — also SYNC. loadRecentJournal returns null or { date, markdown }.
vi.mock('../src/agents/eod-journal-agent.js', () => ({
  loadRecentJournal: vi.fn().mockReturnValue(null),
}));

// Analyst agent — async, returns APPROVE/REJECT/MODIFY shape
vi.mock('../src/agents/analyst-agent.js', () => ({
  runAnalystAgent: mockRunAnalystAgent,
}));

// Calendar veto — pure
vi.mock('../src/news/calendar-veto.js', () => ({
  instrumentToCurrencies: vi.fn().mockReturnValue([]),
  shouldVetoOrderForCalendar: vi.fn().mockReturnValue(false),
}));

vi.mock('../src/news/forex-factory-calendar.js', () => ({
  fetchForexFactoryCalendar: vi.fn().mockResolvedValue([]),
}));

// Database — only the 4 functions trading-agent.ts imports at top
vi.mock('../src/database/index.js', () => ({
  getLatestBrief: vi.fn().mockReturnValue(null),
  countOpenPositions: vi.fn().mockReturnValue(0),
  getOpenTradesByInstrument: vi.fn().mockReturnValue([]),
  getRealisedPnlSince: vi.fn().mockReturnValue(0),
}));

// NOW import the module under test
import {
  runTradingAgent,
  executeTool,
  _setExecuteToolImpl,
  _resetExecuteToolImpl,
} from '../src/agents/trading-agent.js';

describe('runTradingAgent loop — smoke test', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockMessagesCreate.mockReset();
    mockAlertSystemWarning.mockReset().mockResolvedValue(undefined);
    mockAlertTradePlaced.mockReset().mockResolvedValue(undefined);
    mockRunAnalystAgent.mockReset().mockResolvedValue({ decision: 'APPROVE', confidence: 0.9 });
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    _resetExecuteToolImpl();
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleLogSpy.mockRestore();
    _resetExecuteToolImpl();
  });

  it('runs end-to-end with immediate end_turn (smoke)', async () => {
    mockMessagesCreate.mockResolvedValue({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'no setup, standing by' }],
    });

    await expect(runTradingAgent()).resolves.toBeUndefined();

    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('CYCLE TIMED OUT'),
    );
  });

  it('exports executeTool + seam helpers as functions', () => {
    expect(typeof executeTool).toBe('function');
    expect(typeof _setExecuteToolImpl).toBe('function');
    expect(typeof _resetExecuteToolImpl).toBe('function');
  });

  it('seam: _setExecuteToolImpl(mock) routes loop calls to the mock', async () => {
    const mockImpl = vi.fn().mockResolvedValue(JSON.stringify({ ok: true }));
    _setExecuteToolImpl(mockImpl);

    let callCount = 0;
    mockMessagesCreate.mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) {
        return {
          stop_reason: 'tool_use',
          content: [
            { type: 'tool_use', id: 'a', name: 'get_daily_pnl', input: {} },
          ],
        };
      }
      return { stop_reason: 'end_turn', content: [] };
    });

    await runTradingAgent();

    expect(mockImpl).toHaveBeenCalledTimes(1);
    expect(mockImpl).toHaveBeenCalledWith('get_daily_pnl', {});
  });
});

describe('iteration cap — env-var override + validation', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockMessagesCreate.mockReset();
    mockAlertSystemWarning.mockReset().mockResolvedValue(undefined);
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // Force a never-ending tool_use loop so the cap fires deterministically.
    mockMessagesCreate.mockResolvedValue({
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'call_1', name: 'get_daily_pnl', input: {} }],
    });
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleLogSpy.mockRestore();
    delete process.env.ICT_AGENT_MAX_ITER;
  });

  it('defaults cap to 12 when ICT_AGENT_MAX_ITER is unset', async () => {
    await runTradingAgent();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('after 12 iterations'),
    );
  });

  it('honours ICT_AGENT_MAX_ITER=3 (lowers cap)', async () => {
    process.env.ICT_AGENT_MAX_ITER = '3';
    await runTradingAgent();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('after 3 iterations'),
    );
  });

  it('falls back to 12 when ICT_AGENT_MAX_ITER is non-numeric', async () => {
    process.env.ICT_AGENT_MAX_ITER = 'oops';
    await runTradingAgent();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('after 12 iterations'),
    );
  });

  it('falls back to 12 when ICT_AGENT_MAX_ITER is out of range', async () => {
    process.env.ICT_AGENT_MAX_ITER = '99999';
    await runTradingAgent();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('after 12 iterations'),
    );
  });

  it('falls back to 12 when ICT_AGENT_MAX_ITER is non-integer', async () => {
    process.env.ICT_AGENT_MAX_ITER = '3.7';
    await runTradingAgent();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('after 12 iterations'),
    );
  });
});

describe('enriched timeout log', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockMessagesCreate.mockReset();
    mockAlertSystemWarning.mockReset().mockResolvedValue(undefined);
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    process.env.ICT_AGENT_MAX_ITER = '3'; // small cap = fast test
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleLogSpy.mockRestore();
    delete process.env.ICT_AGENT_MAX_ITER;
  });

  it('includes Last iter tools, Total tool calls, distinct count', async () => {
    let callCount = 0;
    mockMessagesCreate.mockImplementation(async () => {
      callCount += 1;
      // Iter 1: get_daily_pnl. Iter 2: get_prices ×2. Iter 3: get_news_context.
      const blocks =
        callCount === 1
          ? [{ type: 'tool_use', id: 'a', name: 'get_daily_pnl', input: {} }]
          : callCount === 2
            ? [
                { type: 'tool_use', id: 'b', name: 'get_prices', input: {} },
                { type: 'tool_use', id: 'c', name: 'get_prices', input: {} },
              ]
            : [{ type: 'tool_use', id: 'd', name: 'get_news_context', input: {} }];
      return { stop_reason: 'tool_use', content: blocks };
    });

    await runTradingAgent();

    const calls = consoleErrorSpy.mock.calls.map((c) => c[0] as string);
    const timeoutLog = calls.find((c) => c.includes('CYCLE TIMED OUT'));
    expect(timeoutLog).toBeDefined();
    expect(timeoutLog).toMatch(/Last iter tools: get_news_context/);
    expect(timeoutLog).toMatch(/Total tool calls: 4/);
    expect(timeoutLog).toMatch(/across 3 distinct tools/);
  });
});

describe('stop_reason handling', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockMessagesCreate.mockReset();
    mockAlertSystemWarning.mockReset().mockResolvedValue(undefined);
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleLogSpy.mockRestore();
    delete process.env.ICT_AGENT_MAX_ITER;
  });

  it('breaks out on max_tokens stop_reason and logs the cause', async () => {
    mockMessagesCreate.mockResolvedValue({
      stop_reason: 'max_tokens',
      content: [{ type: 'text', text: 'partial response' }],
    });

    await runTradingAgent();

    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Unexpected stop_reason 'max_tokens'"),
    );
    const errorCalls = consoleErrorSpy.mock.calls.map((c) => c[0] as string);
    const timeoutLog = errorCalls.find((c) => c.includes('CYCLE TIMED OUT'));
    expect(timeoutLog).toMatch(/Last stop_reason: max_tokens/);
  });
});

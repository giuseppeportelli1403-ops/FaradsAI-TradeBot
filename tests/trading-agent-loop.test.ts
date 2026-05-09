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
  _resetIctTimeoutAlertDate,
  _getIctTimeoutAlertDate,
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

describe('Telegram dedup per UTC day', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockMessagesCreate.mockReset();
    mockAlertSystemWarning.mockReset().mockResolvedValue(undefined);
    _resetIctTimeoutAlertDate();
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    process.env.ICT_AGENT_MAX_ITER = '2'; // small cap = fast timeout
    mockMessagesCreate.mockResolvedValue({
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'x', name: 'get_daily_pnl', input: {} }],
    });
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleLogSpy.mockRestore();
    delete process.env.ICT_AGENT_MAX_ITER;
    vi.useRealTimers();
  });

  it('dedups alerts: first per UTC day fires, same-day suppressed, next UTC day re-fires', async () => {
    vi.useFakeTimers();

    // First timeout 2026-05-08 UTC — alert should fire
    vi.setSystemTime(new Date('2026-05-08T10:00:00Z'));
    await runTradingAgent();
    expect(mockAlertSystemWarning).toHaveBeenCalledTimes(1);
    expect(_getIctTimeoutAlertDate()).toBe('2026-05-08');

    // Second timeout same UTC day — alert suppressed
    vi.setSystemTime(new Date('2026-05-08T14:00:00Z'));
    await runTradingAgent();
    expect(mockAlertSystemWarning).toHaveBeenCalledTimes(1);

    // Third timeout next UTC day — alert re-fires
    vi.setSystemTime(new Date('2026-05-09T01:00:00Z'));
    await runTradingAgent();
    expect(mockAlertSystemWarning).toHaveBeenCalledTimes(2);
    expect(_getIctTimeoutAlertDate()).toBe('2026-05-09');
  });

  it('alert payload includes cap, last-iter tools, and total tool calls', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-08T10:00:00Z'));

    await runTradingAgent();

    expect(mockAlertSystemWarning).toHaveBeenCalledWith(
      expect.stringMatching(
        /ICT cycle hit iteration cap \(2\)\..*Last iter tools: get_daily_pnl\..*\d+ total tool calls/,
      ),
    );
  });
});

describe('parallel tool execution', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockMessagesCreate.mockReset();
    mockAlertSystemWarning.mockReset().mockResolvedValue(undefined);
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    _resetExecuteToolImpl();
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleLogSpy.mockRestore();
    delete process.env.ICT_AGENT_MAX_ITER;
    _resetExecuteToolImpl();
  });

  it('runs 4 parallel tool_use blocks concurrently (max in-flight = 4)', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const order: string[] = [];

    // Use deferred promises so concurrency is provable without real-clock dependencies.
    const resolvers: Array<() => void> = [];
    const pendingPromises: Array<Promise<void>> = [];
    for (let i = 0; i < 4; i++) {
      pendingPromises.push(
        new Promise<void>((resolve) => {
          resolvers.push(resolve);
        }),
      );
    }
    let callIndex = 0;

    _setExecuteToolImpl(async (name: string) => {
      const myIndex = callIndex++;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      order.push(`start:${name}`);
      await pendingPromises[myIndex];
      inFlight -= 1;
      order.push(`end:${name}`);
      return JSON.stringify({ ok: true, tool: name });
    });

    let messagesCallCount = 0;
    mockMessagesCreate.mockImplementation(async () => {
      messagesCallCount += 1;
      if (messagesCallCount === 1) {
        return {
          stop_reason: 'tool_use',
          content: [
            { type: 'tool_use', id: 'a', name: 'get_prices', input: {} },
            { type: 'tool_use', id: 'b', name: 'get_news_context', input: {} },
            { type: 'tool_use', id: 'c', name: 'get_economic_calendar', input: {} },
            { type: 'tool_use', id: 'd', name: 'get_lessons', input: {} },
          ],
        };
      }
      return { stop_reason: 'end_turn', content: [] };
    });

    // Start the cycle. It will await all 4 tool calls in parallel.
    const cyclePromise = runTradingAgent();

    // Yield microtasks so all 4 _executeToolImpl invocations get to "start".
    // After microtask drain, all 4 should be in-flight if Promise.all is concurrent.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // Concurrent: all 4 should be in-flight before any resolves.
    expect(inFlight).toBe(4);
    expect(maxInFlight).toBe(4);

    // Resolve all 4 deferred promises so the cycle can complete.
    resolvers.forEach((r) => r());
    await cyclePromise;

    // Order assertion: all 4 starts came before any end.
    const startCount = order.filter((o) => o.startsWith('start:')).length;
    const firstEndIdx = order.findIndex((o) => o.startsWith('end:'));
    expect(startCount).toBe(4);
    expect(firstEndIdx).toBeGreaterThanOrEqual(4);
  });

  it('one tool failure does not poison sibling results', async () => {
    _setExecuteToolImpl(async (name: string) => {
      if (name === 'get_news_context') {
        throw new Error('news API down');
      }
      return JSON.stringify({ ok: true, tool: name });
    });

    let messagesCallCount = 0;
    const capturedToolResults: unknown[] = [];
    mockMessagesCreate.mockImplementation(async (req: { messages: Array<{ role: string; content: unknown }> }) => {
      messagesCallCount += 1;
      if (messagesCallCount === 1) {
        return {
          stop_reason: 'tool_use',
          content: [
            { type: 'tool_use', id: 'a', name: 'get_prices', input: {} },
            { type: 'tool_use', id: 'b', name: 'get_news_context', input: {} },
            { type: 'tool_use', id: 'c', name: 'get_lessons', input: {} },
          ],
        };
      }
      // On the second call, capture what the loop sent us as tool_result.
      capturedToolResults.push(req.messages[req.messages.length - 1]);
      return { stop_reason: 'end_turn', content: [] };
    });

    await runTradingAgent();

    // Three tool_results were sent back, one with an error envelope.
    const userMessage = capturedToolResults[0] as {
      content: Array<{ tool_use_id: string; content: string }>;
    };
    expect(userMessage.content).toHaveLength(3);

    const byId = Object.fromEntries(
      userMessage.content.map((c) => [c.tool_use_id, c.content]),
    );
    expect(byId.a).toMatch(/ok.*get_prices/);
    expect(byId.b).toMatch(/error.*news API down/);
    expect(byId.c).toMatch(/ok.*get_lessons/);
  });

  it('mixed batch: read-only tools run concurrently; stateful tool runs after them sequentially', async () => {
    // 2026-05-09: Codex flagged that Promise.all over ALL emitted tools is
    // unsafe when stateful ones (place_split_trade, update_sl, etc.) appear
    // alongside reads. Fix splits the batch: reads in parallel, statefuls
    // sequential. This test pins the contract: when the model emits
    // [get_prices, place_split_trade, get_lessons], get_prices and
    // get_lessons start before place_split_trade begins.
    let inFlight = 0;
    let maxInFlight = 0;
    const order: string[] = [];

    const resolvers: Record<string, () => void> = {};
    const gates: Record<string, Promise<void>> = {};
    for (const name of ['get_prices', 'get_lessons', 'place_split_trade']) {
      gates[name] = new Promise<void>((r) => { resolvers[name] = r; });
    }

    _setExecuteToolImpl(async (name: string) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      order.push(`start:${name}`);
      await gates[name];
      inFlight -= 1;
      order.push(`end:${name}`);
      return JSON.stringify({ ok: true, tool: name });
    });

    let messagesCallCount = 0;
    mockMessagesCreate.mockImplementation(async () => {
      messagesCallCount += 1;
      if (messagesCallCount === 1) {
        return {
          stop_reason: 'tool_use',
          content: [
            { type: 'tool_use', id: 'a', name: 'get_prices', input: {} },
            { type: 'tool_use', id: 'b', name: 'place_split_trade', input: {} },
            { type: 'tool_use', id: 'c', name: 'get_lessons', input: {} },
          ],
        };
      }
      return { stop_reason: 'end_turn', content: [] };
    });

    const cyclePromise = runTradingAgent();

    // Drain microtasks. Read-only batch should now have 2 in-flight
    // (get_prices + get_lessons). place_split_trade must NOT have started yet.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(inFlight).toBe(2);
    expect(maxInFlight).toBe(2);
    expect(order.filter((o) => o === 'start:get_prices')).toHaveLength(1);
    expect(order.filter((o) => o === 'start:get_lessons')).toHaveLength(1);
    expect(order.filter((o) => o === 'start:place_split_trade')).toHaveLength(0);

    // Resolve the read-only batch. Stateful only starts AFTER both reads complete.
    resolvers.get_prices();
    resolvers.get_lessons();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(order).toContain('end:get_prices');
    expect(order).toContain('end:get_lessons');
    expect(order).toContain('start:place_split_trade');
    expect(inFlight).toBe(1); // only the stateful is in-flight now

    // Resolve the stateful so the cycle can complete.
    resolvers.place_split_trade();
    await cyclePromise;

    // Final ordering invariant: both reads ended BEFORE the stateful started.
    const startStateful = order.indexOf('start:place_split_trade');
    const endPrices = order.indexOf('end:get_prices');
    const endLessons = order.indexOf('end:get_lessons');
    expect(endPrices).toBeLessThan(startStateful);
    expect(endLessons).toBeLessThan(startStateful);
  });
});

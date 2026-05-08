# ICT Agent: cap bump (8→12) + observability + parallel tool execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce ICT-cycle iteration timeouts on complex days (NFP-class) by giving the agent more headroom (cap 8→12, env-overridable), better observability when the cap fires (enriched log + per-UTC-day Telegram), explicit handling of non-end_turn stop reasons, and parallel tool execution within an iteration so multi-tool batches finish in true parallel wall-time instead of serial-await.

**Architecture:** Six surgical changes inside `src/agents/trading-agent.ts` plus one new test file. The cap value moves from a hard-coded `8` to an env-var-aware `Number(process.env.ICT_AGENT_MAX_ITER) || 12` with `1 ≤ N ≤ 50` validation. The loop body grows light bookkeeping state (`lastIterToolNames`, `totalToolCalls`, `distinctTools`, `lastStopReason`) feeding a richer `console.error` and a once-per-UTC-day Telegram alert. A new top-level branch handles `stop_reason` values other than `end_turn` / `tool_use` (e.g. `max_tokens`, `stop_sequence`) by breaking out with a `console.warn` rather than burning iterations silently. Tool execution inside one iteration switches from `for...await executeTool(...)` to `Promise.all(blocks.map(executeTool))` with per-tool try/catch preserved. Parallelism is the only behavioral change observable to the LLM (faster wall-time per multi-tool iter); the model still sees the same `tool_result` envelope keyed by `tool_use_id`.

**Tech Stack:** TypeScript, Node 22.22.2, vitest 4.1.4, Anthropic SDK (`@anthropic-ai/sdk`), already-mocked Telegram (`alertSystemWarning`).

**Spec:** `docs/superpowers/specs/2026-05-08-ict-iteration-cap-bump-design.md` (commit `9428119`).

---

## File map

- **Modify:** `src/agents/trading-agent.ts`
  - Line 741: add `export` keyword to `async function executeTool` (test access)
  - Lines 1713-1718: replace `const maxIterations = 8` plus its 5-line comment with env-var-aware version + new 16-line comment
  - Lines 1731 area: add 4 module-level state declarations (`lastIctTimeoutAlertDate` and the per-cycle bookkeeping is local to the loop, but the dedup is module-level)
  - Below line 1731: add 2 exported `_*` test helpers (`_resetIctTimeoutAlertDate`, `_getIctTimeoutAlertDate`)
  - Lines 1733-1804: rework the for-loop body — bookkeeping, parallel tool exec, stop_reason handler
  - Lines 1816-1822: replace timeout `console.error` with enriched format + Telegram dedup call
- **Create:** `tests/trading-agent-loop.test.ts` — new file, all loop tests live here

---

## Task 1: Test scaffolding + export `executeTool`

**Files:**
- Modify: `src/agents/trading-agent.ts:741` — add `export`
- Create: `tests/trading-agent-loop.test.ts`

- [ ] **Step 1: Export `executeTool`**

In `src/agents/trading-agent.ts`, change line 741:

```diff
-async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
+export async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
```

No other change. The function body and signature are identical.

- [ ] **Step 2: Create test file with mocks + smoke test**

Create `tests/trading-agent-loop.test.ts`:

```ts
// Loop-level tests for runTradingAgent — covers iteration cap, stop_reason
// handling, timeout observability, Telegram dedup, parallel tool execution.
// Mocks the Anthropic SDK and all I/O surfaces so the loop runs deterministically.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// IMPORTANT: vi.mock calls are hoisted ABOVE imports of the module under test.
// Define mocks before the trading-agent import.

// Anthropic SDK — class mock with controllable messages.create
const mockMessagesCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: mockMessagesCreate };
  },
}));

// Telegram — count alertSystemWarning calls
const mockAlertSystemWarning = vi.fn().mockResolvedValue(undefined);
const mockAlertTradePlaced = vi.fn().mockResolvedValue(undefined);
vi.mock('../src/notifications/telegram.js', () => ({
  alertSystemWarning: mockAlertSystemWarning,
  alertTradePlaced: mockAlertTradePlaced,
}));

// Prompt loaders — return stub strings
vi.mock('../src/agents/load-prompt.js', () => ({
  loadPrompt: vi.fn().mockResolvedValue('mock system prompt'),
  loadPromptWithDemoContext: vi.fn().mockResolvedValue('mock system prompt with demo'),
  loadStrategy: vi.fn().mockResolvedValue('mock strategy'),
}));

// Journal — return empty
vi.mock('../src/agents/eod-journal-agent.js', () => ({
  loadRecentJournal: vi.fn().mockResolvedValue(''),
}));

// Analyst — return APPROVE shape (won't be called by loop tests, but needs stub)
vi.mock('../src/agents/analyst-agent.js', () => ({
  runAnalystAgent: vi.fn().mockResolvedValue({ decision: 'APPROVE', confidence: 0.9 }),
}));

// Calendar veto — pass-through
vi.mock('../src/news/calendar-veto.js', () => ({
  instrumentToCurrencies: vi.fn().mockReturnValue([]),
  shouldVetoOrderForCalendar: vi.fn().mockReturnValue(false),
}));

vi.mock('../src/news/forex-factory-calendar.js', () => ({
  fetchForexFactoryCalendar: vi.fn().mockResolvedValue([]),
}));

// Database — safe defaults
vi.mock('../src/database/index.js', () => ({
  getLatestBrief: vi.fn().mockReturnValue(null),
  countOpenPositions: vi.fn().mockReturnValue(0),
  getOpenTradesByInstrument: vi.fn().mockReturnValue([]),
  getRealisedPnlSince: vi.fn().mockReturnValue(0),
}));

// NOW import the module under test
import { runTradingAgent, executeTool } from '../src/agents/trading-agent.js';

describe('runTradingAgent loop — smoke test', () => {
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

  it('exports executeTool as a function (test access)', () => {
    expect(typeof executeTool).toBe('function');
  });
});
```

- [ ] **Step 3: Run the smoke test to verify it passes**

```bash
npx vitest run tests/trading-agent-loop.test.ts
```

Expected: 2 tests pass. If `runTradingAgent` throws because a mock is incomplete, add the missing mock to the `vi.mock(...)` block and re-run.

- [ ] **Step 4: Commit**

```bash
git add src/agents/trading-agent.ts tests/trading-agent-loop.test.ts
git commit -m "test(trading-agent): scaffold loop tests + export executeTool

Adds tests/trading-agent-loop.test.ts with vi.mock coverage of
@anthropic-ai/sdk and all I/O imports, plus a smoke test that drives
runTradingAgent through one end_turn iteration. Exports executeTool so
later loop tests can vi.spyOn it.

No runtime behaviour change. Per spec
docs/superpowers/specs/2026-05-08-ict-iteration-cap-bump-design.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Env-var configurable cap + comment rewrite

**Files:**
- Modify: `src/agents/trading-agent.ts:1713-1718`
- Test: `tests/trading-agent-loop.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/trading-agent-loop.test.ts` (inside a new `describe` block):

```ts
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
```

- [ ] **Step 2: Run tests — expect them to fail**

```bash
npx vitest run tests/trading-agent-loop.test.ts -t 'iteration cap'
```

Expected: 5 tests fail, all with messages along the lines of *"expected console.error to have been called with stringContaining 'after 12 iterations'"* — current code says `after 8 iterations`.

- [ ] **Step 3: Replace the cap declaration and comment**

In `src/agents/trading-agent.ts`, replace lines 1713-1718:

```ts
  // Iteration cap reduced 15 → 8 on 2026-04-21. Typical decision cycle
  // completes in 5-8 iterations; runs that hit 15 were usually stuck in
  // a research loop that never converges. 8 forces a decision with the
  // data the agent has gathered so far — occasional quality dip on
  // borderline cases, significant tail-cost saving.
  const maxIterations = 8;
```

with:

```ts
  // 2026-04-21: cap reduced 15 → 8 to force decisions; runs that hit 15
  // were stuck in a never-converging research loop. The reduction
  // prioritised "force a decision with the data the agent has gathered"
  // over occasional quality on borderline cases.
  //
  // 2026-05-09: cap bumped 8 → 12. NFP Friday (2026-05-08) surfaced 5 of
  // 12 cycles hitting the 8 cap before reaching end_turn. Decision graph
  // has grown since 2026-04-21 (calendar veto check, bias-mismatch
  // validation, sizing constraint check, Force-Propose mandatory analyst
  // submission, multi-candidate pivot logic) — 8 is now too tight on
  // complex days. 12 keeps the "force decision" guardrail at a higher
  // threshold.
  //
  // ICT_AGENT_MAX_ITER env override added 2026-05-09 so live tuning
  // (during a kill zone) doesn't require a redeploy. Reads as Number();
  // falls back to 12 on NaN, non-integer, or out-of-range. 1 ≤ N ≤ 50.
  const envCap = Number(process.env.ICT_AGENT_MAX_ITER);
  const maxIterations =
    Number.isInteger(envCap) && envCap >= 1 && envCap <= 50 ? envCap : 12;
```

- [ ] **Step 4: Run tests — expect them to pass**

```bash
npx vitest run tests/trading-agent-loop.test.ts -t 'iteration cap'
```

Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/agents/trading-agent.ts tests/trading-agent-loop.test.ts
git commit -m "feat(trading-agent): cap bump 8→12 with ICT_AGENT_MAX_ITER override

Bumps the ICT loop iteration cap from 8 to 12 (NFP Friday 2026-05-08
saw 5/12 cycles time out at 8). Adds ICT_AGENT_MAX_ITER env override
so the cap is tunable on the VPS without a redeploy. Validates 1 ≤ N
≤ 50 with Number.isInteger guard; falls back to 12 on any invalid
input. Per spec
docs/superpowers/specs/2026-05-08-ict-iteration-cap-bump-design.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Iteration tracking state + enriched timeout log

**Files:**
- Modify: `src/agents/trading-agent.ts` (loop body around lines 1731-1822)
- Test: `tests/trading-agent-loop.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/trading-agent-loop.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests — expect failure**

```bash
npx vitest run tests/trading-agent-loop.test.ts -t 'enriched timeout log'
```

Expected: FAIL — current `console.error` says "after N iterations without end_turn. Decision may be incomplete..." with no `Last iter tools:` or `Total tool calls:` substrings.

- [ ] **Step 3: Add bookkeeping state in the loop**

In `src/agents/trading-agent.ts`, find the `for (let i = 0; i < maxIterations; i++) {` line (currently around line 1733). Immediately ABOVE that line, add the bookkeeping state:

```ts
  // 2026-05-09: bookkeeping for the enriched timeout log. Tracks what the
  // agent was doing at the moment the cap fired so pm2-err.log lines can
  // answer "is the agent looping on a single tool, or making real
  // progress that just runs out of room?".
  let lastIterToolNames: string[] = [];
  let lastStopReason: string | null = null;
  let totalToolCalls = 0;
  const distinctTools = new Set<string>();
```

Inside the existing `if (response.stop_reason === 'tool_use') { ... }` branch (currently around line 1780), at the very TOP of the branch (before the `for (const block of response.content)` line), record `lastStopReason`:

```ts
      lastStopReason = response.stop_reason;
```

Inside the inner `for (const block of response.content)` loop, where `if (block.type === 'tool_use') {` matches (current line 1784), add the tracking IMMEDIATELY after the existing `console.log`:

```ts
        if (block.type === 'tool_use') {
          console.log(`[ICT Agent] Calling tool: ${block.name}`);
          distinctTools.add(block.name);
          totalToolCalls += 1;
          // ... existing executeTool path stays as-is ...
```

After the inner for-loop completes (still inside the `if (response.stop_reason === 'tool_use')` branch, after `messages.push(...)` calls), record `lastIterToolNames`:

```ts
      lastIterToolNames = response.content
        .filter((b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use')
        .map((b) => b.name);
```

- [ ] **Step 4: Replace the timeout `console.error`**

In `src/agents/trading-agent.ts`, find the existing `if (!cleanlyCompleted) { ... }` block (currently around lines 1816-1822). Replace its body with:

```ts
  if (!cleanlyCompleted) {
    const lastTools = lastIterToolNames.join(',') || '(none)';
    const stopReasonNote =
      lastStopReason && lastStopReason !== 'tool_use'
        ? ` Last stop_reason: ${lastStopReason}.`
        : '';
    console.error(
      `[ICT Agent] CYCLE TIMED OUT after ${maxIterations} iterations without end_turn.` +
        stopReasonNote +
        ` Last iter tools: ${lastTools}. Total tool calls: ${totalToolCalls} ` +
        `across ${distinctTools.size} distinct tools. ` +
        `Decision may be incomplete. If this happens repeatedly, raise the cap or audit ` +
        `which tool the agent is looping on.`,
    );
  }
```

- [ ] **Step 5: Run tests — expect them to pass**

```bash
npx vitest run tests/trading-agent-loop.test.ts -t 'enriched timeout log'
```

Expected: 1 test passes.

- [ ] **Step 6: Re-run earlier tests to confirm no regression**

```bash
npx vitest run tests/trading-agent-loop.test.ts
```

Expected: all tests pass (smoke + cap + enriched log).

- [ ] **Step 7: Commit**

```bash
git add src/agents/trading-agent.ts tests/trading-agent-loop.test.ts
git commit -m "feat(trading-agent): enriched ICT cycle timeout log

Adds last-iter tool names, total tool call count, and distinct tool
count to the CYCLE TIMED OUT console.error so pm2-err.log lines
answer 'which tool was the agent looping on?' without requiring a
re-run with extra debug logging.

Per spec docs/superpowers/specs/2026-05-08-ict-iteration-cap-bump-design.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Non-`end_turn` / non-`tool_use` stop_reason handler

**Files:**
- Modify: `src/agents/trading-agent.ts` loop body
- Test: `tests/trading-agent-loop.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/trading-agent-loop.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test — expect failure**

```bash
npx vitest run tests/trading-agent-loop.test.ts -t 'stop_reason handling'
```

Expected: FAIL — currently when `stop_reason === 'max_tokens'`, the loop falls through with neither branch matching, so `mockMessagesCreate` keeps getting called until the cap fires (12 times), and there's no `Unexpected stop_reason` warn.

- [ ] **Step 3: Add the early-break handler**

In `src/agents/trading-agent.ts`, locate the existing pair of branches:

```ts
    if (response.stop_reason === 'end_turn') {
      console.log('ICT Trading Agent decision cycle complete.');
      cleanlyCompleted = true;
      break;
    }

    // If there are tool calls, execute them
    if (response.stop_reason === 'tool_use') {
      // ...
    }
```

Insert a new branch AFTER the `tool_use` branch closes, at the bottom of the for-loop body (right before the closing `}` of the for-loop). Add:

```ts
    // 2026-05-09: explicit handler for stop_reasons other than end_turn/
    // tool_use (e.g. 'max_tokens', 'stop_sequence', 'pause_turn'). Pre-fix
    // the loop fell through with neither branch matching, silently spinning
    // until the cap fired. Now: log loudly, set lastStopReason for the
    // timeout log, and break out so we don't waste iterations.
    if (
      response.stop_reason !== 'end_turn' &&
      response.stop_reason !== 'tool_use'
    ) {
      console.warn(
        `[ICT Agent] Unexpected stop_reason '${response.stop_reason}' on iter ${i + 1}. ` +
          `Breaking loop to avoid wasted iterations.`,
      );
      lastStopReason = response.stop_reason;
      // Don't set cleanlyCompleted = true — this is an abnormal exit; the
      // timeout-log path will still fire to give us observability.
      break;
    }
```

- [ ] **Step 4: Run test — expect pass**

```bash
npx vitest run tests/trading-agent-loop.test.ts -t 'stop_reason handling'
```

Expected: 1 test passes.

- [ ] **Step 5: Re-run all tests**

```bash
npx vitest run tests/trading-agent-loop.test.ts
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/agents/trading-agent.ts tests/trading-agent-loop.test.ts
git commit -m "feat(trading-agent): break loop on non-end_turn/non-tool_use stop_reason

Pre-fix, stop_reasons like 'max_tokens', 'stop_sequence', or
'pause_turn' fell through both existing branches and the loop kept
calling messages.create until the cap fired — silent iteration waste.
Now: log a warn, set lastStopReason for the timeout log, and break.
The timeout console.error still fires so we keep observability.

Per spec docs/superpowers/specs/2026-05-08-ict-iteration-cap-bump-design.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Telegram alert deduped per UTC day

**Files:**
- Modify: `src/agents/trading-agent.ts` (module state + timeout branch)
- Test: `tests/trading-agent-loop.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/trading-agent-loop.test.ts`:

```ts
import { _resetIctTimeoutAlertDate, _getIctTimeoutAlertDate } from '../src/agents/trading-agent.js';

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
```

- [ ] **Step 2: Run test — expect failure**

```bash
npx vitest run tests/trading-agent-loop.test.ts -t 'Telegram dedup'
```

Expected: FAIL — currently `_resetIctTimeoutAlertDate` and `_getIctTimeoutAlertDate` are not exported (build error), and no `alertSystemWarning` call exists in the timeout branch.

- [ ] **Step 3: Add module-level dedup state and test helpers**

In `src/agents/trading-agent.ts`, find the existing test-helper exports (look for `_resetAnalystApprovals` near line 43). After that block, add:

```ts
// 2026-05-09: Telegram dedup for ICT cycle timeouts. Module-level state.
// Safe under module-level mutation because ICT cycles are serialized via
// scheduler/index.ts ictRunning + ictOverlapQueue — two runTradingAgent
// invocations never run concurrently. See spec
// docs/superpowers/specs/2026-05-08-ict-iteration-cap-bump-design.md
// "Change 3" for the serialization invariant.
let lastIctTimeoutAlertDate: string | null = null;

/** Test-only: reset dedup so a same-day timeout re-alerts. */
export function _resetIctTimeoutAlertDate(): void {
  lastIctTimeoutAlertDate = null;
}

/** Test-only: read current dedup state. Symmetry with _getPingFailureStreak. */
export function _getIctTimeoutAlertDate(): string | null {
  return lastIctTimeoutAlertDate;
}
```

- [ ] **Step 4: Fire alertSystemWarning in the timeout branch**

In `src/agents/trading-agent.ts`, find the `if (!cleanlyCompleted) { ... }` block (the one Task 3 reworked). After the `console.error(...)` call, add:

```ts
    // Fire Telegram alert ONCE per UTC day to surface sustained timeouts
    // without spamming on a single bad-day run.
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
    if (lastIctTimeoutAlertDate !== today) {
      lastIctTimeoutAlertDate = today;
      const lastTools = lastIterToolNames.join(',') || '(none)';
      alertSystemWarning(
        `⚠️ ICT cycle hit iteration cap (${maxIterations}). ` +
          `Last iter tools: ${lastTools}. ${totalToolCalls} total tool calls. ` +
          `Decision may be incomplete. Check pm2-err.log for full context.`,
      ).catch(() => {
        /* alert failure non-blocking */
      });
    }
```

(`alertSystemWarning` is already imported at line 17 of the file — verify.)

- [ ] **Step 5: Run test — expect pass**

```bash
npx vitest run tests/trading-agent-loop.test.ts -t 'Telegram dedup'
```

Expected: 2 tests pass.

- [ ] **Step 6: Re-run all tests**

```bash
npx vitest run tests/trading-agent-loop.test.ts
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/agents/trading-agent.ts tests/trading-agent-loop.test.ts
git commit -m "feat(trading-agent): Telegram alert on ICT cycle timeout (deduped per UTC day)

Fires alertSystemWarning once when the iteration cap is first hit on a
given UTC day; subsequent same-day timeouts log to pm2-err.log only.
Resets at midnight UTC. Safe under module-level state because ICT
cycles are serialized by ictRunning + ictOverlapQueue in
scheduler/index.ts. Adds _resetIctTimeoutAlertDate and
_getIctTimeoutAlertDate test helpers matching the existing _reset*
convention.

Per spec docs/superpowers/specs/2026-05-08-ict-iteration-cap-bump-design.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Parallel tool execution (`Promise.all` replacing `for...await`)

**Files:**
- Modify: `src/agents/trading-agent.ts` lines 1779-1804 (the inside-iteration tool execution block)
- Test: `tests/trading-agent-loop.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/trading-agent-loop.test.ts`:

```ts
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
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleLogSpy.mockRestore();
    delete process.env.ICT_AGENT_MAX_ITER;
  });

  it('runs 4 parallel tool_use blocks concurrently (max in-flight = 4)', async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    // Spy on executeTool by intercepting via the SDK mock call sequence.
    // executeTool is real here — but we don't care; the mocks for capital,
    // database, etc. make the underlying tools fast. We instrument by
    // wrapping fetch* via the database mock... easier: drive the loop with
    // a custom messages.create that records timing of tool_use ⇒ tool_result
    // round-trips.
    //
    // Trick: 4 tool_use blocks in iter 1, then end_turn. In the parallel
    // branch each block's executeTool starts before the previous one's
    // promise resolves. We measure by making the database mocks awaitable
    // with a fake timer.

    const order: string[] = [];
    let pendingResolvers: Array<() => void> = [];

    // Override database mock to count concurrent calls.
    const dbMock = await import('../src/database/index.js');
    vi.mocked(dbMock.countOpenPositions).mockImplementation(() => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Return synchronously — countOpenPositions is sync.
      // Use an async path instead via getOpenTradesByInstrument.
      inFlight -= 1;
      return 0;
    });

    // Better: intercept executeTool's side effect via a controllable mock
    // on getOpenTradesByInstrument (which get_portfolio doesn't use, but
    // get_lessons + get_news_context route through other mocks that we
    // can make awaitable).

    // Simplest reliable approach: spy on executeTool directly.
    const tradingAgentModule = await import('../src/agents/trading-agent.js');
    const executeToolSpy = vi.spyOn(tradingAgentModule, 'executeTool')
      .mockImplementation(async (name: string) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        order.push(`start:${name}`);
        await new Promise((r) => setTimeout(r, 20));
        inFlight -= 1;
        order.push(`end:${name}`);
        return JSON.stringify({ ok: true, tool: name });
      });

    let callCount = 0;
    mockMessagesCreate.mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) {
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

    await runTradingAgent();

    expect(executeToolSpy).toHaveBeenCalledTimes(4);
    expect(maxInFlight).toBe(4);
    // Concurrent: all 4 starts come before any end (with 20ms delay).
    const startCount = order.filter((o) => o.startsWith('start:')).length;
    const firstEndIdx = order.findIndex((o) => o.startsWith('end:'));
    expect(firstEndIdx).toBeGreaterThanOrEqual(4);
    expect(startCount).toBe(4);

    executeToolSpy.mockRestore();
  });

  it('one tool failure does not poison sibling results', async () => {
    const tradingAgentModule = await import('../src/agents/trading-agent.js');
    const executeToolSpy = vi.spyOn(tradingAgentModule, 'executeTool')
      .mockImplementation(async (name: string) => {
        if (name === 'get_news_context') {
          throw new Error('news API down');
        }
        return JSON.stringify({ ok: true, tool: name });
      });

    let callCount = 0;
    const capturedToolResults: unknown[] = [];
    mockMessagesCreate.mockImplementation(async (req) => {
      callCount += 1;
      if (callCount === 1) {
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
    const userMessage = capturedToolResults[0] as { content: Array<{ tool_use_id: string; content: string }> };
    expect(userMessage.content).toHaveLength(3);

    const byId = Object.fromEntries(
      userMessage.content.map((c) => [c.tool_use_id, c.content]),
    );
    expect(byId.a).toMatch(/ok.*get_prices/);
    expect(byId.b).toMatch(/error.*news API down/);
    expect(byId.c).toMatch(/ok.*get_lessons/);

    executeToolSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run tests — expect failure**

```bash
npx vitest run tests/trading-agent-loop.test.ts -t 'parallel tool execution'
```

Expected: first test FAILS — `maxInFlight` is `1` (serial) not `4` (parallel). Second test passes already because the existing for-await loop also handles per-tool errors via try/catch — that's fine, the test still proves the new code preserves the behavior.

- [ ] **Step 3: Replace the for-await loop with Promise.all**

In `src/agents/trading-agent.ts`, find the existing `if (response.stop_reason === 'tool_use') { ... }` branch. Replace its entire body with the parallel version:

```ts
    if (response.stop_reason === 'tool_use') {
      lastStopReason = response.stop_reason;

      // 2026-05-09: parallel tool execution. Pre-fix the for-await loop
      // executed each tool serially even when the model emitted them as
      // parallel tool_use blocks in one response. With multi-tool
      // batches (4-5 reads in iter 1 of clean cycles) wall-time was
      // dominated by the slowest tool × N. Now Promise.all runs them
      // concurrently. Order is preserved (Promise.all keeps input
      // order); Anthropic matches tool_use to tool_result by id anyway.
      // Per-tool try/catch is preserved so one failed tool's error
      // envelope reaches the model without poisoning siblings.
      const toolUseBlocks = response.content.filter(
        (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use',
      );

      const toolResults: Anthropic.Messages.ToolResultBlockParam[] =
        await Promise.all(
          toolUseBlocks.map(async (block) => {
            console.log(`[ICT Agent] Calling tool: ${block.name}`);
            distinctTools.add(block.name);
            totalToolCalls += 1;
            let result: string;
            try {
              result = await executeTool(
                block.name,
                block.input as Record<string, unknown>,
              );
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              console.warn(
                `[ICT Agent] Tool ${block.name} failed: ${message}`,
              );
              result = JSON.stringify({ error: message, tool: block.name });
            }
            return {
              type: 'tool_result' as const,
              tool_use_id: block.id,
              content: result,
            };
          }),
        );

      lastIterToolNames = toolUseBlocks.map((b) => b.name);

      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });
    }
```

(Note: the bookkeeping moves are integrated — Task 3's separate state update step is now folded into the parallel map, since both edits touch the same lines. The `distinctTools.add` and `totalToolCalls += 1` happen inside `Promise.all`'s map; the `lastIterToolNames = ...` happens after `await`. Functionally identical to Task 3's separate update.)

- [ ] **Step 4: Run tests — expect both to pass**

```bash
npx vitest run tests/trading-agent-loop.test.ts -t 'parallel tool execution'
```

Expected: 2 tests pass. `maxInFlight` is now 4.

- [ ] **Step 5: Re-run ALL loop tests + full suite**

```bash
npx vitest run tests/trading-agent-loop.test.ts
```

Expected: all loop tests pass.

```bash
npx vitest run
```

Expected: full suite passes (should be ≥780 tests).

- [ ] **Step 6: Commit**

```bash
git add src/agents/trading-agent.ts tests/trading-agent-loop.test.ts
git commit -m "feat(trading-agent): execute parallel tool_use blocks concurrently (Promise.all)

Pre-fix: the loop's for-await tool execution serialized each tool_use
block even when the model emitted them as a parallel batch in one
response. On clean cycles batching 4 reads at iter 1, wall-time was
the sum of all 4 latencies instead of the max. Now Promise.all runs
them concurrently; per-tool try/catch is preserved so one failure
doesn't poison siblings; order is preserved (Promise.all keeps input
order, and Anthropic matches by tool_use_id anyway).

Bookkeeping (distinctTools, totalToolCalls, lastIterToolNames) folds
into the Promise.all map so Task 3's enriched timeout log keeps
working unchanged.

Per spec docs/superpowers/specs/2026-05-08-ict-iteration-cap-bump-design.md L1.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Final verification + push

**Files:** none modified — verification only.

- [ ] **Step 1: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 2: Run full test suite**

```bash
npx vitest run
```

Expected: all tests pass. Test count should be ≥780 (was 774 pre-plan; Task 1 adds 2, Task 2 adds 5, Task 3 adds 1, Task 4 adds 1, Task 5 adds 2, Task 6 adds 2 → +13).

- [ ] **Step 3: Push to origin/master**

```bash
git push origin master
```

Expected: push succeeds. GitHub Actions runs Build+Test and triggers VPS auto-deploy (`/home/bot/deploy.sh`). Wait ~3 min for deploy to complete.

- [ ] **Step 4: Verify VPS state**

```bash
ssh bot@162.55.212.198 'cd /home/bot/trading-bot && git log --oneline -10 && echo --- && pm2 jlist | python3 -c "import sys,json; d=json.load(sys.stdin); p=d[0]; print(p[\"name\"], p[\"pm2_env\"][\"status\"], \"node:\", p[\"pm2_env\"].get(\"node_version\"), \"restarts:\", p[\"pm2_env\"][\"restart_time\"])"'
```

Expected:
- `git log` shows the 6 task commits as the latest 6 entries (newest first).
- pm2 shows `trading-bot online`, Node 22.22.2, restart count incremented by 1 from pre-deploy.

- [ ] **Step 5: Verify next ICT cycle uses the bumped cap**

Wait for the next 15m candle close inside a kill zone (or trigger one via the next cron tick). Then:

```bash
ssh bot@162.55.212.198 'tail -100 /home/bot/trading-bot/data/pm2-err.log | grep -E "CYCLE TIMED OUT|ICT iter"'
```

If a timeout occurs post-deploy, the new format should show: `CYCLE TIMED OUT after 12 iterations without end_turn. Last iter tools: <names>. Total tool calls: N across M distinct tools.` Confirm the new format is live.

- [ ] **Step 6: Mark task complete**

No commit (verification only). Update task tracker.

---

## Self-Review (skill-required)

**1. Spec coverage check:** every "Change" in the spec maps to a task above:
- Spec Change 1 (cap + env-var) → Task 2 ✓
- Spec Change 2 (enriched timeout log + non-end_turn handler) → Tasks 3 + 4 ✓
- Spec Change 3 (Telegram dedup) → Task 5 ✓
- Spec L1 (parallel tool execution) → Task 6 ✓
- Spec "Required surface change" (export executeTool) → Task 1 ✓
- Spec test cases (5 numbered) → all covered across Tasks 2/3/4/5/6 + 1 smoke

**2. Placeholder scan:** no TBD, no "implement appropriate", no "similar to Task N" without code.

**3. Type consistency:** `executeTool` signature unchanged (just `export` added); `lastIterToolNames: string[]`, `lastStopReason: string | null`, `totalToolCalls: number`, `distinctTools: Set<string>`, `lastIctTimeoutAlertDate: string | null` — all referenced consistently across Tasks 3, 4, 5, 6.

**4. Ordering check:** Task 1 (scaffold) blocks all others. Task 2 (cap) is independent of 3/4/5/6. Task 3 (bookkeeping) sets up state Task 4 reads (`lastStopReason`) and Task 5 reads (`lastIterToolNames`, `totalToolCalls`, `distinctTools`). Task 6 (parallel) re-arranges Task 3's bookkeeping inside `Promise.all` map but keeps the public state names. Tasks 4 and 5 are independent of each other. Task 7 verifies. Order is correct.

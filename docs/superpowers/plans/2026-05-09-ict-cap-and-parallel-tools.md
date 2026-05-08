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
  - **Below executeTool body**: add test seam — `_executeToolImpl` mutable var + `_setExecuteToolImpl(impl)` + `_resetExecuteToolImpl()` exports so the loop's tool dispatch is patchable from tests (vi.spyOn cannot intercept the in-file lexical call site; this seam is the right way)
  - Loop body (line 1788): change the call from `executeTool(...)` to `_executeToolImpl(...)` so the seam takes effect
  - Lines 1713-1718: replace `const maxIterations = 8` plus its 5-line comment with env-var-aware version + new 16-line comment
  - Lines 1731 area: add module-level dedup state (`lastIctTimeoutAlertDate`) and per-cycle bookkeeping local to the loop
  - Below line 1731: add 2 exported `_*` test helpers (`_resetIctTimeoutAlertDate`, `_getIctTimeoutAlertDate`)
  - Lines 1733-1804: rework the for-loop body — bookkeeping, parallel tool exec, stop_reason handler
  - Lines 1816-1822: replace timeout `console.error` with enriched format + Telegram dedup call
- **Create:** `tests/trading-agent-loop.test.ts` — new file, all loop tests live here

## Critical test-seam decision (preempting plan-review P0 findings)

Both Claude and Codex flagged the same P0: `vi.spyOn(tradingAgentModule, 'executeTool')` cannot intercept the loop's in-file call. ESM exports a binding to the function, but `runTradingAgent`'s call `executeTool(...)` resolves via lexical scope, NOT via the export object. The spy patches `module.executeTool` but the loop never reads from there.

**Fix adopted:** introduce a module-level `_executeToolImpl` indirection. The loop calls `_executeToolImpl(...)` (a `let` binding initialised to the real `executeTool`). Tests patch via `_setExecuteToolImpl(mockFn)` and clean up via `_resetExecuteToolImpl()`. This adds 8 lines and removes the entire test-seam class of bugs.

Other P0 fixes adopted from the plan review:
- All shared mock vars use `vi.hoisted(() => ({ ... }))` so they exist before `vi.mock(...)` factory calls (which vitest hoists to top).
- `loadPrompt`, `loadPromptWithDemoContext`, `loadStrategy`, `loadRecentJournal` are SYNC functions (verified via `src/agents/load-prompt.ts:7,42,135` and `src/agents/eod-journal-agent.ts:67`) — must mock with `mockReturnValue`, NOT `mockResolvedValue`. The latter would make their results Promises and crash on `journal.markdown.length`.

---

## Task 1: Test scaffolding + export `executeTool` + dispatcher seam

**Files:**
- Modify: `src/agents/trading-agent.ts:741` — add `export`
- Modify: `src/agents/trading-agent.ts` (below executeTool body) — add seam
- Modify: `src/agents/trading-agent.ts:1788` — change loop call site
- Create: `tests/trading-agent-loop.test.ts`

- [ ] **Step 1: Export `executeTool` and add the test seam**

In `src/agents/trading-agent.ts`, change line 741:

```diff
-async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
+export async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
```

Find the closing brace of `executeTool` (it's the function that ends just before `request_analyst_review` returns out — search forward for the next top-level `}` after the `case 'request_analyst_review'` block ends). Immediately AFTER the closing brace of `executeTool`, insert:

```ts
// 2026-05-09: Test seam for the loop's tool dispatch. Both Claude and
// Codex plan-reviewers flagged that vi.spyOn(module, 'executeTool')
// cannot intercept the loop's in-file lexical call — ESM exports a
// binding to the function, but the call resolves via lexical scope,
// not via the export object. The seam below routes the loop through
// a mutable module-level binding that tests can patch via
// _setExecuteToolImpl. Default is the real executeTool above.
let _executeToolImpl: typeof executeTool = executeTool;

/** Test-only: patch the loop's tool dispatcher. Restore via _resetExecuteToolImpl. */
export function _setExecuteToolImpl(impl: typeof executeTool): void {
  _executeToolImpl = impl;
}

/** Test-only: restore the default executeTool dispatcher. */
export function _resetExecuteToolImpl(): void {
  _executeToolImpl = executeTool;
}
```

Now find the loop's tool dispatch call (line 1788 currently — `result = await executeTool(...)`). Change it to use the seam:

```diff
-            result = await executeTool(block.name, block.input as Record<string, unknown>);
+            result = await _executeToolImpl(block.name, block.input as Record<string, unknown>);
```

This is the ONLY runtime change in this step. The default dispatcher is the real `executeTool`, so production behaviour is identical.

- [ ] **Step 2: Create test file with vi.hoisted mocks + smoke test**

Create `tests/trading-agent-loop.test.ts`:

```ts
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
```

- [ ] **Step 3: Run the tests to verify they pass**

```bash
npx vitest run tests/trading-agent-loop.test.ts
```

Expected: 3 tests pass. If `runTradingAgent` throws because a mock is incomplete, add the missing mock to the `vi.mock(...)` block and re-run. The third test verifies the seam works — if it fails, the in-file `_executeToolImpl(...)` call site change in Step 1 was missed.

- [ ] **Step 4: Commit**

```bash
git add src/agents/trading-agent.ts tests/trading-agent-loop.test.ts
git commit -m "test(trading-agent): scaffold loop tests + executeTool dispatcher seam

Adds tests/trading-agent-loop.test.ts with vi.hoisted mock vars,
vi.mock coverage of @anthropic-ai/sdk + 7 I/O surfaces (telegram,
prompt loaders, journal, analyst, calendar, forex calendar, db), plus
3 tests: smoke (end_turn cycle), executeTool exported, dispatcher
seam routes loop calls to mocks.

Adds the _executeToolImpl/_setExecuteToolImpl/_resetExecuteToolImpl
seam in trading-agent.ts so the loop's tool dispatch is patchable
from tests. Pre-fix vi.spyOn could not intercept the in-file lexical
call (flagged by both reviewers as P0). Default behaviour identical
to current production.

Per spec docs/superpowers/specs/2026-05-08-ict-iteration-cap-bump-design.md.

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

Append to `tests/trading-agent-loop.test.ts`. **These tests use the `_setExecuteToolImpl` seam introduced in Task 1, NOT `vi.spyOn` (which cannot intercept the loop's lexical call).**

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

    // Use deferred promises (NOT setTimeout) so concurrency is provable
    // without relying on real-clock timing on slow CI.
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

    // Yield microtasks so all 4 executeToolImpl invocations get to "start".
    // After microtask drain, all 4 should be in-flight if Promise.all is
    // running them concurrently.
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
              // _executeToolImpl is the test-seam-aware dispatcher; in
              // production it's the real executeTool. See Task 1 Step 1.
              result = await _executeToolImpl(
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

Expected: all tests pass. Test count should be ≥788 (was 774 pre-plan; Task 1 adds 3 — smoke + exports check + seam test, Task 2 adds 5, Task 3 adds 1, Task 4 adds 1, Task 5 adds 2, Task 6 adds 2 → +14).

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
- Spec test cases (5 numbered) → all covered across Tasks 2/3/4/5/6 + 3 in Task 1 (smoke/exports/seam)

**2. Placeholder scan:** no TBD, no "implement appropriate", no "similar to Task N" without code.

**3. Type consistency:** `executeTool` signature unchanged (just `export` added); `_executeToolImpl: typeof executeTool` introduced as test seam (Task 1, used in loop body and Task 6); `lastIterToolNames: string[]`, `lastStopReason: string | null`, `totalToolCalls: number`, `distinctTools: Set<string>`, `lastIctTimeoutAlertDate: string | null` — all referenced consistently across Tasks 3, 4, 5, 6.

**4. Ordering check:** Task 1 (scaffold + seam) blocks all others. Task 2 (cap) is independent of 3/4/5/6. Task 3 (bookkeeping) sets up state Task 4 reads (`lastStopReason`) and Task 5 reads (`lastIterToolNames`, `totalToolCalls`, `distinctTools`). Task 6 (parallel) re-arranges Task 3's bookkeeping inside `Promise.all` map but keeps the public state names AND uses the `_executeToolImpl` seam from Task 1. Tasks 4 and 5 are independent of each other. Task 7 verifies. Order is correct.

**5. Plan-review P0 fixes folded in (2026-05-09 review by Claude + Codex):**
- ✅ vi.hoisted() used for shared mock vars (Task 1 Step 2)
- ✅ mockReturnValue (not mockResolvedValue) for sync prompt loaders (Task 1 Step 2)
- ✅ executeTool dispatcher seam introduced in Task 1, used in Task 6 (eliminates the vi.spyOn-cannot-intercept-lexical-call class of bugs)
- ✅ Concurrency assertions use deferred Promises + setImmediate microtask drain (Task 6 Step 1) — robust on slow CI, no real-clock dependency
- ✅ Test count expectation updated from ≥780 to ≥788

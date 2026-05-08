# ICT Agent iteration cap bump (8 → 12) + observability

**Date:** 2026-05-08
**Author:** Giuseppe + Claude (brainstorming session)
**Status:** Spec — pending user review, then writing-plans
**Base commit:** `f577434` (post-merge with parallel session's TP1 BE+offset fix)
**Resolves:** Appendix A2 of `docs/superpowers/plans/2026-05-08-tp1-be-offset-and-race-fix.md` (ICT 8-iteration cycle timeouts deferred to its own brainstorm)

## Problem

The ICT trading agent runs an agentic loop in `src/agents/trading-agent.ts` (around lines 1708-1822). Each loop iteration is one round-trip to Claude (Haiku 4.5): Claude thinks → Claude calls one or more tools → tools return → Claude reads results → repeat, until Claude emits `stop_reason === 'end_turn'`.

The loop is bounded by `const maxIterations = 8` (line 1718). On 2026-05-08 (NFP Friday), **5 of 12 cycles (~42%) hit the cap before reaching `end_turn`**. The bot did not place any trades that day. Calendar veto on the NFP window explains most of the no-trade decisions, but the timeouts mean we cannot even tell whether those cycles would have decided to trade — they were forcibly cut off mid-reasoning.

Cap timestamps from today (UTC, all in `pm2-err.log`):

```
07:46:29   08:01:20   08:16:09   08:47:40   09:01:59
```

The in-code timeout comment (line 1819) already anticipates this: *"If this happens repeatedly, raise the cap or audit which tool the agent is looping on."* This spec does both.

## Why the cap was 8 in the first place

It was bumped *down* from 15 to 8 on 2026-04-21 (per the existing comment on lines 1713-1717). Rationale at the time: most cycles complete in 5-8 iterations, and runs that hit 15 were usually stuck in a research loop that never converged. The reduction prioritised "force a decision with the data the agent has gathered so far" over occasional quality on borderline cases.

That reasoning held under the simpler decision tree the agent had on 2026-04-21. Since then we have layered:
- Calendar veto checks (separate `get_economic_calendar` tool call)
- Bias-mismatch validation (extra `get_prices` for higher TF confirmation)
- Sizing constraint validation against tier risk caps
- Force-Propose path with mandatory analyst submission
- Multi-candidate pivot logic when the top candidate fails a gate

The decision graph is meaningfully bigger. 8 is now too tight on complex days.

## Goal

Stop missing trades on complex days (e.g. NFP, multi-candidate kill zones) by giving the agent enough iterations to reach a real decision. Pair the bump with light observability so we can keep validating the new cap is the right value.

Non-goal: maximise trade count. The bot should still pass when the structure or calendar genuinely don't justify a trade. The bump is a ceiling change, not a behaviour change.

## Design

### Change 1 — bump the cap (env-var configurable, default 12)

In `src/agents/trading-agent.ts:1718`:

```diff
-  const maxIterations = 8;
+  // 2026-04-21: cap reduced 15 → 8 to force decisions; runs that hit 15
+  // were stuck in a never-converging research loop. The reduction
+  // prioritised "force a decision with the data the agent has gathered"
+  // over occasional quality on borderline cases.
+  //
+  // 2026-05-08: cap bumped 8 → 12. NFP Friday surfaced 5 of 12 cycles
+  // hitting the 8 cap before reaching end_turn. Decision graph has grown
+  // since 2026-04-21 (calendar veto check, bias-mismatch validation,
+  // sizing constraint check, Force-Propose mandatory analyst submission,
+  // multi-candidate pivot logic) — 8 is now too tight on complex days.
+  // 12 keeps the "force decision" guardrail at a higher threshold.
+  //
+  // ICT_AGENT_MAX_ITER env override added 2026-05-08 so live tuning
+  // (during a kill zone) doesn't require a redeploy. Reads as Number(),
+  // falls back to 12 on NaN / unset / invalid.
+  const envCap = Number(process.env.ICT_AGENT_MAX_ITER);
+  const maxIterations =
+    Number.isInteger(envCap) && envCap >= 1 && envCap <= 50 ? envCap : 12;
```

Validation guard `1 ≤ envCap ≤ 50`: prevents a typo (`MAX_ITER=oops` → NaN → falls back) or a runaway value (`MAX_ITER=99999` → clamped reject) from breaking the bot. 50 is a sane "obviously wrong" upper bound — even pathological cycles converge before 50.

**Worst-case wall-time per cycle is NOT bounded by `cap × iterationTimeoutMs`**. Codex review caught this: the per-iter `withTimeout(..., 90_000)` (line 1761) bounds only the `anthropic.messages.create` call — `executeTool` calls (line 1788) run unwrapped, so each iteration's true wall-time is `90s` (LLM round-trip) + sum-of-tool-execution-times. A wedged Capital API call inside `executeTool` can stretch the cycle indefinitely. Capping `executeTool` is a separate hardening item, NOT in scope for this spec — flagged here so the writing-plans phase doesn't claim a 18-min ceiling that doesn't actually hold.

Worst-case extra LLM cost when the cap fires: `4 × $0.03 ≈ $0.12 per timeout cycle`. On a 5-timeout day like today, ~$0.6 extra. Today's full ICT spend is ~$10-15, so the bump is a rounding error against the existing daily budget.

### Change 2 — enriched timeout log + handle non-`end_turn`/non-`tool_use` stop reasons

During the loop, accumulate three pieces of state:

```ts
let lastIterToolNames: string[] = [];
let lastStopReason: string | null = null;
let totalToolCalls = 0;
const distinctTools = new Set<string>();
```

Inside the existing `if (response.stop_reason === 'tool_use')` branch, populate them:

```ts
lastStopReason = response.stop_reason;
const iterTools: string[] = [];
for (const block of response.content) {
  if (block.type === 'tool_use') {
    iterTools.push(block.name);
    distinctTools.add(block.name);
    totalToolCalls += 1;
    // ... existing executeTool path stays as-is ...
  }
}
lastIterToolNames = iterTools;
```

**Handle other stop reasons explicitly.** The existing loop only branches on `'end_turn'` (clean exit) and `'tool_use'` (continue). Any other `stop_reason` (e.g. `'max_tokens'`, `'stop_sequence'`, `'pause_turn'`) falls through silently and the loop spins until the cap. Codex review flagged this. Fix:

```ts
// After the tool_use branch, before the next iteration:
if (
  response.stop_reason !== 'end_turn' &&
  response.stop_reason !== 'tool_use'
) {
  console.warn(
    `[ICT Agent] Unexpected stop_reason '${response.stop_reason}' on iter ${i + 1}. ` +
      `Breaking loop to avoid wasted iterations.`,
  );
  lastStopReason = response.stop_reason;
  // Don't set cleanlyCompleted = true — this is an abnormal exit, the
  // timeout log path will still fire so we get observability.
  break;
}
```

In the `if (!cleanlyCompleted)` block (current lines 1816-1822), replace the existing message with:

```ts
const lastTools = lastIterToolNames.join(',') || '(none)';
const stopReasonNote = lastStopReason && lastStopReason !== 'tool_use'
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
```

The single-line format keeps it greppable from `pm2-err.log`. The fields directly answer "is the agent looping on a single tool, or making real progress that just runs out of room?". The `stop_reason` note distinguishes "ran out of iterations" from "abnormal exit" cases.

### Change 3 — Telegram alert (deduped per UTC day)

Add module-level state. **No concurrency guard needed** — unlike `pingKeepAlive` (8-min cron, fire-and-forget at `scheduler/index.ts:975`), ICT cycles are fully serialized by `ictRunning` + `ictOverlapQueue` in `scheduler/index.ts:935-970`. The scheduler awaits `safeRun(...runTradingAgent)` before clearing `ictRunning`, so two `runTradingAgent` invocations never run concurrently. Module-level reads/writes to `lastIctTimeoutAlertDate` are sequential by construction.

```ts
let lastIctTimeoutAlertDate: string | null = null;

/** Test-only: reset the dedup so a same-day timeout re-alerts. */
export function _resetIctTimeoutAlertDate(): void {
  lastIctTimeoutAlertDate = null;
}

/** Test-only: read current dedup state. Symmetry with _getPingFailureStreak. */
export function _getIctTimeoutAlertDate(): string | null {
  return lastIctTimeoutAlertDate;
}
```

Inside the `if (!cleanlyCompleted)` branch, after the `console.error`:

```ts
const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
if (lastIctTimeoutAlertDate !== today) {
  lastIctTimeoutAlertDate = today;
  alertSystemWarning(
    `⚠️ ICT cycle hit iteration cap (${maxIterations}). ` +
      `Last iter tools: ${lastTools}. ${totalToolCalls} total tool calls. ` +
      `Decision may be incomplete. Check pm2-err.log for full context.`,
  ).catch(() => { /* alert failure non-blocking */ });
}
```

Behaviour:
- First timeout in a UTC day → Telegram alert + console.error
- Subsequent timeouts same UTC day → console.error only (no spam)
- First timeout next UTC day → alert again (date string differs)

Same `.catch(() => {})` non-blocking pattern as `pingKeepAlive`. The `alertSystemWarning` import is already in scope from line 44.

### Why per-UTC-day dedup (not per-cycle / per-run)

- **Per-cycle**: every timeout alerts → spam (today would have been 5 alerts in one morning)
- **Per-process-run**: a pm2 restart clears it → reboots silently restart the noise
- **Per-UTC-day**: one alert tells the operator "today is a hard day for the agent", subsequent timeouts get logged only. Resets naturally at midnight UTC, matches the bot's daily rhythm (kill-switch reset, daily PnL snapshot, etc.)

## Tests

The agentic loop in `runTradingAgent` has **no existing unit-test coverage**. `tests/demo-gates.test.ts`, `tests/proposal-hash.test.ts`, `tests/rr-validation.test.ts`, and `tests/weekly-kill-switch.test.ts` all test pure helpers exported from `trading-agent.ts`, but none mock the `anthropic.messages.create` call that drives the loop. So we are creating new tests, not extending existing ones.

### Required surface change to make tests possible

`executeTool` is currently a private async function (`src/agents/trading-agent.ts:741`, no `export`). Both reviewers identified this as the only way to test the loop without a deeper refactor. **Decision: export `executeTool` directly (no underscore prefix)**. The existing `_reset*` / `_get*` helpers in this codebase are test-only (their only purpose is mutating module state for tests); `executeTool` is the real per-tool dispatcher and would be used by future code paths beyond tests. So it gets a normal `export`, not the test-only underscore convention. The alternative (extract a `runIctCycle({ deps })` function) is a larger refactor and offers no additional test fidelity.

```diff
-async function executeTool(
+export async function executeTool(
```

`anthropic.messages.create` is harder — `anthropic` is constructed at module-load (line 19) with no factory or DI. Use `vi.mock('@anthropic-ai/sdk', ...)` to replace the `Anthropic` class with a mock whose `messages.create` returns controllable responses. This is a top-of-file mock so it applies before the trading-agent module imports the real SDK.

### New file: `tests/trading-agent-loop.test.ts`

Mocks at the top:
- `vi.mock('@anthropic-ai/sdk')` — class mock with `messages.create = vi.fn()`
- `vi.mock('../src/notifications/telegram.js')` — `alertSystemWarning = vi.fn().mockResolvedValue(undefined)`
- `vi.mock('../src/agents/load-prompt.js')` — return stub strategy/prompt strings
- `vi.mock('../src/database/index.js')` — return safe defaults for `getLatestBrief`, `countOpenPositions`, etc.

The test then `vi.spyOn(tradingAgentModule, 'executeTool')` to count tool-call invocations and return controllable results.

Test fixture: a helper `makeToolUseResponse(toolName)` returns `{ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'x', name: toolName, input: {} }] }`. The `messages.create` mock is set to return this on every call so the loop never sees `end_turn` and exhausts the cap.

### Test cases

**Test 1 — Enriched timeout log fires with the expected fields** (own `it` block)

Exhaust the loop, assert `console.error` is called with a single argument matching:
```
/CYCLE TIMED OUT after 12 iterations.*Last iter tools: get_prices.*Total tool calls: 12 across 1 distinct tools/
```

**Test 2 — Telegram dedup state machine** (single `it` block with three sequential assertions)

The original spec had 3 separate `it` blocks sharing module state across them. Both reviewers flagged this as fragile (vitest's `--sequence.shuffle` or `test.concurrent` would silently break it). Combined into one `it` per their recommendation:

```ts
it('dedups Telegram alerts per UTC day', async () => {
  _resetIctTimeoutAlertDate();
  const alertMock = vi.mocked(alertSystemWarning);
  alertMock.mockClear();

  // First timeout on 2026-05-08 UTC
  vi.setSystemTime(new Date('2026-05-08T10:00:00Z'));
  await runOneTimeoutCycle();
  expect(alertMock).toHaveBeenCalledTimes(1);

  // Second timeout same UTC day — suppressed
  vi.setSystemTime(new Date('2026-05-08T14:00:00Z'));
  await runOneTimeoutCycle();
  expect(alertMock).toHaveBeenCalledTimes(1);

  // Third timeout next UTC day — re-fires
  vi.setSystemTime(new Date('2026-05-09T01:00:00Z'));
  await runOneTimeoutCycle();
  expect(alertMock).toHaveBeenCalledTimes(2);
});
```

**Test 3 — Abnormal `stop_reason` breaks the loop early and still logs** (own `it`)

Mock `messages.create` to return `{ stop_reason: 'max_tokens', content: [] }` on the first call. Assert: loop exits before consuming all 12 iterations, `console.warn` fires with "Unexpected stop_reason 'max_tokens'", `console.error` fires with the timeout message including "Last stop_reason: max_tokens".

**Test 4 — `ICT_AGENT_MAX_ITER` env-var override** (own `it`)

`process.env.ICT_AGENT_MAX_ITER = '3'`, run a timeout cycle, assert the `console.error` says "after 3 iterations" (not 12). Cleanup: `delete process.env.ICT_AGENT_MAX_ITER` in `afterEach`.

**Test 5 — Invalid env-var falls back to 12** (own `it`)

`process.env.ICT_AGENT_MAX_ITER = 'oops'`, assert the log says "after 12 iterations". Same for `'-5'`, `'99999'`, `'3.7'` — all should fall through to 12.

## Scheduler interaction (acknowledged, not changed)

The split-position monitor cron is now `*/1 * * * *` (parallel session's `acc6c80`, 2026-05-08). Candle-close detection at `scheduler/index.ts:134-148` gates the ICT trigger: only 15m or 1h candle closes hand off to `runTradingAgent`. The `ictRunning` flag (line 935) + `ictOverlapQueue` (lines 941-970) serialize cycles and queue overflows.

**The 15-min queue staleness window (line 954, `15 * 60_000`) interacts with this spec.** A bumped cap can produce cycles whose wall-time exceeds 15 min when LLM rounds AND tool execution stack up. If a queued follow-up is >15 min old when the in-flight cycle finishes, it gets discarded as stale and the next cycle waits for the next candle close.

**This is acceptable, not a problem.** The discarded queued cycle would have been triggered by a candle that's now ≥15 min stale — too old to act on anyway. The next cycle fires at the next candle close. No data loss, no missed structural opportunity.

But: this spec does NOT need to extend the staleness window. If observation post-deploy shows we're discarding queued follow-ups during real timeouts (visible via `[Scheduler] queued ICT cycle discarded as stale` log line if it exists, or worth adding), that's a separate observability item.

## What we are explicitly not doing (YAGNI)

- **Adaptive cap** (per-cycle dynamic based on kill-zone state or candidate count). Adds complexity without clear benefit at this scale; fixed 12 (env-overridable) covers the observed worst case with margin.
- **Per-iteration log file** (separate `ict-iterations.log`). The single-line enriched timeout log gives enough fingerprinting; full per-iter trail is overkill for one bot instance.
- **`executeTool` timeout wrapper.** Codex flagged that `executeTool` runs outside `withTimeout`, so the per-iter wall-time isn't bounded by `90s`. Wrapping `executeTool` in its own `withTimeout` is the right fix but it's a separate hardening item (broader test impact, blast radius beyond this spec). Tracked as a follow-up; explicitly out of scope here.
- **Hard token budget** alongside the iteration cap. The existing `iterationTimeoutMs = 90s` and per-iter `max_tokens = 12000` already bound per-iter LLM cost. A token-aggregate cap is double-belting.
- **Extend `ictOverlapQueue` staleness window** beyond 15 min. See "Scheduler interaction" above — not needed.

## Files touched

- `src/agents/trading-agent.ts`
  - Change 1: env-var-aware constant + comment rewrite (~20 lines, replacing the existing 5)
  - Change 2: loop state + enriched log + non-`end_turn`/`tool_use` stop-reason handling (~25 lines)
  - Change 3: module dedup state + 2 test helpers + alert call (~15 lines)
  - Surface change: `executeTool` gains `export` keyword (1 line, no runtime change)
- `tests/trading-agent-loop.test.ts` (NEW) — 5 test cases (test 2 has 3 sequential assertions in one `it`), ~120 lines including mocks/fixtures

Total diff: roughly 130-160 lines added, 5-10 removed. No new dependencies, no schema changes.

## Risk

Low. The change touches only the loop's stop condition and the timeout-branch logging. The agent's decision logic (tool calls, prompt, message construction) is untouched.

The per-iter `withTimeout(..., 90_000)` (line 1761) bounds the LLM round-trip but NOT `executeTool` (see Change 1 paragraph). So a wedged tool call inside `executeTool` could stretch a single iteration indefinitely; bumping the cap from 8 → 12 multiplies the worst-case bound by 1.5×. In practice, every `executeTool` call routes to a tool that already has its own timeout (Capital client uses 15s axios, MarketAux/RSS/TwelveData all use bounded HTTP clients). So the practical worst-case wall-time is `12 × (90s + sum-of-tool-timeouts ≈ 60s)` ≈ 30 min, vs `8 × ≈ 20 min` before. Both exceed the 15-min `ictOverlapQueue` staleness window, but that's already true at cap=8 and is acknowledged as acceptable in the Scheduler interaction section.

If 12 turns out wrong (still timing out, or burning credits), the env-var override (`ICT_AGENT_MAX_ITER`) lets you tune live without a redeploy. If the env override path itself is wrong, bumping the constant or reverting are both 1-line changes.

## Review history

**Reviewed in parallel by Claude (general-purpose) and Codex (rescue) on 2026-05-08.** Both verdicts: revise (small) before writing-plans. Convergent findings folded into this spec:

- **P1: `executeTool` not exported** → adding `export` keyword. Chose plain `export` (no underscore prefix) because `executeTool` is a real dispatcher, not a test-only helper. Documented in the "Required surface change" subsection.
- **P1: Test isolation across `it` blocks** → cases 2/3/4 collapsed into a single `it` per Codex's recommendation. The state machine is logically one test anyway.
- **P1: Env-var config in scope** → `ICT_AGENT_MAX_ITER` added to Change 1 with `1 ≤ N ≤ 50` validation guard.
- **P1: Module dedup safety justification** → ICT serialization invariant (`ictRunning` + `ictOverlapQueue`) cited explicitly in Change 3.
- **P1 (Codex unique): `executeTool` outside `withTimeout`** → per-iter wall-time NOT bounded by 90s. Spec corrected, follow-up tracked as out-of-scope item.
- **P1 (Codex unique): Non-`end_turn`/`tool_use` stop reasons silently spin** → explicit handler added with `console.warn` + early break.
- **P2: Comment block rewrite text** → inlined in Change 1.
- **P2: `_getIctTimeoutAlertDate()` for symmetry** → added.
- **P2: Scheduler 15-min staleness window interaction** → acknowledged in own section, no code change needed.

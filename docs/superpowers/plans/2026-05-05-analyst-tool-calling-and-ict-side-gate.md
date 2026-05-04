# Analyst Tool-Calling + ICT Pre-Analyst Order-Side Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the analyst's 100% JSON-parse-failure rate (0/6 approvals over 6 days) by switching the decision emission to forced tool calling, and stop wasting analyst calls on geometrically invalid proposals by adding an order-side validator gate before the analyst LLM call.

**Architecture:** Two surgical, independently-deployable changes on `master`. (A) `runAnalystAgent` calls `anthropic.messages.create` with a single `submit_decision` tool and `tool_choice: { type: 'tool', name: 'submit_decision' }`. The decision is read from the `tool_use` block, never parsed from text. (B) A new pure function `validateOrderSide` lives next to `validateRRFloor` in `trading-agent.ts`, is unit-tested, and is wired into the `request_analyst_review` handler immediately after the existing R:R pre-check.

**Tech Stack:** TypeScript, Anthropic SDK `@anthropic-ai/sdk@^0.65.0`, vitest. Changes touch `src/agents/analyst-agent.ts`, `src/agents/trading-agent.ts`, `tests/analyst.test.ts`, `tests/rr-validation.test.ts` (or a new `tests/order-side-validation.test.ts`).

---

## Task 1: Add `validateOrderSide` pure function with tests

**Files:**
- Modify: `src/agents/trading-agent.ts` (add export near `validateRRFloor` at line ~150)
- Test: `tests/rr-validation.test.ts` (extend with new describe block)

- [ ] **Step 1.1: Write the failing test**

Append to `tests/rr-validation.test.ts` after the existing tests:

```typescript
import { validateOrderSide } from '../src/agents/trading-agent.js';

describe('validateOrderSide — pre-analyst geometric sanity', () => {
  // Long: sl < entry < tp1 < tp2 < tp3
  it('long with correct ordering passes', () => {
    expect(validateOrderSide({
      direction: 'long', entry: 1.10, sl: 1.09, tp1: 1.11, tp2: 1.12, tp3: 1.13,
    }).ok).toBe(true);
  });

  it('long with SL above entry fails', () => {
    const r = validateOrderSide({
      direction: 'long', entry: 1.10, sl: 1.11, tp1: 1.12, tp2: 1.13, tp3: 1.14,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/long.*sl<entry/i);
  });

  it('long with TPs below entry fails', () => {
    const r = validateOrderSide({
      direction: 'long', entry: 1.10, sl: 1.09, tp1: 1.08, tp2: 1.07, tp3: 1.06,
    });
    expect(r.ok).toBe(false);
  });

  it('long with TPs out of order fails (tp2 < tp1)', () => {
    const r = validateOrderSide({
      direction: 'long', entry: 1.10, sl: 1.09, tp1: 1.13, tp2: 1.12, tp3: 1.14,
    });
    expect(r.ok).toBe(false);
  });

  // Short: tp3 < tp2 < tp1 < entry < sl
  it('short with correct ordering passes', () => {
    expect(validateOrderSide({
      direction: 'short', entry: 1.10, sl: 1.11, tp1: 1.09, tp2: 1.08, tp3: 1.07,
    }).ok).toBe(true);
  });

  // The 2026-05-04 08:31 GOLD case: SHORT with SL below entry and TPs above.
  it('short with inverted geometry fails (the 2026-05-04 GOLD case)', () => {
    const r = validateOrderSide({
      direction: 'short', entry: 4576.29, sl: 4575.00, tp1: 4577.58, tp2: 4578.87, tp3: 4580.16,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/short/i);
      expect(r.reason).toContain('4576.29');  // includes the actual numbers in the rejection
    }
  });

  it('rejects equal levels (degenerate)', () => {
    const r = validateOrderSide({
      direction: 'long', entry: 1.10, sl: 1.10, tp1: 1.11, tp2: 1.12, tp3: 1.13,
    });
    expect(r.ok).toBe(false);
  });

  it('rejects non-finite numbers', () => {
    const r = validateOrderSide({
      direction: 'long', entry: NaN, sl: 1.09, tp1: 1.11, tp2: 1.12, tp3: 1.13,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/finite|number/i);
  });
});
```

- [ ] **Step 1.2: Run the new tests, confirm they fail**

Run: `npx vitest run tests/rr-validation.test.ts`
Expected: 9 new tests fail with "validateOrderSide is not exported".

- [ ] **Step 1.3: Implement `validateOrderSide` in trading-agent.ts**

Insert after `validateRRFloor` (the closing `}` of that function — it ends around line 240):

```typescript
export interface OrderSideInput {
  direction: 'long' | 'short';
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  tp3: number;
}

export type OrderSideResult = { ok: true } | { ok: false; reason: string };

/**
 * Geometric sanity for the proposal. Pure, side-effect-free, no DB or
 * network. Cheap pre-check called BEFORE the analyst LLM call, mirroring
 * the same defense in `place_split_trade`.
 *
 * Long invariant:  sl < entry < tp1 < tp2 < tp3
 * Short invariant: tp3 < tp2 < tp1 < entry < sl
 *
 * Background (2026-05-05): the audit found that the ICT agent had been
 * submitting structurally inverted SHORTs (e.g. GOLD 2026-05-04 08:31 with
 * SL below entry and TPs above) that reached the analyst and consumed a
 * full Sonnet 4.6 + adaptive-thinking call before being rejected. The
 * verbose rejection prose then truncated the analyst's JSON output,
 * compounding into a parse failure. This gate cuts that path off.
 */
export function validateOrderSide(input: OrderSideInput): OrderSideResult {
  const { direction, entry, sl, tp1, tp2, tp3 } = input;

  // Reject any non-finite price up-front so the chained comparisons below
  // can't return misleading "false" on NaN comparisons.
  for (const [k, v] of Object.entries({ entry, sl, tp1, tp2, tp3 })) {
    if (!Number.isFinite(v)) {
      return { ok: false, reason: `Order-side rejected: ${k}=${v} is not a finite number.` };
    }
  }

  if (direction === 'long') {
    if (!(sl < entry && entry < tp1 && tp1 < tp2 && tp2 < tp3)) {
      return {
        ok: false,
        reason: `Long order-side invariant violated: need sl<entry<tp1<tp2<tp3, got sl=${sl}, entry=${entry}, tp1=${tp1}, tp2=${tp2}, tp3=${tp3}.`,
      };
    }
  } else {
    if (!(tp3 < tp2 && tp2 < tp1 && tp1 < entry && entry < sl)) {
      return {
        ok: false,
        reason: `Short order-side invariant violated: need tp3<tp2<tp1<entry<sl, got sl=${sl}, entry=${entry}, tp1=${tp1}, tp2=${tp2}, tp3=${tp3}.`,
      };
    }
  }
  return { ok: true };
}
```

- [ ] **Step 1.4: Run the new tests, confirm they pass**

Run: `npx vitest run tests/rr-validation.test.ts`
Expected: all tests pass (9 new + the existing ones still pass).

- [ ] **Step 1.5: Commit**

```bash
git add src/agents/trading-agent.ts tests/rr-validation.test.ts
git commit -m "feat(trading-agent): add validateOrderSide pure-function pre-check"
```

---

## Task 2: Wire `validateOrderSide` into `request_analyst_review` handler

**Files:**
- Modify: `src/agents/trading-agent.ts` lines ~580-606 (right after the R:R pre-check, before `runAnalystAgent`)

- [ ] **Step 2.1: Add the wiring**

Locate the block ending at line 605 (the `if (!rrPreCheck.ok) { ... }` closing brace) and insert immediately after it, before `const decision = await runAnalystAgent(proposal);`:

```typescript
      // Phase B (2026-05-05): order-side pre-check. Mirrors place_split_trade's
      // geometric validation but runs BEFORE the analyst LLM call so a
      // malformed proposal (e.g. SHORT with SL below entry — observed
      // 2026-05-04 08:31 on GOLD) is rejected without burning a Sonnet
      // 4.6 + adaptive-thinking call. The analyst's verbose rejection of
      // such proposals was also the dominant cause of JSON-output
      // truncation — fixing this here removes both the wasted call and
      // the truncation trigger.
      const orderSidePreCheck = validateOrderSide({
        direction: proposal.direction,
        entry: proposal.entry,
        sl: proposal.sl,
        tp1: proposal.tp1,
        tp2: proposal.tp2,
        tp3: proposal.tp3,
      });
      if (!orderSidePreCheck.ok) {
        console.log(`[Analyst Pre-Check] ${proposal.instrument} ${proposal.direction}: ${orderSidePreCheck.reason} — skipping analyst call.`);
        return JSON.stringify({
          decision: 'REJECT',
          reason: `Pre-analyst order-side violation: ${orderSidePreCheck.reason}`,
          analyst_token: '',
          proposal_hash: hash,
          trade_id: proposal.trade_id,
          confidence: 0,
          modifications: {},
        });
      }
```

- [ ] **Step 2.2: Verify build is clean**

Run: `npm run build`
Expected: tsc completes with no errors.

- [ ] **Step 2.3: Run full suite**

Run: `npm test`
Expected: all tests pass (count = previous + 9 from Task 1).

- [ ] **Step 2.4: Commit**

```bash
git add src/agents/trading-agent.ts
git commit -m "fix(trading-agent): wire order-side pre-check into request_analyst_review"
```

---

## Task 3: Refactor `runAnalystAgent` to use forced tool calling

**Files:**
- Modify: `src/agents/analyst-agent.ts` (replace messages.create call site + decision extraction)
- Test: `tests/analyst.test.ts` (extend with tool-call extractor tests)

- [ ] **Step 3.1: Write the failing test**

Append to `tests/analyst.test.ts`:

```typescript
import { extractAnalystDecisionFromTool } from '../src/agents/analyst-agent.js';

describe('extractAnalystDecisionFromTool — read decision from tool_use block', () => {
  it('extracts an APPROVE decision from a tool_use block', () => {
    const content = [
      { type: 'thinking', thinking: 'Let me run the 6 checks…' },
      {
        type: 'tool_use',
        id: 'tool_01',
        name: 'submit_decision',
        input: {
          decision: 'APPROVE',
          reason: 'All 6 checks pass; sizing math reconciles within 1.2%.',
          confidence: 0.84,
          modifications: {},
        },
      },
    ];
    const d = extractAnalystDecisionFromTool(content as never);
    expect(d.decision).toBe('APPROVE');
    expect(d.confidence).toBeCloseTo(0.84, 2);
    expect(d.reason).toMatch(/6 checks/);
  });

  it('extracts a REJECT decision', () => {
    const content = [
      {
        type: 'tool_use', id: 't', name: 'submit_decision',
        input: { decision: 'REJECT', reason: 'Calendar veto fires in 4 minutes', confidence: 0.95, modifications: {} },
      },
    ];
    const d = extractAnalystDecisionFromTool(content as never);
    expect(d.decision).toBe('REJECT');
  });

  it('extracts a MODIFY with modifications object', () => {
    const content = [
      {
        type: 'tool_use', id: 't', name: 'submit_decision',
        input: { decision: 'MODIFY', reason: 'Tighten SL by 5 pips', confidence: 0.7, modifications: { sl: 1.0985 } },
      },
    ];
    const d = extractAnalystDecisionFromTool(content as never);
    expect(d.decision).toBe('MODIFY');
    expect(d.modifications).toEqual({ sl: 1.0985 });
  });

  it('fails closed (REJECT) when no submit_decision block is present', () => {
    const content = [{ type: 'text', text: 'I forgot to call the tool.' }];
    const d = extractAnalystDecisionFromTool(content as never);
    expect(d.decision).toBe('REJECT');
    expect(d.confidence).toBe(0);
    expect(d.reason).toMatch(/no.*submit_decision/i);
  });

  it('fails closed when decision value is invalid', () => {
    const content = [
      {
        type: 'tool_use', id: 't', name: 'submit_decision',
        input: { decision: 'YES_WHY_NOT', reason: '?', confidence: 1, modifications: {} },
      },
    ];
    const d = extractAnalystDecisionFromTool(content as never);
    expect(d.decision).toBe('REJECT');
    expect(d.reason).toMatch(/invalid decision/i);
  });

  it('clamps out-of-range confidence to [0,1]', () => {
    const content = [
      {
        type: 'tool_use', id: 't', name: 'submit_decision',
        input: { decision: 'APPROVE', reason: 'ok', confidence: 1.7, modifications: {} },
      },
    ];
    const d = extractAnalystDecisionFromTool(content as never);
    expect(d.confidence).toBe(1);
  });

  it('handles non-finite confidence by zeroing it', () => {
    const content = [
      {
        type: 'tool_use', id: 't', name: 'submit_decision',
        input: { decision: 'APPROVE', reason: 'ok', confidence: 'not-a-number', modifications: {} },
      },
    ];
    const d = extractAnalystDecisionFromTool(content as never);
    expect(d.confidence).toBe(0);
  });

  it('ignores tool_use blocks for other tools', () => {
    const content = [
      {
        type: 'tool_use', id: 't', name: 'something_else',
        input: { foo: 'bar' },
      },
    ];
    const d = extractAnalystDecisionFromTool(content as never);
    expect(d.decision).toBe('REJECT');
    expect(d.reason).toMatch(/no.*submit_decision/i);
  });
});
```

- [ ] **Step 3.2: Run the new tests, confirm they fail**

Run: `npx vitest run tests/analyst.test.ts`
Expected: 8 new tests fail with `extractAnalystDecisionFromTool is not exported`.

- [ ] **Step 3.3: Add `extractAnalystDecisionFromTool` to `analyst-agent.ts`**

Insert immediately AFTER the `parseAnalystResponse` function (currently ends at line 71):

```typescript
/**
 * Read the decision from a forced `submit_decision` tool_use block. The
 * Anthropic SDK's input_schema enforces shape on the model side, but we
 * still defensively validate here — the SDK's schema validation guarantees
 * STRUCTURE but does not guarantee SEMANTICS (e.g. decision must be one
 * of three exact values).
 *
 * Fail-closed: any block-shape mismatch, missing tool call, invalid
 * `decision` enum value, or non-finite numerics returns REJECT with
 * confidence 0.
 */
export function extractAnalystDecisionFromTool(
  content: Anthropic.Messages.ContentBlock[],
): AnalystDecision {
  const failClosed = (reason: string): AnalystDecision => ({
    decision: 'REJECT',
    reason,
    modifications: {},
    confidence: 0,
  });

  if (!Array.isArray(content) || content.length === 0) {
    return failClosed('Analyst response had no content blocks.');
  }

  for (const block of content) {
    if (
      block &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'tool_use' &&
      (block as { name?: unknown }).name === 'submit_decision'
    ) {
      const input = (block as { input?: unknown }).input;
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return failClosed('submit_decision tool_use had no object input.');
      }
      const raw = input as Record<string, unknown>;

      const decisionRaw = String(raw.decision ?? '').toUpperCase();
      if (decisionRaw !== 'APPROVE' && decisionRaw !== 'REJECT' && decisionRaw !== 'MODIFY') {
        return failClosed(`Invalid decision in tool input: '${raw.decision}'.`);
      }

      const confRaw = Number(raw.confidence);
      const confidence = Number.isFinite(confRaw) ? Math.max(0, Math.min(1, confRaw)) : 0;

      const modifications = (raw.modifications && typeof raw.modifications === 'object' && !Array.isArray(raw.modifications))
        ? (raw.modifications as Record<string, unknown>)
        : {};

      const reason = typeof raw.reason === 'string' ? raw.reason : '';

      return {
        decision: decisionRaw as 'APPROVE' | 'REJECT' | 'MODIFY',
        reason,
        modifications,
        confidence,
      };
    }
  }
  return failClosed('Analyst response had no submit_decision tool call.');
}
```

NOTE: The Anthropic type import already exists at the top of `analyst-agent.ts` as `import Anthropic from '@anthropic-ai/sdk';`. The block type lives at `Anthropic.Messages.ContentBlock` — verify that path resolves at build time; if not, fall back to `unknown[]` like `extractText` does in `llm-output.ts`.

- [ ] **Step 3.4: Run the new tests, confirm they pass**

Run: `npx vitest run tests/analyst.test.ts`
Expected: 8 new tests pass; existing 6 tests for `parseAnalystResponse` also still pass (extractor is a separate function).

- [ ] **Step 3.5: Replace the `messages.create` call site to force the tool**

In `analyst-agent.ts`, replace the existing `try { response = await withTimeout(...) }` block (currently lines ~189-224) with:

```typescript
  // 2026-05-05 audit: force a structured tool call for the decision instead
  // of free-form prose ending in JSON. The previous shape lost the JSON to
  // max_tokens truncation when adaptive thinking + verbose markdown
  // analysis exceeded the budget — 0/6 analyst calls produced parseable
  // output between 2026-04-29 and 2026-05-04. Tool calling forces a
  // schema-validated input object regardless of how much prose precedes it.
  const submitDecisionTool: Anthropic.Tool = {
    name: 'submit_decision',
    description:
      'Submit your final approval decision for the proposed trade after running the 6-check sequence. ' +
      'Call this tool exactly once. Your full prose analysis goes in the `reason` field — do not write a ' +
      'separate text block; everything you want logged for the trade record should be in `reason`.',
    input_schema: {
      type: 'object',
      properties: {
        decision: {
          type: 'string',
          enum: ['APPROVE', 'REJECT', 'MODIFY'],
          description: 'The verdict on the proposal.',
        },
        reason: {
          type: 'string',
          description: 'Full analysis text. Cite specific check numbers (1-6) and quote relevant evidence (price levels, news headlines, lessons).',
        },
        confidence: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'How confident you are in this decision, 0-1. Use 0 only on fail-closed; reserve >0.9 for unambiguous cases.',
        },
        modifications: {
          type: 'object',
          description: 'Required only when decision=MODIFY. Keys: sl, tp1, tp2, tp3, total_risk_pct (numeric overrides). Empty object {} otherwise.',
          additionalProperties: true,
        },
      },
      required: ['decision', 'reason', 'confidence', 'modifications'],
    },
  };

  const timeoutMs = 60_000;
  let response: Awaited<ReturnType<typeof anthropic.messages.create>>;
  try {
    response = await withTimeout(
      anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 8000,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium' },
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: contextMessage }],
        tools: [submitDecisionTool],
        tool_choice: { type: 'tool', name: 'submit_decision' },
      }),
      timeoutMs,
      'Analyst',
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Analyst] API call failed: ${msg}. Defaulting to REJECT (confidence 0).`);
    const failClosed: AnalystDecision = {
      decision: 'REJECT',
      reason: `Analyst API failure — ${msg}. Fail-closed REJECT.`,
      modifications: {},
      confidence: 0,
    };
    logAnalystDecision(proposal.trade_id, proposal.strategy_tag, failClosed);
    return failClosed;
  }
```

- [ ] **Step 3.6: Replace the response-handling block to use the tool extractor**

Immediately after the try/catch above, replace the existing extraction (currently lines 226-243 — `extractText`, console.log of text, `parseAnalystResponse`, `logAnalystDecision`, console.log) with:

```typescript
  // Surface stop_reason for diagnosis. If we ever see 'max_tokens' here it
  // means the model truncated mid-tool-call — the schema-enforced extractor
  // will fail-closed with confidence 0 in that case, but the stop_reason
  // tells us we need to bump max_tokens or reduce thinking effort.
  console.log(`[Analyst] stop_reason=${response.stop_reason} content_blocks=${response.content.length}`);

  const decision = extractAnalystDecisionFromTool(response.content);

  // Log the decision (always — even on extractor failure, the REJECT row is
  // important audit data).
  logAnalystDecision(proposal.trade_id, proposal.strategy_tag, decision);

  // Truncate reason for stdout but log full reason to DB.
  const reasonPreview = decision.reason.length > 500
    ? decision.reason.slice(0, 500) + '…[truncated]'
    : decision.reason;
  console.log(`[Analyst] Decision: ${decision.decision} (confidence ${decision.confidence}) — ${reasonPreview}`);
  return decision;
```

- [ ] **Step 3.7: Run the full suite**

Run: `npm test`
Expected: all tests pass. The 6 existing `parseAnalystResponse` tests still pass — that function is unchanged. The 8 new `extractAnalystDecisionFromTool` tests pass.

- [ ] **Step 3.8: Run the build**

Run: `npm run build`
Expected: tsc clean. If `Anthropic.Messages.ContentBlock` doesn't resolve, change the parameter type to `unknown[]` and update the test casts to match.

- [ ] **Step 3.9: Commit**

```bash
git add src/agents/analyst-agent.ts tests/analyst.test.ts
git commit -m "fix(analyst): force submit_decision tool call to eliminate JSON parse truncation"
```

---

## Task 4: Push, deploy to VPS, and verify in live logs

**Files:** none (deployment).

- [ ] **Step 4.1: Push master**

Run: `git push origin master`
Expected: push succeeds, new commits on origin.

- [ ] **Step 4.2: VPS pull + build + restart in one SSH session**

Run:
```bash
ssh bot@162.55.212.198 'set -e && cd /home/bot/trading-bot && git pull --ff-only origin master && npm run build && pm2 restart trading-bot && pm2 save && pm2 jlist | grep -o "\"status\":\"[a-z]*\""'
```
Expected: pull fast-forwards, build clean, pm2 restart succeeds, status=online.

- [ ] **Step 4.3: Confirm clean startup**

Run:
```bash
ssh bot@162.55.212.198 'sleep 6 && grep -E "Bot is live|\[Preflight\] (OK|Env OK|Capital.com OK)|Error|FATAL" /home/bot/trading-bot/data/pm2-out.log | tail -10'
```
Expected: see "[OK] Preflight checks passed" and "Bot is live", no errors.

- [ ] **Step 4.4: Watch the next analyst call (may take up to 1 kill-zone cycle, ~5 min during 07:00–17:00 UTC)**

Run periodically (every 2-3 min while in a kill zone):
```bash
ssh bot@162.55.212.198 'grep -E "\[Analyst\]|Trade Analyst reviewing|Decision:|stop_reason" /home/bot/trading-bot/data/pm2-out.log | tail -20'
```
Expected: see a `[Analyst] stop_reason=...` line followed by `[Analyst] Decision: APPROVE|REJECT|MODIFY (confidence X.XX) — ...` with a non-empty, non-fail-closed reason. NO `Could not parse JSON from analyst response` lines on new entries.

- [ ] **Step 4.5: DB verification — at least one new analyst_log row with proper decision**

Run the inline node script via SSH:
```bash
ssh bot@162.55.212.198 'cd /home/bot/trading-bot && node --input-type=module -e "import initSqlJs from \"./node_modules/sql.js/dist/sql-wasm.js\"; import fs from \"fs\"; const SQL = await initSqlJs(); const db = new SQL.Database(fs.readFileSync(\"data/trading-bot.db\")); const r = db.exec(\"SELECT id, decision, substr(reason,1,80), confidence, created_at FROM analyst_log ORDER BY created_at DESC LIMIT 5\"); console.log(r[0]?.values);"'
```
Expected: at least one row dated AFTER deploy where `reason` does NOT start with "Could not parse JSON" (i.e. an actual analyst verdict).

- [ ] **Step 4.6: If verification fails, capture diagnosis and STOP for human review**

If the next analyst call still fails (parse error, or no analyst calls at all in 30 min during a kill zone):
- pull `data/pm2-out.log` lines around the failure
- check `stop_reason` from the new diagnostic log line
- decide: bump max_tokens to 16000, lower effort to 'low', or revert tool calling

Otherwise, mark verification successful and move on.

---

## Self-Review

**Spec coverage check:**
- Fix A (analyst tool calling) → Task 3 ✓
- Fix B (ICT pre-analyst order-side) → Tasks 1+2 ✓
- Backward compat for `parseAnalystResponse` → Task 3 keeps the function unchanged; existing 6 tests still pass ✓
- `stop_reason` diagnostic → Task 3 Step 3.6 ✓
- Success criteria (parseable decisions next 5 calls, malformed proposals rejected pre-analyst, build+test clean) → Tasks 4.4 / 4.5 / 2.2 / 2.3 ✓

**Placeholder scan:** No "TBD", no "implement later", no "similar to Task N". Each step has the exact code or command.

**Type consistency:** `OrderSideInput`, `OrderSideResult`, `AnalystDecision`, `extractAnalystDecisionFromTool` all defined consistently. Tool name `submit_decision` is used identically in implementation and tests.

**Scope check:** Two surgical changes that share infrastructure (both touch `analyst-agent.ts` and `trading-agent.ts`). No subsystem decomposition needed.

**Risk note (no plan change):** The Anthropic SDK version on this project may not export `Anthropic.Tool` or `Anthropic.Messages.ContentBlock` at those exact paths. Step 3.8 catches this at build time and provides the fallback (`unknown[]`).

---

## Execution

This plan executes inline in the current session — Giuseppe pre-authorized execution and asked for no permission gates. Per writing-plans terminal contract, I will use `superpowers:executing-plans` to walk Tasks 1–4 in order.

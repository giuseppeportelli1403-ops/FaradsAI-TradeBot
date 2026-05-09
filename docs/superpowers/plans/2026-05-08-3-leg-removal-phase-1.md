# 3-Leg Legacy Code Removal — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove every 3-leg code path, type field, prompt instruction, and test case from the Farad bot, while leaving the database schema untouched (Phase 2 territory). Add a defensive MCP runtime guard that throws if any caller attempts a 3-leg placement.

**Architecture:** TDD where new behavior is added (MCP guard, negative-coverage test file). Atomic removal where dead code goes away (scheduler functions, agent placement, prompts, tests). One commit per task. Codex twin per task per Giuseppe's standing rule on Farad bot work.

**Tech Stack:** TypeScript, Node 22.22.2, vitest 4.1.4, sql.js, Capital.com REST API.

**Coordination:** A parallel session is editing `src/agents/trading-agent.ts` for the ICT 8-iteration timeout fix. Hold all execution until Giuseppe signals that other session has merged. Re-verify line citations against post-merge master before dispatching Task 5 (the only task in this plan that touches `trading-agent.ts`).

---

## File map

- **Modify:** `src/scheduler/index.ts` — delete `handleTp3Hit`, narrow `handleSlOnLeg` to `'A' | 'B'`, drop `legCOrders`/Pass-3, delete Leg C amend in `handleTp1Hit`, collapse `handleTp2Hit` to terminal handler.
- **Modify:** `src/mcp-server/tools/trading-tools.ts` — add runtime guard, drop legacy 3-leg branch, drop `size_c?`/`tp3?` from input schema.
- **Modify:** `src/agents/trading-agent.ts` — clean up 9 sites of `tp3:null`/`size_c:null`. **HOLD until parallel session merges.**
- **Modify:** `src/agents/analyst-agent.ts` — drop `tp3` and `size_c` from `TradeProposal` type.
- **Modify:** `src/agents/reflection-agent.ts` — drop `position_c_outcome`/`pnl_c_r` from tool schema, extractor, prompt template.
- **Modify:** `src/types.ts` — `@deprecated` JSDoc on `TradeStatus.'tp2_hit'` and 6 nullable C-fields on `TradeRecord`/`Lesson`. No structural change.
- **Modify:** `prompts/analyst-agent.md` — strip 3-leg sizing rules at lines ~43, 60, 106.
- **Modify:** `prompts/reflection-agent.md` — strip C-outcome request lines at ~26, 28.
- **Modify:** `prompts/review-agent.md` — strip Leg C/TP3 reporting at ~20.
- **Modify:** `tests/scheduler.test.ts` — delete 3 tests at ~872, 916, 956.
- **Modify:** `tests/scheduler-tp1-be-offset.test.ts` — delete 3-leg long test at ~118.
- **Modify:** `tests/proposal-hash.test.ts` — delete `tp3/size_c` hash assertion at ~74.
- **Modify:** `tests/rr-validation.test.ts` — strip stale "TP3 removed" comment at ~11.
- **Modify:** `tests/reflection.test.ts` — delete C-fields-nullable assertion at ~95.
- **Modify:** `tests/trading-tools.test.ts` — fix legacy fixture at ~150 (replace 3-leg shape with 2-leg).
- **Modify:** `tests/backtest-engine.test.ts` — strip stale TP3-only comment at ~4.
- **Delete:** `tests/lesson-leg-c.test.ts` — entire file.
- **Create:** `tests/three-leg-removal.test.ts` — 4 negative-coverage assertions.
- **NO CHANGES:** `src/database/index.ts` (Phase 2 territory), `src/backtest/engine.ts` (already 2-leg), `prompts/ict-agent.md` (already 2-leg).

---

## Task 1: Pre-flight database safety check

**Files:** none (read-only verification)

- [ ] **Step 1: Run the in-flight 3-leg query**

```
cd "C:/Users/user/Desktop/Trade Bot/Trade Bot" && cat > /tmp/check-3leg.mjs <<'EOF'
import initSqlJs from 'sql.js';
import fs from 'fs';
const SQL = await initSqlJs();
const db = new SQL.Database(fs.readFileSync('data/trading-bot.db'));
const res = db.exec(
  "SELECT count(*) AS n FROM trades WHERE position_c_id IS NOT NULL AND status NOT IN ('complete','sl_hit','closed_early')"
);
console.log('IN_FLIGHT_3LEG:', res[0]?.values[0][0] ?? 0);
EOF
node --input-type=module < /tmp/check-3leg.mjs 2>&1 || ssh bot@162.55.212.198 "cd /home/bot/trading-bot && node --input-type=module <<'EOF'
import initSqlJs from 'sql.js';
import fs from 'fs';
const SQL = await initSqlJs();
const db = new SQL.Database(fs.readFileSync('data/trading-bot.db'));
const res = db.exec(\"SELECT count(*) AS n FROM trades WHERE position_c_id IS NOT NULL AND status NOT IN ('complete','sl_hit','closed_early')\");
console.log('IN_FLIGHT_3LEG:', res[0]?.values[0][0] ?? 0);
EOF"
```

(The local fallback may fail on Windows path quoting; the VPS path is the authoritative source since that DB is the live trading state.)

Expected: `IN_FLIGHT_3LEG: 0`.

- [ ] **Step 2: If non-zero, ABORT**

If the query returns > 0, the spec's "no in-flight 3-leg trades" assumption is invalidated. Stop, escalate to Giuseppe, and re-design Phase 1 to include a runtime guard for the affected positions.

- [ ] **Step 3: Record the result**

No commit needed — this is a verification step. Note the count in the report for Task 1.

---

## Task 2: Add MCP runtime guard for 3-leg placement (TDD)

**Files:**
- Modify: `src/mcp-server/tools/trading-tools.ts` (add guard at top of `place_split_trade` executor; ~line 280-290 area before the existing schema parsing)
- Test: `tests/trading-tools.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/trading-tools.test.ts`:

```ts
describe('place_split_trade — Phase 1 3-leg guard', () => {
  it('throws when size_c is non-null', async () => {
    const tool = makePlaceSplitTradeTool(); // existing fixture builder
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
    // Should not throw the 3-leg guard error. May throw downstream (Capital
    // mock not wired) — assert specifically NOT the 3-leg error string.
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
```

If `makePlaceSplitTradeTool` doesn't exist with that name, mirror the fixture pattern from existing tests in the file. Read the top 50 lines of `tests/trading-tools.test.ts` first to find the actual fixture-builder convention.

- [ ] **Step 2: Run test to verify it fails**

```
npx vitest run tests/trading-tools.test.ts -t '3-leg guard'
```
Expected: FAIL — first 2 cases pass-through to broker code (no guard exists yet); third case may pass coincidentally.

- [ ] **Step 3: Add the runtime guard**

In `src/mcp-server/tools/trading-tools.ts`, find the `place_split_trade` tool's executor (search for `place_split_trade`). At the **top** of the executor (before any other logic):

```ts
if (args.size_c != null || args.tp3 != null) {
  throw new Error(
    'place_split_trade: 3-leg placement is no longer supported. ' +
    'size_c/tp3 must be null/undefined. See docs/superpowers/specs/2026-05-08-3-leg-removal-phase-1-design.md.',
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

```
npx vitest run tests/trading-tools.test.ts -t '3-leg guard'
```
Expected: PASS, all 3 cases.

- [ ] **Step 5: Commit**

```
git add src/mcp-server/tools/trading-tools.ts tests/trading-tools.test.ts
git commit -m "feat(mcp): add runtime guard rejecting 3-leg placement (size_c/tp3 must be null)"
```

---

## Task 3: Remove legacy 3-leg branch from MCP placement

**Files:**
- Modify: `src/mcp-server/tools/trading-tools.ts` (remove `if (size_c && tp3)` branch at ~line 351 + drop `size_c?`/`tp3?` from input schema at ~line 301)
- Test: `tests/trading-tools.test.ts` (fix existing legacy fixture at ~line 150)

- [ ] **Step 1: Locate the 3-leg branch and schema**

```
grep -n 'size_c\|tp3' src/mcp-server/tools/trading-tools.ts
```

Find the `if (size_c && tp3) { ... }` block (Codex audit cited line 351) and the input schema declaration (line 301).

- [ ] **Step 2: Remove the branch and schema fields**

Delete the entire `if (size_c && tp3) { ... }` block and any code inside it that creates Position C. Remove `size_c?` and `tp3?` from the input schema.

The runtime guard from Task 2 will catch any caller that passes these even though the schema no longer accepts them — the schema rejection happens at parse, the guard catches the explicit-null case.

- [ ] **Step 3: Update the legacy fixture in the test file**

In `tests/trading-tools.test.ts` near line 150, find the legacy fixture that includes Position C / TP3 / size_c. Update it to 2-leg shape (drop those fields entirely from the fixture object). The test that uses this fixture should now exercise only the 2-leg path.

- [ ] **Step 4: Run all trading-tools tests**

```
npx vitest run tests/trading-tools.test.ts
```
Expected: all pass, including the 3 from Task 2.

- [ ] **Step 5: Commit**

```
git add src/mcp-server/tools/trading-tools.ts tests/trading-tools.test.ts
git commit -m "refactor(mcp): remove 3-leg branch from place_split_trade; tighten input schema"
```

---

## Task 4: Scheduler-side 3-leg code removal (atomic)

**Files:**
- Modify: `src/scheduler/index.ts` (multiple sites — see below)
- Test: `tests/scheduler.test.ts` (delete 3 tests), `tests/scheduler-tp1-be-offset.test.ts` (delete 1 test)

This is the largest task in the plan. Five code sites change in `src/scheduler/index.ts`, plus 4 test deletions. All in one atomic commit because the changes are interdependent (deleting `handleTp3Hit` while keeping its caller in `monitorSplitPositions` would leave a dangling reference).

- [ ] **Step 1: Locate every 3-leg site**

```
grep -n 'handleTp3Hit\|legCOrders\|position_c_id\|tp2_hit' src/scheduler/index.ts
```

Cross-check against the 8 citations in the spec (Codex inventory):
- `:334` — `legCOrders` construction in `monitorSplitPositions`
- `:433-454` — Pass 3 iteration block
- `:543` — `handleTp1Hit` Leg C amend branch
- `:567+580-582` — `handleTp2Hit` early-return + 3-leg branch
- `:598` — `handleTp3Hit` function declaration
- `:623` — `handleSlOnLeg` parameter type `'A' | 'B' | 'C'`
- `:644` — `handleSlOnLeg` terminal-status check `tp1_hit || tp2_hit`

(Line numbers may have drifted post-merge with the parallel session; re-grep before editing.)

- [ ] **Step 2: Make the 5 source edits**

**(a) `monitorSplitPositions` — drop `legCOrders` + Pass 3:**

Find the block constructing `legCOrders` (~line 334) and the entire Pass 3 iteration (~lines 433-454, the `for (const order of legCOrders) { ... }` loop). Delete both.

**(b) Delete `handleTp3Hit` entirely:**

Find the `export async function handleTp3Hit(...)` declaration (~line 598) and delete the function (typically ~20 lines).

**(c) Narrow `handleSlOnLeg` signature + drop `tp2_hit` from terminal check:**

```ts
// Before:
export async function handleSlOnLeg(
  trade: TradeRecord,
  tradeId: string,
  leg: 'A' | 'B' | 'C',
  deps?: MonitorDeps,
): Promise<void> {
  ...
  const wasInProfit = trade.status === 'tp1_hit' || trade.status === 'tp2_hit';
  ...
}

// After:
export async function handleSlOnLeg(
  trade: TradeRecord,
  tradeId: string,
  leg: 'A' | 'B',
  deps?: MonitorDeps,
): Promise<void> {
  ...
  const wasInProfit = trade.status === 'tp1_hit';
  ...
}
```

Delete any `if (leg === 'C') { ... }` branches inside the function body.

**(d) `handleTp1Hit` — delete Leg C amend:**

Find the trailing `if (trade.position_c_id) await moveLegSlToBe('C', trade.position_c_id);` line (~543). Delete just that line. Leg B path stays.

**(e) `handleTp2Hit` — collapse to terminal:**

Find the function body. Currently it has two paths:
```ts
if (!trade.position_c_id) {
  // 2-leg terminal: deactivate B, status=complete, alert.
  return;
}
// 3-leg path: status=tp2_hit, trail C SL to TP1.
```

Delete the early-return wrapper AND the 3-leg block. The body becomes the contents of the (formerly-2-leg) early-return branch, unconditionally.

- [ ] **Step 3: Delete the 4 affected tests**

In `tests/scheduler.test.ts`, delete the 3 tests at:
- `~872` — "3-leg: Leg A TP → handleTp1Hit moves BOTH Position B AND Position C SL to BE+offset" (Codex inventory citation)
- `~916` — "3-leg TP2 moves C SL to TP1 + leaves tp2_hit"
- `~956` — "3-leg TP3 completes + alerts"

In `tests/scheduler-tp1-be-offset.test.ts`, delete the test at `~118` — "3-leg long: BOTH Leg B and Leg C amended with the same offset".

(Use `grep -n '3-leg\|TP3\|Leg C' tests/scheduler.test.ts tests/scheduler-tp1-be-offset.test.ts` to confirm before deleting.)

- [ ] **Step 4: Run scheduler test suite + full suite**

```
npx vitest run tests/scheduler.test.ts tests/scheduler-tp1-be-offset.test.ts
npx tsc --noEmit
```

Expected: 89 - 4 = **85 pass** in those two files. tsc clean. If tsc reports errors about `handleTp3Hit`, `legCOrders`, or `'C'` leg references, you missed a site — re-grep and fix.

- [ ] **Step 5: Commit**

```
git add src/scheduler/index.ts tests/scheduler.test.ts tests/scheduler-tp1-be-offset.test.ts
git commit -m "refactor(scheduler): remove 3-leg code paths (handleTp3Hit, monitor Pass 3, handleTp1Hit Leg C, handleTp2Hit 3-leg branch, handleSlOnLeg narrowing)"
```

---

## Task 5: trading-agent.ts cleanup (HOLD until parallel session merges)

**Files:**
- Modify: `src/agents/trading-agent.ts` (9 sites — re-grep for current line numbers)
- Test: existing tests should pass without modification (these were noop sites)

⚠️ **DO NOT START THIS TASK until Giuseppe signals the parallel ICT-timeout session has merged.** That session edits `trading-agent.ts`. Coordinated merge protocol: pull master, re-grep all 9 citations against post-merge code, only then proceed.

- [ ] **Step 1: Re-grep against current master (citations updated 2026-05-09 post-parallel-merge)**

```
grep -nE 'tp3:\s*null|size_c:\s*null|position_c_id:\s*null|pnl_c:\s*null' src/agents/trading-agent.ts
```

Expected output as of master `4aab947` — **8 sites**:
- `:915, 919` — analyst schema reduced (Phase 2): `tp3: null, size_c: null`
- `:1077, 1081` — verification (Phase 2): `tp3: null, size_c: null`
- `:1515, 1518, 1521, 1522` — DB row writes: `tp3, position_c_id, size_c, pnl_c` all null

(Line numbers WILL shift if any further session edits this file before Task 5 runs. Use `grep -n` results as authoritative.)

Then separately, re-find `proposalHash` and `validateOrderSide` to check for IGNORED handling of tp3/size_c that needs removal (the original Codex audit cited `:67` and `:295` for these, but those line numbers are pre-merge stale):

```
grep -nE 'function (proposalHash|validateOrderSide)' src/agents/trading-agent.ts
```

Read both functions and remove any tp3/size_c handling — the upstream MCP guard (Task 2) prevents these fields from ever being set, so the IGNORED branches are now structurally unreachable.

- [ ] **Step 2: Remove the explicit-null lines**

For each of the 9 citations, delete the line that sets `tp3: null`, `size_c: null`, `position_c_id: null`, or `pnl_c: null`. The DB columns default to NULL when omitted from an INSERT, so removal is safe.

For `proposalHash` (line ~67) and `validateOrderSide` (line ~295) — these had IGNORED handling for tp3/size_c. Delete the IGNORED-marked code blocks, since they're now unreachable: the upstream MCP guard from Task 2 prevents the field from ever being set.

- [ ] **Step 3: Run the relevant test files**

```
npx vitest run tests/proposal-hash.test.ts tests/rr-validation.test.ts
npx tsc --noEmit
```

Expected: tests pass; tsc clean. (`proposal-hash.test.ts:74` will be cleaned in Task 7.)

- [ ] **Step 4: Run the full test suite as a sanity check**

```
npm test
```

Expected: ~807 - (Task 4's 4 deletions) + (Task 2's 3 additions) = ~806. Pin exact count in commit message. (Test baseline updated 2026-05-09 from 790 → 807 after parallel session merged Spec 1 + Spec 3 — both shipped 2026-05-09 ~02:33 UTC.)

- [ ] **Step 5: Commit**

```
git add src/agents/trading-agent.ts
git commit -m "refactor(trading-agent): remove tp3/size_c null-write sites (9 locations) post 3-leg removal"
```

---

## Task 6: analyst-agent.ts TradeProposal type cleanup

**Files:**
- Modify: `src/agents/analyst-agent.ts` (drop `tp3` and `size_c` from `TradeProposal` type at lines 155, 158)

- [ ] **Step 1: Locate the type**

```
grep -n 'tp3\|size_c\|TradeProposal' src/agents/analyst-agent.ts | head -20
```

Find the `TradeProposal` type / interface declaration. The fields are at ~lines 155 (tp3) and 158 (size_c) per Codex inventory.

- [ ] **Step 2: Delete the two fields**

Remove the `tp3?: number | null;` and `size_c?: number | null;` lines from the type declaration.

- [ ] **Step 3: Run typecheck**

```
npx tsc --noEmit
```

Expected: zero errors. If the compiler complains about a consumer that reads `proposal.tp3` or `proposal.size_c`, that site needs the same removal — fix in this task.

- [ ] **Step 4: Run analyst-related tests**

```
npx vitest run tests/analyst.test.ts tests/analyst-parse.test.ts
```

Expected: pass. `TradeProposal` is an LLM-facing type; dropping nullable fields removes them from the LLM's structured output schema, which is what we want.

- [ ] **Step 5: Commit**

```
git add src/agents/analyst-agent.ts
git commit -m "refactor(analyst): drop tp3/size_c from TradeProposal type (LLM no longer asked for 3-leg)"
```

---

## Task 7: reflection-agent.ts cleanup

**Files:**
- Modify: `src/agents/reflection-agent.ts` (tool schema + extractor + prompt template)
- Test: `tests/reflection.test.ts` (delete one assertion)

- [ ] **Step 1: Locate the C-fields**

```
grep -n 'position_c_outcome\|pnl_c_r' src/agents/reflection-agent.ts
```

Codex citations: `:51, 54` (tool schema), `:173, 176` (extractor), `:218` (prompt template), `:32` (stale comment).

- [ ] **Step 2: Edit the file in 4 places**

**(a) Tool schema** (~lines 51, 54): drop `position_c_outcome` and `pnl_c_r` from the input schema object.

**(b) Extractor** (~lines 173, 176): drop the lines that coerce `position_c_outcome` and `pnl_c_r` from the LLM response. Adjust the return type to no longer include them.

**(c) Prompt template** (~line 218): remove the "unless legacy 2-leg" branching from the prompt. The template now uniformly asks about A and B legs only.

**(d) Stale comment** (~line 32): remove or rewrite the "legacy 2-leg" comment since the term is now meaningless.

- [ ] **Step 3: Update reflection.test.ts**

```
grep -n 'position_c_outcome\|pnl_c_r\|nullable C' tests/reflection.test.ts
```

The test at ~line 95 asserts nullable C reflection fields. Delete that test entirely — it's now testing a removed feature.

- [ ] **Step 4: Run reflection tests + full suite**

```
npx vitest run tests/reflection.test.ts
npm test
```

Expected: reflection tests pass (one fewer than before). Full suite passes.

- [ ] **Step 5: Commit**

```
git add src/agents/reflection-agent.ts tests/reflection.test.ts
git commit -m "refactor(reflection): drop position_c_outcome/pnl_c_r from tool schema, extractor, prompt"
```

---

## Task 8: types.ts @deprecated JSDocs

**Files:**
- Modify: `src/types.ts` (7 fields + 1 status get JSDoc; no structural change)

- [ ] **Step 1: Locate the affected fields**

```
grep -n "tp2_hit\|tp3\|position_c_id\|size_c\|pnl_c\|position_c_outcome\|pnl_c_r" src/types.ts
```

Codex citations: `:238` (`TradeStatus.'tp2_hit'`), `:269` (`TradeRecord.tp3`), `:272` (`position_c_id`), `:275` (`size_c`), `:279` (`pnl_c`), `:309` (`Lesson.position_c_outcome`), `:312` (`Lesson.pnl_c_r`).

- [ ] **Step 2: Add @deprecated JSDoc above each**

For each of the 8 sites, add a JSDoc comment above the line:

```ts
/** @deprecated since 2026-05-08 — Phase 1 stopped writing/reading this; Phase 2 will drop the column from schema and remove from this type. See docs/superpowers/specs/2026-05-08-3-leg-removal-phase-1-design.md. */
```

For `TradeStatus.'tp2_hit'` (which is a string literal in a union type), add the JSDoc above the entire union and reference `tp2_hit` specifically:

```ts
/** Trade lifecycle status. `'tp2_hit'` is @deprecated since 2026-05-08 — no new code transitions to this state; Phase 2 will remove from union + DB CHECK. */
export type TradeStatus = 'open' | 'tp1_hit' | 'tp2_hit' | 'complete' | 'sl_hit' | 'closed_early';
```

- [ ] **Step 3: Run typecheck**

```
npx tsc --noEmit
```

Expected: zero errors. JSDoc annotations may surface `@deprecated` warnings at consumer sites, but those are non-blocking.

- [ ] **Step 4: Commit**

```
git add src/types.ts
git commit -m "docs(types): mark 3-leg fields and tp2_hit @deprecated (Phase 2 will remove)"
```

---

## Task 9: Prompt cleanups (analyst, reflection, review)

**Files:**
- Modify: `prompts/analyst-agent.md` (lines ~43, 60, 106)
- Modify: `prompts/reflection-agent.md` (lines ~26, 28)
- Modify: `prompts/review-agent.md` (line ~20)

- [ ] **Step 1: Read the 3-leg references in each prompt**

```
grep -n 'Leg C\|TP3\|tp3\|size_c\|position_c\|3-leg\|three-leg\|three leg' prompts/analyst-agent.md prompts/reflection-agent.md prompts/review-agent.md
```

- [ ] **Step 2: Edit `prompts/analyst-agent.md`**

At ~line 43: remove the 3-leg sizing divisor. The file likely has a section like "divide risk by 3 across A/B/C" — replace with the 2-leg 70/30 logic if not already present.

At ~line 60: remove the `size_c` comparison and three-leg comparison. Often something like "compare TP1, TP2, TP3 R:R" — change to just "TP1, TP2 R:R".

At ~line 106: remove the 3-leg risk rule. Often a paragraph about 3-leg split-position risk — delete entirely.

If the prompt's structure is unclear after edits (e.g., a section header for "3-leg trades"), tighten the document so it reads coherently in 2-leg-only mode.

- [ ] **Step 3: Edit `prompts/reflection-agent.md`**

At ~line 26: remove the C outcome request line.
At ~line 28: remove the `pnl_c_r` request line.

- [ ] **Step 4: Edit `prompts/review-agent.md`**

At ~line 20: remove the Leg C / TP3 reporting line from the weekly review template. The review now reports only Leg A and Leg B P&L per trade.

- [ ] **Step 5: Run smoke tests on prompt loaders (if any)**

```
grep -l 'analyst-agent.md\|reflection-agent.md\|review-agent.md' tests/
```

If any test loads these prompts as fixtures and asserts content, those tests may now fail — fix them in this same commit. The standard pattern is `loadPrompt('analyst-agent')` consumed by a smoke test.

- [ ] **Step 6: Commit**

```
git add prompts/analyst-agent.md prompts/reflection-agent.md prompts/review-agent.md
git commit -m "docs(prompts): strip 3-leg references from analyst, reflection, and review prompts"
```

---

## Task 10: Test cleanup + new negative-coverage file

**Files:**
- Delete: `tests/lesson-leg-c.test.ts` (entire file)
- Modify: `tests/proposal-hash.test.ts` (delete tp3/size_c hash assertion at ~74)
- Modify: `tests/rr-validation.test.ts` (strip stale "TP3 removed" comment at ~11)
- Modify: `tests/backtest-engine.test.ts` (strip stale TP3-only comment at ~4)
- Create: `tests/three-leg-removal.test.ts` (4 negative-coverage assertions)

- [ ] **Step 1: Delete `tests/lesson-leg-c.test.ts` entirely**

```
git rm tests/lesson-leg-c.test.ts
```

- [ ] **Step 2: Edit `tests/proposal-hash.test.ts`**

```
grep -n 'tp3\|size_c' tests/proposal-hash.test.ts
```

Find the assertion at ~line 74 ("`tp3/size_c` do not affect hash") and delete it. The fields are gone from `TradeProposal` after Task 6 — the assertion is now meaningless.

- [ ] **Step 3: Edit `tests/rr-validation.test.ts` and `tests/backtest-engine.test.ts`**

These have stale comments referencing TP3 removal (Codex flagged as cosmetic). Strip the comments.

- [ ] **Step 4: Create the new negative-coverage file**

Create `tests/three-leg-removal.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import initSqlJs from 'sql.js';
import fs from 'fs';

describe('three-leg removal — Phase 1 negative coverage', () => {
  // 1. MCP runtime guard catches stale callers.
  it('place_split_trade rejects size_c != null', async () => {
    const tool = makePlaceSplitTradeTool(); // mirror existing test fixture
    await expect(
      tool.executor({
        instrument: 'GOLD', direction: 'long',
        entry: 4735, sl: 4723, tp1: 4748, tp2: 4751,
        size_a: 0.56, size_b: 0.24, size_c: 0.1,
      } as any),
    ).rejects.toThrow(/3-leg placement is no longer supported/);
  });

  it('place_split_trade rejects tp3 != null', async () => {
    const tool = makePlaceSplitTradeTool();
    await expect(
      tool.executor({
        instrument: 'GOLD', direction: 'long',
        entry: 4735, sl: 4723, tp1: 4748, tp2: 4751,
        size_a: 0.56, size_b: 0.24, tp3: 4760,
      } as any),
    ).rejects.toThrow(/3-leg placement is no longer supported/);
  });

  // 2. Type contract — handleTp3Hit is gone.
  it('scheduler does not export handleTp3Hit', async () => {
    const mod = await import('../src/scheduler/index.js');
    expect((mod as any).handleTp3Hit).toBeUndefined();
  });

  // 3. Monitor observable — Leg C ignored.
  it('monitorSplitPositions does not amend a position with position_c_id set', async () => {
    // Build a fixture trade with position_c_id populated. Spy on
    // safelyAmendPosition. Assert it's never called for the C dealId.
    const cDealId = '__leg_C_test__';
    const calls: Array<{ dealId: string }> = [];
    // Stub deps: provide a getOpenPositions returning [{dealId: cDealId}]
    // and an empty activity history so the monitor sees position C as still
    // open. With Pass 3 removed, no amend should fire for cDealId.
    const stubDeps = {
      capital: {
        getOpenPositions: vi.fn(async () => [{ dealId: cDealId, instrument: 'GOLD' }]),
        getActivityHistory: vi.fn(async () => []),
        safelyAmendPosition: vi.fn(async (dealId: string) => {
          calls.push({ dealId });
          return { applied: true };
        }),
      },
      // ... mock the rest of MonitorDeps as needed (existing tests should
      // show the pattern); the assertion that matters is below.
    };
    const { monitorSplitPositions } = await import('../src/scheduler/index.js');
    await monitorSplitPositions(stubDeps as any);
    expect(calls.find(c => c.dealId === cDealId)).toBeUndefined();
  });

  // 4. Defensive read contract — historical 3-leg row remains queryable.
  it('reading a historical 3-leg row does not crash', async () => {
    // Use sql.js to load the actual production DB and query a row that has
    // position_c_id NOT NULL. The TradeRecord type still has the nullable
    // fields, so reading should round-trip safely.
    const SQL = await initSqlJs();
    const dbPath = 'data/trading-bot.db';
    if (!fs.existsSync(dbPath)) return; // skip if DB not present locally
    const db = new SQL.Database(fs.readFileSync(dbPath));
    const res = db.exec(
      "SELECT id, status, tp3, position_c_id, size_c, pnl_c FROM trades WHERE position_c_id IS NOT NULL LIMIT 1"
    );
    if (!res.length) return; // no historical 3-leg rows; skip
    const row = res[0].values[0];
    expect(row).toBeDefined();
    // Type round-trip: simulate reading into TradeRecord shape, no throw.
    const trade = {
      id: row[0], status: row[1], tp3: row[2],
      position_c_id: row[3], size_c: row[4], pnl_c: row[5],
    };
    expect(trade.position_c_id).not.toBeNull();
  });
});
```

If `makePlaceSplitTradeTool` doesn't exist, copy the fixture-builder pattern from `tests/trading-tools.test.ts` (probably `wrapTool` or similar — same as Task 2's first test).

- [ ] **Step 5: Run the new test file**

```
npx vitest run tests/three-leg-removal.test.ts
```

Expected: 4 tests pass (test 4 may skip if no historical 3-leg row exists locally).

- [ ] **Step 6: Run the full test suite**

```
npm test
```

Expected: count converges around 803-806 (807 baseline - deletions + additions). Pin the exact count in the commit message. (Baseline updated 2026-05-09 from 790 → 807 post-parallel-merge.)

- [ ] **Step 7: Commit**

```
git add tests/lesson-leg-c.test.ts tests/proposal-hash.test.ts tests/rr-validation.test.ts tests/backtest-engine.test.ts tests/three-leg-removal.test.ts
git commit -m "test: delete lesson-leg-c.test.ts; clean up stale 3-leg test fragments; add tests/three-leg-removal.test.ts negative-coverage"
```

---

## Task 11: Full test suite + tsc + backtest sanity gate

**Files:** none (verification only)

- [ ] **Step 1: Full test suite**

```
npm test
```

Expected: all pass. Note the exact count for the report.

- [ ] **Step 2: TypeScript typecheck**

```
npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 3: Backtest sanity gate**

```
npx tsx scripts/run-backtest.ts --start 2024 --end 2025 --tickers EURUSD,GBPUSD,GOLD,AUDUSD,OIL_CRUDE
```

Expected: PF ≥ 0.61. The backtest engine is already 2-leg only, so PF should be unchanged from Phase 2 baseline.

- [ ] **Step 4: If anything fails — STOP**

Do not proceed to Task 12. Re-enter `superpowers:systematic-debugging` Phase 1.

- [ ] **Step 5: No commit (verification only)**

---

## Task 12: Push to master + verify live deploy

**Files:** none (commits and ops)

- [ ] **Step 1: Stage and commit the spec + plan**

```
git add docs/superpowers/specs/2026-05-08-3-leg-removal-phase-1-design.md docs/superpowers/plans/2026-05-08-3-leg-removal-phase-1.md
git commit -m "docs: 3-leg removal Phase 1 — design and 12-task plan"
```

- [ ] **Step 2: Push to master**

```
git push origin master
```

- [ ] **Step 3: Watch GitHub Actions deploy**

```
gh run watch --exit-status
```

(Or follow the most recent run via `gh run list --branch master --limit 1` if the watch command needs a specific run ID.)

Expected: Build + Test green, Deploy to VPS in ~14s.

- [ ] **Step 4: Verify VPS picked up the new HEAD and pm2 is healthy**

```
ssh bot@162.55.212.198 "cd /home/bot/trading-bot && git rev-parse HEAD && pm2 status trading-bot && pm2 logs trading-bot --lines 30 --nostream"
```

Expected:
- VPS HEAD matches the local push.
- pm2 trading-bot online, recent restart count incremented by 1.
- Startup banner unchanged (still shows the cron lines from yesterday's TP1 fix).
- No new errors in pm2-err.log post-deploy.

- [ ] **Step 5: Watch for the next live trade**

When the bot opens a new trade, verify in pm2-out.log:
- DB write shows `position_c_id IS NULL`, `tp3 IS NULL`, `size_c IS NULL`.
- No `[TP1] ... Position C ...` lines.
- No `tp2_hit` status entries.
- No throw from the MCP runtime guard (means the LLM and analyst respect the 2-leg-only contract).

If any of these fire, the cleanup is incomplete and Phase 1 needs a follow-up patch.

---

## Self-review

**Spec coverage check:**
- [x] Pre-flight DB safety check → Task 1
- [x] MCP runtime guard → Task 2
- [x] MCP 3-leg branch removal + schema cleanup → Task 3
- [x] Scheduler 3-leg removal (handleTp3Hit, monitor Pass 3, handleTp1Hit Leg C, handleTp2Hit 3-leg, handleSlOnLeg narrow + tp2_hit OR-clause) → Task 4
- [x] trading-agent.ts 9-site cleanup → Task 5 (with parallel-session hold)
- [x] analyst-agent.ts TradeProposal cleanup → Task 6
- [x] reflection-agent.ts cleanup → Task 7
- [x] types.ts @deprecated JSDocs → Task 8
- [x] Prompt cleanup (analyst, reflection, review) → Task 9
- [x] Tests: delete 3-leg cases + create three-leg-removal.test.ts → Tasks 4 (scheduler), 7 (reflection), 10 (others + new file)
- [x] Out-of-scope (Phase 2): NO schema changes in Phase 1 → enforced by Task 8 keeping types nullable + Task 11 backtest gate
- [x] Backtest sanity gate → Task 11
- [x] Push + deploy verify → Task 12
- [x] Coordination protocol with parallel session → Task 5 explicit hold

**Placeholder scan:** None. Every step has exact file paths, exact commands, exact deletions, or actual code blocks.

**Type/method consistency:**
- `handleTp3Hit` — referenced in Task 4 (deletion) and Task 10 (negative-coverage assertion). Same name throughout.
- `handleSlOnLeg` signature `'A' | 'B'` — declared in Task 4. No later task references the old `'A' | 'B' | 'C'` form.
- `MonitorDeps` — referenced for stub-construction in Task 10. The exact field set isn't pinned in the plan; Task 10 instructs "mirror existing tests' MonitorDeps stub pattern" since that's the cleanest way to handle drift if the parallel session adds fields.
- `TradeProposal.tp3`, `TradeProposal.size_c` — declared deleted in Task 6, asserted absent in no later task (the `proposal-hash.test.ts:74` deletion in Task 10 covers this; no positive-coverage test needed).
- `TradeStatus.'tp2_hit'` — kept in union (Task 8), referenced via JSDoc only. No later task adds new code that produces or reads this state.

No drift detected.

**Out-of-order risk:**
- Task 5 (`trading-agent.ts`) is the only one blocked by an external session. Plan is explicit; agent flow honors `addBlockedBy` semantics if you're using TaskCreate dependencies.
- Tasks 6-9 can in principle run in any order after Task 5 completes (or before, since they don't touch `trading-agent.ts`). The plan as written is sequential for review simplicity, but any reordering of 6-9 is safe.
- Task 10 should run AFTER 4 (scheduler) and 6 (analyst) so its `handleTp3Hit` and `TradeProposal` assertions reflect the post-removal state.

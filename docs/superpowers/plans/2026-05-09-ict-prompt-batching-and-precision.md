# ICT Prompt: Batching Directive + R:R Floor Precision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate two prompt-level iteration-waste patterns observed on 2026-05-08 NFP day — sequential single-tool calls (8s where parallel batching saves ~3 iterations per cycle) and TP2=1.30 R:R floor retries (1 wasted iteration per cycle on boundary cases).

**Architecture:** Pure prompt edits to `prompts/ict-agent.md` plus 3 static prompt-content tests in a new `tests/ict-prompt.test.ts`. Zero TypeScript code change, zero new tools, zero scheduler change. Three TDD task pairs (test → prompt edit → commit) plus a final verification + push task.

**Tech Stack:** Markdown prompt file, vitest 4.1.4, Node.js fs.readFileSync. Same project as Spec 1 (Farad trading bot).

**Spec:** `docs/superpowers/specs/2026-05-09-ict-prompt-batching-and-precision-design.md` (commit `42b8fc5`).

---

## File map

- **Modify:** `prompts/ict-agent.md`
  - **STEP 1** (currently lines 101-108): rewrite to mandate parallel batching of `get_daily_pnl()` + `get_portfolio()` + `get_economic_calendar(1)`. Fold the calendar fetch from current Step F into STEP 1.
  - **Step F** (currently lines 140-144): rewrite as a calendar-veto re-check that READS from STEP 1's cached calendar (no fresh tool call).
  - **STEP 3 header** (currently lines 114-116): add a `**CRITICAL — batch all read-only data tools in a single response.**` directive listing the 4-tool minimum batch (`get_prices` 1h + `get_prices` 15m + `get_news_context` + `get_lessons`).
  - **R:R floor section** (after lines 188 and 192): insert the precision rule (`TP2 ≥ 1.31 × |entry − SL|` instead of `1.30`; `TP1 ≥ 1.01` instead of `1.00`).
  - **Step L checklist** (currently line 208): update target margins from `≥ 1.0 / ≥ 1.3` to `≥ 1.01 / ≥ 1.31`.
- **Create:** `tests/ict-prompt.test.ts` (NEW, ~70 lines, 3 static prompt-content tests).

---

## Task 1: STEP 1 parallel-batching directive + fold in `get_economic_calendar`

**Files:**
- Modify: `prompts/ict-agent.md` (STEP 1 + Step F sections — locate by content, line numbers may have drifted)
- Create: `tests/ict-prompt.test.ts`

- [ ] **Step 1: Write the failing test (and create the test file)**

Create `tests/ict-prompt.test.ts` with this exact content:

```ts
// Static prompt-content tests for prompts/ict-agent.md.
// These guard against accidental deletion of L3 directives — they verify
// the prompt file STILL contains the literal directives we shipped, NOT
// behavioral correctness of the agent (which is only validatable in
// production).
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = join(__dirname, '..', 'prompts', 'ict-agent.md');

let promptText: string;

beforeAll(() => {
  promptText = readFileSync(PROMPT_PATH, 'utf-8');
});

describe('ict-agent.md L3 directives', () => {
  it('STEP 1 mandates parallel batching of get_daily_pnl + get_portfolio + get_economic_calendar', () => {
    expect(promptText).toContain(
      'IN PARALLEL (emit all three as parallel tool_use blocks',
    );
    // The three tool calls must appear in the rendered prompt. Order
    // doesn't matter for the test, but all three must be present.
    expect(promptText).toMatch(/get_daily_pnl\(\)/);
    expect(promptText).toMatch(/get_portfolio\(\)/);
    expect(promptText).toMatch(/get_economic_calendar\(1\)/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/ict-prompt.test.ts`
Expected: FAIL — `expect(promptText).toContain('IN PARALLEL ...')` fails because the current prompt does not contain that string.

- [ ] **Step 3: Rewrite STEP 1 in `prompts/ict-agent.md`**

Locate the existing STEP 1 block (search for `### STEP 1 — CHECK DAILY RISK STATUS`). Replace the entire block from `### STEP 1 — CHECK DAILY RISK STATUS` through the empty line before `### STEP 2 — GET RANKED INSTRUMENTS` with:

```markdown
### STEP 1 — CHECK DAILY RISK STATUS + GLOBAL CONTEXT

In a single response, call IN PARALLEL (emit all three as parallel tool_use blocks, NOT one per iteration):
  - get_daily_pnl()
  - get_portfolio()
  - get_economic_calendar(1)

The calendar veto applies to the entire trading window (not per-candidate), so fetching it once at STEP 1 saves N-1 calls when analysing N candidates in STEP 3. The veto windows match the code:
- Generic high-impact event: skip if within **−5/+30 min** of intended trade time
- Tier-1 events (FOMC, NFP, CPI, central-bank rate decisions, Core PCE, GDP, ISM PMI, AHE, Unemployment Rate, Retail Sales, central-bank press conferences): skip if within **−60/+30 min**

After reading the three results:
- If `kill_switch_active` is true (daily loss ≥ 6%): "KILL SWITCH ACTIVE — Daily loss limit reached. No new positions. Managing existing positions only." Then check existing positions (Step 4) only. No new entries.
- Open positions: there is NO hard cap on number of open positions — each new trade stands on its score. Coordination lock applies: do not open a new ICT trade on an instrument already held.
- Calendar: note any Tier-1 events within the next ~3 hours that would veto entries opened now.
```

- [ ] **Step 4: Rewrite Step F in `prompts/ict-agent.md`**

Locate Step F (search for `**F. Get economic calendar**`). The current block is:

```markdown
**F. Get economic calendar** — `get_economic_calendar(1)`. The veto windows match the code:
- Generic high-impact event: skip if within **−5/+30 min** of trade time
- Tier-1 events (FOMC, NFP, CPI, central-bank rate decisions, Core PCE, GDP, ISM PMI, AHE, Unemployment Rate, Retail Sales, central-bank press conferences): skip if within **−60/+30 min**

If you're inside a window: SKIP. Don't bother running structure analysis. The `place_split_trade` tool will refuse anyway.
```

Replace the entire Step F block with:

```markdown
**F. Calendar veto re-check** — apply the veto windows from STEP 1's `get_economic_calendar` result to this candidate's intended trade time. If inside a Tier-1 −60/+30 window or a generic −5/+30 window relative to the current 15M close: SKIP this candidate, no structure analysis, no proposal. The `place_split_trade` tool will refuse anyway. Do NOT call `get_economic_calendar` again here — it was already fetched in STEP 1.
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/ict-prompt.test.ts`
Expected: PASS — all three assertions match the rewritten STEP 1.

- [ ] **Step 6: Run the full test suite to confirm no regression**

Run: `npx vitest run`
Expected: all tests pass. Test count should be 805 (was 804 after Spec 1; +1 from this task's new test).

- [ ] **Step 7: Commit**

```bash
git add prompts/ict-agent.md tests/ict-prompt.test.ts
git commit -m "feat(prompt): STEP 1 parallel-batch get_daily_pnl + get_portfolio + get_economic_calendar

Folds get_economic_calendar from per-candidate Step F into STEP 1 so
it's fetched once per cycle (not N times for N candidates). Mandates
parallel tool_use blocks in a single response so the loop's L1
Promise.all (Spec 1) actually runs the three reads concurrently.

Step F becomes a calendar-veto re-check that reads from STEP 1's
result instead of fetching again.

Adds tests/ict-prompt.test.ts with a static prompt-content guard so
accidental deletion of the directive surfaces in CI.

Per spec docs/superpowers/specs/2026-05-09-ict-prompt-batching-and-precision-design.md L3a.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: STEP 3 batching directive

**Files:**
- Modify: `prompts/ict-agent.md` (STEP 3 header — locate by content)
- Modify: `tests/ict-prompt.test.ts` (append Test 2)

- [ ] **Step 1: Append Test 2 to `tests/ict-prompt.test.ts`**

Inside the existing `describe('ict-agent.md L3 directives', ...)` block (after Test 1), append:

```ts
  it('STEP 3 mandates parallel batching of read-only fetches per candidate', () => {
    expect(promptText).toContain(
      'CRITICAL — batch all read-only data tools in a single response',
    );
    // Minimum batch per candidate
    expect(promptText).toMatch(/get_prices\(instrument, '1h', 50\)/);
    expect(promptText).toMatch(/get_prices\(instrument, '15m', 50\)/);
    expect(promptText).toMatch(/get_news_context\(instrument\)/);
    expect(promptText).toMatch(
      /get_lessons\(setup_type, instrument_category, kill_zone, 'ICT_INTRADAY'\)/,
    );
  });
```

- [ ] **Step 2: Run the new test to verify it fails**

Run: `npx vitest run tests/ict-prompt.test.ts -t 'STEP 3 mandates'`
Expected: FAIL — `expect(promptText).toContain('CRITICAL — batch all read-only data tools')` fails because the current prompt does not contain that directive (only the existing per-step labels A/E/G).

- [ ] **Step 3: Insert the STEP 3 batching directive in `prompts/ict-agent.md`**

Locate the STEP 3 header block (search for `### STEP 3 — FOR EACH CANDIDATE, RUN THE FULL ANALYSIS`). The current text is:

```markdown
### STEP 3 — FOR EACH CANDIDATE, RUN THE FULL ANALYSIS

For each promising instrument, in score order:
```

Replace those three lines with:

```markdown
### STEP 3 — FOR EACH CANDIDATE, RUN THE FULL ANALYSIS

For each promising instrument, in score order:

**CRITICAL — batch all read-only data tools in a single response.** Sub-steps A, E, and G below are all read-only data fetches that don't depend on each other. Emit them as parallel tool_use blocks in ONE response, NOT one tool per iteration. Then proceed to B/C/D and H-L (which require analysis of the data) once all results are back.

The minimum batch per candidate is:
  - get_prices(instrument, '1h', 50)
  - get_prices(instrument, '15m', 50)
  - get_news_context(instrument)
  - get_lessons(setup_type, instrument_category, kill_zone, 'ICT_INTRADAY')

Issue these four calls in a single response. The scheduler runs each tool concurrently via Promise.all (per the 2026-05-09 L1 change), so wall-time is the slowest tool, not the sum.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/ict-prompt.test.ts -t 'STEP 3 mandates'`
Expected: PASS — all four tool-name regex assertions and the directive substring are now present.

- [ ] **Step 5: Run the full file to confirm Test 1 still passes**

Run: `npx vitest run tests/ict-prompt.test.ts`
Expected: 2 tests pass.

- [ ] **Step 6: Commit**

```bash
git add prompts/ict-agent.md tests/ict-prompt.test.ts
git commit -m "feat(prompt): STEP 3 batching directive — parallel tool_use per candidate

Adds a CRITICAL header at the top of STEP 3's per-candidate loop
mandating that get_prices(1h) + get_prices(15m) + get_news_context +
get_lessons be emitted as parallel tool_use blocks in one response,
not one tool per iteration. Names the minimum batch explicitly so the
model has a concrete recipe to follow.

Pre-fix, c0800-class cycles split these 4 reads into 4 separate
iterations (one tool per iter); c0930-class cycles batched 4 in 1
iter and finished in 5 total iterations. The directive raises the
batching probability from 'sometimes' to 'mandated'.

Per spec docs/superpowers/specs/2026-05-09-ict-prompt-batching-and-precision-design.md L3a.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: TP2 R:R floor precision rule

**Files:**
- Modify: `prompts/ict-agent.md` (R:R floor section + Step L checklist — locate by content)
- Modify: `tests/ict-prompt.test.ts` (append Test 3)

- [ ] **Step 1: Append Test 3 to `tests/ict-prompt.test.ts`**

Inside the existing `describe` block, append after Test 2:

```ts
  it('TP2 R:R precision rule cites 1.31 (not 1.30) as the safe target', () => {
    // The precision rule itself
    expect(promptText).toContain('TP2 ≥ 1.31 × |entry − SL|');
    // Step L checklist updated to use 1.01 / 1.31 as the safe-target margins
    expect(promptText).toContain(
      'R:R to TP1 ≥ 1.01 and R:R to TP2 ≥ 1.31',
    );
  });
```

- [ ] **Step 2: Run the new test to verify it fails**

Run: `npx vitest run tests/ict-prompt.test.ts -t 'TP2 R:R precision'`
Expected: FAIL — both assertions fail because the prompt currently uses `≥ 1.0 / ≥ 1.3` in the checklist and has no precision rule.

- [ ] **Step 3: Insert the precision rule after the trend-mode TP2 line**

Locate the trend-mode TP2 line (search for `**TP2: ≥ 1.3:1 R:R** (universal — same floor for all tiers and all instruments)`). Immediately AFTER that line, insert a blank line then this paragraph:

```markdown
> **Precision rule (post-2026-05-09 retry-pattern audit):** broker tick rounding can shave the actual R:R below the strict 1.30 floor even when your math computes 1.30 exactly. To clear the floor robustly, **always set TP2 ≥ 1.31 × |entry − SL|** (1.31, not 1.30). The same defensive margin applies to TP1 — set TP1 ≥ 1.01 × |entry − SL| even though the de-risk leg is described as "1:1" in spirit. The pre-check at request_analyst_review is strict; one extra basis point of TP distance avoids a same-cycle resubmission.
```

- [ ] **Step 4: Insert the same precision rule after the range-mode TP2 line**

Locate the range-mode TP2 line (search for `**TP2: opposite range extreme** — must be ≥ 1.3:1 R:R (universal floor)`). Immediately AFTER that line, insert a blank line then the SAME paragraph as Step 3:

```markdown
> **Precision rule (post-2026-05-09 retry-pattern audit):** broker tick rounding can shave the actual R:R below the strict 1.30 floor even when your math computes 1.30 exactly. To clear the floor robustly, **always set TP2 ≥ 1.31 × |entry − SL|** (1.31, not 1.30). The same defensive margin applies to TP1 — set TP1 ≥ 1.01 × |entry − SL| even though the de-risk leg is described as "1:1" in spirit. The pre-check at request_analyst_review is strict; one extra basis point of TP distance avoids a same-cycle resubmission.
```

- [ ] **Step 5: Update Step L's checklist line**

Locate the Step L checklist line (search for `R:R to TP1 ≥ 1.0 and R:R to TP2 ≥ 1.3 (universal floors post-2026-05-07)`). Replace that single line with:

```markdown
- [ ] R:R to TP1 ≥ 1.01 and R:R to TP2 ≥ 1.31 (precision margin against broker tick rounding — see precision rule above; strict floors are 1.0 / 1.3 but the safe target is 1.01 / 1.31)
```

- [ ] **Step 6: Run Test 3 to verify it passes**

Run: `npx vitest run tests/ict-prompt.test.ts -t 'TP2 R:R precision'`
Expected: PASS — both `toContain` assertions match.

- [ ] **Step 7: Run all 3 prompt tests + the full suite**

Run: `npx vitest run tests/ict-prompt.test.ts`
Expected: 3 tests pass.

Run: `npx vitest run`
Expected: full suite passes. Test count = 807 (was 804 + 3 new prompt tests = 807).

- [ ] **Step 8: Commit**

```bash
git add prompts/ict-agent.md tests/ict-prompt.test.ts
git commit -m "feat(prompt): TP2 R:R floor precision rule (1.31 not 1.30)

validateRRFloor enforces strict ≥ 1.30 in src/agents/trading-agent.ts.
Broker tick rounding shaves the actual R:R below 1.30 at execution
time even when the agent's math computes exactly 1.30, causing
RR_FLOOR_VIOLATION rejections that the agent then corrects on the
next iteration (observed in cycles c0845, c0900 on 2026-05-08).

Adds a precision rule to both trend-mode and range-mode TP2 sections:
'always set TP2 ≥ 1.31 × |entry − SL| (1.31, not 1.30)' with the same
defensive margin for TP1 (1.01 vs 1.00). Updates Step L's final
checklist to use the safe-target margins 1.01/1.31; strict floors
1.0/1.3 stay unchanged in the validateRRFloor code.

One extra basis point of TP distance per leg eliminates the boundary-
case retry pattern.

Per spec docs/superpowers/specs/2026-05-09-ict-prompt-batching-and-precision-design.md L3b-1.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Final verification + push + VPS deploy check

**Files:** none modified — verification only.

- [ ] **Step 1: Confirm working tree is clean and commits look right**

Run: `git status -s | grep -vE "^\?\?"`
Expected: empty (no tracked-file modifications outstanding).

Run: `git log --oneline origin/master..HEAD`
Expected: 3 commits — Task 1 (`feat(prompt): STEP 1 parallel-batch...`), Task 2 (`feat(prompt): STEP 3 batching directive...`), Task 3 (`feat(prompt): TP2 R:R floor precision rule...`).

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: zero errors. (No TypeScript change in this plan; this just confirms the existing build still works.)

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: 807/807 pass (804 from Spec 1 + 3 new prompt tests).

- [ ] **Step 4: Concurrent-session safety pull**

Run: `git fetch origin && git log --oneline HEAD..origin/master`
Expected: empty output (no parallel pushes to master since this plan started). If non-empty, STOP and reconcile before pushing.

- [ ] **Step 5: Push to origin**

Run: `git push origin master`
Expected: push succeeds. GitHub Actions runs Build+Test, then triggers `/home/bot/deploy.sh` on the VPS, which now sources nvm (per yesterday's deploy.sh fix) so the bot restarts under Node 22.22.2.

- [ ] **Step 6: Verify VPS state after deploy completes (~3 min)**

Run:
```bash
ssh bot@162.55.212.198 'cd /home/bot/trading-bot && git log --oneline -4 && export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use default >/dev/null 2>&1 && pm2 jlist | python3 -c "import sys,json; d=json.load(sys.stdin); p=d[0]; print(p[\"name\"], p[\"pm2_env\"][\"status\"], \"node:\", p[\"pm2_env\"].get(\"node_version\"), \"restarts:\", p[\"pm2_env\"][\"restart_time\"])"'
```

Expected:
- `git log` shows the 3 prompt commits as the latest 3 (newest first).
- pm2 shows `trading-bot online` with `node: 22.22.2` (the deploy.sh fix should have restored Node 22).

If pm2 still shows `node: 20.20.2`, the deploy.sh fix didn't take effect — investigate (see `/home/bot/deploy.sh.bak.20260509` for the pre-fix version to compare against).

- [ ] **Step 7: Verify the next ICT cycle picks up the new prompt**

Wait for the next 15M candle close inside a kill zone (07:00-10:00 UTC London Open or 13:00-16:00 UTC NY Open). Then:

```bash
ssh bot@162.55.212.198 'tail -200 /home/bot/trading-bot/data/pm2-out.log | grep -E "STEP 1|IN PARALLEL|get_daily_pnl|get_portfolio|get_economic_calendar" | head -10'
```

Expected: see the agent's actual cycle output reflect the new STEP 1 structure. Specifically, three `[ICT Agent] Calling tool:` lines for `get_daily_pnl`, `get_portfolio`, `get_economic_calendar` should appear within ~1 second of each other (parallel batch in iter 1) instead of spread across multiple iterations.

If the agent still calls them sequentially after this deploy, the directive isn't being followed and L3a needs revision.

- [ ] **Step 8: Mark all tasks complete in the tracker**

No commit (verification only).

---

## Self-Review (skill-required)

**1. Spec coverage check:** every section of the spec maps to a task above:
- Spec Change 1 (STEP 1 batching + Step F rewrite) → Task 1 ✓
- Spec Change 2 (STEP 3 batching directive) → Task 2 ✓
- Spec Change 3 (TP2 precision rule + Step L checklist) → Task 3 ✓
- Spec test cases (Test 1, Test 2, Test 3) → Tasks 1, 2, 3 ✓
- Spec verification + production observation plan → Task 4 ✓
- Spec "What's deliberately NOT in scope" (L3b-2 Leg-B notional pre-flight) → correctly NOT included as a task ✓

**2. Placeholder scan:** no TBD, no "implement appropriate", no "similar to Task N" without code. Every prompt edit shows the exact replacement text in a code block; every test shows the exact assertion code; every command shows the exact `npx vitest run …` invocation.

**3. Type consistency:** the test file uses `readFileSync(PROMPT_PATH, 'utf-8')` consistently across all three tests. The `promptText` variable name is consistent. The `expect(promptText).toContain(...)` and `toMatch(...)` patterns are consistent.

**4. Ordering check:** Task 1 creates the test file (Tasks 2-3 append). Task 1's prompt edit is independent of Tasks 2-3's prompt edits (different sections of the file). Task 3 inserts the precision rule in TWO places (trend-mode + range-mode); the Test 3 assertion only requires the literal text be present once in the file, but inserting it twice (once per mode) is per the spec and won't break the test (`toContain` is satisfied by either occurrence). Task 4 verifies + deploys. Order is correct.

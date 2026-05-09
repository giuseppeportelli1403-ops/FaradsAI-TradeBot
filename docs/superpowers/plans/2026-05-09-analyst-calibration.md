# Trade Analyst — APPROVE/MODIFY/REJECT Calibration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the "9 MODIFYs / 0 APPROVEs / 0 trades" antipattern observed on 2026-05-08 by tightening the analyst's three-decision boundaries via a pure prompt edit.

**Architecture:** Three insertions into `prompts/analyst-agent.md` (DECISION RULE table, CHECK 2 explicit Tier-1 clause, three-band calibration targets) + 3 static prompt-content tests in a new `tests/analyst-prompt.test.ts`. Zero TypeScript change, zero new tools.

**Tech Stack:** Markdown prompt file, vitest 4.1.4, Node.js fs.readFileSync. Same pattern as `tests/ict-prompt.test.ts` (the L3 prompt tests shipped earlier today).

**Spec:** `docs/superpowers/specs/2026-05-09-analyst-calibration-design.md` (commit `b5bd48e`).

---

## File map

- **Modify:** `prompts/analyst-agent.md`
  - **Line 7** (existing single-line calibration `Your target rejection rate is 15-25%...`): replace with three-band calibration block (APPROVE 60-80%, MODIFY 5-15%, REJECT 15-25%, plus self-check heuristic guidance).
  - **After line 11** (`## 6-CHECK APPROVAL SEQUENCE`): insert DECISION RULE block — table mapping check outcomes to APPROVE/MODIFY/REJECT, strict-MODIFY-requires-non-empty-modifications rule, "Wait is REJECT not MODIFY" rule, "All-6-pass with concerns is APPROVE not MODIFY" rule.
  - **CHECK 2 block** (currently 4 lines: regime, Tier-1 macro, correlated asset): replace with expanded version that explicitly handles the inside-veto-window case (REJECT with deferred-resubmit reason) and outside-veto-window case (caveat in `reason`, no downgrade).
- **Create:** `tests/analyst-prompt.test.ts` (NEW, ~50 lines, 3 static prompt-content tests).

---

## Task 1: Test scaffolding + three-band calibration targets

**Files:**
- Create: `tests/analyst-prompt.test.ts`
- Modify: `prompts/analyst-agent.md` (line 7 — locate by content)

- [ ] **Step 1: Create `tests/analyst-prompt.test.ts` with Test 1 (calibration bands)**

Create the file with this exact content:

```ts
// Static prompt-content tests for prompts/analyst-agent.md.
// Same pattern as tests/ict-prompt.test.ts — guards against accidental
// deletion of the 2026-05-09 calibration directives. Real validation
// of the analyst's behavior is production observation (APPROVE rate,
// MODIFY-with-empty-modifications count, trade-placement count).
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = join(__dirname, '..', 'prompts', 'analyst-agent.md');

let promptText: string;

beforeAll(() => {
  promptText = readFileSync(PROMPT_PATH, 'utf-8');
});

describe('analyst-agent.md decision-rule calibration', () => {
  it('contains the APPROVE rate target (60-80%) and MODIFY/REJECT bands', () => {
    expect(promptText).toContain('APPROVE rate target: 60-80%');
    expect(promptText).toContain('MODIFY rate target: 5-15%');
    expect(promptText).toContain('REJECT rate target: 15-25%');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/analyst-prompt.test.ts`
Expected: FAIL — `expect(promptText).toContain('APPROVE rate target: 60-80%')` fails. The current prompt has only the single line `Your target rejection rate is 15-25%...` with no APPROVE-rate target.

- [ ] **Step 3: Replace the calibration line in `prompts/analyst-agent.md`**

Locate the existing single-line calibration (search for the literal `Your target rejection rate is 15-25%`). The current line 7 is:

```markdown
Your target rejection rate is 15-25%. Greater than 40% means you are too strict. Less than 5% means you are rubber-stamping. Calibrate.
```

Replace that single line with this multi-line block:

```markdown
**Calibration targets (post-2026-05-09 recalibration after the 9-MODIFY-zero-APPROVE incident on 2026-05-08):**
- **APPROVE rate target: 60-80%** of proposals that reach you (after the ICT agent's pre-checks). Below 30% means you are over-cautious — concerns belong in `reason`, not as a MODIFY/REJECT downgrade.
- **MODIFY rate target: 5-15%** — sizing-math drift, one-tick R:R precision, stale-entry refresh, narrow specific fixes that name proposal fields in `modifications`. Above 25% means you are using MODIFY as a hedge instead of as a fix-list.
- **REJECT rate target: 15-25%** — banned patterns, calendar veto windows, opposing Cat-A news on range-mode, fundamental risk-concentration violations, wait-for-event defers.
- The above bands are calibration TARGETS, not data the analyst tracks itself. The analyst is invoked once per proposal with no memory of prior decisions across sessions; do NOT attempt to recall or count past verdicts. Use the bands as a self-check heuristic *for the current decision*: ask "is this proposal really REJECT-tier, or am I downgrading an APPROVE because I have a qualitative concern?" If the latter, return APPROVE with the concern in `reason`. The ICT agent reads the structured `decision` field as authority — it cannot infer "yes-but" from prose.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/analyst-prompt.test.ts`
Expected: PASS — all three `toContain` assertions match the new block.

- [ ] **Step 5: Run the full suite to confirm no regression**

Run: `npx vitest run`
Expected: 805 tests pass (804 from prior session + 1 new test).

- [ ] **Step 6: tsc clean check**

Run: `npx tsc --noEmit`
Expected: clean (no TypeScript change in this task; this just confirms the existing build still works).

- [ ] **Step 7: Commit**

```bash
git add prompts/analyst-agent.md tests/analyst-prompt.test.ts
git commit -m "feat(analyst-prompt): three-band calibration targets (APPROVE 60-80%, MODIFY 5-15%, REJECT 15-25%)

Replaces the single-line REJECT-only calibration target with three
bands. Adds a self-check heuristic explicitly noting the analyst has
no cross-session memory and should not attempt to recall past
verdicts — use the bands as a within-decision rubric instead.

Pre-fix the prompt had no APPROVE-rate target, which is why
2026-05-08 produced 0 APPROVEs out of 9 successful analyst calls
(all 6 checks passed but the analyst defaulted to MODIFY for
qualitative concerns).

Adds tests/analyst-prompt.test.ts with a static prompt-content guard
on the new calibration band literals.

Per spec docs/superpowers/specs/2026-05-09-analyst-calibration-design.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: DECISION RULE table + strict MODIFY rule

**Files:**
- Modify: `prompts/analyst-agent.md` (after line 11 — locate by content)
- Modify: `tests/analyst-prompt.test.ts` (append Test 2)

- [ ] **Step 1: Append Test 2 to `tests/analyst-prompt.test.ts`**

Inside the existing `describe` block, after Test 1, append:

```ts
  it('contains the explicit DECISION RULE table + strict MODIFY clause', () => {
    // The decision-rule table header
    expect(promptText).toContain('DECISION RULE — pick exactly one');
    // The strict-MODIFY-requires-non-empty-modifications rule
    expect(promptText).toContain(
      'MODIFY requires `modifications` to contain at least one specific proposal field',
    );
    // The "wait is REJECT not MODIFY" rule
    expect(promptText).toContain('"Wait for X event to clear" is REJECT, not MODIFY');
    // The "all-6-pass with concerns is APPROVE" rule
    expect(promptText).toContain(
      '"All 6 checks pass but I have qualitative concerns" is APPROVE, not MODIFY',
    );
  });
```

- [ ] **Step 2: Run the new test to verify it fails**

Run: `npx vitest run tests/analyst-prompt.test.ts -t 'DECISION RULE'`
Expected: FAIL — none of the four substrings exist in the current prompt.

- [ ] **Step 3: Insert the DECISION RULE block in `prompts/analyst-agent.md`**

Locate the line `## 6-CHECK APPROVAL SEQUENCE` (currently line 11). IMMEDIATELY AFTER that line, insert this block (with a leading and trailing blank line so it forms a proper section break):

```markdown

## DECISION RULE — pick exactly one based on the 6-check outcome

After running the 6 checks, your decision is determined by the table below. The `decision` field is the ONLY authority — your `reason` text is human-readable context, never an override.

| All 6 checks pass? | Concrete fixable issue with a specific field-level change? | Decision |
|---|---|---|
| Yes | — | **APPROVE** |
| No, but the failing check is fixable by the agent NOW (sizing math, R:R one-tick precision, stale-entry refresh) | Yes — name the fields in `modifications` | **MODIFY** |
| No, and the failing check is NOT a same-cycle proposal change (calendar veto, banned pattern, opposing Cat-A news, wait-for-event, mode mismatch) | No | **REJECT** |

**MODIFY requires `modifications` to contain at least one specific proposal field with a new value.** Examples of valid `modifications`: `{ tp2: 80.66 }`, `{ size_per_leg: 4.2, total_risk_pct: 1.0 }`, `{ entry: 1.0853 }`. **Empty `modifications: {}` on a MODIFY is invalid** — if you have nothing to fix, return APPROVE; if the issue is a wait/defer, return REJECT.

**"Wait for X event to clear" is REJECT, not MODIFY.** The agent cannot apply a "wait until 13:00 UTC" instruction inside its current cycle. Use REJECT with reason `"Deferred — Tier-1 [event name] at [time UTC] within veto window. Next fresh evaluation: 15M close after [time + 30 min UTC]."` The agent treats this as a normal REJECT — log, skip cycle, move on. The "next fresh evaluation" phrase is a hint that the *scheduler's* next 15M candle close (after the veto window) will independently re-evaluate market structure and propose afresh; it is NOT a directive for the agent to retry the same proposal.

**"All 6 checks pass but I have qualitative concerns" is APPROVE, not MODIFY.** Sector weakness, mixed regime, slightly elevated volatility — these belong in the `reason` field as caveats, not as a decision downgrade. The 6 checks are designed to catch hard fails; if they don't fail, the analyst's job is done — APPROVE and let the cycle continue.

---
```

(The trailing `---` is a horizontal rule separating this rubric from the 6-check definitions below. The leading blank line ensures the new `## DECISION RULE` heading is recognised as its own section.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/analyst-prompt.test.ts -t 'DECISION RULE'`
Expected: PASS — all four `toContain` assertions match the new block.

- [ ] **Step 5: Run the full file (no regression)**

Run: `npx vitest run tests/analyst-prompt.test.ts`
Expected: 2 tests pass.

- [ ] **Step 6: Run the full suite + tsc**

Run: `npx vitest run`
Expected: 806 tests pass (805 + 1 new from this task).

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add prompts/analyst-agent.md tests/analyst-prompt.test.ts
git commit -m "feat(analyst-prompt): DECISION RULE table + strict MODIFY clause

Inserts an explicit decision-mapping table at the top of the 6-check
section. Codifies three rules the existing prompt left implicit:

  1. MODIFY requires non-empty 'modifications' field with concrete
     proposal-field changes (entry/sl/tp1/tp2/size_*/total_risk_pct).
     Empty {} on MODIFY is invalid — emit APPROVE if nothing to fix
     or REJECT if the issue is wait/defer.

  2. 'Wait for X event to clear' is REJECT, not MODIFY. Wait-
     instructions are not field-level changes the agent can apply
     in its current cycle. Use REJECT with deferred-resubmit reason
     prose; the next 15M candle close after the veto window will
     re-evaluate via fresh structure analysis (not a same-proposal
     retry).

  3. 'All 6 checks pass but I have qualitative concerns' is APPROVE,
     not MODIFY. Sector weakness, mixed regime, slightly elevated
     volatility belong in the 'reason' field as caveats — never as
     a decision downgrade.

Pre-fix the prompt's MODIFY example only showed sizing-fix shape
(modifications: { size_per_leg: 4.2 }) but had no rule that
modifications MUST be non-empty. On 2026-05-08 the analyst returned
9 MODIFYs with empty modifications or wait-instructions, and the
ICT agent (no fields to apply) gave up on each.

Per spec docs/superpowers/specs/2026-05-09-analyst-calibration-design.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: CHECK 2 explicit Tier-1 macro event clause

**Files:**
- Modify: `prompts/analyst-agent.md` (CHECK 2 block — locate by content)
- Modify: `tests/analyst-prompt.test.ts` (append Test 3)

- [ ] **Step 1: Append Test 3 to `tests/analyst-prompt.test.ts`**

Inside the existing `describe` block, after Test 2, append:

```ts
  it('CHECK 2 explicit deferred-resubmit clause for inside-veto-window case', () => {
    // The expanded Tier-1 event list (proves CHECK 2 was rewritten,
    // not just lightly edited)
    expect(promptText).toContain('central-bank decision');
    expect(promptText).toContain('AHE, Unemployment Rate, Retail Sales');
    // The inside-veto-window REJECT branch
    expect(promptText).toContain('inside the −60/+30 veto window');
    expect(promptText).toContain(
      '→ REJECT with reason',
    );
    // The outside-veto-window caveat branch (must NOT downgrade)
    expect(promptText).toContain(
      'flag in `reason` as a caveat',
    );
    expect(promptText).toContain('do NOT downgrade');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/analyst-prompt.test.ts -t 'CHECK 2 explicit'`
Expected: FAIL — none of the substrings exist in the current CHECK 2 (which is just 4 lines without the deferred-resubmit branch).

- [ ] **Step 3: Replace the CHECK 2 block in `prompts/analyst-agent.md`**

Locate the existing CHECK 2 block (search for the literal `### CHECK 2 — CONTEXT`). The current block is:

```markdown
### CHECK 2 — CONTEXT
- Does the trade direction contradict the researcher brief's regime or themes?
- Is there a Tier 1 macro event (FOMC, NFP, CPI) within the expected trade duration?
- Does a correlated asset strongly disagree with the trade direction?
```

Replace those 4 lines with this expanded block:

```markdown
### CHECK 2 — CONTEXT
- Does the trade direction contradict the researcher brief's regime or themes?
- Is there a Tier 1 macro event (FOMC, NFP, CPI, central-bank decision, AHE, Unemployment Rate, Retail Sales, Core PCE, GDP, ISM PMI) within the expected trade duration?
  - **If yes and entry is INSIDE the −60/+30 veto window for that event** → REJECT with reason `"Deferred — Tier-1 [event name] at [time UTC] within veto window. Next fresh evaluation: 15M close after [time + 30 min UTC]."` Do NOT use MODIFY for this — wait-instructions are not field-level changes the agent can apply.
  - **If yes but entry is OUTSIDE the veto window AND the event is BEFORE the trade closes** → flag in `reason` as a caveat ("trade matures into post-event volatility"), but do NOT downgrade to MODIFY/REJECT solely on this. The kill-zone gate already filters most of these; if the proposal reached you, the structural setup is acceptable.
- Does a correlated asset strongly disagree with the trade direction?
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/analyst-prompt.test.ts -t 'CHECK 2 explicit'`
Expected: PASS — all 6 substring assertions match.

- [ ] **Step 5: Run the full file (verify Tests 1+2 still pass)**

Run: `npx vitest run tests/analyst-prompt.test.ts`
Expected: 3 tests pass.

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run`
Expected: 807 tests pass (806 + 1 new from this task).

- [ ] **Step 7: tsc clean**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add prompts/analyst-agent.md tests/analyst-prompt.test.ts
git commit -m "feat(analyst-prompt): CHECK 2 explicit Tier-1 macro event handling

CHECK 2 previously asked 'Is there a Tier 1 macro event within the
expected trade duration?' but didn't specify what to do when found.
On 2026-05-08 the analyst chose MODIFY-with-defer for every NFP-
window setup, which the ICT agent could not action.

Now CHECK 2:
  - Expands the Tier-1 event list (FOMC, NFP, CPI, central-bank
    decision, AHE, Unemployment Rate, Retail Sales, Core PCE, GDP,
    ISM PMI) to match the actual veto rules in
    src/news/calendar-veto.ts.
  - Branches on whether entry is inside/outside the −60/+30 veto
    window:
      INSIDE → REJECT with deferred-resubmit reason. The scheduler's
              next 15M close after the window will re-evaluate.
      OUTSIDE but event during trade → caveat in reason, do NOT
              downgrade. Kill-zone gate already filters most of these.

The deferred-resubmit prose is a hint to a future fresh evaluation
by the scheduler, not a directive to retry the same proposal. The
existing ICT agent rule (prompts/ict-agent.md:238) forbids retrying
without a material change; this CHECK 2 update preserves that
semantic.

Per spec docs/superpowers/specs/2026-05-09-analyst-calibration-design.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Final verification + push + VPS deploy check

**Files:** none modified — verification only.

- [ ] **Step 1: Confirm working tree clean and 3 commits ahead of origin**

Run: `git status -s | grep -vE "^\?\?"`
Expected: empty (no tracked-file modifications outstanding).

Run: `git log --oneline origin/master..HEAD`
Expected: 3 commits — Task 1 (`feat(analyst-prompt): three-band calibration targets...`), Task 2 (`feat(analyst-prompt): DECISION RULE table...`), Task 3 (`feat(analyst-prompt): CHECK 2 explicit Tier-1 macro event handling`).

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: 807/807 pass (804 from prior session + 3 new analyst-prompt tests).

- [ ] **Step 4: Concurrent-session safety pull**

Run: `git fetch origin && git log --oneline HEAD..origin/master`
Expected: empty output. If non-empty, STOP and reconcile via `git pull --ff-only origin master` before pushing.

- [ ] **Step 5: Push to origin**

Run: `git push origin master`
Expected: push succeeds. GitHub Actions runs Build+Test, then triggers `/home/bot/deploy.sh` on the VPS, which sources nvm so the bot restarts under Node 22.22.2.

- [ ] **Step 6: Verify VPS state after deploy completes (~3 min)**

Run:
```bash
ssh bot@162.55.212.198 'cd /home/bot/trading-bot && git log --oneline -4 && export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use default >/dev/null 2>&1 && pm2 jlist | python3 -c "import sys,json; d=json.load(sys.stdin); p=d[0]; print(p[\"name\"], p[\"pm2_env\"][\"status\"], \"node:\", p[\"pm2_env\"].get(\"node_version\"), \"restarts:\", p[\"pm2_env\"][\"restart_time\"])"'
```

Expected:
- `git log` shows the 3 analyst-prompt commits as the latest 3 (newest first).
- pm2 shows `trading-bot online` with `node: 22.22.2`.

- [ ] **Step 7: Verify the next ICT cycle's analyst response uses the new rule**

Wait for the next 15M candle close inside a kill zone (07:00-10:00 UTC London Open or 13:00-16:00 UTC NY Open). Then:

```bash
ssh bot@162.55.212.198 'tail -300 /home/bot/trading-bot/data/pm2-out.log | grep -E "Decision: APPROVE|Decision: MODIFY|Decision: REJECT|Calling tool: place_split_trade|Trade placed" | head -20'
```

Expected: the next analyst response should reflect the new calibration. Look for `Decision: APPROVE` (zero on 2026-05-08; target ≥1 on a clean-structure cycle going forward) or `Decision: REJECT` with reason starting `"Deferred — Tier-1"` (the new prose template). MODIFY responses, if any, should have non-empty `modifications` fields naming concrete proposal fields.

If the next 5 analyst calls all still return MODIFY with empty `modifications`, the prompt rule isn't being followed → escalate by adding a runtime guard at `src/agents/analyst-agent.ts:48-66` (rejecting empty MODIFY at the parser).

- [ ] **Step 8: Mark all tasks complete**

No commit (verification only).

---

## Self-Review (skill-required)

**1. Spec coverage check:** every section of the spec maps to a task above:
- Spec Change 1 (DECISION RULE table) → Task 2 ✓
- Spec Change 2 (CHECK 2 explicit clause) → Task 3 ✓
- Spec Change 3 (three-band calibration targets) → Task 1 ✓
- Spec test cases (Test 1 + Test 2 in spec) → covered by Tasks 1 + 2 (this plan splits into 3 tests by adding a CHECK 2-specific test in Task 3 for full TDD coverage) ✓
- Spec Integration table claims → verified at write-time; Task 7 of Task 4 is the production-observation gate ✓
- Spec "What's deliberately NOT in scope" (no code change) → respected ✓

**2. Placeholder scan:** no TBD, no "implement appropriate", no "similar to Task N" without code. Every prompt edit shows the exact replacement text in a code block; every test shows the exact assertion code; every command shows the exact `npx vitest run …` invocation.

**3. Type consistency:** the test file uses `readFileSync(PROMPT_PATH, 'utf-8')` and `expect(promptText).toContain(...)` patterns consistently across all three tests. The `promptText` variable name is consistent. The `PROMPT_PATH` resolves via `dirname(fileURLToPath(import.meta.url))` cross-platform pattern matching the existing `tests/ict-prompt.test.ts`.

**4. Ordering check:** Task 1 creates the test file (Tasks 2-3 append). Task 1's prompt edit is independent of Tasks 2-3. Task 2's DECISION RULE block at the top of the 6-CHECK section doesn't conflict with Task 3's CHECK 2 rewrite (different sections of the prompt). Task 4 verifies + deploys.

**5. Plan-review pre-empt:** Both Claude and Codex flagged in spec review that the runtime parser doesn't validate `modifications` shape — accepted as out of scope for this plan, deferred runtime guard tracked as a follow-up if production observation shows persistent empty-MODIFY responses (Task 4 Step 7's escalation path).

# Trade Analyst Agent — APPROVE/MODIFY/REJECT calibration

**Date:** 2026-05-09
**Author:** Giuseppe + Claude (brainstorming + systematic-debugging)
**Status:** Spec — design approved by Giuseppe, proceeding to writing-plans
**Base commit:** `ed677fa` (post-MODIFY-misread fix)
**Sibling specs (already shipped today):**
- `2026-05-08-ict-iteration-cap-bump-design.md` — Spec 1 (cap+L1+observability) — live
- `2026-05-09-ict-prompt-batching-and-precision-design.md` — L3 (ICT prompt batching + R:R precision) — live
- `2026-05-08-3-leg-removal-phase-1-design.md` + Phase 2 — 3-leg cleanup — live

## Problem

Forensics on 2026-05-08 (NFP Friday, 28 cycles, 0 trades): **9 of 9 successful analyst calls returned MODIFY, zero APPROVEs.** Reading each MODIFY's full body, all 6 checks PASSED in every case. The analyst was using MODIFY as a "yes-but-with-concerns" verdict instead of "here's the specific field-level fix". The `modifications` field was empty or contained wait-instructions like "DEFER until post-NFP" — neither of which the ICT agent can apply as a proposal change.

The cascading effect: 14 cycles reached `request_analyst_review`, all returned non-APPROVE, agent only attempted `place_split_trade` ONCE (misreading a MODIFY as APPROVE — fixed in commit `ed677fa` earlier today). 0 trades persisted. Without recalibration, the bot will keep accumulating analyst MODIFYs that the agent can't action, even with Spec 1 + Spec 3 buying iteration headroom and the structured-field rule preventing place_split_trade misfires.

The current prompt at `prompts/analyst-agent.md` has:
- Target REJECT rate (15-25%) but no APPROVE rate target
- A MODIFY example showing sizing-fix shape (`modifications: { size_per_leg: 4.2 }`) but no rule that `modifications` MUST be non-empty
- CHECK 2 asks about Tier-1 macro events but doesn't specify what to do when found (analyst chose MODIFY-with-defer; should be REJECT)
- No explicit "all 6 pass → APPROVE, even with qualitative concerns" rule

## Goal

Replace MODIFY-as-warning with sharp three-decision boundaries. Each decision must have a single, unambiguous trigger:

- **APPROVE** ← all 6 checks pass (qualitative concerns belong in `reason`, not as a downgrade)
- **MODIFY** ← failing check has a concrete field-level fix the agent can apply this cycle (`modifications` MUST contain at least one proposal field with a new value)
- **REJECT** ← failing check is NOT a same-cycle proposal change (calendar veto window, banned pattern, opposing Cat-A news on range-mode, wait-for-event, mode mismatch)

Yesterday's 9 MODIFYs traced through the new rule:
- 4 morning SILVER MODIFYs (NFP-timing flag) → REJECT with deferred-resubmit reason. Agent skips cycle, next 15M close re-evaluates.
- 5 afternoon SILVER MODIFYs (post-NFP, all checks pass, qualitative concerns only) → APPROVE. Agent calls place_split_trade.

Net: ~5 trade attempts instead of 0.

Non-goal: change the 6 checks themselves, the analyst's strategy logic, or any code path. Pure prompt edit.

## Why pure prompt (no code)

`analyst-agent.ts:48-66` and `:104-128` parse the analyst's structured output and accept any object as `modifications`. A code-level validator that rejects MODIFY with empty `modifications` would be belt-and-braces — but the rule lives behavioral-side, in the prompt. If the prompt rule is ignored in practice (production observation shows empty MODIFYs persisting), revisit with a runtime guard. **Out of scope here:** code-level enforcement.

## Design

### Change 1 — Insert DECISION RULE table at the top of the 6-check section

In `prompts/analyst-agent.md`, immediately after the line `## 6-CHECK APPROVAL SEQUENCE` (line 11), insert:

```markdown
## DECISION RULE — pick exactly one based on the 6-check outcome

After running the 6 checks, your decision is determined by the table below. The `decision` field is the ONLY authority — your `reason` text is human-readable context, never an override.

| All 6 checks pass? | Concrete fixable issue with a specific field-level change? | Decision |
|---|---|---|
| Yes | — | **APPROVE** |
| No, but the failing check is fixable by the agent NOW (sizing math, R:R one-tick precision, stale-entry refresh) | Yes — name the fields in `modifications` | **MODIFY** |
| No, and the failing check is NOT a same-cycle proposal change (calendar veto, banned pattern, opposing Cat-A news, wait-for-event, mode mismatch) | No | **REJECT** |

**MODIFY requires `modifications` to contain at least one specific proposal field with a new value.** Examples of valid `modifications`: `{ tp2: 80.66 }`, `{ size_per_leg: 4.2, total_risk_pct: 1.0 }`, `{ entry: 1.0853 }`. **Empty `modifications: {}` on a MODIFY is invalid** — if you have nothing to fix, return APPROVE; if the issue is a wait/defer, return REJECT.

**"Wait for X event to clear" is REJECT, not MODIFY.** The agent cannot apply a "wait until 13:00 UTC" instruction inside its current cycle. Use REJECT with reason `"Deferred — Tier-1 [event name] at [time UTC] within veto window. Next fresh evaluation: 15M close after [time + 30 min UTC]."` The agent treats this as a normal REJECT — log, skip cycle, move on. The "next fresh evaluation" phrase is a hint that the *scheduler's* next 15M candle close (after the veto window) will independently re-evaluate market structure and propose afresh; it is NOT a directive for the agent to retry the same proposal. The agent's existing rule (`prompts/ict-agent.md:238`) forbids retrying without a material change, and the new prose preserves that semantic.

**"All 6 checks pass but I have qualitative concerns" is APPROVE, not MODIFY.** Sector weakness, mixed regime, slightly elevated volatility — these belong in the `reason` field as caveats, not as a decision downgrade. The 6 checks are designed to catch hard fails; if they don't fail, the analyst's job is done — APPROVE and let the cycle continue.

---
```

(The `---` at the bottom is a horizontal rule separating this rubric from the 6-check definitions below.)

### Change 2 — Make CHECK 2 explicit on Tier-1 macro events

Currently CHECK 2 says:

```markdown
### CHECK 2 — CONTEXT
- Does the trade direction contradict the researcher brief's regime or themes?
- Is there a Tier 1 macro event (FOMC, NFP, CPI) within the expected trade duration?
- Does a correlated asset strongly disagree with the trade direction?
```

Replace with:

```markdown
### CHECK 2 — CONTEXT
- Does the trade direction contradict the researcher brief's regime or themes?
- Is there a Tier 1 macro event (FOMC, NFP, CPI, central-bank decision, AHE, Unemployment Rate, Retail Sales, Core PCE, GDP, ISM PMI) within the expected trade duration?
  - **If yes and entry is inside the −60/+30 veto window for that event** → REJECT with reason `"Deferred — Tier-1 [event name] at [time UTC] within veto window. Next fresh evaluation: 15M close after [time + 30 min UTC]."` Do NOT use MODIFY for this — wait-instructions are not field-level changes the agent can apply.
  - **If yes but entry is outside the veto window AND the event is before the trade closes** → flag in `reason` as a caveat ("trade matures into post-event volatility"), but do NOT downgrade to MODIFY/REJECT solely on this. The kill-zone gate already filters most of these; if the proposal reached you, the structural setup is acceptable.
- Does a correlated asset strongly disagree with the trade direction?
```

### Change 3 — Add APPROVE rate calibration target

Currently the prompt says (line 7):
> Your target rejection rate is 15-25%. Greater than 40% means you are too strict. Less than 5% means you are rubber-stamping. Calibrate.

Replace that single line with:

```markdown
**Calibration targets (post-2026-05-09 recalibration after the 9-MODIFY-zero-APPROVE incident on 2026-05-08):**
- **APPROVE rate target: 60-80%** of proposals that reach you (after the ICT agent's pre-checks). Below 30% means you are over-cautious — concerns belong in `reason`, not as a MODIFY/REJECT downgrade.
- **MODIFY rate target: 5-15%** — sizing-math drift, one-tick R:R precision, stale-entry refresh, narrow specific fixes that name proposal fields in `modifications`. Above 25% means you are using MODIFY as a hedge instead of as a fix-list.
- **REJECT rate target: 15-25%** — banned patterns, calendar veto windows, opposing Cat-A news on range-mode, fundamental risk-concentration violations, wait-for-event defers.
- The above bands are calibration TARGETS, not data the analyst tracks itself. The analyst is invoked once per proposal with no memory of prior decisions across sessions; do NOT attempt to recall or count past verdicts. Use the bands as a self-check heuristic *for the current decision*: ask "is this proposal really REJECT-tier, or am I downgrading an APPROVE because I have a qualitative concern?" If the latter, return APPROVE with the concern in `reason`. The ICT agent reads the structured `decision` field as authority — it cannot infer "yes-but" from prose.
```

### Integration with existing system (the "hook it up" check)

| Component | Current behavior | Behavior after this spec | Compatible? |
|---|---|---|---|
| `request_analyst_review` pre-checks (`trading-agent.ts:808-1001`) | Synthetic REJECT for BELOW_MIN_SIZE / RR_FLOOR_VIOLATION / order-side BEFORE calling analyst | Unchanged. Analyst only sees proposals that pass pre-checks. | ✓ |
| `runAnalystAgent` decision parsing (`analyst-agent.ts:48-66`, `:104-128`) | Accepts APPROVE/REJECT/MODIFY; doesn't validate `modifications` shape | Unchanged. Empty MODIFY would still parse, but the prompt rule discourages it. | ✓ |
| `approvedProposals.set(hash, ...)` (`trading-agent.ts:1003`) | Only populates on APPROVE | Unchanged. New APPROVEs flow through; new REJECTs/MODIFYs don't authorize placement. | ✓ |
| ICT agent's MODIFY-handling rule (commit `ed677fa`, shipped earlier today) | "If decision === 'MODIFY', the `modifications` field is your action list. Apply each change, then call request_analyst_review again with the modified proposal." | Unchanged. With strict-MODIFY, the analyst's prompt asks for real field-level changes — but `analyst-agent.ts:120-123` and the `submit_decision` schema (`:277-282`) accept any object, so an off-rule analyst could still emit a bogus key (e.g. `{deferUntil: '13:00'}`). The ICT agent's MODIFY-handling rule applies only named proposal fields (`entry`/`sl`/`tp1`/`tp2`/`risk_pct`); unknown keys silently no-op. Result: at worst, one wasted resubmission per off-rule MODIFY (~30-45s + Sonnet cost), no malformed trade fires. Detect via production logs; revisit with a runtime guard at `analyst-agent.ts:48-66` if it persists. | ✓ (with documented graceful-no-op on parser-vs-prompt drift) |
| ICT agent's "REJECT means skip the trade entirely" rule (existing line 268 of ict-agent.md) | "REJECT → log the reason and move on. Do NOT retry the same proposal in a subsequent cycle without a material change." | Unchanged. New deferred-resubmit REJECTs (NFP wait) follow the same path — skip this cycle; next 15M close re-evaluates. | ✓ |
| Pre-Phase-2 schema columns (tp3 etc) | Removed | Unchanged. The 6-CHECK SIZING MATH already references the 2-leg 70/30 split (post-Phase-2 prompt). | ✓ |
| Spec 1 cap=12 + L1 parallel exec | Live | Unchanged. Analyst calls happen mid-cycle; cap headroom unaffected. | ✓ |
| Spec 3 batching + R:R precision | Live | Unchanged. Agents emit batched reads + 1.31R proposals; analyst now correctly APPROVEs them. | ✓ |

**Critical integration test (production)**: post-deploy, watch for `Decision: APPROVE` followed by `Calling tool: place_split_trade` followed by `Trade placed.*deal_id`. This is the path that produced 0 trades yesterday; the new analyst rule should make it producible.

### What's deliberately NOT in scope

- **No `analyst-agent.ts` code change.** The parser stays as-is. If the analyst ignores the prompt rule and emits empty-MODIFY, the agent's MODIFY-handling rule will no-op the apply-step (no field changes to apply) and waste a cycle. Detect this in production via the tool-call trace; revisit if it recurs.
- **No new tools.** The analyst already has its inputs (proposal + research brief + lessons via the agent's prompt context).
- **No 6-check changes.** The checks themselves are correct; only the decision-mapping rule was wrong.
- **No `confidence` field semantics change.** Today's prompt has it as a free-form 0-1 number; we leave that. APPROVE-with-low-confidence still APPROVEs.

## Tests

Two static prompt-content tests in a new `tests/analyst-prompt.test.ts` (separate file from `ict-prompt.test.ts` — the analyst is a different agent with a different prompt). Pattern matches the existing prompt-content tests:

```ts
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
  it('contains the explicit DECISION RULE table + strict MODIFY clause', () => {
    expect(promptText).toContain('DECISION RULE — pick exactly one');
    expect(promptText).toContain(
      'MODIFY requires `modifications` to contain at least one specific proposal field',
    );
    expect(promptText).toContain('"Wait for X event to clear" is REJECT, not MODIFY');
  });

  it('contains the APPROVE rate target (60-80%) and MODIFY/REJECT bands', () => {
    expect(promptText).toContain('APPROVE rate target: 60-80%');
    expect(promptText).toContain('MODIFY rate target: 5-15%');
    expect(promptText).toContain('REJECT rate target: 15-25%');
  });
});
```

Static tests are guards against accidental prompt deletion. **Real validation is production observation.** Three measurable signals:

1. **APPROVE rate per kill-zone day**: zero on 2026-05-08, target ≥3 per kill-zone day going forward.
2. **MODIFY responses with empty `modifications`**: 9/9 on 2026-05-08, target zero post-deploy.
3. **`Trade placed.*deal_id` log lines**: zero on 2026-05-08, target ≥1 per kill-zone day on a clean structure (won't be 100% — there will still be days with no qualifying triggers; the metric is "proposals that reach the analyst now successfully cross the bar").

If after one week of production data the APPROVE rate is still below 30%, the prompt rule isn't being followed and we revisit with a code-level enforcement (validator that rejects empty MODIFY at the analyst-agent.ts parser).

## Files touched

- **Modify:** `prompts/analyst-agent.md`
  - Insert DECISION RULE block after line 11 (header for 6-CHECK APPROVAL SEQUENCE) — ~25 lines added
  - Replace CHECK 2 block — ~5 lines net added (replacing 4 lines with 9 lines)
  - Replace existing single calibration line (line 7) with multi-line calibration targets — ~5 lines net added
- **Create:** `tests/analyst-prompt.test.ts` — ~35 lines, 2 static-content tests

Total diff: ~75 lines added, ~5 removed (the old single-line calibration).

## Risk

Very low. Pure prompt edit + 2 static tests. Failure modes considered:
- **Analyst over-corrects → too many APPROVEs on weak setups.** The 6 hard-fail checks remain in place; APPROVE only fires when all 6 pass. Pre-checks (BELOW_MIN_SIZE / RR_FLOOR_VIOLATION / order-side) at `request_analyst_review` already filter the worst proposals before the analyst sees them.
- **Analyst still emits MODIFY-with-empty-modifications.** ICT agent's MODIFY-handling rule (shipped commit `ed677fa`) tells it to apply changes; with no fields to apply, the cycle effectively no-ops. Mild ugliness, no harm. Detect via production logs; revisit with a runtime guard if it persists.
- **The new APPROVE rate target (60-80%) is too high in practice.** This is calibration — the existing prompt's "15-25% rejection target" had no APPROVE counterpart and is the reason the analyst defaulted to MODIFY. The new bands are derived from "REJECT 15-25% = APPROVE+MODIFY 75-85%" with strict MODIFY contributing the small (5-15%) tail.

Rollback is one-line `git revert`.

## Production observation plan

Three signals to track over the next 5 kill-zone days:

| Signal | 2026-05-08 baseline | Post-deploy target |
|---|---|---|
| `Decision: APPROVE` count per day | 0 | ≥3 |
| MODIFY responses with empty `modifications` | 9 | 0 |
| `Trade placed.*deal_id` count per day | 0 | ≥1 on clean-structure days |

If signal 1 stays below 1/day for 5 days OR signal 2 stays above 0 for 3 days, the prompt rule isn't being followed → escalate with a runtime guard at `analyst-agent.ts:48-66` rejecting empty-MODIFY.

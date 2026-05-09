# ICT prompt — batching directive + R:R floor precision (L3)

**Date:** 2026-05-09
**Author:** Giuseppe + Claude (brainstorming + systematic-debugging session)
**Status:** Spec — design approved by Giuseppe, proceeding to writing-plans
**Base commit:** `b635cc6` (Spec 1 of the cap+L1+observability series)
**Sibling specs:**
- `docs/superpowers/specs/2026-05-08-ict-iteration-cap-bump-design.md` — Spec 1 (cap + L1 + observability) — **shipped 2026-05-09 02:33 UTC**
- L2 (analyst pre-validate) — **CANCELED 2026-05-09** with evidence; pre-checks already exist in `src/agents/trading-agent.ts:808-1001` (Phase A6 + Phase B from 2026-05-04/05). The retry pattern observed on NFP day was legitimate convergence (modified retries to clear the R:R floor by ≥ 0.01R), not waste.

## Problem

Root-cause investigation of the 2026-05-08 NFP-day timeouts (after Spec 1 shipped) identified **two distinct prompt-level waste sources**:

1. **Sequential single-tool iterations** (cycle c0800: agent split `get_news_context` and `get_lessons` into separate iterations after `get_prices` instead of batching all three in one parallel response). 4 iterations wasted in that one cycle. The Anthropic API supports parallel `tool_use` blocks in a single response; the loop's `for...await` was the L1 bottleneck (now fixed via Spec 1 / Promise.all). But L1 only helps if the model **emits** multiple `tool_use` blocks per response — and without an explicit prompt directive, the model batches inconsistently (cycles c0930 / c0830 batched 4 tools at iter 1; cycles c0800 / c0815 didn't).

2. **Modified retries on R:R floor boundary cases.** Cycles c0845 and c0900 each consumed multiple iterations because the agent proposed `TP2 = entry + 1.30 × |entry−SL|` exactly, the pre-check `validateRRFloor` rejected for failing the strict `> 1.30` floor (broker tick rounding shaves the actual R:R below 1.30 even when math computes 1.30 exactly), the agent corrected to 1.31R, and resubmitted. Each retry is one iteration. **The math fix is precision, not strategy** — the agent already knows what it's doing, just needs a prompt rule.

The c0900 cycle is the most informative: the corrected proposal reached the analyst at iter 8 and got `decision: 'MODIFY'` with confidence 0.82 — **a trade was approvable but the cap killed the cycle before the agent could read the response**. Spec 1's cap=12 likely rescues this exact case, but the upstream fix is to not waste the iteration on the 1.30 retry in the first place.

## Goal

Reduce ICT-cycle iteration consumption on complex days by addressing two observed prompt-level waste sources: (a) sequential single-tool calls when parallel batching is available, and (b) R:R floor boundary retries that could be eliminated with a precision rule. Both are **pure prompt edits to `prompts/ict-agent.md`**.

Non-goal: change the agent's strategy, score rubric, kill-zone gates, calendar veto, or any other decision logic. The precision rule is a tactical correction (1.30 → 1.31R defensive margin); the batching directive is operational guidance the prompt should always have included.

## Why pure prompt (no code)

Spec 1 shipped a cap bump + parallel tool execution + observability. With those in place, the remaining timeouts are **not** about loop budget or wall-time — they're about the model emitting too many sequential tool calls (one per iteration) when parallelism is available, and burning iterations on retries that a one-line precision rule would prevent. Code to enforce these via tool-level changes (e.g. blocking solo `get_news_context` calls, rate-limiting `request_analyst_review`) was considered and rejected:

- **Tool-level batching enforcement** is fragile (the agent might legitimately need a solo follow-up call). Blocking would cause real misses.
- **Retry rate-limiting** was investigated under L2 and found to be **counterproductive** — would have killed legitimate convergence in c0845 (3 calls → MODIFY at confidence 0.82) and c0900 (2 calls → MODIFY).

The dominant waste is the model not knowing it should batch and not knowing about broker tick-rounding on the R:R floor. Both are prompt-knowable.

## Design

### Change 1 — L3a: STEP 1 batching + move `get_economic_calendar`

**Current STEP 1** (lines 101-108 of `prompts/ict-agent.md`):

```
### STEP 1 — CHECK DAILY RISK STATUS

Call `get_daily_pnl()`. If `kill_switch_active` is true (daily loss ≥ 6%):
> "KILL SWITCH ACTIVE — Daily loss limit reached. No new positions. Managing existing positions only."

Then check existing positions (Step 4) only. No new entries.

Call `get_portfolio()`. There is NO hard cap on number of open positions — each new trade stands on its score. Coordination lock applies: do not open a new ICT trade on an instrument already held.
```

**New STEP 1** — fold in `get_economic_calendar` from current Step F, mandate parallel batching:

```
### STEP 1 — CHECK DAILY RISK STATUS + GLOBAL CONTEXT

In a single response, call IN PARALLEL (emit all three as parallel tool_use blocks, NOT one per iteration):
  - get_daily_pnl()
  - get_portfolio()
  - get_economic_calendar(1)

The calendar veto applies to the entire trading window (not per-candidate), so fetching it once at STEP 1 saves N-1 calls when analysing N candidates in STEP 3. The veto windows match the code:
- Generic high-impact event: skip if within −5/+30 min of intended trade time
- Tier-1 events (FOMC, NFP, CPI, central-bank rate decisions, Core PCE, GDP, ISM PMI, AHE, Unemployment Rate, Retail Sales, central-bank press conferences): skip if within −60/+30 min

After reading the three results:
- If `kill_switch_active` is true (daily loss ≥ 6%): "KILL SWITCH ACTIVE — Daily loss limit reached. No new positions. Managing existing positions only." Then check existing positions (Step 4) only. No new entries.
- Open positions: there is NO hard cap on number of open positions — each new trade stands on its score. Coordination lock applies: do not open a new ICT trade on an instrument already held.
- Calendar: note any Tier-1 events within the next ~3 hours that would veto entries opened now.
```

**Delete current Step F** (line 140-144):

```
**F. Get economic calendar** — `get_economic_calendar(1)`. The veto windows match the code:
- Generic high-impact event: skip if within **−5/+30 min** of trade time
- Tier-1 events (FOMC, NFP, CPI, ...): skip if within **−60/+30 min**

If you're inside a window: SKIP. Don't bother running structure analysis. The `place_split_trade` tool will refuse anyway.
```

→ becomes (replace with one-line back-reference):

```
**F. Calendar veto re-check** — apply the veto windows from STEP 1 to this candidate's intended trade time. If inside a Tier-1 −60/+30 or generic −5/+30 window relative to the current 15M close: SKIP this candidate, no structure analysis, no proposal. The `place_split_trade` tool will refuse anyway.
```

(Step F isn't deleted entirely — the per-candidate veto check still applies — but it becomes a **read** of the cached calendar from STEP 1, not a re-fetch.)

### Change 2 — L3a: STEP 3 batching directive for sub-steps A through G

**Current STEP 3 header** (line 114-116):

```
### STEP 3 — FOR EACH CANDIDATE, RUN THE FULL ANALYSIS

For each promising instrument, in score order:
```

**New STEP 3 header** — add the batching directive:

```
### STEP 3 — FOR EACH CANDIDATE, RUN THE FULL ANALYSIS

For each promising instrument, in score order:

**CRITICAL — batch all read-only data tools in a single response.** Sub-steps A, E, and G below are all read-only data fetches that don't depend on each other. Emit them as parallel tool_use blocks in ONE response, NOT one tool per iteration. Then proceed to B/C/D and H-L (which require analysis of the data) once all results are back.

The minimum batch per candidate is:
  - get_prices(instrument, '1h', 50)
  - get_prices(instrument, '15m', 50)
  - get_news_context(instrument)
  - get_lessons(setup_type, instrument_category, kill_zone, 'ICT_INTRADAY')

Issue these four calls in a single response. The scheduler runs each tool in parallel via Promise.all (per the 2026-05-09 L1 change), so wall-time is the slowest tool, not the sum.
```

### Change 3 — L3b-1: TP2 R:R floor precision rule

The current strict floor is documented in Step L checklist (line 208) and the trend-mode/range-mode TP rules (lines 186-192). All say "≥ 1.3:1 R:R" or "≥ 1.3R". The pre-check `validateRRFloor` enforces strict-greater than the floor (TP2 must clear 1.30R, not equal it; broker tick rounding can shave a 1.30R proposal below the floor at execution time).

Add a new note immediately after the existing R:R lines (insert after line 188, "**TP2: ≥ 1.3:1 R:R** (universal — same floor for all tiers and all instruments)"):

```
> **Precision rule (post-2026-05-09 retry-pattern audit):** broker tick rounding can shave the actual R:R below the strict 1.30 floor even when your math computes 1.30 exactly. To clear the floor robustly, **always set TP2 ≥ 1.31 × |entry − SL|** (1.31, not 1.30). The same defensive margin applies to TP1 — set TP1 ≥ 1.01 × |entry − SL| even though the de-risk leg is described as "1:1" in spirit. The pre-check at request_analyst_review is strict; one extra basis point of TP distance avoids a same-cycle resubmission.
```

Same insertion in the range-mode block after line 192 (the "**TP2: opposite range extreme**" line).

Update Step L's checklist (line 208) from:

```
- [ ] R:R to TP1 ≥ 1.0 and R:R to TP2 ≥ 1.3 (universal floors post-2026-05-07)
```

to:

```
- [ ] R:R to TP1 ≥ 1.01 and R:R to TP2 ≥ 1.31 (precision margin against broker tick rounding — see precision rule above; strict floors are 1.0 / 1.3 but the safe target is 1.01 / 1.31)
```

## What's deliberately NOT in scope

- **L3b-2 — Leg-B notional pre-flight.** The c0745 cycle's USDJPY retry was futile because the $1012 account simply cannot meet `min_deal_size` on USDJPY at any tier × SL distance. A pre-flight check requires either a heuristic table in the prompt (drift risk: broker can change `min_deal_size` without notice; the prompt would silently lie) or a new tool exposing `min_deal_size` (~80-120 LOC: tool definition, handler, tests, prompt instructions). Out of scope for this spec; documented as a follow-up. With Spec 1's cap=12, one futile retry per cycle no longer causes a timeout.

- **Code changes.** Pure prompt edit. Zero TypeScript, zero new tools, zero scheduler change.

- **Strategy / score / risk changes.** This spec is mechanical — it doesn't loosen or tighten any gate. The 1.31R margin is defensive against rounding, not a strategy loosening.

## Tests

Two static prompt-content tests in a new `tests/ict-prompt.test.ts`:

**Test 1 — "STEP 1 mandates parallel batching of get_daily_pnl, get_portfolio, get_economic_calendar"**
Read `prompts/ict-agent.md` once. Assert the rendered prompt contains:
- The literal substring `IN PARALLEL (emit all three as parallel tool_use blocks` (catches accidental deletion of the L3a STEP 1 directive)
- All three tool names in the same line or adjacent lines after that directive: `get_daily_pnl()`, `get_portfolio()`, `get_economic_calendar(1)`

**Test 2 — "STEP 3 mandates batching of A, E, G read-only fetches"**
Read `prompts/ict-agent.md` once. Assert it contains:
- The literal substring `CRITICAL — batch all read-only data tools in a single response` (the L3a STEP 3 directive)
- All four batched tool names in the minimum-batch list: `get_prices(instrument, '1h', 50)`, `get_prices(instrument, '15m', 50)`, `get_news_context(instrument)`, `get_lessons(setup_type, instrument_category, kill_zone, 'ICT_INTRADAY')`

**Test 3 — "TP2 precision rule cites 1.31, not 1.30"**
Read `prompts/ict-agent.md` once. Assert:
- Contains the literal `TP2 ≥ 1.31 × |entry − SL|` (the precision rule)
- Step L checklist line includes `R:R to TP1 ≥ 1.01 and R:R to TP2 ≥ 1.31`

**These are static prompt-content guards, not behavior tests.** They catch accidental edits/deletions to the prompt file. The real validation of L3 is **production observation**:

- L3a working signal: iteration counts on multi-candidate cycles drop from typical 8 to typical 5-6 (matching the existing successful-cycle pattern from c0930/c0830 on 2026-05-08).
- L3b-1 working signal: zero `RR_FLOOR_VIOLATION` rejections on first analyst submission per candidate. Pre-fix, c0845 and c0900 saw these on every candidate.

## Files touched

- **Modify:** `prompts/ict-agent.md`
  - STEP 1 rewrite (lines 101-108): add parallel-batch directive + fold in get_economic_calendar
  - Step F rewrite (lines 140-144): becomes calendar-veto re-check, no longer fetches
  - STEP 3 header (lines 114-116): add batching directive for A/E/G
  - R:R floor section (after line 188 and after line 192): add precision rule
  - Step L checklist (line 208): update target margins to 1.01 / 1.31
- **Create:** `tests/ict-prompt.test.ts` (~50 lines, 3 static-content tests)

Total diff: roughly 60-90 lines of prompt edits + ~50 lines of tests. No code logic changed.

## Risk

Very low. Pure prompt edit + static prompt-content tests.

Failure modes considered:
- **Model ignores the batching directive.** The cycle data shows the model already batches sometimes (4 tools at iter 1 in c0930). Explicit recipes raise the probability; they don't guarantee it. Worst case: same as today (sometimes batches, sometimes doesn't), no regression.
- **1.31R margin constrains a legitimate 1.30R setup.** Broker rounding always cuts in the unfavorable direction; 1.31R is just one basis point of extra TP distance. No realistic setup turns infeasible at 1.31R that was feasible at 1.30R. The R:R floor itself is a strategy choice (post-2026-05-07 Phase 2 lowered it from 2.0R to 1.30R — adding 0.01R back is invisible at that scale).
- **Calendar moved to STEP 1 misses an event added mid-cycle.** ICT cycles are at most ~1 minute wall-time; calendar updates are not real-time during a cycle. Re-fetching at Step F per-candidate added no new information vs. fetching once at STEP 1. No correctness loss.

Rollback is a one-line `git revert`.

## Production observation plan

Three signals to watch on the next London Open + NY Open (post-deploy):

1. **Iteration counts on timed-out cycles.** Pre-Spec-1, NFP-day cycles timed out at iter 8. Post-Spec-1, the cap is 12. Post-L3, cycles that previously hit 8 should reach end_turn at iter 5-7 (the batching savings). If timeouts persist at iter 12, the batching directive isn't being followed and L3a needs revision.

2. **Pre-check rejection patterns.** Pre-L3, `RR_FLOOR_VIOLATION` was the dominant pre-check rejection on c0845/c0900. Post-L3, this should drop to near-zero (the agent's first proposal already clears 1.31R). If `RR_FLOOR_VIOLATION` persists, the precision rule isn't being read or the agent is still using the strict 1.30R floor as its target.

3. **Tool-call count per cycle vs iteration count.** Pre-L3, c0930 successfully batched 4 tools in 1 iteration; c0800 fired 4 tools across 4 iterations. Post-L3, the median ratio of (tool calls / iterations) should rise — same work, fewer iterations.

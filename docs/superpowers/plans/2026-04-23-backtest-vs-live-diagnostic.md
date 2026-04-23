# Backtest vs Live Diagnostic — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute the 4-angle backtest-vs-live diagnostic defined in `docs/superpowers/specs/2026-04-23-backtest-vs-live-diagnostic-design.md` and commit an integrated findings report that answers Giuseppe's question ("is the bot underperforming the backtest?").

**Architecture:** Three read-only specialist agents run in parallel via a single multi-tool Agent call (α=Explore, β=general-purpose, γ=general-purpose). Main thread collects their structured summaries, performs Angle D (expectations forecast) math, synthesizes into a single markdown report at `docs/superpowers/reviews/2026-04-23-backtest-vs-live-diagnostic.md`, and commits.

**Tech Stack:** Agent tool (subagent dispatch), SSH/Bash (VPS log access for β), Read/Grep (code access for α), throwaway Node for γ realism fork. No changes to running bot, no pm2 restart, no DB writes.

---

## File Structure

**Created by this plan:**
- `docs/superpowers/reviews/2026-04-23-backtest-vs-live-diagnostic.md` — the final report (committed).

**Possibly created during execution, DELETED before commit:**
- `scratch/realism-fork.ts` — Agent γ's throwaway realism-patch runner. Must NOT be committed. Task 8 verifies cleanup.

**Modified:** none. The investigation is read-only against all live systems and the committed codebase.

**Read (live systems):**
- `/home/bot/trading-bot/data/pm2-out.log` on `bot@162.55.212.198` (β only).

**Read (repo files):**
- `src/backtest/engine.ts`, `src/scanner/index.ts`, `src/agents/trading-agent.ts`, `src/agents/analyst-agent.ts`, `src/news/index.ts`, `src/mcp-server/capital-client.ts`, `prompts/ict-agent.md` — α, β, γ as applicable per spec §3.

---

### Task 1: Dispatch the 3 specialist agents in parallel

**Files:**
- No files created. Single multi-tool Agent call with 3 subagent dispatches.

- [ ] **Step 1: Verify VPS SSH reachability**

Run: `ssh -o ConnectTimeout=10 bot@162.55.212.198 "echo ok"`
Expected: output `ok`. If it fails, Agent β cannot work — stop and escalate to Giuseppe.

- [ ] **Step 2: In ONE assistant message, invoke Agent tool three times in parallel**

This is critical — the three calls must be in the same message to run concurrently.

**Agent α dispatch — subagent_type: Explore**

Description: `Rule-drift audit: backtest vs live`

Prompt:
```
You are an independent auditor. Read-only investigation. Do NOT propose fixes, do NOT edit any file.

Task: produce a definitive delta table of every gate/filter present in the LIVE ICT trading path that is absent from the BACKTEST simulator, and vice versa. This explains the trade-frequency gap between the live bot (~0.5-1 ICT trades/day across 7 instruments in 4 demo days) and the backtest (~7 trades/day over 2019-2025, 14918 total).

Read EVERY line of these files at the absolute path `C:\Users\user\Desktop\Trade Bot\Trade Bot\`:
- src/backtest/engine.ts
- src/scanner/index.ts
- src/agents/trading-agent.ts
- src/agents/analyst-agent.ts
- src/news/index.ts
- prompts/ict-agent.md

Report back in EXACTLY this structure (≤500 words total in the summary section; appendix table may be longer):

## Summary
3 sentences max. Name the top 3 gates that most likely explain the frequency gap, with severity A/B/C.

## Delta table
| Gate | Live? | Backtest? | Severity | Evidence |
|---|---|---|---|---|
| (row 1) | ✓/✗ | ✓/✗ | A/B/C | `file:line` |
...(≤30 rows)

Severity legend:
- A: gate alone could halve trade frequency (e.g., news-opposing skip, Analyst REJECT)
- B: material but not dominant (e.g., 15M trigger, Researcher shortlist)
- C: minor (e.g., 3-candle cooldown, spread sort order)

Every row MUST have an evidence citation (file:line). No fluff, no fixes, no speculation. If a gate exists in a form that's hard to categorize, put it in the table with a `?` and a note.

Thoroughness: very thorough. Read all files top to bottom before filling the table.
```

**Agent β dispatch — subagent_type: general-purpose**

Description: `5-trade forensic + skipped-cycle audit`

Prompt:
```
You are a forensic analyst. Read-only. Do NOT modify any file, do NOT call place_order, do NOT touch the live bot.

Task has two parts.

PART 1 — Five ICT place_order attempts since 2026-04-20 demo start:
- 2026-04-21 12:58:41 UTC  (3 calls — GBPUSD first-trade attempt, log_trade schema crashes)
- 2026-04-22 14:18:49 UTC  (2 calls — USDJPY closed on 14.6-pip slippage)

For each attempt, SSH to bot@162.55.212.198 and grep /home/bot/trading-bot/data/pm2-out.log around the timestamp (±10 min window). Reconstruct: `{timestamp, instrument, direction, entry, SL, TP1, TP2, TP3, actual outcome, why-it-ended-how-it-did, would-backtest-simulator-take-it-yes/no-why, backtest-counterfactual R estimate}`.

To answer "would backtest take it", read the repo's src/backtest/engine.ts at `C:\Users\user\Desktop\Trade Bot\Trade Bot\src\backtest\engine.ts` and apply its rules (bias non-neutral + score ≥50 + R:R ≥1.5 for Tier 3 / ≥2.0 for Tier 1-2 + 3-candle cooldown) against the data in each case.

PART 2 — Sample 10 "high-score but skipped" cycles:
Grep the pm2 log for patterns like "SKIP|no trigger|bias unclear|R:R" where the skip happened DURING an active kill zone (London Open 07-10 UTC, NY Open 13-16 UTC, London Close 15-17 UTC) in the last 48 hours. Pick the 10 cycles with the highest scanner composite score that still resulted in skip.

For each of those 10 skips, report: `{timestamp, instrument, scanner score, kill zone, live agent's actual skip reason, would-backtest-take-it-yes/no-why, backtest-counterfactual R estimate}`.

Deliverable structure (≤500 words in the summary section):

## Summary
5-sentence executive summary. Key question: if the backtest had been in charge of the same windows, would the live bot's 5 attempts have had different outcomes, AND how many additional trades would the backtest have executed from the 10 sampled skips?

## Part 1 — 5 case files
(one case file per attempt)

## Part 2 — 10 skip case files
(one per sampled skip)

## Comparative R tally
| Source | Actual R (live) | Backtest hypothetical R |
|---|---|---|
| Executed trades | (sum) | (sum if backtest rules had applied) |
| Skipped but backtest would take | 0 | (sum if taken) |
| Total | (sum) | (sum) |

SSH command examples:
  ssh bot@162.55.212.198 "grep '2026-04-21 12:5[0-9]' /home/bot/trading-bot/data/pm2-out.log"
  ssh bot@162.55.212.198 "grep -E 'SKIP|no trigger' /home/bot/trading-bot/data/pm2-out.log | tail -200"

Every claim in the summary must cite either a log timestamp or a file:line. No fix proposals.
```

**Agent γ dispatch — subagent_type: general-purpose**

Description: `Backtest realism check`

Prompt:
```
You are a model-validity analyst. Read-only against the committed codebase. You MAY write throwaway scratch code to a one-off scratch file under `scratch/` at `C:\Users\user\Desktop\Trade Bot\Trade Bot\scratch\`. The scratch code MUST NOT be committed — include a command at the end to rm it.

Task: quantify how much the Farad backtest's headline `+1671R over 2019-2025` shrinks under realistic live conditions. The backtest currently assumes zero spread, zero slippage, and `newsScore=0` for every trade.

Read these first (absolute path `C:\Users\user\Desktop\Trade Bot\Trade Bot\`):
- src/backtest/engine.ts  (understand simulation assumptions)
- src/mcp-server/capital-client.ts  (Capital.com spread/slippage behavior)
- /home/bot/trading-bot/data/pm2-out.log on bot@162.55.212.198 — grep for 'slippage' or '14.6 pips' for the 2026-04-22 USDJPY live observation

Produce 3 delta estimates, each expressed as `1671R → X R` with a credibility rating:

1. **Spread-cost delta** (credibility A — quantitative)
   Method: for each instrument, subtract typical Capital.com demo spread in R-units from every backtest trade's gross R. (Spread in R = spread_pips / (stop_distance_pips) ≈ 0.02-0.05 R per trade depending on instrument.)
   Report: per-instrument spread assumption (pips), resulting total R.

2. **Slippage delta** (credibility B — modelled from observation)
   Method: apply a per-instrument market-order slippage estimate derived from the 2026-04-22 USDJPY observation (14.6 pips = ~$0.146 on a $50k USDJPY trade at $1/pip, which gutted R:R from ~1.7:1 to 0.5:1). Extrapolate: every backtest trade loses some fraction of R to entry slippage. Report the fraction per instrument.

3. **News-filter-proxy delta** (credibility C — hand-waved proxy)
   Method: the backtest takes trades at any hour; the live bot skips trades when news opposes. Proxy by assuming X% of backtest trades entered within ±30 min of a high-impact event, and that ~half of those would have been filtered by a live-style news gate. Pick X based on the backtest's hourly distribution.

OPTIONAL scratch work:
You MAY write `scratch/realism-fork.ts` (≤150 lines) that re-runs a narrow slice of the backtest (e.g., just EURUSD 2024) with the 3 deltas patched in, and prints the patched total R vs the unpatched total R. The scratch file is NOT to be committed. End your report with a `rm scratch/realism-fork.ts` instruction.

Deliverable structure (≤500 words summary):

## Summary
3 sentences. Name the biggest delta (spread, slippage, or news) and state the single-number result: after all three deltas stacked, the backtest's 1671R reduces to approximately X R.

## Delta 1 — Spread
Method: ...
Input assumption: ...
Result: 1671R → X R
Credibility: A

## Delta 2 — Slippage
(same structure)

## Delta 3 — News filter proxy
(same structure)

## Stacked estimate
Applying all three deltas: 1671R → Y R

## Cleanup
If scratch files were created, include `rm` commands.
```

- [ ] **Step 3: Verify all three agents returned structured summaries**

Expected: three Agent tool responses, each with sections matching the contract above. If any agent failed to follow the contract (missing severity ratings, missing citations, off-structure summary), dispatch a clarification message via SendMessage(to=<agent_name>) asking for the missing section. Do NOT proceed to Task 2 until all three summaries are complete.

- [ ] **Step 4: Commit intermediate — log agent outputs as a sidecar file**

Not required. The summaries will be embedded in the final report in Task 6. Skip.

---

### Task 2: Main-thread Angle D — expectations-forecast math

**Files:**
- No files created in this task. Math + notes are held in context for Task 6.

- [ ] **Step 1: Extract probabilities from agents' summaries**

Use α's severity-A gates list and β's skip-reason counts to estimate each conditional probability:
```
P(1H bias non-neutral)        = (664 - 4 bias-unclear - outside-kz-count) / 664  — from α's Delta table + live cycle counts
P(in-kill-zone score ≥ 45)    = from α's clarity/base/kz math: base 30 + clarity 10/15/20 + kz bonus 15 + spread 5 → ~65-70 on average
P(15M trigger present)        = 1 - (52 "no trigger" / count of cycles that passed bias+score) — from β
P(news non-opposing)          = from γ's news-proxy delta + live logs
P(R:R ≥ 1.5:1)                = 1 - (8 R:R-fail / cycles that passed the above) — from live logs
P(Analyst APPROVE)            = from analyst_log DB table if available, else read ICT prompt for REJECT rate ≈ 15-25%
```

- [ ] **Step 2: Multiply to get expected trades per kill-zone-per-instrument**

Compute: `E(trade | kz,instrument) = ∏ P(...)` from Step 1.

- [ ] **Step 3: Scale to 4-day window**

Compute: `E(trades in 4 days) = E(trade | kz,instrument) × 7 instruments × 3 kz/day × 4 days × weekday_ratio`.

Weekday ratio for 2026-04-20 to 2026-04-23 is 4/4 (all trading days). FX has a weekend gap but we're in a trading window.

- [ ] **Step 4: Compute ±1σ range**

Binomial approximation: `σ ≈ √(n × p × (1-p))` where n is the trials and p is the combined success probability. Report `E ± 1σ`.

- [ ] **Step 5: Compare to actual 5 ICT attempts**

Verdict options:
- If `actual` is within `E ± 1σ`: ON-TRACK
- If `actual < E - 1σ`: UNDER-PERFORMING (then name the single most-restrictive gate from α/β as the cause)
- If `actual > E + 1σ`: OVER-PERFORMING (unlikely with 5 attempts, but possible if gates were accidentally loose)

Write the verdict to a note (held in context for Task 6).

---

### Task 3: Write the integrated report

**Files:**
- Create: `C:\Users\user\Desktop\Trade Bot\Trade Bot\docs\superpowers\reviews\2026-04-23-backtest-vs-live-diagnostic.md`

- [ ] **Step 1: Ensure the reviews directory exists**

Run: `ls "C:/Users/user/Desktop/Trade Bot/Trade Bot/docs/superpowers/"`
Expected: current output shows `plans  specs`. Need to create `reviews`.
Run: `mkdir -p "C:/Users/user/Desktop/Trade Bot/Trade Bot/docs/superpowers/reviews"`
Verify: `ls "C:/Users/user/Desktop/Trade Bot/Trade Bot/docs/superpowers/"` now shows `plans  reviews  specs`.

- [ ] **Step 2: Use Write tool to produce the full report**

Structure (copy verbatim, fill in substantive content from agent summaries + Angle D):

```markdown
# Farad Backtest vs Live Diagnostic — 2026-04-23

**Period analysed:** 2026-04-20 (demo start) → 2026-04-23 (day 4)
**Spec:** docs/superpowers/specs/2026-04-23-backtest-vs-live-diagnostic-design.md
**Methodology:** 3 read-only specialist agents + main-thread synthesis

---

## TL;DR

(≤200 words)

**Verdict:** {UNDER-PERFORMING | ON-TRACK | MIXED}

(3 numbered findings, ranked by impact)

---

## Angle A — Rule-drift audit

(paste α's summary verbatim, then α's delta table under an Appendix subsection)

---

## Angle B — Live-trade forensic + skipped-cycle audit

(paste β's summary verbatim, then 15 case files under Appendix subsections
"B.1 — 5 executed ICT attempts" and "B.2 — 10 sampled skips")

---

## Angle C — Backtest realism check

(paste γ's summary verbatim, then each delta's Method/Assumption/Result
under Appendix subsections)

---

## Angle D — Expectations forecast

(main-thread synthesis from Task 2, showing:
- each conditional probability with its source
- the multiplication to E(trades in 4 days)
- ±1σ range
- comparison to actual 5 attempts)

---

## Integrated verdict

(explicit answer to Giuseppe's question. 2-3 paragraphs. Must cite numbers
from α/β/γ/D. Must name the single most-restrictive gate if under-performing.)

---

## Recommendations

(GATED — only populated if Giuseppe has explicitly requested action items.
Otherwise leave this section as "None requested — see spec §8.")

---

## Appendix

### A. Rule-drift delta table
(α's full table)

### B.1 — 5 executed ICT attempts
(β's Part 1 case files)

### B.2 — 10 sampled skipped cycles
(β's Part 2 case files)

### C. Realism deltas
(γ's full Method/Assumption/Result for each delta)
```

- [ ] **Step 3: Verify report against spec §6 success criteria**

Checklist (from spec):
1. Every gate gap from α has a file:line citation — verify by scanning Appendix A for `file:line` or `.ts:` patterns in each row.
2. 5 Part-1 case files present — count section B.1.
3. Exactly 10 Part-2 case files present — count section B.2.
4. γ produces 3 deltas, each with credibility A/B/C — grep the report for "Credibility: A", "B", "C".
5. Angle D outputs a concrete expected-trades number with range — verify it's a number ± number, not a word.
6. TL;DR verdict cites numbers — scan for digits.
7. (Report commit deferred to Task 4.)

If ANY check fails, fix the report inline before proceeding.

---

### Task 4: Clean up scratch files (if any) and commit the report

**Files:**
- Commit: `docs/superpowers/reviews/2026-04-23-backtest-vs-live-diagnostic.md`
- Delete (if exists): `scratch/realism-fork.ts`

- [ ] **Step 1: Check for throwaway scratch files**

Run: `ls "C:/Users/user/Desktop/Trade Bot/Trade Bot/scratch/" 2>/dev/null`
If the directory exists and contains files, read Agent γ's final instruction line for the `rm` command(s). Execute them.

- [ ] **Step 2: Verify git status shows ONLY the new report**

Run: `cd "C:/Users/user/Desktop/Trade Bot/Trade Bot" && git status --short`
Expected: only `docs/superpowers/reviews/2026-04-23-backtest-vs-live-diagnostic.md` in the added/untracked list. If any scratch file remains, go back to Step 1.

- [ ] **Step 3: Commit**

Run:
```bash
cd "/c/Users/user/Desktop/Trade Bot/Trade Bot" && git add docs/superpowers/reviews/2026-04-23-backtest-vs-live-diagnostic.md && git commit -m "$(cat <<'EOF'
docs(review): backtest vs live diagnostic — 2026-04-23

4-angle read-only investigation per spec at
docs/superpowers/specs/2026-04-23-backtest-vs-live-diagnostic-design.md.
Three specialist agents (rule-drift audit, live-trade forensic + skipped-
cycle audit, backtest realism check) plus main-thread expectations
forecast. No code changes. No live-bot changes.

Verdict: see TL;DR in the report.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```
Expected: one new commit on master, 1 file changed, ~300-500 insertions.

- [ ] **Step 4: Push**

Run: `cd "/c/Users/user/Desktop/Trade Bot/Trade Bot" && git push origin master`
Expected: `master -> master` success (with the usual "Bypassed rule violations" warning for direct push).

- [ ] **Step 5: Confirm sync**

Run: `cd "/c/Users/user/Desktop/Trade Bot/Trade Bot" && git rev-parse --short HEAD && git rev-parse --short origin/master`
Expected: both hashes match.

---

### Task 5: Report the verdict to Giuseppe

**Files:**
- No files. User-facing message only.

- [ ] **Step 1: Summarize in chat**

Content of the final assistant message to Giuseppe (≤150 words):

1. One-line verdict (UNDER-PERFORMING / ON-TRACK / MIXED + the single biggest driver).
2. Path to the committed report.
3. The top 3 numbers that support the verdict.
4. Ask if Giuseppe wants the "Recommendations" section populated (it was left empty per spec §8 unless requested).

---

## Self-Review

Spec coverage check against `docs/superpowers/specs/2026-04-23-backtest-vs-live-diagnostic-design.md`:

- Spec §2 Architecture — **Task 1** dispatches the 3 agents in parallel ✓
- Spec §3 Agent α — **Task 1 Step 2** α prompt matches the brief ✓
- Spec §3 Agent β (incl. Part 2 skip audit) — **Task 1 Step 2** β prompt includes both parts ✓
- Spec §3 Agent γ — **Task 1 Step 2** γ prompt includes 3 deltas + optional scratch code ✓
- Spec §4 Angle D — **Task 2** performs the expectations math in main thread ✓
- Spec §5 Final deliverable path — **Task 3 Step 1** creates `reviews/` dir, **Step 2** writes to the exact path ✓
- Spec §6 Success criteria — **Task 3 Step 3** enumerates all 7 and bails if any fail ✓
- Spec §7 Timeline — implicit in task granularity (Task 1 is the ~10-min parallel phase) ✓
- Spec §8 Out of scope — Task 4 Step 2 verifies only the report is in git-add, scratch is deleted ✓
- Spec §9 Demo-safety — read-only agents, no pm2 restart anywhere, no DB writes ✓

Placeholder scan: no "TBD", "TODO", or vague-error-handling phrases in any task. Every code step shows the code.

Type consistency: agent dispatch subagent_types (`Explore`, `general-purpose`) used consistently across Task 1 and the spec.

---

## Execution notes

- **Worktree:** this plan was NOT created in a dedicated worktree. Giuseppe has been working directly on master for today's 7 commits. Per Farad demo workflow, this is acceptable — the investigation is read-only against the live system and the only commit it produces is a documentation file.

- **Concurrency:** Task 1 is the ONLY task that benefits from parallelism. Tasks 2–5 are strictly sequential.

- **Stop conditions:** if any of α/β/γ returns an obviously broken summary (fewer than the required case files, missing severity ratings, or fabricated citations), stop at Task 1 Step 3 and escalate to Giuseppe with the broken summary.

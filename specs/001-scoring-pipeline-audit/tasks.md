---
description: "Atomic, parallelizable task list for scoring pipeline audit"
---

# Tasks: Scoring Pipeline Audit & Silent-Rejection Fix

**Input**: Design documents from `specs/001-scoring-pipeline-audit/`
**Prerequisites**: spec.md, plan.md, research.md, data-model.md, quickstart.md (all committed at `7918546`)
**Branch**: `spec/scoring-pipeline-audit`

**Ship order (Codex-preferred, per owner decision):**
- **PR 1** = US-1 (deterministic scoring) + US-2 (categorised rejections + digest) + US-6 (post-approval drops) — one DB migration
- **PR 2** = US-3 (code-level cooldown) + US-5 (structure-quality scorer)
- **PR 3** = US-4 (range-mode evaluation) + US-7 (opt-in concurrent trades)

**Tests:** REQUIRED. The bot has 820 passing tests on master `c86b164` and uses TDD discipline. Every implementation task is preceded by failing test tasks per Red-Green-Refactor.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel — different files, no shared state, no dependency on incomplete work
- **[Story]**: User story label (US1–US7); omitted for Setup/Foundational/Polish phases
- **File paths are absolute or repo-relative** (relative to `C:\Users\user\Desktop\Trade Bot\Trade Bot\`)

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Create folder skeletons and add npm scripts before any code lands.

- [ ] T001 Create folder skeletons with empty `index.ts` re-export files: `src/scoring/`, `src/rejection-log/`, `src/cooldown/`, `src/risk-budget/`. Each `index.ts` exports `{}` for now. Acceptance: `tsc --noEmit` clean.
- [ ] T002 [P] Add npm scripts to `package.json`: `scoring-regression`, `plant-trades`, `plant-approval`, `place-pending`, `submit-proposal`, `digest`, `trade-cycle-once`, `backtest:range-mode` (all as placeholder stubs in `scripts/` returning exit 0). Acceptance: `npm run digest -- --help` exits 0.
- [ ] T003 [P] Create `tests/fixtures/scoring/` directory with three empty JSON files: `historical-snapshots.json`, `cooldown-scenarios.json`, `rejection-categories.json`. Acceptance: files exist, valid empty arrays/objects.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Migration 007 + the rejection-log primitives + the scoring scaffold. Every user story depends on these.

**⚠️ CRITICAL**: No US-1 / US-2 / US-6 task can begin until T004–T010 complete.

- [ ] T004 Implement Migration 007 in `src/database/index.ts` (extend the `PRAGMA table_info` + guarded `ALTER TABLE` pattern at `src/database/index.ts:544-570`). Creates: `score_breakdowns` table, `trade_rejections` table (with two indexes), three new columns on `analyst_log` (`category`, `is_fail_closed`, `subcategory`) plus index, three new `pm_state` rows (`cooldown_max_consecutive_losses=3`, `cooldown_clear_after_hours=24`, `max_total_risk_pct=0.0`). Idempotent. Acceptance: run twice in a row, no errors; `PRAGMA table_info(trade_rejections)` lists all 9 columns.
- [ ] T005 Run existing test suite to confirm migration is non-breaking: `npm test`. Acceptance: 820/820 still pass.
- [ ] T006 [P] Create `REJECTION_CATEGORIES` enum + `RejectionCategory` type in `src/rejection-log/categories.ts` (25 categories per data-model.md E-2). Export the const array AND the union type. Acceptance: importing `RejectionCategory` from another file gives autocomplete on all 25 values.
- [ ] T007 [P] Create `recordRejection({ instrument, layer, category, subcategory?, reason_text, proposed_score?, proposed_tier?, request_id? })` in `src/rejection-log/record.ts`. Writes to `trade_rejections` table. For analyst layer, ALSO writes to `analyst_log.category/is_fail_closed/subcategory` columns (helper inside same file). Acceptance: unit test in `tests/rejection-log/record.test.ts` covers both write paths.
- [ ] T008 [P] Add helpers to `src/database/index.ts`: `insertScoreBreakdown(row)`, `insertRejection(row)`, `getDailyRejections(date)`, `getOpenTradesRiskSum()`. Each is a thin prepared-statement wrapper. Acceptance: typecheck clean; smoke test inserts and reads one row of each.
- [ ] T009 [P] Create `src/scoring/tiers.ts` re-exporting `TIER_1_THRESHOLD=80`, `TIER_2_THRESHOLD=60`, `tier3FloorFor` (proxy import from `src/agents/spread.ts`). Single import surface for the rest of `src/scoring/`. Acceptance: `import { TIER_1_THRESHOLD } from '../scoring/tiers'` works in scanner.
- [ ] T010 Create scoring stub: `src/scoring/components.ts` exports `baseComponent()=>25`, `biasClarityComponent(c)=>0|15|20|25`, `newsComponent(raw)=>clamp(-15,10)`, `spreadComponent(q)=>0|5`, `historyComponent(winRate, n)=>0|+10|-10` (activates at n≥2), `ictArrayComponent(_)=>0` (STUB — full impl in T058). Plus `composeScore(inputs)` in `src/scoring/compose.ts` returning `{composite_score, score_breakdown, tier}`. Acceptance: every function is pure; no LLM call; no DB call; all unit-testable.

**Checkpoint:** Foundation ready. PR 1 work (US-1, US-2, US-6) can now proceed in parallel.

---

## Phase 3: User Story 1 — Deterministic Scoring (Priority: P1) 🎯 MVP-PR1

**Goal**: Move ICT-array scoring (+0/15/25/35) and history adjustment (±10) from `prompts/ict-agent.md:161-169` into TypeScript code so the same input always produces the same composite_score.

**Independent Test**: Replay 100 historical setup snapshots through `composeScore()` 10 times each → composite_score variance = 0 (SC-001). Re-score last 30 days of historical T1 trades → ≥80% retain T1 (SC-006).

### Tests for User Story 1 (write FIRST, must FAIL before implementation)

- [ ] T011 [P] [US1] Test: `tests/scoring/components.test.ts` — one test per component covering boundary values (clarity 14 vs 15, news 10.5 → clamped to 10, history sampleSize 1 vs 2, range +20 then capped to 59, etc.). Should FAIL initially because the components have stub bodies. Acceptance: tests defined and `npm test` reports them failing in expected ways.
- [ ] T012 [P] [US1] Test: `tests/scoring/compose.test.ts` — fixture-based: feed identical input 10 times, assert byte-identical `composite_score`, byte-identical `score_breakdown` JSON. Acceptance: test exists; runs fail-then-pass after T015.
- [ ] T013 [P] [US1] Test: `tests/scoring/historical-replay.test.ts` — load `tests/fixtures/scoring/historical-snapshots.json` (50 frozen scanner inputs from past production days); for each, run `composeScore(input)` and assert `≥80%` of historical T1 inputs still resolve to Tier 1. Acceptance: test fails until fixture is populated AND scorer is real.
- [ ] T014 [US1] Populate `tests/fixtures/scoring/historical-snapshots.json` from a 30-day VPS DB snapshot. Use `scripts/extract-historical-snapshots.ts` (new helper). Each snapshot includes the original score and tier for diff'ing. Acceptance: 50 entries, all with `original_score`, `original_tier`, `inputs` keys.

### Implementation for User Story 1

- [ ] T015 [P] [US1] Implement `src/scoring/components.ts` (replace T010 stubs with real bodies for `baseComponent`, `biasClarityComponent`, `newsComponent`, `spreadComponent`, `historyComponent`). Keep `ictArrayComponent` as a stub returning 0 — full implementation lands in T058 (US-5). Acceptance: T011 tests pass.
- [ ] T016 [US1] Implement `src/scoring/compose.ts` — combines components, applies range-mode +20/cap-59 logic per data-model.md, returns `{composite_score, score_breakdown, tier}` with `range_cap_applied` flag when relevant. Acceptance: T012 + T013 tests pass; deterministic.
- [ ] T017 [US1] MODIFY `src/types.ts:430-443` — extend `RankedInstrument` interface with `score_breakdown: ScoreBreakdownJson` field. Define `ScoreBreakdownJson` type matching data-model.md E-1 `breakdown_json` shape. Acceptance: `tsc --noEmit` clean.
- [ ] T018 [US1] MODIFY `src/scanner/index.ts:380-446` — replace inline math (lines 390-441) with one call to `composeScore({...})`. Pass through `composite_score`, `tier`, AND `score_breakdown` on the returned `RankedInstrument`. Keep the `Math.max(0, Math.min(100, score))` clamp logic inside `compose.ts` instead. Acceptance: existing `tests/scanner.test.ts` still passes; new score_breakdown field present.
- [ ] T019 [US1] MODIFY `src/agents/trading-agent.ts:700-707` (request_analyst_review schema) — extend the input schema to accept `score_breakdown` from Haiku (which Haiku gets from the scanner verbatim). Acceptance: existing trading-tools tests pass.
- [ ] T020 [US1] MODIFY `src/agents/trading-agent.ts:945` — when storing the trade record, also call `insertScoreBreakdown({trade_id, instrument, composite_score, tier, breakdown_json, scored_at, scorer_version})` (helper from T008). Acceptance: query DB after a trade attempt, breakdown row present.
- [ ] T021 [US1] MODIFY `src/agents/trading-agent.ts:1090-1105, 1143-1178` (executor revalidation) — keep the existing `expectedTier` check as a defensive sanity gate; ADD a check that the supplied `score_breakdown` sums to the supplied `composite_score` (catches Haiku tampering). Reject with `EXECUTOR_REJECT_TIER_SCORE_MISMATCH` if not. Acceptance: integration test plants a tampered proposal → rejected.
- [ ] T022 [US1] MODIFY `src/agents/trading-agent.ts:114` — bump `proposalHash` version constant from `v1` → `v2` to invalidate any in-flight approvals across the migration window. Acceptance: existing `tests/proposal-hash.test.ts` updated to assert v2.
- [ ] T023 [US1] MODIFY `prompts/ict-agent.md:161-169` (§H) — replace the 9-line scoring rubric with: "Use the scanner-supplied `composite_score` and `tier` verbatim. Do NOT recompute. The scanner's score is now deterministic and matches what the executor will validate." Acceptance: prompt diff reviewed; manual replay of 5 historical Haiku contexts confirms it stops emitting score numbers.
- [ ] T024 [US1] MODIFY `src/backtest/engine.ts:144-146` — switch from inline `if (score >= 80) return 1; ...` ladder to a single call to `composeScore(...).tier`. Acceptance: existing backtest tests still pass with same R-output.
- [ ] T025 [US1] DELETE the "Acknowledged limitation: live scoring will be 0-35 points higher" comment block at `src/backtest/engine.ts:24-28` AND any reference to it. Grep-replace to find references. Acceptance: `grep "0-35 points higher" src/` returns nothing.
- [ ] T026 [US1] DOC: update `docs/architecture/SYSTEM-FLOWCHART.md` §2 (scoring rubric) to point to `src/scoring/compose.ts` as the single source of truth; remove any prose that lists the rubric inline. Acceptance: grep doc for "+20 base" / "0/15/20/25" — only one occurrence remains (cross-reference to code).

**Checkpoint US-1**: composite_score is deterministic (zero variance across 10 runs of identical input). 820 + ~14 new tests green. SC-001 + SC-006 verified.

---

## Phase 4: User Story 2 — Categorised Rejections + Daily Digest (Priority: P1)

**Goal**: Every rejection across scanner / analyst / executor / post-approval gets a machine-parseable category code and surfaces in a daily Telegram digest at 21:30 UTC.

**Independent Test**: Force each of the 25 categories via test fixtures → daily digest shows that category with count ≥ 1; no `OTHER` row anywhere; SC-002 + SC-003 + SC-009 verified.

### Tests for User Story 2

- [ ] T027 [P] [US2] Test: `tests/rejection-log/categories.test.ts` — every value in `REJECTION_CATEGORIES` enum has a forced-trigger fixture; `OTHER` count is asserted = 0 across the trigger run. Acceptance: test enumerates all 25 categories.
- [ ] T028 [P] [US2] Test: `tests/rejection-log/digest.test.ts` — fixture: insert 12 rejections across 5 categories → digest output has exactly 5 rows summing to 12. Acceptance: test asserts row counts and sum.
- [ ] T029 [P] [US2] Test: `tests/integration/analyst-fail-closed.test.ts` — `ANALYST_FORCE_TIMEOUT=true` env var triggers an API timeout in the analyst; assert `analyst_log` row written with `category=ANALYST_FAIL_CLOSED_API_ERROR`, `is_fail_closed=1`. Acceptance: test exists; runs against test DB.
- [ ] T030 [P] [US2] Test: `tests/integration/digest-distinguishes-fail-closed.test.ts` — fixture has 1 cause-REJECT and 1 fail-closed REJECT for the same day; digest shows them as separate categories per FR-005. Acceptance: assertion explicit.

### Implementation for User Story 2

- [ ] T031 [US2] Create `src/rejection-log/digest.ts` — `buildDailyDigest(date) → DigestPayload`. Queries both `trade_rejections` AND `analyst_log` for the given UTC date; UNIONs by category; returns `{date, total_rejections, by_category: Record<RejectionCategory, number>, fail_closed_total}`. Acceptance: T028 passes.
- [ ] T032 [US2] MODIFY `src/scanner/index.ts:331` — wrap kill-zone `return []` with `recordRejection({layer:'scanner', category:'KILL_ZONE_OUT', instrument: each, reason_text:'outside London/NY kill zones'})`. ⚠️ DO NOT remove the gate itself — only instrument it. Acceptance: kill-zone-skipped instruments now log entries.
- [ ] T033 [US2] MODIFY `src/scanner/index.ts:469` (per-instrument fetch error path) — `recordRejection({layer:'scanner', category:'SCANNER_FETCH_ERROR', subcategory: err.constructor.name, ...})`. Acceptance: forced TwelveDataDailyCapError → row written.
- [ ] T034 [US2] MODIFY `src/agents/analyst-agent.ts:48` (parseAnalystResponse fail-closed) — augment the existing fail-closed return to also emit `recordRejection({...ANALYST_FAIL_CLOSED_PARSE, is_fail_closed:1})`. Acceptance: T029 variant for parse failure.
- [ ] T035 [US2] MODIFY `src/agents/analyst-agent.ts:135` (no submit_decision tool call) — `recordRejection({...ANALYST_FAIL_CLOSED_NO_TOOL_CALL})`. Acceptance: forced fixture triggers it.
- [ ] T036 [US2] MODIFY `src/agents/analyst-agent.ts:319-344` (API failure catch + logAnalystDecision) — set `analyst_log.category=ANALYST_FAIL_CLOSED_API_ERROR, is_fail_closed=1` when emitting the failClosed decision. For successful decisions, set the category from the analyst's verdict + reason mapping (`ANALYST_REJECT_BANNED_PATTERN` etc.). Acceptance: T029 + T030 pass.
- [ ] T037 [US2] MODIFY `src/agents/trading-agent.ts:1160-1190` — wrap each `error: '...'` JSON return with `recordRejection({layer:'executor', category:'EXECUTOR_REJECT_*', proposed_score, proposed_tier, ...})`. Maps: `SCORE_BELOW_TIER_MIN` → `EXECUTOR_REJECT_SCORE_BELOW_TIER_MIN`, etc. Acceptance: forced trigger of each → DB row written.
- [ ] T038 [US2] MODIFY `src/notifications/telegram.ts` — add `sendDailyRejectionDigest(payload: DigestPayload)`. Format: one line per category sorted by count desc, total at bottom, fail-closed total in a dedicated line. Acceptance: dry-run mode prints to console; live mode posts to Telegram chat ID from env.
- [ ] T039 [US2] MODIFY scheduler at `src/scheduler/index.ts` (near `:1039-1057` per Codex) — add cron `30 21 * * *` calling `sendDailyRejectionDigest(buildDailyDigest(today))`. Coexists with existing 21:30 EOD journalist. Acceptance: cron registered; manual trigger works.
- [ ] T040 [US2] MODIFY `scripts/dump-reject-metrics.ts:15-38` — read primarily from new `trade_rejections` + `analyst_log.category`; keep legacy regex-on-stdout path as `--legacy` flag for one release. Acceptance: `tests/dump-reject-metrics.test.ts` passes in both modes.
- [ ] T041 [US2] DOC: update `docs/architecture/SYSTEM-FLOWCHART.md` §10 (working backlog) — close the "no observability for fail-closed REJECTs" item; add §3.5 documenting the new rejection-log layer. Acceptance: section number stable; cross-refs updated.

**Checkpoint US-2**: 100% of rejections fall into a named category for 7 consecutive days (SC-002). Fail-closed and cause-REJECT distinguishable in digest (SC-003). Owner can answer "why was X rejected on Y" in <60s via `sqlite3` or `npm run digest` (SC-009).

---

## Phase 5: User Story 6 — Surface Post-Approval Drops (Priority: P3 — ships in PR 1)

**Goal**: TTL expiry, hash mismatch, and duplicate-instrument lock — all three currently silent — emit categorised rejection records.

**Independent Test**: Force each of the three drops via test fixtures → distinct category in the daily digest with both timestamps / hashes / lock metadata in `subcategory`.

### Tests for User Story 6

- [ ] T042 [P] [US6] Test: `tests/integration/post-approval-ttl.test.ts` — plant approval with `--ttl 1`, sleep 2s, attempt placement → `POST_APPROVAL_TTL_EXPIRED` row with elapsed delta in `subcategory`. Acceptance: row present, both timestamps recoverable.
- [ ] T043 [P] [US6] Test: `tests/integration/post-approval-hash.test.ts` — plant approval, mutate proposal payload, attempt placement → `POST_APPROVAL_HASH_MISMATCH` with both hashes in `subcategory`. Acceptance: forensic fields present.
- [ ] T044 [P] [US6] Test: `tests/integration/post-approval-duplicate.test.ts` — plant two approvals for same instrument, attempt both placements → second attempt fires `POST_APPROVAL_DUPLICATE_LOCK`. Acceptance: row written; first placement still succeeds.

### Implementation for User Story 6

- [ ] T045 [US6] MODIFY `src/agents/trading-agent.ts:124-128` (approval pass TTL prune) — wrap silent prune with `recordRejection({layer:'post_approval', category:'POST_APPROVAL_TTL_EXPIRED', subcategory: JSON.stringify({approved_at, expired_at, elapsed_ms})})`. Acceptance: T042 passes.
- [ ] T046 [US6] MODIFY `src/agents/trading-agent.ts:1126-1139` (hash check) — `recordRejection({layer:'post_approval', category:'POST_APPROVAL_HASH_MISMATCH', subcategory: JSON.stringify({approved_hash, current_hash})})`. Acceptance: T043 passes.
- [ ] T047 [US6] MODIFY `src/agents/trading-agent.ts:1135` AND `:1371-1386` (duplicate-instrument lock — Codex flagged both locations) — `recordRejection({layer:'post_approval', category:'POST_APPROVAL_DUPLICATE_LOCK', subcategory: JSON.stringify({instrument, conflicting_trade_id})})`. Acceptance: T044 passes.

**Checkpoint US-6**: Three previously-silent drops are visible in the digest. Together with US-2's 22 categories, total of 25 named categories with zero `OTHER`.

---

## 🚢 PR 1 Ship Gate

- [ ] T048 PR1 verification: `npm test` reports 820 + ~30 new tests green, zero regressions. `npm run tsc -- --noEmit` clean.
- [ ] T049 PR1 manual smoke: in dev DB, force one rejection per category via `npm run trade-cycle-once` with various env-var triggers; run `npm run digest -- --dry-run` and verify all 25 categories present with sane counts.
- [ ] T050 PR1 deploy window: 22:00 UTC Sunday (after weekly review). Pre-deploy: `SELECT COUNT(*) FROM approvals WHERE consumed_at IS NULL` → 0. Run migration. Restart pm2. Watch `pm2 logs trading-bot --lines 100` for 10 min; alert on any `OTHER` category emission.

---

## Phase 6: User Story 3 — Code-Level Cooldown (Priority: P1, ships in PR 2)

**Goal**: 3 consecutive losses trigger a hard executor gate (currently prompt-only, unreliable). Cooldown clears on next winning trade OR 24h elapsed.

**Independent Test**: Insert 3 losses → submit any proposal → `COOLDOWN_3_LOSSES_ACTIVE` rejection. Insert 2 losses + 1 win → cooldown does not fire. Advance clock 25h → cooldown clears.

### Tests for User Story 3

- [ ] T051 [P] [US3] Test: `tests/cooldown/state.test.ts` — fixture LLL → `getCooldownState().active === true`. Acceptance: test exists.
- [ ] T052 [P] [US3] Test: `tests/cooldown/state.test.ts` — fixture LLW → `active === false`. Acceptance: separate test case.
- [ ] T053 [P] [US3] Test: `tests/cooldown/state.test.ts` — fixture LLL + frozen clock advanced 25h → `active === false`. Acceptance: helper for clock-advance present.
- [ ] T054 [P] [US3] Test: `tests/integration/cooldown-rejects-proposal.test.ts` — LLL fixture + submit proposal → `COOLDOWN_3_LOSSES_ACTIVE` rejection record. Analyst NOT called (saves API cost). Acceptance: assert no analyst call.

### Implementation for User Story 3

- [ ] T055 [US3] Create `src/cooldown/state.ts` — `getCooldownState({now}: {now: Date}) → { active, consecutive_losses, last_loss_closed_at, clears_at }`. Reads `trades` table; counts losses from end backwards until first non-loss; reads `pm_state` for `cooldown_max_consecutive_losses` and `cooldown_clear_after_hours`. Acceptance: T051–T053 pass.
- [ ] T056 [US3] Create `src/cooldown/policy.ts` — pure config helpers: `getMaxConsecutiveLosses()`, `getClearAfterHours()`. Both read from `pm_state` with defaults. Acceptance: smoke test.
- [ ] T057 [US3] MODIFY `src/agents/trading-agent.ts:834` (cooldown injection point — Codex twin verified this is the entry to `request_analyst_review`; supersedes the `:1240-1305` estimate in plan.md). Add `if (isCooldownActive()) { recordRejection({...COOLDOWN_3_LOSSES_ACTIVE}); return JSON.stringify({error:'COOLDOWN_3_LOSSES_ACTIVE', ...}) }`. Acceptance: T054 passes; analyst call count = 0 in cooldown fixture.
- [ ] T058 [US3] MODIFY `prompts/analyst-agent.md:50-52` — remove the prompt-only 3-loss rule. Replace with: "The executor enforces loss-streak cooldown before you are called. CHECK 3 below remains for `banned patterns` only."
- [ ] T059 [US3] MODIFY `prompts/analyst-agent.md:54-57` — smooth out the surrounding paragraph per Codex's hidden-coupling note (the "no hard cap" mention was paired with cooldown text; rewrite so the analyst doesn't see broken context). Acceptance: manual analyst run on a 3-loss fixture confirms it no longer cites cooldown.

---

## Phase 7: User Story 5 — Structure-Quality Scorer (Priority: P2, ships in PR 2)

**Goal**: Replace the `ictArrayComponent` stub from Phase 2 (T010, T015) with a deterministic OB/FVG/sweep/BOS scorer. Removes the last LLM-side scoring contribution and makes the structure component score deterministically from price action.

**Independent Test**: Two instruments — A: bias=15, structure=high; B: bias=25, structure=low → A ranks ≥ B. After full structure scorer in place, ≥80% of historical T1 trades retain T1 (SC-006 finally fully verified).

### Tests for User Story 5

- [ ] T060 [P] [US5] Test: `tests/scoring/ict-array.test.ts` — OB proximity scoring (close OB → high contribution; no OB → 0). Acceptance: 4 boundary cases.
- [ ] T061 [P] [US5] Test: `tests/scoring/ict-array.test.ts` — FVG count scoring (0/1/2/3+ unfilled gaps in 1H last 20 candles → 0/5/10/15 contribution before threshold mapping). Acceptance: 4 cases.
- [ ] T062 [P] [US5] Test: `tests/scoring/ict-array.test.ts` — sweep recency scoring. Acceptance: 3 cases (≤2 candles ago / 3-6 / older).
- [ ] T063 [P] [US5] Test: `tests/scoring/ict-array.test.ts` — 15M BOS count in bias direction (0/1/2+). Acceptance: 3 cases.
- [ ] T064 [P] [US5] Test: `tests/scoring/ict-array.test.ts` — combined 0/15/25/35 threshold mapping per research.md R-2. Acceptance: 4 cases at each threshold boundary.
- [ ] T065 [P] [US5] Test: `tests/scoring/structure-vs-bias-ranking.test.ts` — high-structure-low-bias instrument outranks low-structure-high-bias. Acceptance: assertion explicit.

### Implementation for User Story 5

- [ ] T066 [US5] FULL IMPL `src/scoring/ict-array.ts` — replace the stub (which returns 0) with the four-primitive scorer per research.md R-2: `obProximityScore(candles)`, `fvgCountScore(candles)`, `sweepRecencyScore(candles)`, `bosCountScore(candles15m, biasDirection)`, plus `combineToIctArrayContribution({...}) → 0 | 15 | 25 | 35`. Acceptance: T060–T064 pass.
- [ ] T067 [US5] MODIFY `src/scoring/compose.ts` — wire `ictArrayComponent()` into the score. The `breakdown_json` now has a non-zero `ict_array` field for setups with structure. Acceptance: T065 passes.
- [ ] T068 [US5] MODIFY `src/scanner/index.ts:380-446` — pass the candle arrays to `composeScore()` so `ictArrayComponent` has data. The scanner already fetches 1H + 15M for bias detection; reuse those arrays. Acceptance: existing scanner tests still pass; structure-aware scoring active.
- [ ] T069 [US5] MODIFY `src/backtest/engine.ts` — pass the candle arrays to `composeScore()` too. The backtest's "structure quality always 0" caveat goes away. Re-run existing backtest fixtures and confirm tier distributions shift toward T1/T2 (more trades fire). Acceptance: backtest snapshot tests updated.
- [ ] T070 [US5] Verification: re-run `npm run scoring-regression -- --days 30` from quickstart.md. Acceptance: SC-006 (≥80% historical T1 retain T1) now passes with full scorer (was indeterminate with stub).

---

## 🚢 PR 2 Ship Gate

- [ ] T071 PR2 verification: `npm test` 820 + ~50 new tests green; `tsc --noEmit` clean.
- [ ] T072 PR2 7-day shadow run on demo: deploy to VPS, monitor digest daily for 7 days. Acceptance: rejection rate within ±10pp of pre-deploy baseline (SC-008). If exceeded, investigate before marking shipped.
- [ ] T073 PR2 SC-001 final verification: `npm test -- tests/scoring/compose.test.ts` 10 runs of fixed snapshot. Acceptance: zero variance.

---

## Phase 8: User Story 4 — Range-Mode Evaluation (Priority: P2, ships in PR 3)

**Goal**: Backtest whether the score-59 cap on range-mode setups is justified. Lift cap iff backtest shows range-mode T2-eligible win rate ≥45% AND ≥1.3R AND within 5pp of trend-mode T2.

**Independent Test**: `npm run backtest:range-mode -- --days 90 --report ...` produces a markdown report at `specs/001-scoring-pipeline-audit/range-mode-backtest.md`. Decision logic in quickstart.md drives whether code changes follow.

### Backtest Harness (must run before any code change)

- [ ] T074 [US4] Create `tests/backtest/range-mode.test.ts` — extends `src/backtest/engine.ts` with 15M candle support and trigger-5 evaluator per `prompts/ict-agent.md:184-191`. Replays 90 days using `backtest-data/*_15m.json` (loaded via `src/backtest/fetcher.ts:38-41`). Acceptance: harness runs end-to-end on at least 1 instrument.
- [ ] T075 [US4] Implement `npm run backtest:range-mode` script under `scripts/backtest-range-mode.ts`. Outputs side-by-side: cap-on vs cap-off, by tier, win rate, profit factor, total R. Writes markdown report to spec directory. Acceptance: report file generated; format matches the Decision Logic block in quickstart.md.
- [ ] T076 [US4] Run the backtest. Commit the report to `specs/001-scoring-pipeline-audit/range-mode-backtest.md`. Acceptance: report committed; PR description quotes the headline numbers.

### Conditional Implementation (IF FR-012 met)

- [ ] T077 [US4] CONDITIONAL: MODIFY `src/scanner/index.ts:434` — change `Math.min(score, 59)` → `Math.min(score, 100)`. Acceptance: range-mode setups can now reach Tier 2/1.
- [ ] T078 [US4] CONDITIONAL: MODIFY `src/types.ts:435` — update inline comment about Tier mapping to remove "range-mode capped at 59".
- [ ] T079 [US4] CONDITIONAL: MODIFY `src/agents/trading-agent.ts:1173-1178` — relax the `RANGE_MODE_TIER_MISMATCH` gate (currently rejects T1/T2 range proposals) so range setups can clear executor at any tier. Acceptance: integration test with range-mode T2 proposal → executor accepts.
- [ ] T080 [US4] CONDITIONAL: MODIFY `prompts/ict-agent.md:211` — remove "Tier MUST be 3 in the proposal (range-mode never qualifies for Tier 1 or 2)". Replace with "Tier follows from `composite_score` per the standard mapping."
- [ ] T081 [US4] CONDITIONAL: Update existing range-mode tests — `tests/range-mode.test.ts` (any) to allow new tier outcomes.

### Conditional Logging (IF cap kept)

- [ ] T082 [US4] CONDITIONAL: MODIFY `src/scoring/compose.ts` — when `range_cap_applied=true`, also call `recordRejection({layer:'scanner', category:'OTHER' /* WAIT — change OTHER to a new category 'RANGE_CAP_APPLIED' added in T006 amendment */})`. Re-amend `categories.ts` to add `RANGE_CAP_APPLIED` (if not already present). Acceptance: cap-fire visibility in digest.
- [ ] T083 [US4] CONDITIONAL: DOC: close US-4 in `spec.md` with "Evaluated, cap kept. See range-mode-backtest.md for evidence."

---

## Phase 9: User Story 7 — Opt-In Concurrent Trades (Priority: P3, ships in PR 3)

**Goal**: Configurable `max_total_risk_pct` (default 0 = backward-compat single-trade). When >0, accept multiple trades up to budget; reject only when sum-of-risks would exceed.

**Independent Test**: Set budget=2.5%, open T2+T2 (both 1.0%) → both APPROVED. Add T1 (1.5%) → REJECTED with `EXECUTOR_REJECT_RISK_BUDGET_EXCEEDED`. Set budget=0 → reverts to today's behaviour exactly.

### Tests for User Story 7

- [ ] T084 [P] [US7] Test: `tests/risk-budget/policy.test.ts` — budget=2.5%, open 1.0% → second 1.0% APPROVED. Acceptance: assertion explicit.
- [ ] T085 [P] [US7] Test: `tests/risk-budget/policy.test.ts` — budget=2.5%, open 2.0% → 1.5% REJECTED with `EXECUTOR_REJECT_RISK_BUDGET_EXCEEDED`. Acceptance.
- [ ] T086 [P] [US7] Test: `tests/risk-budget/policy.test.ts` — budget=0 + open 1.0% → second proposal REJECTED with `EXECUTOR_REJECT_TRADE_OPEN` (legacy gate). Acceptance: backward-compat verified.
- [ ] T087 [P] [US7] Test: `tests/risk-budget/composes-with-correlation.test.ts` — budget=2.5% allows two trades but analyst CHECK 4 rejects on correlation > 3% → analyst REJECT wins; both gates logged. Acceptance: two rejection rows present.

### Implementation for User Story 7

- [ ] T088 [US7] Create `src/risk-budget/policy.ts` — `getRiskBudgetState() → { open_risk_pct, max_total_risk_pct }`, `wouldExceed(proposedPct, state) → boolean`. Acceptance: T084–T087 pass.
- [ ] T089 [US7] MODIFY `src/agents/trading-agent.ts:1375` (concurrent-trade gate — Codex twin verified this exact line; supersedes the `:1366-1396` range estimate in plan.md). Branch on `max_total_risk_pct`: if 0, keep current `EXECUTOR_REJECT_TRADE_OPEN` behaviour; else apply `wouldExceed()` and reject with `EXECUTOR_REJECT_RISK_BUDGET_EXCEEDED`. Both paths call `recordRejection`. Acceptance: T084–T086 all pass.
- [ ] T090 [US7] MODIFY `prompts/ict-agent.md:113-114` — update any "no hard cap on concurrent trades" mention to reference the new budget gate. Acceptance: prompt accurately describes runtime behaviour.
- [ ] T091 [US7] MODIFY `prompts/analyst-agent.md:54-57` — same as T090 for the analyst-side prompt. Acceptance: analyst doesn't claim concurrent trades are forbidden when budget>0.
- [ ] T092 [US7] DOC: add a 1-paragraph "Opt-in: enable with `UPDATE pm_state SET value='2.5' WHERE key='max_total_risk_pct'`" note to `docs/architecture/SYSTEM-FLOWCHART.md` §4.

---

## 🚢 PR 3 Ship Gate

- [ ] T093 PR3 verification: `npm test` all green; tsc clean.
- [ ] T094 PR3 backtest report: `range-mode-backtest.md` committed; PR description quotes headline numbers; conditional code changes applied (or not) consistent with report decision.
- [ ] T095 PR3 backward-compat: with `max_total_risk_pct=0` (default), `npm test` shows zero behavioural diff for single-trade scenarios (SC-007).

---

## Phase 10: Polish & Cross-Cutting Concerns

- [ ] T096 [P] DOC: update `docs/architecture/SYSTEM-FLOWCHART.md` §3 (analyst tree) — correct "8 checks" → "6 checks" per code reality (`analyst-agent.ts:5`); cross-reference cooldown moved to executor.
- [ ] T097 [P] DOC: update `docs/architecture/SYSTEM-FLOWCHART.md` §4 (executor) — add the new gates (cooldown, risk-budget) and the rejection-log instrumentation; cross-reference categories.ts.
- [ ] T098 [P] MEMORY: update `reference_farad_architecture_doc.md` if section numbers shifted; refresh §10 working backlog.
- [ ] T099 Run full quickstart.md validation against PR 1 + 2 + 3 merged. Acceptance: every recipe in quickstart.md produces the expected output.
- [ ] T100 Performance check: `npm run trade-cycle-once` end-to-end timing ≤ pre-spec baseline + 500ms. The new structure scorer adds CPU work per scan; verify scanner cycle still <8s. Acceptance: timing log shows all cycles under budget.
- [ ] T101 [P] Audit memory: write a project memory `project_farad_scoring_v2_shipped.md` capturing the PR1+2+3 merge dates, post-deploy rejection-rate baseline, SC-001 through SC-009 verification status, and any deferred follow-ups.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: independent; can start immediately.
- **Phase 2 (Foundational)**: depends on Phase 1. **BLOCKS US-1, US-2, US-6**.
- **Phase 3 (US-1)**: depends on Phase 2 (T010 stub used).
- **Phase 4 (US-2)**: depends on Phase 2 (rejection-log primitives). Independent of US-1's scoring change.
- **Phase 5 (US-6)**: depends on Phase 2. Independent of US-1 + US-2.
- **PR 1 Ship Gate (T048-T050)**: depends on Phases 3 + 4 + 5.
- **Phase 6 (US-3)**: depends on Phase 4 (uses recordRejection). Should ship after PR 1 to avoid bundling.
- **Phase 7 (US-5)**: depends on Phase 3 (replaces stub from T015). Independent of US-3.
- **PR 2 Ship Gate (T071-T073)**: depends on Phases 6 + 7.
- **Phase 8 (US-4)**: depends on Phase 7 (structure-aware backtest). Independent of US-7.
- **Phase 9 (US-7)**: depends on Phase 4 (rejection categories). Independent of US-4.
- **PR 3 Ship Gate (T093-T095)**: depends on Phases 8 + 9.
- **Phase 10 (Polish)**: depends on PR 3 merged.

### Within-Phase Parallelism

- **Phase 2** is largely parallel: T006, T007, T008, T009 can all run in parallel after T004 + T005 complete.
- **Phase 3 tests (T011-T014)** can all be written in parallel.
- **Phase 3 implementation**: T015 must complete before T016; T017 + T018 + T019 + T020 + T021 + T022 + T023 + T024 + T025 + T026 are mostly independent (different files).
- **Phase 4 tests + implementation**: T031 (digest) is independent; T032-T037 each modify a different code location (or different lines in same file) and can be done in parallel.
- **Phase 5 (US-6)**: T045, T046, T047 each touch a distinct trading-agent.ts location → parallel-safe.
- **Phase 6 (US-3)**: T055 + T056 in parallel; T057 depends on both.
- **Phase 7 (US-5)**: T060-T065 (tests) all parallel; T066 must complete before T067.

### Critical Path

`T001 → T004 → T005 → T010 → T015 → T016 → T020 → T024 → T048 → T050 (PR1 deploy)`

That's the shortest sequence to PR 1 production.

---

## Parallel Execution Examples

**Phase 2 launched after T004 + T005:**
```
[parallel] T006: REJECTION_CATEGORIES enum
[parallel] T007: recordRejection() helper
[parallel] T008: DB helpers
[parallel] T009: scoring/tiers.ts
[parallel] T010: scoring/components.ts stubs
```

**Phase 3 tests:**
```
[parallel] T011: components.test.ts
[parallel] T012: compose.test.ts
[parallel] T013: historical-replay.test.ts
[serial]   T014: populate fixture (depends on a VPS DB snapshot script)
```

**Phase 4 implementation (after Phase 2 done):**
```
[parallel] T032: scanner kill-zone instrumentation
[parallel] T033: scanner fetch-error instrumentation
[parallel] T034: analyst parse failure
[parallel] T035: analyst no-tool-call
[parallel] T036: analyst API failure + log row
[parallel] T037: executor 8-step gate instrumentation
[parallel] T038: telegram digest sender
[parallel] T039: scheduler cron
```

---

## Implementation Strategy

### MVP (PR 1 only)

1. Phase 1 + Phase 2 → foundation ready
2. Phase 3 + Phase 4 + Phase 5 → US-1, US-2, US-6 in one DB migration window
3. PR 1 ship gate (T048–T050) → deploy at 22:00 UTC Sunday
4. **STOP and VALIDATE** with 7-day digest watch
5. Owner reviews digest output; confirms zero `OTHER` and category sanity

### Incremental Delivery

- PR 1 (US-1 + US-2 + US-6): deterministic scoring + categorised rejections + post-approval visibility (one migration). MVP.
- PR 2 (US-3 + US-5): code-level cooldown + full structure scorer (depends on PR 1). After 7-day shadow.
- PR 3 (US-4 + US-7): range-mode evaluation + opt-in risk budget (depends on PR 2 + backtest report).

### Parallel Team Strategy (if multiple agents/devs)

- Phase 2 work splits cleanly across devs: enum, helpers, DB, scoring scaffold.
- Once PR 1 lands: US-3 (cooldown) and US-5 (structure) can be developed in parallel by different agents — no shared files.
- US-4 and US-7 in PR 3 are file-disjoint and can ship in either order.

---

## Notes

- `[P]` tasks = different files, no incomplete-task dependencies.
- `[Story]` label maps each task to a user story for traceability.
- Each user story must remain independently testable.
- TDD discipline: write test, see it fail, write code, see it pass, refactor.
- Commit after each task or atomic logical group.
- Stop at any ship gate to validate the increment.
- AVOID: cross-story dependencies that break independence; vague tasks; same-file conflicts in parallel work.

## Counts

- **Total tasks:** 101
- **PR 1 (US-1 + US-2 + US-6):** T001–T050 (50 tasks)
- **PR 2 (US-3 + US-5):** T051–T073 (23 tasks)
- **PR 3 (US-4 + US-7):** T074–T095 (22 tasks)
- **Polish:** T096–T101 (6 tasks)
- **Parallelizable (`[P]` marker):** ~40 tasks (~40%)
- **Critical path to PR 1 deploy:** ~10 tasks (T001 → T004 → T005 → T010 → T015 → T016 → T020 → T024 → T048 → T050)

---

## Appendix: Codex Cross-Verification (Condensed 28-task View)

The parallel Codex twin produced a more compressed task list (28 tasks across 3 PRs) by bundling multiple file edits into single tasks. **Both views describe the same work.** Use the granular 101-task view above for agent-actionable subtask dispatch; use the 28-task view below for PR-level ticket tracking or status reporting.

### Codex's PR 1 (12 tasks)

| Codex ID | Maps to (this doc) | Codex's verified file:line |
|---|---|---|
| CX-T001 Migration | T004 | `src/database/index.ts:549` (PRAGMA-guarded ALTER pattern) |
| CX-T002 Migration rerun test | T005 | `tests/database.test.ts:98` |
| CX-T003 Compose determinism test | T012 | `tests/backtest-engine.test.ts:28` (existing test file referenced for harness pattern) |
| CX-T004 Categories + digest test | T027 + T028 | `tests/dump-reject-metrics.test.ts:17` |
| CX-T005 Scoring components/compose | T015 + T016 | `src/scoring/compose.ts` (new) |
| CX-T006 Rejection-log API | T006 + T007 | `src/rejection-log/categories.ts` (new) |
| CX-T007 DB helpers for audit rows | T008 | `src/database/index.ts:1054` |
| CX-T008 Scanner scoring | T018 + T032 + T033 | `src/scanner/index.ts:390` (do NOT touch `:331` kill-zone) |
| CX-T009 Analyst categories | T034 + T035 + T036 | `src/agents/analyst-agent.ts:48, 135, 319` |
| CX-T010 Executor + post-approval logging | T037 + T045 + T046 + T047 | `src/agents/trading-agent.ts:1126, 1135, 1166, 1173, 1189` |
| CX-T011 Telegram digest + dump script | T038 + T040 | `src/notifications/telegram.ts:64`; `scripts/dump-reject-metrics.ts:14, 43` |
| CX-T012 Scheduler + prompts | T039 + T023 | `src/scheduler/index.ts:1021`; `prompts/ict-agent.md:161` |

### Codex's PR 2 (8 tasks)

| Codex ID | Maps to (this doc) | Codex's verified file:line |
|---|---|---|
| CX-T013 Cooldown state test | T051–T054 | `tests/database.test.ts:147` |
| CX-T014 ICT-array test | T060–T065 | `tests/scanner.test.ts:24` |
| CX-T015 Cooldown policy/state | T055 + T056 | `src/cooldown/state.ts` (new) |
| CX-T016 ICT-array scorer | T066 | `src/scoring/ict-array.ts` (new) |
| CX-T017 Executor cooldown gate | T057 | **`src/agents/trading-agent.ts:834`** (corrects plan.md's `:1240-1305` estimate) |
| CX-T018 Scanner + backtest structure | T068 + T069 | `src/scanner/index.ts:348`; **`src/backtest/engine.ts:112`** (corrects plan.md's `:144-146` for the structure call site) |
| CX-T019 Analyst cooldown prompt | T058 + T059 | `prompts/analyst-agent.md:50` (leave `:57` correlated-risk text intact) |
| CX-T020 PR2 regression | T071–T073 | `package.json:8` |

### Codex's PR 3 (8 tasks)

| Codex ID | Maps to (this doc) | Codex's verified file:line |
|---|---|---|
| CX-T021 Range-mode harness test | T074 | `src/backtest/engine.ts:40, 242` |
| CX-T022 Risk-budget test | T084–T087 | `src/agents/trading-agent.ts:1375` |
| CX-T023 Backtest range evaluator | T075 + T076 | `src/backtest/engine.ts:223` |
| CX-T024 Risk-budget policy | T088 | `src/risk-budget/policy.ts` (new) |
| CX-T025 Conditional range-cap code/prompt | T077–T080 | `src/scanner/index.ts:434`; `prompts/ict-agent.md:211` |
| CX-T026 Executor concurrent-trade gate | T089 | **`src/agents/trading-agent.ts:1375`** (corrects plan.md's `:1366-1396` range) |
| CX-T027 Range decision doc | T083 + T076 | `specs/001-scoring-pipeline-audit/range-mode-backtest.md` |
| CX-T028 PR3 integration | T093–T095 | `package.json:8` |

### Codex's headline counts
- **PR1: 12 tasks. PR2: 8 tasks. PR3: 8 tasks. Total: 28.** Parallelizable: 36%.

### Key Codex file:line corrections folded in
1. **Cooldown injection point**: `trading-agent.ts:834` (not `:1240-1305`) — T057 updated.
2. **Risk-budget gate location**: `trading-agent.ts:1375` (not `:1366-1396`) — T089 updated.
3. **Backtest structure scoring**: `backtest/engine.ts:112` (not `:144-146`) — T069 to verify on touch.
4. **Scanner inline-math start**: `scanner/index.ts:390` (not `:380`) — T018 verified.

### How to use this appendix
- **Agent dispatch / parallel subagents**: use the 101-task granular view above. Each task is one file change small enough for an LLM to do without context.
- **Status reporting / PR description**: use Codex's 28-task view here. Easier for a human to scan.
- **Conflicts**: if any task in the 101-view conflicts with a Codex finding, Codex's verified file:line wins (it was grounded in a live grep).

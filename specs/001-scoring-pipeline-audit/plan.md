# Implementation Plan: Scoring Pipeline Audit & Silent-Rejection Fix

**Branch**: `spec/scoring-pipeline-audit` | **Date**: 2026-05-12 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `specs/001-scoring-pipeline-audit/spec.md`

## Summary

Move the bot's scoring math from the Haiku prompt into deterministic TypeScript, codify the 3-loss cooldown in the executor, expose every silent rejection through a single categorised log + daily Telegram digest, then evaluate (via backtest) whether the range-mode score-59 cap and the one-trade-at-a-time rule are still correct. Seven user stories ship in three sequential PRs to keep blast radius contained and let the 820-test suite catch regressions early.

**Technical approach in one line:** introduce `src/scoring/` as a single source of truth that both the live scanner and the backtest engine call, then surface every gate (existing or new) through a `RejectionRecord` table queryable by category — making "why was this skipped?" answerable in seconds.

## Technical Context

**Language/Version**: TypeScript (Node.js 20.20.2 on VPS; yahoo-finance2 v3 wants 22+ but works on 20 with a warning — see [[reference_farad_node_version]])
**Primary Dependencies**: `@anthropic-ai/sdk` (Sonnet 4.6 analyst, Haiku trading agent), `better-sqlite3` (local DB), `node-cron` (scheduler), Capital.com REST client (in-house)
**Storage**: SQLite at `data/trading-bot.db` (VPS authoritative). 6 tables today: `trades`, `analyst_decisions`, `lessons`, `briefs`, `pm_state`, `migration_meta`. This plan adds 2: `score_breakdowns`, `trade_rejections`.
**Testing**: `node --test` against `tests/*.test.ts`. 820/820 passing on master `c86b164`. tsc clean.
**Target Platform**: Linux server (Hetzner CX23 Nuremberg, Ubuntu, pm2 fork process)
**Project Type**: Single-project Node.js trading bot — no frontend, no web service, MCP server is an internal IPC layer not a public API
**Performance Goals**: ~1 cycle/min during kill zones (London Open 7-10 / NY Open 13-16 / London Close 16-17 UTC). Scanner must complete a full 12-instrument scan in <8s (cap budget).
**Constraints**:
- 60s per analyst call (Sonnet, hard timeout)
- 12 iterations max per ICT cycle (cap → CYCLE_TIMED_OUT)
- 0 LLM math allowed in scoring contribution after this spec ships
- Load-bearing 1.30R/1.31R desync NOT touched ([[project_farad_trading_bot]] §"Deferred / explicitly out of scope")
- Kill-zone hard gate NOT touched (owner deferred to next iteration)
**Scale/Scope**: 12 instruments, 5 trading sessions/week (Mon–Fri UTC), ~2-15 trade attempts/day on a normal day, ~$5k demo balance. This bot is owner-only; no multi-user or multi-account scope.

## Constitution Check

*The repo's `.specify/memory/constitution.md` is a placeholder template (not filled in by the owner). No constitution gates apply for this iteration. If a constitution is later ratified, re-evaluate this section before merge. The implicit owner principles applied throughout: deterministic over LLM-judgmental wherever possible; observability before behaviour change; backward-compat default off for any new gate.*

## Project Structure

### Documentation (this feature)

```text
specs/001-scoring-pipeline-audit/
├── spec.md                       # Already shipped (commit 16491da)
├── plan.md                       # THIS FILE
├── research.md                   # Phase 0 — resolves technical unknowns
├── data-model.md                 # Phase 1 — entities, schemas, migrations
├── quickstart.md                 # Phase 1 — verification recipes
├── checklists/
│   └── requirements.md           # Already shipped — gate to /speckit-plan
└── tasks.md                      # Phase 2 — produced by /speckit-tasks (NOT this command)
```

### Source Code (repository root — this is a single-project Node.js layout)

```text
src/
├── scoring/                      # NEW — single source of truth for scoring math
│   ├── components.ts             # NEW — pure functions per score component (base, bias, ict, news, history, spread, range)
│   ├── compose.ts                # NEW — combines components into composite_score + score_breakdown
│   ├── ict-array.ts              # NEW — deterministic OB/FVG/sweep quality scorer (US-5)
│   └── tiers.ts                  # NEW — re-exports TIER_1_THRESHOLD, TIER_2_THRESHOLD, tier3FloorFor (moved from scanner + spread)
├── rejection-log/                # NEW — single API for recording rejections at any layer
│   ├── categories.ts             # NEW — enum of REJECTION_CATEGORIES (machine-parseable)
│   ├── record.ts                 # NEW — recordRejection() and helpers
│   └── digest.ts                 # NEW — daily Telegram digest builder (US-2)
├── cooldown/                     # NEW — code-level loss-streak gate (US-3)
│   ├── state.ts                  # NEW — getCooldownState(), isCooldownActive()
│   └── policy.ts                 # NEW — config: maxConsecutiveLosses, clearAfterHours
├── risk-budget/                  # NEW — concurrent-trade risk cap (US-7)
│   └── policy.ts                 # NEW — getMaxTotalRiskPct(), sumOpenTradesRisk()
├── scanner/index.ts              # MODIFY — call scoring/compose.ts instead of inline math; emit score_breakdown
├── agents/
│   ├── trading-agent.ts          # MODIFY — read deterministic score from proposal; gate via cooldown + risk-budget; new rejection categories
│   ├── analyst-agent.ts          # MODIFY — emit ANALYST_FAIL_CLOSED_* categories distinctly from cause-REJECTs
│   └── spread.ts                 # KEEP — re-exported by scoring/tiers.ts
├── backtest/engine.ts            # MODIFY — use scoring/compose.ts so backtest matches live (Acknowledged limitation §1-26 goes away)
├── database/index.ts             # MODIFY — add insertScoreBreakdown(), insertRejection(), getDailyRejections()
├── notifications/telegram.ts     # MODIFY — add sendDailyRejectionDigest()
└── prompts/
    ├── ict-agent.md              # MODIFY — remove §H scoring math (Base/bias/ICT/news/history/spread). Replace with: "the scanner has scored this for you; do NOT re-derive. Use the supplied composite_score and tier verbatim."
    └── analyst-agent.md          # MODIFY — remove the prompt-only 3-loss-cooldown rule (§52). The cooldown is now a hard executor gate; the analyst's job is the other 5 checks only.

tests/
├── scoring/                      # NEW
│   ├── components.test.ts        # Determinism tests per component (FR-001)
│   ├── compose.test.ts           # End-to-end: same input → same score, 10 iterations
│   └── ict-array.test.ts         # Unit tests for OB/FVG/sweep scoring (US-5)
├── rejection-log/                # NEW
│   ├── categories.test.ts        # Every layer maps to a category (FR-004)
│   └── digest.test.ts            # Forced rejections appear in digest (FR-007, SC-002)
├── cooldown/                     # NEW
│   └── state.test.ts             # 3 losses → COOLDOWN_3_LOSSES_ACTIVE (FR-008, SC-004)
├── risk-budget/                  # NEW
│   └── policy.test.ts            # Open T2 + T2 ok at 2.5%, +T1 rejected (FR-018)
├── backtest/range-mode.test.ts   # NEW — backtest harness extension for range-mode evaluation (US-4)
└── (existing 820 tests must continue passing — see "Backward compat" below)
```

**Structure Decision**: The repo is already a single-project Node.js layout. New code lives in **four new feature folders under `src/`** (`scoring/`, `rejection-log/`, `cooldown/`, `risk-budget/`) — each is self-contained, independently testable, and depends on `database/` and `types.ts` only. This avoids growing `scanner/index.ts` or `trading-agent.ts` further (both already >1000 lines) and creates clean injection points for future changes.

## Ship Order

Three PRs, sequential. Each PR is independently shippable and leaves the bot in a working state.

### PR 1 — Observability foundation (P1: US-2 + US-6)
Ships the rejection-log infrastructure and daily digest. ZERO behaviour change to scoring or trade-taking; only adds visibility. **First because** it's the safety net for everything else — once we can see rejections, we can confidently change scoring math knowing we'll catch regressions in the digest.

> **Codex twin disagrees on ship order.** Codex proposes PR1 = US-1 + US-2 + US-6 in one PR because all three share one DB migration and none touches kill-zone / 1.31R / position-sizing / range-cap. The argument has merit (one migration vs two). The counter-argument (this plan's choice) is that US-1 changes scoring numbers and PR1 should be ZERO behaviour change so any post-deploy anomaly is unambiguously attributable. **Decision deferred to owner — see research.md → "Decision needed: PR ordering".**

**Includes:** `src/rejection-log/` (new), `src/notifications/telegram.ts` (modified), `src/database/index.ts` migration, instrumentation calls added to `scanner/index.ts`, `analyst-agent.ts`, `trading-agent.ts` (every existing reject path gets a `recordRejection({...})` call). Includes the three post-approval gates (TTL, hash, duplicate-instrument lock) so US-6 ships in the same PR.

**Risk:** very low. Pure additions. Existing tests untouched. No prompt changes.

**Ship gate:** `npm test` green (820 + ~25 new tests), force every category in dev to verify digest classification.

### PR 2 — Deterministic scoring + cooldown (P1: US-1 + US-3 + US-5)
Ships the scoring rewrite, the structure-quality scorer, and the code-level cooldown. **Second because** it's the highest-impact behaviour change — it depends on PR 1's digest to safely measure regressions ("did rejection rate explode?") in the first 7 days post-deploy.

**Includes:** `src/scoring/` (new) replacing inline math in `scanner/index.ts` and the prompt math in `prompts/ict-agent.md` §H. `src/cooldown/` (new) called by `trading-agent.ts` before analyst dispatch. `src/backtest/engine.ts` switches to `scoring/compose.ts` so the "Acknowledged limitation: live scoring will be 0-35 points higher" comment block in `backtest/engine.ts:24-28` becomes obsolete and is deleted.

**Risk:** medium. Score numbers may shift by ±5 points per setup vs. today (because Haiku's "moderate" structure judgment becomes a deterministic threshold). PR 1's digest catches any rejection-rate spike; rollback is `git revert` since scoring is its own folder.

**Ship gate:** `npm test` green; SC-001 (zero variance over 10 runs) verified by new test; SC-006 (≥80% historical T1 trades retain T1) verified by replaying last 30 days through new scorer; cooldown integration test green (insert 3 losses → reject); 7-day shadow run on demo: rejection rate must not increase by >10 percentage points (SC-008).

### PR 3 — Conditional behaviour changes (P2/P3: US-4 + US-7)
Ships the range-mode backtest harness AND the opt-in risk-budget gate. **Third because** both are gated on evidence (US-4 on backtest result, US-7 on opt-in config) and have a real chance of being closed as "no change" after evaluation.

**Includes:**
- `tests/backtest/range-mode.test.ts` (new) — extend `backtest/engine.ts` to model range-mode setups using 15M data + spread/ATR floors per the existing `prompts/ict-agent.md` §I trigger 5 spec. Run on `backtest-data/` for the past 90 trading days. Output: a markdown report committed to `specs/001-scoring-pipeline-audit/range-mode-backtest.md`.
- If backtest favours cap removal (FR-012 met): change `scanner/index.ts:434` from `Math.min(score, 59)` to `Math.min(score, 100)` AND remove the prompt restriction at `prompts/ict-agent.md:211` ("Tier MUST be 3"). Else: no code change, document negative result and close US-4.
- `src/risk-budget/` (new) called by `trading-agent.ts` only-one-trade check. Default `max_total_risk_pct=0` preserves current single-trade behaviour (FR-017, SC-007).

**Risk:** US-4 is bounded by backtest evidence. US-7 is opt-in, defaults to current behaviour. Combined risk: low.

**Ship gate:** `npm test` green; if range cap lifted, all existing range-mode tests adjusted; if risk-budget shipped, two integration tests (open T2 + accept T2 at budget=2.5%; reject T1 that exceeds budget).

## Phase Sequence

### Phase 0 — Research (this command)

Resolve open technical questions. Output: `research.md`.

Items researched:
- Where to place `src/scoring/` so both live scanner and backtest engine import cleanly without a circular dep (scanner already imports from `agents/spread.ts`)
- What ICT primitives the bot already computes and which can feed a deterministic structure-quality scorer (US-5)
- The 3-loss cooldown clear condition: 24h elapsed vs. 1 winning trade vs. configurable (FR-009)
- Schema design for `RejectionRecord` (single table or polymorphic per layer)
- Backtest harness extension cost for range-mode (current engine acknowledges it doesn't model trigger 5)

### Phase 1 — Design & Contracts (this command)

**Outputs:**
- `data-model.md` — full entity definitions: ScoreBreakdown, RejectionRecord, CooldownState, RiskBudgetState. Includes SQL schema and migration steps.
- `quickstart.md` — copy-pasteable verification recipes for each user story (force a rejection, replay scoring, trigger cooldown, etc.)
- No `contracts/` directory — this is an internal trading bot, no external API surface for this feature. The MCP server's `place_split_trade` tool already has a stable contract that this spec extends but does not break.

### Phase 2 — Tasks (deferred to /speckit-tasks)

Per spec-kit convention, atomic task generation belongs to `/speckit-tasks`. This plan stops here.

## Per-User-Story Implementation Notes

### US-1 (P1) — Deterministic scoring
- **New code**: `src/scoring/components.ts` — one pure function per component (e.g., `baseComponent() → 25`, `biasClarityComponent(clarity: number) → 0|15|20|25`, `newsComponent(rawScore: number) → number` clamped -15..+10, `spreadComponent(quality: 'tight'|'medium'|'wide') → 0|5`, `historyComponent(winRate: number, sampleSize: number) → 0|+10|-10` activating at sampleSize≥2, `ictArrayComponent(structure: ICTStructure) → 0|15|25|35`).
- **New code**: `src/scoring/compose.ts` — `composeScore(inputs) → { composite_score, score_breakdown, tier }`.
- **Modified**: `scanner/index.ts:380-446` — replace inline math with `composeScore()` call.
- **Modified**: `prompts/ict-agent.md` §H (lines 161-169) — replaced with a single line: "The scanner has scored this candidate. Use the supplied `composite_score` and `tier` verbatim. Do NOT recompute."
- **Modified**: `trading-agent.ts:1166` — keep the existing `expectedTier` check; it now becomes a defensive sanity gate that should never fire (since Haiku no longer scores).
- **Modified**: `backtest/engine.ts:144-146, 24-28` — switch to `composeScore()`. Delete the "0-35 points higher" limitation note.
- **Tests**: `tests/scoring/components.test.ts` (one per component, edge cases: clarity=14 vs 15 boundary, sampleSize=1 vs 2, news=10.5 clamped to 10, etc.); `tests/scoring/compose.test.ts` (10× same input → identical bytes per SC-001).

### US-2 (P1) — Categorised rejections + daily digest
- **New code**: `src/rejection-log/categories.ts` — single TypeScript enum with the 15 categories from spec.md US-2 plus `OTHER` (intentionally NEVER used; presence triggers a test failure to enforce SC-002).
- **New code**: `src/rejection-log/record.ts` — `recordRejection({ instrument, layer, category, subcategory?, reason_text, proposed_score?, proposed_tier?, request_id? })` writes to `trade_rejections` table.
- **New code**: `src/rejection-log/digest.ts` — `buildDailyDigest(date) → DigestPayload`; pairs with new cron at 21:30 UTC.
- **Modified call sites** (every silent reject path gets a `recordRejection` call):
  - `scanner/index.ts:331` (kill zone — even though we're not removing this gate, we should log it so US-2 covers it)
  - `scanner/index.ts:469` (per-instrument fetch error)
  - `analyst-agent.ts:48` (parse failure → ANALYST_FAIL_CLOSED_PARSE)
  - `analyst-agent.ts:135` (no submit_decision → ANALYST_FAIL_CLOSED_NO_TOOL_CALL)
  - `analyst-agent.ts:321` (API failure → ANALYST_FAIL_CLOSED_API_ERROR)
  - `trading-agent.ts:124` (TTL → POST_APPROVAL_TTL_EXPIRED)
  - `trading-agent.ts:1126` (hash → POST_APPROVAL_HASH_MISMATCH)
  - `trading-agent.ts:1135` (duplicate → POST_APPROVAL_DUPLICATE_LOCK)
  - `trading-agent.ts:1160-1190` (each `error` return path — SCORE_BELOW_TIER_MIN, TIER_SCORE_MISMATCH, RANGE_MODE_TIER_MISMATCH, RISK_PCT_TIER_MISMATCH, INVALID_ORDER_SIDE)
- **Modified**: `notifications/telegram.ts` — add `sendDailyRejectionDigest()`.
- **Modified**: scheduler — add `30 21 * * *` cron entry; coexists with existing 21:30 EOD journalist cron (different instrument/responsibility).

### US-3 (P1) — Code-level cooldown
- **New code**: `src/cooldown/state.ts` — `getCooldownState() → { active: boolean, consecutive_losses: number, clears_at: Date | null }`. Reads from `trades` table ordered by closed_at DESC.
- **New code**: `src/cooldown/policy.ts` — config defaults `maxConsecutiveLosses=3`, `clearAfterHours=24` AND `clearOnNextWin=true` (whichever fires first). Configurable via `pm_state` row to allow live tuning without redeploy.
- **Modified**: `trading-agent.ts` — at the top of every trade attempt (BEFORE analyst dispatch), call `isCooldownActive()`. If true, `recordRejection({ category: 'COOLDOWN_3_LOSSES_ACTIVE', ... })` and return.
- **Modified**: `prompts/analyst-agent.md` line ~52 — remove the prompt-only 3-loss rule. Replace with: "Loss-streak cooldown is enforced by the executor before you are called. You do not need to check this."
- **Tests**: `tests/cooldown/state.test.ts` — fixture: insert 3 losses → assert active=true; insert 2 losses + 1 win → assert active=false; insert 3 losses + advance clock 25h → assert active=false.

### US-4 (P2) — Range-mode evaluation
- **PR 3 only**. Build the harness first; the code change depends on results.
- **New tests**: `tests/backtest/range-mode.test.ts` — extends `backtest/engine.ts` with 15M candle support and trigger-5 spec from `prompts/ict-agent.md:184-191`.
- **New report**: `specs/001-scoring-pipeline-audit/range-mode-backtest.md` (committed to repo for transparency).
- **Conditional code change**: `scanner/index.ts:434` AND `prompts/ict-agent.md:211` — only if FR-012 met.

### US-5 (P2) — Structure-quality scorer
- **New code**: `src/scoring/ict-array.ts` — deterministic functions to score:
  - Order block proximity: distance from current price to nearest valid OB on 1H (closer = higher)
  - Fair value gap presence: count of unfilled FVGs on 1H within last 20 candles
  - Liquidity sweep recency: candles since last valid sweep on 1H
  - BOS confirmation count on 15M
  Combined: 0 (no structure) / 15 (one weak signal) / 25 (two aligned signals) / 35 (three+ aligned signals + recent sweep). Numeric thresholds in code, NOT in prompt.
- **Modified**: `scanner/index.ts` — call `ictArrayComponent()` and add to score (this is what makes Tier 1 reachable at the scanner without LLM math).
- **Modified**: `backtest/engine.ts` — also calls `ictArrayComponent()`. The "0-35 points higher live" limitation goes away.

### US-6 (P3) — Surface post-approval drops
- Lands in PR 1 alongside US-2. The three new categories (POST_APPROVAL_TTL_EXPIRED, POST_APPROVAL_HASH_MISMATCH, POST_APPROVAL_DUPLICATE_LOCK) are part of `categories.ts` from day one.

### US-7 (P3) — Opt-in risk budget
- **New code**: `src/risk-budget/policy.ts` — `getRiskBudgetState() → { open_risk_pct, max_total_risk_pct, would_exceed(proposed_pct): boolean }`.
- **Modified**: `trading-agent.ts` only-one-trade check — replaced with: if `max_total_risk_pct === 0` keep current single-trade behaviour (default, BACKWARD COMPAT). Else apply `would_exceed()`.
- **Config**: read `max_total_risk_pct` from `pm_state` row; default 0.
- **Tests**: see PR 3 ship gate.

## Backward Compat & Risk

| Risk | Mitigation |
|---|---|
| **`proposalHash` includes `composite_score`** (`trading-agent.ts:114`) — changing score format invalidates hash, every in-flight approval would mismatch | Migration window: introduce `score_breakdown` as additional field, keep `composite_score` numeric and stable; bump hash version in same commit; ensure no overnight in-flight approvals when deploying (deploy at scheduler quiet window 22:00 UTC after weekly review) |
| **`scripts/dump-reject-metrics.ts:15-38` parses rejection log lines by regex** | Update the script to read from new `trade_rejections` table in the same PR as US-2; keep the legacy regex path for one release as a fallback; remove in PR 3 |
| **Executor enforces range-mode-Tier-3-only at `trading-agent.ts:1173-1178`** | US-4 must modify this gate when (and only when) backtest favours cap removal; otherwise leave it. Document in PR 3 description. |
| **`request_analyst_review` accepts `composite_score` from Haiku at `trading-agent.ts:700-707`, stores at `:945`, executor revalidates at `:1090-1105, 1143-1178`** | All four call sites need to switch from "trust LLM-provided score" to "trust the scanner-computed score; reject if Haiku tries to override". Defensive: keep the validation block as a sanity check (catches Haiku tampering). |
| Existing 820 tests reference `composite_score` math inline | Re-export new `composeScore()` from `scanner/index.ts` to keep public surface stable |
| Backtest engine's "0-35 points higher live" limitation note is referenced in 2 other places | Grep for the exact comment string before deletion; update all references |
| `analyst_log` table is referenced by US-2 — needs new category columns too, not just a new `trade_rejections` table | data-model.md migration adds columns to `analyst_log` AND creates `trade_rejections`; both in one migration step |
| Telegram noise from new daily digest | One scheduled send/day, not per-rejection. Per-rejection alerts stay opt-in via existing `cap-hit Telegram dedup` |
| Cooldown gate duplicates existing analyst CHECK 3 | Analyst CHECK 3 stays as defensive belt; code-level cooldown is the suspenders. Two REJECTs may now be logged for the same trade with different categories — that's fine, they're informational |
| Risk-budget gate composes wrong with analyst CHECK 4 (correlated risk > 3%) | Both gates evaluated independently; whichever rejects first wins. Documented in spec.md Edge Cases |
| Deterministic scorer changes Tier 1 boundary by ±5 points → some setups demote | SC-006 gates merge: ≥80% historical T1 retain T1, OR each demotion is documented |
| Removing prompt scoring instructions breaks Haiku's understanding | The prompt's other guidance (instrument selection, trigger validation, sizing math) is unaffected. Only §H (10 lines) changes. Test by reviewing 5 historical Haiku outputs against the new prompt in dev. |

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| Four new feature folders (`scoring/`, `rejection-log/`, `cooldown/`, `risk-budget/`) added in one feature spec | Each has independent dependency graph and test surface | Cramming into existing `scanner/`, `agents/`, `notifications/` would push files past 1500 lines and entangle PR 1's observability change with PR 2's scoring change, breaking the safe-rollout sequence |
| Two new DB tables in one spec | `score_breakdowns` (US-1) and `trade_rejections` (US-2) serve different layers and join differently | One generic `audit_events` table considered but rejected: `score_breakdowns` is keyed by trade_id (1:1), `trade_rejections` is keyed by request_id (n:1 to attempts) — different shape, different query patterns |
| Range-mode backtest harness extension (US-4) is 200+ LOC for a P2 story | Without it, the cap removal is a guess. The owner's "winning trades I'm losing" hypothesis is testable only if range-mode is testable | Skipping the harness and shipping a config flag was rejected — that just moves the risk to production |

## Acceptance for moving to /speckit-tasks

- [ ] Owner reviews ship order and confirms PR 1 → 2 → 3 sequence (or proposes a re-order)
- [ ] research.md resolves all NEEDS CLARIFICATION (currently 0 marked, but Phase 0 may surface some)
- [ ] data-model.md schema reviewed for SQLite compatibility
- [ ] quickstart.md verification recipes match the spec.md acceptance scenarios

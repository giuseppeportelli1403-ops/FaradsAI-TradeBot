# Feature Specification: Scoring Pipeline Audit & Silent-Rejection Fix

**Feature Branch**: `spec/scoring-pipeline-audit`
**Created**: 2026-05-12
**Status**: Draft
**Input**: User description: "Audit and fix the bot's signal-scoring → threshold → trade-entry pipeline. The owner suspects the system has too many gates and is silently rejecting winning trades. Cross-verified investigation identified 8 ranked culprits. Scope: address culprits #2 through #8. Culprit #1 (kill-zone hard gate) is intentionally OUT OF SCOPE for this iteration."

---

## Context Summary *(non-template — added for grounding)*

The bot scores setups 0–100, maps to Tier 1/2/3 (≥80, ≥60, ≥40-or-45), then runs an Analyst LLM review and an 8-step Executor gate. Independent code review confirmed the following gates that drop trades silently or unreliably:

| # | Culprit | Where | In scope? |
|---|---|---|---|
| 1 | Kill-zone hard gate (instrument returns `[]` outside London/NY sessions) | `scanner/index.ts:331` | **OUT** |
| 2 | Prompt-only score boost — Haiku adds +0/15/25/35 ICT-array points and ±10 history points in natural language | `prompts/ict-agent.md:161` | **IN (P1)** |
| 3 | Range-mode setups hard-capped at score 59 (always Tier 3, always 0.5%) | `scanner/index.ts:432` | **IN (P2)** |
| 4 | 3-loss cooldown lives only in the analyst PROMPT, not in code; LLM may skip it | `prompts/analyst-agent.md:52` | **IN (P1)** |
| 5 | Three post-approval silent drops: TTL/token, hash integrity, duplicate-instrument lock | `trading-agent.ts:124, 1126, 1135` | **IN (P3)** |
| 6 | Score weight is bias-heavy: 25 of 75 scanner points on bias clarity, 0 on structure (only added by prompt later) | `scanner/index.ts:380-440` | **IN (P2)** |
| 7 | Analyst fail-closed REJECTs (API timeout, parse failure) look identical to cause-REJECTs in logs | `analyst-agent.ts:48, 321` | **IN (P1)** |
| 8 | Only one open trade at a time, even if total risk budget allows another | `trading-agent.ts` only-one-trade check | **IN (P3)** |

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Score must be deterministic and reproducible (Priority: P1)

The bot owner replays the same market snapshot through the scoring pipeline twice and gets the same composite_score, the same tier, and the same accept/reject decision. Today, because the ICT-array contribution (+0/+15/+25/+35) is computed by an LLM from a natural-language prompt instruction, two runs against the same data can produce different tiers — a Tier 1 setup can silently become Tier 2, and a Tier 2 can fall below the floor and be discarded entirely.

**Why this priority**: Score determinism is the foundation for every other improvement. Without it, no backtest is reliable, no rejection log is interpretable, and the owner cannot trust that tomorrow's bot will treat today's setup the same way. This single change is responsible for the largest suspected loss of winning trades.

**Independent Test**: Build a regression harness that feeds 100 historical setup snapshots through the scoring pipeline 10 times each. The composite_score must be byte-identical across all 10 runs for every snapshot (zero variance). The accept/reject decision must be byte-identical. The harness is fully self-contained — no broker, no live LLM call required for the score computation itself.

**Acceptance Scenarios**:

1. **Given** a fixed market snapshot with bias_clarity=20, news_score=+5, spread=tight, ICT-array quality=high, and 0 recent losses, **When** the scoring pipeline runs, **Then** the composite_score is the same number on every run and the tier is the same.
2. **Given** the same snapshot with ICT-array quality changed from "high" to "medium", **When** the scoring pipeline runs, **Then** the composite_score decreases by exactly the ICT-array delta defined in the scoring spec (no LLM judgment involved).
3. **Given** a setup that previously scored 81 (Tier 1) under the old prompt-side scorer, **When** re-scored under the deterministic scorer, **Then** the new score is within ±2 points of 81 OR the change is explained by a documented rule difference.

---

### User Story 2 — Every rejection must be visible and categorised (Priority: P1)

The bot owner opens the daily Telegram digest (or a status file) and sees a structured count of every rejection from the previous trading day, broken down by category: `KILL_ZONE_OUT`, `SCORE_BELOW_TIER_FLOOR`, `ANALYST_REJECT_BANNED_PATTERN`, `ANALYST_REJECT_CORRELATION`, `ANALYST_REJECT_NEWS_WINDOW`, `ANALYST_REJECT_COOLDOWN`, `ANALYST_FAIL_CLOSED_API_ERROR`, `ANALYST_FAIL_CLOSED_PARSE`, `EXECUTOR_REJECT_RR_FLOOR`, `EXECUTOR_REJECT_EMERGENCY_STOP`, `EXECUTOR_REJECT_BELOW_MIN_SIZE`, `EXECUTOR_REJECT_TRADE_OPEN`, `POST_APPROVAL_TTL_EXPIRED`, `POST_APPROVAL_HASH_MISMATCH`, `POST_APPROVAL_DUPLICATE_LOCK`. Today, fail-closed REJECTs (API timeout, JSON parse error) and the three post-approval drops are indistinguishable from "rejected for cause" in the logs.

**Why this priority**: Without visibility, the owner cannot know whether the bot made a correct decision or quietly failed. Between 2026-04-29 and 2026-05-04, 0 of 6 analyst calls produced parseable output for 5 days — every trade was silently rejected, undetected. That class of failure must never be invisible again.

**Independent Test**: Force each rejection category to fire (mock the Analyst API to time out; mock a malformed JSON response; submit a setup below the tier floor; etc.) and assert the daily digest contains that category with count ≥ 1. Each category must have a distinct, machine-parseable reason code in the database `analyst_decisions` and `trade_rejections` tables.

**Acceptance Scenarios**:

1. **Given** the Analyst API times out on 1 call during the trading day, **When** the daily digest runs at 21:30 UTC, **Then** the digest shows `ANALYST_FAIL_CLOSED_API_ERROR: 1` as a distinct line item.
2. **Given** an approved trade proposal whose hash mismatches at executor entry, **When** the trade is dropped, **Then** the rejection appears under `POST_APPROVAL_HASH_MISMATCH` with the trade_id and timestamps for both the approval and the mismatch.
3. **Given** the bot rejected 12 trades during the day across 5 categories, **When** the owner reads the digest, **Then** the digest shows exactly 12 rows summed across exactly 5 named categories — no "other" or unclassified bucket.

---

### User Story 3 — 3-loss cooldown must be enforced in code, not prompt (Priority: P1)

The bot owner relies on a "stop trading after 3 losses in a row" safety rule. Today this rule lives only in the analyst's natural-language prompt — there is no code-level enforcement. The Sonnet LLM may apply it, may forget it, or may apply it differently from one call to the next. From the owner's perspective the rule is theoretical.

**Why this priority**: This is both a SAFETY rule (limits drawdown after a bad run) and a SCORING rule (the analyst factors it into APPROVE/REJECT). LLM-only enforcement makes both behaviours unpredictable. Codifying it in TypeScript makes it deterministic and lets it appear in the rejection digest from User Story 2.

**Independent Test**: Insert 3 consecutive losing trades into the database via a test fixture. Submit a fresh trade proposal of any tier and instrument. The proposal MUST be rejected with reason code `COOLDOWN_3_LOSSES_ACTIVE`. After a winning trade or a configurable cooldown period elapses, a new proposal MUST be accepted again.

**Acceptance Scenarios**:

1. **Given** the last 3 closed trades are all losses, **When** the trading agent submits a new proposal, **Then** the executor returns `COOLDOWN_3_LOSSES_ACTIVE` regardless of analyst verdict.
2. **Given** the last 3 closed trades are 2 losses and 1 win, **When** the trading agent submits a new proposal, **Then** the cooldown does not fire.
3. **Given** the cooldown has fired and 24 hours have passed (or one winning trade has closed, whichever the spec defines), **When** a new proposal is submitted, **Then** the cooldown clears and normal flow resumes.

---

### User Story 4 — Range-mode setups should size by quality, not by mode (Priority: P2)

The bot owner has range-mode setups that historically perform as well as trend-mode setups, but today they are hard-capped at score 59 — meaning they are always Tier 3 and always sized at 0.5% risk, even when bias clarity, news, and spread all line up perfectly. A range-mode setup that "deserves" Tier 2 sizing (1.0%) is permanently throttled.

**Why this priority**: Only relevant if range-mode setups actually have edge. The owner should run a backtest first to confirm range-mode win rate is competitive with trend-mode before lifting the cap. P2 because gated behind backtest evidence.

**Independent Test**: Run a backtest comparing range-mode setups under (a) current 59-cap and (b) cap removed. If range-mode setups with raw score ≥60 show win rate within ±5% of trend-mode setups with the same raw score, the cap should be removed for the matching tier. Otherwise the cap stays.

**Acceptance Scenarios**:

1. **Given** the backtest shows range-mode T2-eligible setups (raw score 60-79) win at ≥45% with ≥1.3R average, **When** the cap is removed, **Then** range-mode setups can be proposed at Tier 2 with 1.0% risk.
2. **Given** the cap remains in place after backtest, **When** a range setup with raw score 78 enters the scanner, **Then** the score is still capped to 59 AND a structured log line records "range_cap_applied" with the original score so the owner can monitor missed-edge counts.

---

### User Story 5 — Score weight rebalance: structure should count in the scanner (Priority: P2)

The bot owner observes that today the scanner alone awards up to 65 points (25 base + 25 bias + 10 news + 5 spread) and the remaining 35 points come from the Haiku trading agent's prompt-side ICT-array scoring. This means structure (the actual ICT setup quality) contributes 0% to the scanner-side ranking that decides which instruments get evaluated. A perfectly structured setup with merely "neutral" bias may never be selected for analysis.

**Why this priority**: Solves the same root cause as User Story 1 (LLM-side scoring is fragile), but from the ranking angle. The scanner needs at least a deterministic proxy for structure quality so high-structure setups bubble up to the top of the ranked list.

**Independent Test**: Build a deterministic structure-quality scorer (e.g., distance to nearest order-block, sweep depth, or BOS confirmation count) and integrate it into the scanner. Re-run the scanner against 50 historical days. Verify (a) at least 70% of historically-winning setups now appear in the top 10 ranked instruments, and (b) the scanner score range across all setups widens (better separation between strong and weak).

**Acceptance Scenarios**:

1. **Given** two instruments where Instrument A has bias_clarity=15 and structure_quality=high, and Instrument B has bias_clarity=25 and structure_quality=low, **When** the scanner ranks them, **Then** Instrument A ranks at or above Instrument B.
2. **Given** the rebalanced weights, **When** any historical Tier 1 setup is re-scored, **Then** it remains Tier 1 OR the demotion is explained by a documented rule difference.

---

### User Story 6 — Surface post-approval drops in logs (Priority: P3)

The bot owner wants to see when an APPROVED trade gets dropped between analyst APPROVE and executor entry due to TTL expiry, hash mismatch, or duplicate-instrument lock. Today these three drops are silent.

**Why this priority**: Solved as a side-effect of User Story 2 if executed correctly. P3 because the absolute count is likely small but the diagnostic value is high.

**Independent Test**: Trigger each of the three post-approval drops via test fixtures and assert each appears as a distinct rejection category in the daily digest from User Story 2.

**Acceptance Scenarios**:

1. **Given** an approved trade whose token expires before executor entry, **When** the executor runs, **Then** `POST_APPROVAL_TTL_EXPIRED` is logged with both timestamps and the elapsed delta.
2. **Given** the approval payload hash differs from what the executor receives, **When** the executor runs, **Then** `POST_APPROVAL_HASH_MISMATCH` is logged with both hashes for forensic comparison.

---

### User Story 7 — Optional: allow concurrent trades within a risk budget (Priority: P3)

The bot owner wants to optionally allow more than one open trade at a time, provided the SUM of all open-trade risks does not exceed a configurable `max_total_risk_pct` (e.g., 2.5%). Today the bot rejects every second proposal regardless of how small the first trade was.

**Why this priority**: Real upside but real risk. Requires careful correlation handling (don't allow two open longs on highly correlated instruments to count as independent risk) AND must compose with the analyst's existing CHECK 4 (correlated risk > 3%). P3 because it's a behaviour change, not a fix to a bug.

**Independent Test**: Set `max_total_risk_pct=2.5%`, open one Tier 2 trade (1.0% risk). Submit a second Tier 2 proposal. Expected: second trade APPROVED (1.0% + 1.0% = 2.0% < 2.5%). Submit a third Tier 1 proposal (1.5% risk). Expected: third trade REJECTED (2.0% + 1.5% = 3.5% > 2.5%) with reason `RISK_BUDGET_EXCEEDED`.

**Acceptance Scenarios**:

1. **Given** `max_total_risk_pct=2.5%` and one open T2 trade, **When** a second T2 proposal arrives, **Then** it is APPROVED and placed.
2. **Given** the same configuration with a T2 + T1 already open (2.5% deployed), **When** a third proposal arrives, **Then** it is REJECTED with `RISK_BUDGET_EXCEEDED`.
3. **Given** `max_total_risk_pct=0` (default — backward compatible), **When** any proposal arrives while a trade is open, **Then** behaviour is identical to today (reject second trade).

---

### Edge Cases

- What happens when the deterministic structure scorer (US-5) cannot fetch enough historical candles to compute structure quality? — Fail-OPEN at neutral structure score (0 contribution), logged as `STRUCTURE_INSUFFICIENT_DATA`, do not silently drop the instrument.
- What happens when the cooldown rule (US-3) is enforced but the Analyst LLM independently APPROVES the trade? — Code-level cooldown wins. Analyst verdict is logged for forensic comparison but does not override.
- What happens when concurrent trades (US-7) push correlated exposure over the analyst's existing 3% CHECK 4 limit? — Analyst CHECK 4 wins. The risk-budget gate is an additional layer, not a replacement.
- What happens when the rejection digest (US-2) becomes too large (e.g., 200 rejections on a noisy day)? — Digest summarises by category counts; full per-rejection log remains in the database, queryable on demand.
- What happens when a backtest (US-4) shows range-mode underperforms? — Cap stays. Spec records the negative result and closes US-4 as "evaluated, no change".

---

## Requirements *(mandatory)*

### Functional Requirements

**Score determinism (US-1):**
- **FR-001**: System MUST compute the composite_score deterministically — same inputs produce the same score on every run, with zero LLM-side scoring contribution.
- **FR-002**: System MUST move the ICT-array score component (currently +0/+15/+25/+35) and the trade-history adjustment (currently ±10) from the trading agent's prompt into TypeScript code in the scanner or a shared scoring module.
- **FR-003**: System MUST emit a `score_breakdown` object alongside every composite_score, listing each component name and its contribution (e.g., `{ base: 25, bias_clarity: 20, news: -5, spread: 5, ict_array: 25, history: 0 }`).

**Rejection visibility (US-2, US-6):**
- **FR-004**: System MUST tag every trade rejection (scanner-side, analyst-side, executor-side, post-approval-side) with a machine-parseable category code from a single enumerated list.
- **FR-005**: System MUST distinguish fail-closed REJECTs (API timeout, parse failure, schema validation failure) from cause-REJECTs (analyst said REJECT for a stated reason) using separate category codes.
- **FR-006**: System MUST persist rejection records to the database with `category`, `subcategory`, `reason_text`, `instrument`, `proposed_score`, `proposed_tier`, `timestamp`, and `request_id` (for joining to upstream logs).
- **FR-007**: System MUST emit a daily Telegram digest at 21:30 UTC summarising rejection counts per category for the previous 24 hours.

**Cooldown enforcement (US-3):**
- **FR-008**: System MUST enforce a "stop after N consecutive losses" rule in TypeScript code at the executor layer (default N=3), independent of analyst verdict.
- **FR-009**: System MUST expose the cooldown threshold N and the cooldown clear condition (winning trade OR M hours elapsed, default M=24) as configuration values.
- **FR-010**: System MUST emit `COOLDOWN_N_LOSSES_ACTIVE` as a rejection category when the cooldown gate fires.

**Range-mode (US-4):**
- **FR-011**: System MUST run a backtest comparing range-mode setups with and without the score-59 cap, using ≥50 historical trading days.
- **FR-012**: System MUST keep the cap if backtest evidence does not show range-mode T2/T1 candidates win at ≥ trend-mode T2/T1 win rate minus 5 percentage points.
- **FR-013**: System MUST emit `range_cap_applied` log entries when the cap is hit so the owner can monitor missed-edge frequency.

**Score weight rebalance (US-5):**
- **FR-014**: System MUST add a deterministic structure-quality component to the scanner score (using ICT primitives like nearest order-block distance, sweep depth, or BOS count).
- **FR-015**: System MUST rebalance scanner score weights so structure ≥ 25% of total scanner contribution.
- **FR-016**: System MUST validate the rebalance via re-scoring historical Tier 1 trades and confirming ≥80% remain Tier 1 (or document each demotion).

**Concurrent trades (US-7):**
- **FR-017**: System MUST expose a `max_total_risk_pct` configuration value, default 0 (preserves current single-trade behaviour).
- **FR-018**: System MUST sum the deployed risk percent of all open trades and reject any new proposal where (sum + proposed risk) > `max_total_risk_pct`.
- **FR-019**: System MUST compose with — not replace — the analyst CHECK 4 correlated-risk limit.

### Key Entities

- **ScoreBreakdown**: Per-instrument record of every score component and its numeric contribution, attached to the RankedInstrument and persisted with the trade record. Enables score determinism audits and post-mortem score reconstruction.
- **RejectionRecord**: Database row capturing every rejection across all four layers (scanner, analyst, executor, post-approval). Fields: id, instrument, timestamp, layer, category, subcategory, reason_text, proposed_score, proposed_tier, request_id.
- **CooldownState**: Bot-wide state tracking consecutive_losses_count, last_cooldown_triggered_at, cooldown_clears_at. Read by executor on every trade attempt.
- **RiskBudgetState**: Per-attempt computation: open_trades_total_risk_pct, proposed_trade_risk_pct, max_total_risk_pct. Used by FR-018 gate.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Composite_score variance across 10 runs of any given snapshot is exactly 0 (US-1, FR-001).
- **SC-002**: 100% of rejections in the daily digest fall into a named category (no "other" or unclassified bucket) for 7 consecutive trading days (US-2, FR-004).
- **SC-003**: At least 1 fail-closed REJECT and at least 1 cause-REJECT are distinguishable in the digest within the first week of production rollout (US-2, FR-005).
- **SC-004**: Cooldown gate fires correctly in 100% of test cases where 3 consecutive losses precede a new proposal (US-3, FR-008).
- **SC-005**: Range-mode backtest result is published as a documented decision (US-4, FR-011) — either "cap removed" or "cap kept, evidence:".
- **SC-006**: After score weight rebalance, ≥80% of historical Tier 1 trades retain Tier 1 status (or each demotion has a documented rule attribution) (US-5, FR-016).
- **SC-007**: Risk-budget gate (US-7) is opt-in: setting `max_total_risk_pct=0` preserves current behaviour with zero regressions in existing tests (FR-017).
- **SC-008**: Total bot rejection rate (rejections / total proposals) tracked weekly does not increase by more than 10 percentage points after rollout — confirming the changes do not add NEW silent gates while exposing existing ones.
- **SC-009**: Owner can answer the question "why was setup X rejected on day Y?" in under 60 seconds by querying the digest or RejectionRecord table.

## Assumptions

- Range-mode setups currently exist in the strategy and represent enough historical trade volume to support a meaningful backtest (≥30 closed range-mode trades). If not, US-4 closes as "insufficient data, defer".
- The structure-quality scorer (US-5) can be built deterministically from price action primitives the bot already computes (order-block detection, sweep detection, BOS detection). If not, US-5 narrows to "weight rebalance only" and structure remains an LLM-side input.
- Existing tests cover the analyst and executor APIs sufficiently that adding a code-level cooldown (US-3) and risk-budget gate (US-7) can be TDD'd without rewriting test infrastructure (820 tests reported on master c86b164 as of 2026-05-10).
- Telegram is the right surface for the daily digest. If the owner prefers a Markdown file in the repo or a Grafana panel instead, FR-007 adjusts but FR-006 (database persistence) is unchanged.
- The kill-zone hard gate (culprit #1) remains in place for this iteration — no scanner runs are added outside London/NY sessions. A separate spec will revisit it after the deterministic scoring foundation is in place.
- The 1.30R-vs-1.31R prompt/code desync is intentional defensive margin and is NOT touched by this spec.

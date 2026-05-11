# Phase 0 — Research

**Feature:** Scoring Pipeline Audit & Silent-Rejection Fix
**Spec:** [spec.md](./spec.md) | **Plan:** [plan.md](./plan.md)
**Date:** 2026-05-12

This document resolves the technical unknowns surfaced by the spec and plan, and records key decisions with their rationale and rejected alternatives. A parallel codex:rescue twin verified file:line citations and surfaced 5 hidden coupling risks now folded into plan.md.

---

## R-1 — Where to place `src/scoring/` to avoid circular deps

**Decision:** New folder `src/scoring/` with no dependency on `src/scanner/` or `src/agents/`. Both consume from `src/scoring/`.

**Rationale:** `scanner/index.ts` already imports `tier3FloorFor` from `agents/spread.ts`. If scoring lived inside `scanner/`, the backtest engine's existing import of `detectBias` from `../scanner/index.js` (`backtest/engine.ts:45`) would pull in the entire scanner module to get scoring math, increasing test isolation cost. Putting scoring in its own folder keeps it dependency-free.

**Concrete dep graph:**
```
scoring/         ← depends only on types.ts
  ↑
scanner/         ← imports scoring + spread (existing)
agents/          ← imports scoring + spread (existing)
backtest/        ← imports scoring + scanner.detectBias (existing)
```

**Alternatives considered:**
- *Inline in scanner/index.ts as today, just refactored:* rejected — doesn't solve the backtest-engine duplication.
- *Inside agents/ alongside spread.ts:* rejected — agents already imports from scanner, would create a new cycle.

---

## R-2 — Which ICT primitives can feed a deterministic structure scorer (US-5)?

**Decision:** Use four primitives the bot can compute from the candle arrays it already fetches, without new data sources:

1. **Order block proximity** — distance from current price to the nearest valid 1H OB, normalised by ATR. Closer = higher score.
2. **Fair value gap presence** — count of unfilled FVGs on 1H within last 20 candles.
3. **Liquidity sweep recency** — candles since last valid sweep (wick > 1× spread beyond prior swing) on 1H.
4. **15M BOS confirmation count** — number of BOS within last 6 candles in bias direction.

Combined into 0/15/25/35 via threshold-based scoring (e.g., 0 if all four signals weak, 15 if exactly one strong, 25 if two aligned, 35 if three+ aligned with recent sweep).

**Rationale:** Today the bot already detects bias on 1H (`detectBias` in `scanner/index.ts`) and the Haiku prompt §I describes OB/FVG/sweep/BOS triggers using exact numeric criteria. Those numeric criteria are deterministic — they're just being evaluated by the LLM today. Lifting them into TypeScript is a refactor, not a new feature.

**Alternatives considered:**
- *Keep ICT-array scoring in the prompt but force structured-output JSON:* rejected — Sonnet/Haiku are still doing the math; FR-001 (zero variance) would not pass.
- *Score 0/35 binary (no middle ground):* rejected — loses the calibration the current 0/15/25/35 scale has historically used.
- *Train a small ML model:* rejected — data scarcity (~70 trades total in the demo run) and would break determinism the moment retrained.

---

## R-3 — Cooldown clear condition (FR-009)

**Decision:** Cooldown clears on EITHER (a) the next winning trade closes OR (b) `clearAfterHours` (default 24h) elapses since the third loss closed — whichever fires first. Both configurable via `pm_state` row.

**Rationale:** A pure time-based cooldown can be too restrictive (a winning trade is the strongest evidence the streak is over). A pure win-based cooldown can be too lenient (no trades for 3 days after the streak still keeps cooldown active, blocking when conditions have clearly changed). OR-of-both matches how a human risk manager would think.

**Alternatives considered:**
- *24h time-only:* rejected — blocks valid setups when intraday recovery is obvious.
- *Win-only:* rejected — can leave cooldown active for days during quiet markets.
- *Configurable N-loss threshold (not hardcoded 3):* accepted as part of the same config row (`maxConsecutiveLosses`, default 3).

---

## R-4 — Single `trade_rejections` table vs. polymorphic per-layer

**Decision:** Single `trade_rejections` table with `layer` column. Plus minimal column additions to `analyst_log` (existing table) so the analyst's verdict and category live together where they already are.

**Rationale:** Codex's twin caught that `analyst_log` already exists and stores analyst decisions. Forking analyst rejections into a NEW table would create a join every time the digest runs. Better: add `category`, `is_fail_closed`, `subcategory` columns to the existing `analyst_log` AND create `trade_rejections` for the OTHER three layers (scanner, executor, post-approval).

**Schema sketch (full version in data-model.md):**
- `trade_rejections (id, ts, instrument, layer, category, subcategory, reason_text, proposed_score, proposed_tier, request_id)`
- `ALTER TABLE analyst_log ADD COLUMN category TEXT, ADD COLUMN is_fail_closed INTEGER, ADD COLUMN subcategory TEXT`

The daily digest builder UNIONs both tables.

**Alternatives considered:**
- *Single audit_events table for everything:* rejected — `analyst_log` already has columns the analyst flow depends on; replacing it is a bigger blast radius than augmenting it.
- *One table per layer (scanner_rejections, executor_rejections, post_approval_rejections):* rejected — all queries would need 3-way UNIONs, no benefit.

---

## R-5 — Backtest harness extension cost for range-mode (US-4)

**Decision:** Implement range-mode in `backtest/engine.ts` using the existing 15M support pattern + ATR computation already in the engine, plus an inline trigger-5 evaluator that mirrors `prompts/ict-agent.md:184-191`. Estimated 200-300 LOC. Output report committed to `specs/001-scoring-pipeline-audit/range-mode-backtest.md`.

**Rationale:** The engine's own header comment (`backtest/engine.ts:40-43`) explicitly calls out range-mode as not modeled because trigger-5 needs 15M data + spread/ATR floors. The 15M data IS available in `backtest-data/*_15m.json` (loaded via `src/backtest/fetcher.ts:38-41` per Codex's note). ATR can be computed inline. Spread floors come from the same `tier3FloorFor`/`isTightSpreadTicker` carve-out.

**Backtest design:**
- Replay last 90 trading days
- For each 1H candle in that window: detect neutral bias → check prior 8 candles' range width vs current 15M ATR → if range qualifies, look forward 2× 15M candles for sweep → look forward 2 more for reversal → if all qualify, simulate entry at reversal close, SL beyond range extreme, TP1 at mid-range, TP2 at opposite extreme
- Tally win rate, average R, profit factor by tier (current cap = T3 only; experimental no-cap = T1/T2/T3)
- Report side-by-side comparison

**Acceptance:** US-4 ships if range-mode T2-eligible (raw score 60-79) wins at ≥45% with ≥1.3R average AND within 5pp of trend-mode T2 win rate. Else cap stays.

**Alternatives considered:**
- *Skip US-4 entirely:* rejected — owner explicitly listed it as in-scope.
- *Backtest in a separate one-off script:* rejected — extending the engine means future cap changes are repeatable, not a one-shot.

---

## R-6 — Decision needed: PR ordering (Claude vs Codex disagreement)

This is the only divergence between this plan and the parallel Codex twin's independent plan.

**This plan proposes (PR-by-PR):**
- PR 1 = US-2 + US-6 (observability only, ZERO behaviour change)
- PR 2 = US-1 + US-3 + US-5 (deterministic scoring + cooldown + structure)
- PR 3 = US-4 + US-7 (conditional behaviour changes)

**Codex twin proposes:**
- PR 1 = US-1 + US-2 + US-6 (one DB migration, no kill-zone / 1.31R / sizing / range-cap touched)
- PR 2 = US-3 + US-5 (cooldown + structure)
- PR 3 = US-4 + US-7

**Trade-off:**
- **This plan** is safer for diagnosing post-deploy anomalies. If rejection rate spikes in week-2 of PR 1, we know it's an observability artifact, not a scoring change. PR 2's scoring change can be reverted in isolation.
- **Codex's plan** ships faster (one migration window instead of two) and the share-one-migration argument is real for SQLite — every migration is a small risk window.

**Recommendation:** Owner picks. If the bot's demo P&L is currently stable and the owner wants speed, Codex's plan is fine. If the owner wants belt-and-suspenders observability before any scoring change, this plan's order wins. Default to this plan unless owner overrides.

**No alternatives considered** — both options are valid; this is a prioritisation call.

---

## R-7 — Prompt rewrites: scope and rollback path

**Decision:** Three prompt edits; each isolated to a small block; each reversible by a single commit revert.

| File | Lines | Change | Test before merge |
|---|---|---|---|
| `prompts/ict-agent.md` | 161-169 (§H) | Replace 9 lines of scoring rubric with 1 line: "Use the scanner-supplied composite_score and tier verbatim." | Manual replay: feed Haiku the same context with old vs new prompt; verify it stops emitting score numbers and uses the supplied ones. |
| `prompts/ict-agent.md` | 211 | Remove "Tier MUST be 3 in the proposal (range-mode never qualifies for Tier 1 or 2)" — ONLY if US-4 backtest favours lift | Conditional on US-4 |
| `prompts/analyst-agent.md` | 50-52 | Remove the prompt-only 3-loss cooldown rule. Add: "The executor enforces loss-streak cooldown before you are called. Skip CHECK 3 cooldown reasoning." | Run the analyst on a 3-loss fixture and verify it no longer cites cooldown as a reason. |

**Rationale:** Prompt edits are dangerous because Sonnet/Haiku may have learned cross-references to phrases we delete. Keeping each edit small and focused minimises that risk. The full prompts stay otherwise unchanged.

**Hidden coupling Codex flagged:** `prompts/analyst-agent.md:54-57` mentions "no hard cap" near the cooldown rule — when removing the cooldown, the surrounding paragraph may need a 1-sentence smooth-out so the analyst doesn't see broken context.

---

## R-8 — Test fixture strategy

**Decision:** Three new fixture files in `tests/fixtures/scoring/`:
1. `historical-snapshots.json` — 50 frozen scanner inputs (1H candles + bias + news + spread) from past production days, with their original scanner output. Used for SC-006 (≥80% T1 retention).
2. `cooldown-scenarios.json` — 10 trade-history fixtures (3 losses, 2 losses + win, 3 losses + 25h elapsed, etc.) for FR-008 testing.
3. `rejection-categories.json` — one minimal payload per category, used to assert every category is reachable in tests (SC-002 enforcement).

**Rationale:** The existing tests use inline fixtures, which is fine for unit tests but doesn't scale to the historical-replay regression checks. Frozen snapshots let SC-001 (zero variance) AND SC-006 (T1 retention) run as deterministic CI.

**Storage:** JSON, committed. Total estimated size ~200KB.

---

## Open NEEDS CLARIFICATION

None. All technical questions are resolved with documented decisions. The single open item is R-6 (PR ordering), which is a prioritisation call for the owner, not a technical unknown.

---

## Summary of Codex divergences folded in

| Codex finding | This plan's response |
|---|---|
| `proposalHash` at `trading-agent.ts:114` includes `composite_score` | Added to plan.md → Backward Compat table; data-model.md will spec the migration window |
| `analyst_log` already exists; needs columns added (not just new table) | R-4 above; data-model.md migration spec |
| `scripts/dump-reject-metrics.ts:15-38` parses rejection logs by regex | Added to plan.md → Backward Compat table; same-PR update with one-release fallback |
| Executor's range-T1/T2 hard reject at `trading-agent.ts:1173-1178` | Added to plan.md → Backward Compat table; US-4 PR 3 task |
| `request_analyst_review` accepts Haiku-supplied score at `:700-707, :945, :1090-1105, :1143-1178` | All four call sites listed in plan.md → US-1 implementation notes |
| Codex's preferred ship order (PR1 = US-1+US-2+US-6) | R-6 above — owner-decision deferral |

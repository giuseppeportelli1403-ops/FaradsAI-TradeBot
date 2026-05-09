# 3-Leg Legacy Code Removal — Phase 1 (code, types, prompts, tests)

**Date:** 2026-05-08
**Author:** Claude (with Giuseppe / BetterOps AI)
**Status:** Drafted 2026-05-08 — awaiting user spec review then handoff to writing-plans.

## TL;DR

Phase 1 of a 2-phase removal of the legacy 3-leg trade ladder from the Farad bot. Phase 2 (deferred) drops the database columns and `tp2_hit` status. Phase 1 stops every code path that reads or writes 3-leg fields, removes 3-leg references from the analyst/reflection/review prompts, deletes 3-leg-specific tests, and marks the affected TypeScript fields `@deprecated`. Schema is untouched in Phase 1, so a Phase 1 rollback is a single `git revert` with zero data risk.

The user's chosen rollout is **phased: code first, schema later** (over big-bang single PR and schema-first variants) to keep migration timing decoupled from the code change.

## Locked decisions

- **Q1 — Schema strategy:** hard delete in Phase 2 (drop columns, drop `tp2_hit` from CHECK, drop `'C'` from `sl_tp_orders.leg`). Phase 1 leaves schema fully intact.
- **Q2 — Rollout:** phased, code-first. Phase 1 ships now (this spec). Phase 2 ships separately when the bot has been live on Phase 1 long enough to confirm no `position_c_id`-bearing rows are produced.
- **Q3 — `lesson-leg-c.test.ts`:** delete entirely. Whole file is 3-leg-specific.
- **Q4 — `mcp-server/tools/trading-tools.ts:351` (live 3-leg placement):** remove the entire `if (size_c && tp3)` branch in Phase 1, plus add a runtime check that **throws** if any caller passes `size_c` or `tp3` after the change.

## Why now

Phase 2 (2026-05-07) collapsed the ICT strategy from a 3-leg ladder (33/33/33 across TP1/TP2/TP3) to a 2-leg ladder (70/30 across TP1/TP2). All trades opened post-Phase-2 have `position_c_id = NULL`, `tp3 = NULL`, `size_c = NULL`. The 3-leg code paths are dead for new trades — but they remain in the codebase as load-bearing scaffolding behind every test, type, prompt, and database query.

Two specific risks justify a near-term cleanup rather than indefinite deferral:

1. **`mcp-server/tools/trading-tools.ts:351` is live placement code, not dead.** It will still create a Leg C if any caller (LLM, manual MCP request) passes `size_c + tp3`. The 2-leg analyst prompt no longer asks for those, but a stale prompt revision or a hand-rolled MCP call could re-introduce a 3-leg trade by accident.
2. **`prompts/analyst-agent.md` lines 43/60/106 still contain 3-leg sizing rules** (Codex audit, 2026-05-08). The LLM occasionally prints reasoning text that references "Leg C / TP3" and could in principle produce a 3-leg proposal that flows through the still-live MCP placement path above.

A single-phase code cleanup closes both risks immediately. The schema cleanup that completes the removal can wait for Phase 2 without affecting safety.

## Live in-flight constraint

Phase 1 implementation begins with a database query:

```sql
SELECT count(*) FROM trades
WHERE position_c_id IS NOT NULL
  AND status NOT IN ('complete', 'sl_hit', 'closed_early');
```

Expected result: 0. If non-zero, **abort and re-design** — the assumption "no in-flight 3-leg trades" is wrong and Phase 1 needs a runtime guard for the affected positions. Project memory as of 2026-05-08 12:10 UTC says the result is 0 (the SILVER trade `trade-a8a0eb21` closed at 12:20 UTC on 2026-05-07 with status `complete`).

## Code surface (Phase 1 changes)

### `src/scheduler/index.ts`

- **Line ~598 — `handleTp3Hit`:** delete the entire function. No call sites remain after the monitor changes below.
- **Line ~543 — `handleTp1Hit` Leg C branch:** delete the `if (trade.position_c_id) await moveLegSlToBe('C', trade.position_c_id);` line. Leg B path stays unchanged.
- **Line ~580-582 — `handleTp2Hit` 3-leg branch:** delete the `if (!trade.position_c_id) { ... return; }` early-return wrapper and the trailing 3-leg branch that sets `tp2_hit` + trails Leg C SL to TP1. The function body becomes unconditionally what was previously the 2-leg path: deactivate Leg B order, set status `'complete'`, fire `alertTp2Hit`. Note: this changes the function from a state-machine intermediate to a terminal handler.
- **Line ~623 — `handleSlOnLeg`:** narrow the `leg` parameter type from `'A' | 'B' | 'C'` to `'A' | 'B'`. Drop any branches that handle `leg === 'C'`.
- **Line ~644 — `handleSlOnLeg` terminal-status logic:** remove the `|| trade.status === 'tp2_hit'` clause from the `tp1_hit ||` check. After Phase 1, `tp2_hit` is no longer reachable as a state (the 3-leg branch that set it is gone), so the check simplifies to just `trade.status === 'tp1_hit'`.
- **Line ~334 — `monitorSplitPositions`:** remove the `legCOrders` array construction.
- **Line ~433-454 — `monitorSplitPositions` Pass 3:** delete the entire Leg C iteration block.

### `src/mcp-server/tools/trading-tools.ts`

- **Line ~301 — legacy tool schema:** drop `size_c?` and `tp3?` fields from the input schema. The schema now accepts only the 2-leg shape.
- **Line ~351 — live 3-leg placement branch:** remove the `if (size_c && tp3) { ... }` block entirely. Replace with a defensive guard at the top of the tool's executor:
  ```ts
  if (args.size_c != null || args.tp3 != null) {
    throw new Error(
      'place_split_trade: 3-leg placement is no longer supported. ' +
      'size_c/tp3 must be null/undefined. See docs/superpowers/specs/2026-05-08-3-leg-removal-phase-1-design.md.',
    );
  }
  ```
  This converts a silent bug (wrong code path) into a loud one. The Phase 2 schema cleanup will eventually drop the schema fields entirely; Phase 1 is conservative.

### `src/agents/trading-agent.ts`

- **9 sites where `tp3: null` / `size_c: null` are explicitly set on DB writes / proposals (per Codex inventory: lines 67, 295, 633, 897, 901, 1059, 1063, 1497-1504):** remove the explicit-null lines. The DB columns default to NULL when omitted.
- **`proposalHash` (line ~67), `validateOrderSide` (line ~295):** drop the IGNORED tp3/size_c handling. These have been noops since Phase 2; clean removal.
- **`computeServerSizing` (line ~338):** no change — already 2-leg.
- **Analyst tool schema (line ~633):** already reduced to 2 legs in Phase 2; no change.
- **`place_split_trade` executor (line ~1411):** the 3-leg placement code was removed in Phase 2; verify no resurrection.

### `src/agents/analyst-agent.ts`

- **Line 155 — `TradeProposal.tp3`:** remove the field from the type entirely (this is the LLM-facing proposal type, not a DB-backed type).
- **Line 158 — `TradeProposal.size_c`:** same — remove.

### `src/agents/load-prompt.ts`

- **Line ~88 — override text:** Codex says the TP3 floors are already removed; verify and proceed. No change expected.

### `src/agents/reflection-agent.ts`

- **Line ~32 — stale "legacy 2-leg" comment:** remove (the term "legacy 2-leg" is now misleading since 2-leg is the only mode).
- **Line ~51, 54 — tool schema:** drop `position_c_outcome`, `pnl_c_r` from the reflection tool schema.
- **Line ~173, 176 — extractor:** drop the C-outcome and `pnl_c_r` coercion.
- **Line ~218 — prompt:** drop the "unless legacy 2-leg" branch from the prompt template.

### `src/types.ts`

- **Line ~238 — `TradeStatus`:** keep `'tp2_hit'` in the union. Phase 2 will remove it. Add a JSDoc comment marking it `@deprecated since 2026-05-08 — no new code reaches this status. Phase 2 will drop from CHECK constraint and union.`
- **Line ~269 — `TradeRecord.tp3`:** keep nullable. Add `@deprecated` JSDoc with the same Phase 2 reference.
- **Line ~272 — `TradeRecord.position_c_id`:** same.
- **Line ~275 — `TradeRecord.size_c`:** same.
- **Line ~279 — `TradeRecord.pnl_c`:** same.
- **Line ~309 — `Lesson.position_c_outcome`:** same.
- **Line ~312 — `Lesson.pnl_c_r`:** same.

### `src/database/index.ts`

- **NO CHANGES in Phase 1.** Schema columns stay. The `'tp2_hit'` status in the CHECK constraint stays. The open-trade SQL at line ~539 stays (defensively treats `tp2_hit` as active even though no new code produces it). All untouched until Phase 2.

### Prompts

- **`prompts/analyst-agent.md:43`:** remove the stale 3-leg sizing divisor (Codex flagged this as TANGLED — line uses 3-leg division logic that's no longer correct).
- **`prompts/analyst-agent.md:60`:** remove the stale `size_c` comparison and three-leg comparison.
- **`prompts/analyst-agent.md:106`:** remove the stale 3-leg risk rule.
- **`prompts/reflection-agent.md:26,28`:** remove the C outcome request and `pnl_c_r` request lines.
- **`prompts/review-agent.md:20`:** remove Leg C / TP3 reporting from the weekly review template.
- **`prompts/ict-agent.md`:** Codex confirmed it's already clean post-Phase-2 (lines 21, 261). No change.

### Tests

- **`tests/scheduler.test.ts`:** delete the 3 tests at ~lines 872 (3-leg TP1 moves B+C to BE), 916 (3-leg TP2 moves C SL to TP1 + leaves `tp2_hit`), 956 (3-leg TP3 completes + alerts).
- **`tests/scheduler-tp1-be-offset.test.ts`:** delete the 3-leg long test at ~line 118.
- **`tests/proposal-hash.test.ts`:** delete the line ~74 assertion that `tp3/size_c` do not affect hash. The fields are gone from the proposal type in `analyst-agent.ts`.
- **`tests/rr-validation.test.ts`:** remove the line ~11 "TP3 removed" comment if it's now stale.
- **`tests/lesson-leg-c.test.ts`:** delete the entire file.
- **`tests/reflection.test.ts:95`:** delete the test that asserts nullable C reflection fields.
- **`tests/trading-tools.test.ts:150`:** update the legacy fixture to no longer include C deal/TP3/size_c. Specifically, replace any 3-leg fixture data with 2-leg shape.
- **`tests/backtest-engine.test.ts:4`:** update the stale comment that references TP3 only (Codex flagged as cosmetic).

### New tests (Phase 1 acceptance)

- **`tests/three-leg-removal.test.ts` (new):** a small "negative-coverage" file asserting:
  - **MCP runtime guard:** `place_split_trade` MCP tool throws an error matching `/3-leg placement is no longer supported/` when called with `size_c != null` OR `tp3 != null`.
  - **Type contract:** importing `handleTp3Hit` from `'../src/scheduler/index.js'` raises a TypeScript error at compile time. (Test asserted via a `// @ts-expect-error` annotation followed by the import — vitest will fail if the annotation is unused, i.e., if the import resolves.)
  - **Monitor observable:** a fixture trade record with `position_c_id` populated, when fed to `monitorSplitPositions` with stub deps, results in zero calls to `safelyAmendPosition` for that position id. This tests the OBSERVABLE outcome (Leg C is ignored) rather than the implementation detail (no `legCOrders` array). Achievable without exporting internals.
  - **Defensive read contract:** the DB schema still permits nullable `tp3`/`position_c_id`/`size_c`/`pnl_c` (Phase 2 will tighten). Test inserts a row with these populated and asserts no read path crashes — verifies the historical SILVER row remains queryable.

## Out of scope (deferred to Phase 2)

- Drop columns `tp3`, `position_c_id`, `size_c`, `pnl_c` from the `trades` table.
- Drop columns `position_c_outcome`, `pnl_c_r` from the `lessons` table.
- Drop `'tp2_hit'` from the `trades.status` CHECK constraint.
- Drop `'C'` from the `sl_tp_orders.leg` CHECK constraint.
- Refactor the open-trade SQL at `database/index.ts:539` to no longer reference `tp2_hit`.
- Drop `'tp2_hit'` from the `TradeStatus` TypeScript union.
- Backfill or migrate any historical `tp2_hit` rows (none expected; if Phase 2 finds any, it will need a small migration).

## Out of scope (other, unrelated work)

- Capital streaming WebSocket (TP1 race fix's Approach B — deferred from `2026-05-08-tp1-be-offset-and-race-fix-design.md`)
- ICT Agent 8-iteration cycle timeout fix (parallel session is on this as of 2026-05-08)
- Anthropic API credit topup (operational)
- systemd Node-22 service repoint (operational, requires sudo)
- pm2 binary update on VPS (cosmetic version drift)

## Tests / verification gates

- `npm test` — all pass after the test removals. Concrete pre-/post- counts pinned during plan-writing by reading the file headers; the implementation plan will assert exact numbers (e.g., "790 → 786") so any deviation flags an unintended test addition/removal. Approximate: removes 6 cases (3 in `scheduler.test.ts`, 1 in `scheduler-tp1-be-offset.test.ts`, 1 in `proposal-hash.test.ts`, 1 in `reflection.test.ts`) plus the entire `lesson-leg-c.test.ts` file (~5 tests), and adds 3-4 in the new `three-leg-removal.test.ts`.
- `npx tsc --noEmit` — zero errors. The TradeRecord/Lesson types keep the nullable C-fields with `@deprecated` JSDoc, so existing rows with C-data still typecheck.
- Backtest sanity: PF ≥ 0.61 (Phase 2 baseline). The backtest engine is already 2-leg only — no impact expected.
- Live smoke: post-deploy, watch pm2-out.log for one full ICT cycle. Expect:
  - No `[TP1] ... Position C ...` lines
  - No `tp2_hit` writes in DB activity
  - The startup banner unchanged from current 2026-05-08 state
- Codex twin per task during execution (per Giuseppe's standing rule on Farad bot work).

## Rollout

Single PR / single push to master. CI auto-deploys. pm2 restarts. No DB migration. No in-flight position state to preserve. A Phase 1 rollback is `git revert` with zero data risk.

## Acceptance criteria

1. **No live-code references to 3-leg.** `grep -r "handleTp3Hit\|position_c_id\|size_c\|tp3\|pnl_c\|position_c_outcome\|pnl_c_r" src/ prompts/` returns ONLY:
   - Nullable type field declarations in `src/types.ts` (with `@deprecated` JSDoc)
   - Schema column declarations in `src/database/index.ts` (untouched)
   - The open-trade SQL `tp2_hit` reference at `database/index.ts:539`
   No matches in agent code, prompts, scheduler logic, or tests (other than the new `three-leg-removal.test.ts` which references the removed surface by design).

2. **No 3-leg test cases except negative-coverage.** `grep -rL "Leg C\|TP3\|3-leg\|tp3" tests/` (note: capital L = files WITHOUT match) lists every test file other than `tests/three-leg-removal.test.ts`. The new negative-coverage file is the only place these strings legitimately appear; everywhere else in `tests/`, the 3-leg surface is gone.

3. **Bot opens 2-leg trades only.** After deploy, the next 5 ICT cycles open trades with exactly 2 legs, log no `[TP1] ... Position C ...` lines, and DB writes show `position_c_id IS NULL`, `tp3 IS NULL`, `size_c IS NULL`.

4. **Analyst LLM never proposes 3-leg.** In the next 24 hours of pm2 logs, no `proposalHash` includes `tp3` or `size_c`. The prompt cleanup at `analyst-agent.md:43,60,106` enforces this on the LLM side; the MCP runtime guard enforces it on the placement side.

5. **Phase 1 negative-coverage tests pass.** The new `tests/three-leg-removal.test.ts` confirms the 3-leg surface is structurally gone.

## Edge cases considered

- **Historical 3-leg row in DB (the SILVER `trade-a8a0eb21` from 2026-05-07):** still in the table with `status='complete'`, `position_c_id`, `size_c`, `pnl_c` populated. Phase 1 reads of this row return the populated fields (type still nullable + populated). No Phase 1 code reads them in a way that could fail. Phase 2 will drop the columns and lose the leg-level breakdown; aggregate `pnl_total` survives.
- **`handleSlOnLeg` simplification:** the terminal-status check at line ~644 currently branches on `tp1_hit || tp2_hit`. After Phase 1 the `tp2_hit` branch is unreachable. Simplifying to `tp1_hit` only is a behavior-preserving change for any reachable state.
- **`tp2_hit` in code that reads (not writes):** the open-trade SQL at `database/index.ts:539` and the `handleSlOnLeg` check are the only code paths that READ this status. Both are defensive — they correctly handle a state that Phase 1 has rendered unreachable. Phase 2 cleans them up.
- **MCP runtime guard at `trading-tools.ts`:** must throw with a clear, greppable error string so a stale caller surfaces immediately rather than silently producing a 1-leg trade.
- **Test count drift:** the spec estimates 783-787 tests post-Phase-1. The plan should pin the exact pre-/post- counts after the implementation lands, so any deviation flags an unintended test addition or removal.

## Acceptance criteria (negative — what should NOT happen)

- No new database migration in Phase 1.
- No change to the live bot's strategy semantics — only dead code is removed.
- No new trades produced during the deploy window get a 3-leg shape (verified by the runtime guard + the LLM prompt cleanup, in that order).
- No backwards-incompatible change to the MCP `place_split_trade` tool's schema for callers that already pass only 2-leg fields.

# Deploy Plan — Spec 001 (scoring-pipeline-audit)

**Branch:** `spec/scoring-pipeline-audit` (14 commits as of 2026-05-12)
**Base:** `chore/add-spec-kit` → `master`
**Tests:** 901/901 passing on every commit. tsc clean throughout.
**Migration:** 007 (idempotent — `PRAGMA table_info` + guarded `ALTER`).

This doc covers the manual ship gates: T048-T050 (PR 1), T071-T073 (PR 2), T093-T095 (PR 3). It is the single source of truth for the deploy sequence — follow it top-to-bottom.

---

## Pre-deploy checklist (do once before ANY merge)

- [ ] **Codex twin / `superpowers:requesting-code-review`** on the 14-commit chain. Spec 001 is structurally large enough that one independent reviewer should look at the whole branch before splitting into PRs.
- [ ] **Run the range-mode backtest at least once** with `TWELVE_DATA_API_KEY` so `specs/001-scoring-pipeline-audit/range-mode-backtest.md` lands with the FR-012 verdict. The verdict (LIFT THE CAP / KEEP THE CAP / INSUFFICIENT DATA) gates whether T077-T080 conditional code changes ship.
  ```powershell
  cd C:\Users\user\.config\superpowers\worktrees\trading-bot\spec-scoring-audit
  npm run backtest:range-mode
  git add specs/001-scoring-pipeline-audit/range-mode-backtest.md
  git commit -m "feat(backtest): range-mode report — verdict X"
  ```
- [ ] **Pull a VPS DB snapshot** and run `scripts/extract-historical-snapshots.ts` so the historical-replay regression has fixtures to test against. Optional but strongly recommended for SC-006 verification.
  ```powershell
  ssh bot@162.55.212.198 'cat /home/bot/trading-bot/data/trading-bot.db' > /tmp/farad-snapshot.db
  npx tsx scripts/extract-historical-snapshots.ts --db /tmp/farad-snapshot.db --days 30
  git add tests/fixtures/scoring/historical-snapshots.json
  git commit -m "test: historical-snapshots fixture for SC-006 regression"
  ```
- [ ] **Confirm pm_state defaults match intent.** Migration 007 inserts `cooldown_max_consecutive_losses=3`, `cooldown_clear_after_hours=24`, `max_total_risk_pct=0.0`. The first two activate cooldown; the third keeps the risk budget OFF (preserves legacy single-instrument-lock behaviour). To enable the budget, post-deploy:
  ```sql
  UPDATE pm_state SET value='2.5' WHERE key='max_total_risk_pct';
  ```
  Decide BEFORE deploy whether you want this on or off; it can also be toggled live.

---

## Deploy window

**Required: 22:00 UTC Sunday** (after weekly review, before Asia open). Reasons:
1. **proposalHash bumped v1 → v2** (T022). Any in-flight v1 approval will mismatch on placement and TTL-prune. Sunday 22:00 UTC is when `approvedProposals` is reliably empty (no active scanning since Friday 17:00 UTC London Close).
2. EOD journalist cron fires at 21:30 UTC Mon-Fri only — Sunday is clear.
3. Weekly review fires at 00:00 UTC Sunday — already done by 22:00.

Pre-deploy command (RUN ON VPS):
```bash
ssh bot@162.55.212.198 'sqlite3 /home/bot/trading-bot/data/trading-bot.db "SELECT COUNT(*) FROM trades WHERE closed_at IS NULL"'
# Expected: 0 — confirms no open trades that would race the migration.
# If non-zero, postpone: there are open trades that the new monitor cron must not race.
```

---

## Ship sequence (3 PRs in order)

### PR 1 — Foundation + Observability + Scoring (T048-T050)

**Includes commits:**
- `6c06f1b` (tasks doc)
- `d6e52a0` (Phase 1+2 foundation: Migration 007 + helpers + scaffold)
- `edbe9aa` (US-1 scanner + backtest unification)
- `e50432e` (US-2 + US-6 rejection wiring)
- `bd43087` (US-2 daily digest + tests)
- `35643d3` (T040 dump-reject-metrics + T058 prompt clarifications)
- `5d4b991` (US-1 prompt §H rewrite + closing gaps)
- `8bc9ba8` (US-5 ICT structure scorer)
- `61201a4` (T020 audit-trail write)
- `d548495` (T014/T019/T020-upgrade/T021/T022 plumb-through + hash bump)

**Ship gate (T048):**
- [ ] `npm test` 901/901 passing on the worktree
- [ ] `npx tsc --noEmit` clean
- [ ] `npm run build` produces `dist/` without errors
- [ ] Manual smoke: in dev DB, set `ANALYST_FORCE_TIMEOUT=true`, run `npm run trade-cycle-once`, verify `ANALYST_FAIL_CLOSED_API_ERROR` row in `trade_rejections`
- [ ] Manual smoke: plant 3 LL trades, run a cycle, verify `COOLDOWN_3_LOSSES_ACTIVE` rejection BEFORE analyst dispatch
- [ ] Push: `git push -u origin spec/scoring-pipeline-audit`
- [ ] Open PR vs `master` (NOT `main` — active branch is `master` per project memory)
- [ ] Reviewer approval

**Deploy (T049):**
- [ ] On VPS: `cd /home/bot/trading-bot && git fetch && git checkout master && git pull`
- [ ] `npm install` (if package.json changed — check `git diff HEAD@{1} HEAD package.json`)
- [ ] `npm run build`
- [ ] `pm2 restart trading-bot`
- [ ] Watch `pm2 logs trading-bot --lines 200` for 10 min — alert on any `OTHER` category emission, any unhandled rejection, or migration error.

**Post-deploy verification (T050):**
- [ ] Wait 24h. Run `ssh bot@162.55.212.198 'sqlite3 /home/bot/trading-bot/data/trading-bot.db "SELECT category, COUNT(*) FROM trade_rejections WHERE substr(ts, 1, 10) = date(\"now\") GROUP BY category"'`
  - Expected: at least KILL_ZONE_OUT entries (most common). NO `OTHER` rows.
- [ ] Verify daily digest fired at 21:35 UTC (check Telegram chat).
- [ ] **SC-008 check:** rejection rate (rejections / total proposals) within ±10pp of pre-spec baseline. Pre-spec baseline available via legacy log-scrape: `npx tsx scripts/dump-reject-metrics.ts --legacy <yesterday>`.

### PR 2 — Cooldown + Structure scorer (T071-T073)

(Already merged into PR 1's commit chain — this section preserved for traceability if a future reviewer wants to split.)

**Per-commit ship gate (T071):**
- [ ] `9176980` (US-3 cooldown) — verify `tests/cooldown/state.test.ts` 13 tests passing
- [ ] `8bc9ba8` (US-5 structure scorer) — verify `tests/scoring/ict-array-detector.test.ts` 20 tests passing
- [ ] Manual replay: pull 5 historical Haiku contexts, verify they don't mis-tier setups under the deterministic scorer

**7-day shadow run (T072):**
- [ ] Watch the digest daily for 7 days.
- [ ] **SC-008 check:** rejection rate within ±10pp of pre-spec baseline.
- [ ] **SC-001 check:** run `npm test -- tests/scoring/compose.test.ts` — zero variance across 10 runs.
- [ ] If rejection rate spikes by >10pp: investigate via the per-category breakdown. Most likely cause is the new `EXECUTOR_REJECT_TIER_SCORE_MISMATCH` from T021's breakdown sum check — check `subcategory='BREAKDOWN_SUM_MISMATCH'` count.

**Final verification (T073):**
- [ ] **SC-006 check:** ≥80% of historical Tier 1 trades retain Tier 1 under the new scorer. Run after `extract-historical-snapshots` populates the fixture.

### PR 3 — Range backtest + Risk budget (T093-T095)

(Also merged into PR 1's commit chain.)

**Per-commit ship gate (T093):**
- [ ] `6036f9f` (US-4 range-mode harness) — verify `tests/backtest/range-engine.test.ts` 6 tests passing
- [ ] `f83df0d` (US-7 risk budget) — verify `tests/risk-budget/policy.test.ts` 12 tests passing

**Range-mode decision (T094):**
- [ ] `range-mode-backtest.md` committed with FR-012 verdict.
- [ ] If LIFT THE CAP: implement T077-T080 (scanner cap removal + prompt edit + executor relaxation). Re-run `npm test` and re-deploy.
- [ ] If KEEP THE CAP or INSUFFICIENT DATA: no code change. Document the decision in spec.md US-4 status block.

**Risk budget activation (T095):**
- [ ] Default `max_total_risk_pct=0` is safe — preserves legacy single-instrument-per-INSTRUMENT lock as the only gate.
- [ ] If you want to opt in to the budget cap: `UPDATE pm_state SET value='2.5' WHERE key='max_total_risk_pct'` (or your chosen percentage).
- [ ] Verify next trade attempt: if budget would be exceeded, the executor returns `EXECUTOR_REJECT_RISK_BUDGET_EXCEEDED` with the open/proposed/max numbers.

---

## Rollback procedure

If something goes wrong post-deploy, the worst-case rollback is:
```bash
ssh bot@162.55.212.198
cd /home/bot/trading-bot
git checkout c86b164    # last pre-spec master
npm run build
pm2 restart trading-bot
```

The new tables (`score_breakdowns`, `trade_rejections`, `pm_state`) are LEFT in place — they're additive and unreferenced by the rolled-back code. The `analyst_log` columns added by Migration 007 (`category`, `is_fail_closed`, `subcategory`) are also additive — old code reads only the original columns. Migration 007 is **forward-compatible** with the rollback.

The proposalHash v2 → v1 transition: rolling back will start producing v1 hashes again. Any approval issued AFTER the rollback (under v1) won't be valid for any placement attempt that happens to have been issued BEFORE rollback (under v2). This is a self-healing race — the LLM re-requests review on the next cycle.

---

## Per-SC verification matrix

| SC | What to check | When |
|---|---|---|
| SC-001 zero variance | `npm test -- tests/scoring/compose.test.ts` | Pre-deploy + 24h post |
| SC-002 no `OTHER` category | Daily digest output | Every digest send |
| SC-003 fail-closed distinguishable | Force timeout + observe digest | First week |
| SC-004 cooldown fires correctly | Plant 3 losses + submit proposal | Pre-deploy smoke |
| SC-005 range backtest decision | `range-mode-backtest.md` verdict | Before T077-T080 ship |
| SC-006 ≥80% T1 retention | Historical-replay regression test | After fixture extraction |
| SC-007 budget=0 backward-compat | `tests/risk-budget/policy.test.ts` legacy-mode test | Pre-deploy |
| SC-008 rejection rate ≤ baseline + 10pp | Daily digest comparison | 24h + 7d post-deploy |
| SC-009 owner can answer "why was X rejected on Y" in <60s | Manual query against trade_rejections | One-shot post-deploy |

---

## Final check before sign-off

- [ ] All commits squashed/merged to master
- [ ] VPS pulled + restarted
- [ ] First daily digest fired successfully
- [ ] No `OTHER` category in 24h
- [ ] Rejection rate within ±10pp of baseline
- [ ] Owner runs `sqlite3 /home/bot/trading-bot/data/trading-bot.db "SELECT category, COUNT(*) FROM trade_rejections GROUP BY category ORDER BY 2 DESC"` and confirms the distribution looks sensible

Spec 001 is **shipped** when all the above are checked.

# 3-Leg Legacy Code Removal — Phase 2 (schema + types + dead wires)

**Date:** 2026-05-09
**Author:** Claude (with Giuseppe / BetterOps AI)
**Status:** Drafted 2026-05-09. Codex failure-mode audit folded in (3 fixes: BEGIN/COMMIT pattern correction, BLOCKER on legacy add-column re-resurrection, 4 missed C-field reads expanding the surface). Awaiting user spec review then handoff to writing-plans.

## TL;DR

Phase 2 of the 3-leg legacy code removal. Where Phase 1 stopped writing/reading 3-leg fields in code, Phase 2 drops them from the database schema, the TypeScript types, and the 5 dead-but-typed wires that Phase 1 intentionally left. After Phase 2, `grep -rE 'tp3|position_c_id|size_c|pnl_c|tp2_hit|alertTp3Hit|realAlertTp3Hit' src/ prompts/` returns ZERO matches.

**Rollout:** single PR, idempotent startup migration, atomic at the file level. Pre-deploy DB backup. Pause-bot-during-migrate is unnecessary because the migration runs INSIDE the existing `initDatabase` startup flow — the scheduler hasn't started yet at that point. Rollback = `git revert` + restore DB from the pre-deploy backup.

## Locked decisions (from Phase 1 spec, carried forward)

- **Schema strategy:** hard delete (drop columns, drop `'tp2_hit'`, drop `'C'` leg). Historical 3-leg rows lose leg-level data but keep aggregate `pnl_total`. Demo data; not load-bearing for analytics.
- **Sequencing:** code first (Phase 1, shipped), schema later (this Phase 2).

## Pre-flight findings (2026-05-09)

| Migration target | Row count |
|---|---|
| `trades` with `status='tp2_hit'` | 0 |
| `trades` with `position_c_id IS NOT NULL` | 3 (closed historical) |
| `lessons` with `position_c_outcome IS NOT NULL OR pnl_c_r IS NOT NULL` | 1 |
| `sl_tp_orders` with `leg='C'` | 3 (closed historical) |
| `tp2_hit` source references | 13 sites across 3 files |

`tp2_hit` is in 0 live rows — clean drop possible without backfill.

## Code surface

### `src/database/index.ts` — schema migration

**1. New `rebuildTradesTablePhase2()` migration** (sibling to existing `rebuildTradesTable`):

Idempotent guard at the top:
```ts
const cols = db.exec("PRAGMA table_info(trades)")[0]?.values.map(r => r[1]) ?? [];
const stillHas3LegCols = cols.includes('tp3') || cols.includes('position_c_id')
  || cols.includes('size_c') || cols.includes('pnl_c');
const checkSql = (db.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='trades'")[0]?.values[0][0] ?? '') as string;
const stillHasTp2Hit = checkSql.includes("'tp2_hit'");
if (!stillHas3LegCols && !stillHasTp2Hit) return; // already migrated
```

Migration body — wrap in `BEGIN TRANSACTION` / `COMMIT` / `ROLLBACK` matching the existing `rebuildTradesTable` pattern at `src/database/index.ts:120-181`. **This is an existing-codebase pattern, not a new addition.**

```ts
console.log("[DB Migration] Phase 2: dropping tp3/position_c_id/size_c/pnl_c columns + 'tp2_hit' status");
db.run('PRAGMA foreign_keys = OFF'); // sl_tp_orders.trade_id FK survives the RENAME by name
db.run('BEGIN TRANSACTION');
try {
  // Defensive: zero rows expected, but if any tp2_hit row exists it gets coerced to closed_early.
  db.run("UPDATE trades SET status='closed_early' WHERE status='tp2_hit'");
  db.run('ALTER TABLE trades RENAME TO trades_old_phase2');
  db.run(`
    CREATE TABLE trades (
      id TEXT PRIMARY KEY,
      strategy_tag TEXT NOT NULL,
      instrument TEXT NOT NULL,
      instrument_category TEXT NOT NULL,
      direction TEXT NOT NULL,
      setup_type TEXT NOT NULL,
      entry REAL NOT NULL,
      sl REAL NOT NULL,
      tp1 REAL NOT NULL,
      tp2 REAL NOT NULL,
      position_a_id TEXT NOT NULL,
      position_b_id TEXT NOT NULL,
      size_a REAL NOT NULL,
      size_b REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'tp1_hit', 'complete', 'sl_hit', 'closed_early')),
      pnl_a REAL,
      pnl_b REAL,
      pnl_total REAL,
      composite_score INTEGER,
      kill_zone TEXT,
      news_category TEXT,
      analyst_decision TEXT,
      reasoning TEXT,
      closure_reason TEXT,
      opened_at TEXT NOT NULL DEFAULT (datetime('now')),
      closed_at TEXT
    )
  `);
  db.run(`
    INSERT INTO trades (
      id, strategy_tag, instrument, instrument_category, direction, setup_type,
      entry, sl, tp1, tp2, position_a_id, position_b_id, size_a, size_b, status,
      pnl_a, pnl_b, pnl_total, composite_score, kill_zone, news_category,
      analyst_decision, reasoning, closure_reason, opened_at, closed_at
    )
    SELECT
      id, strategy_tag, instrument, instrument_category, direction, setup_type,
      entry, sl, tp1, tp2, position_a_id, position_b_id, size_a, size_b, status,
      pnl_a, pnl_b, pnl_total, composite_score, kill_zone, news_category,
      analyst_decision, reasoning, closure_reason, opened_at, closed_at
    FROM trades_old_phase2
  `);
  db.run('DROP TABLE trades_old_phase2');
  // Recreate indexes
  db.run('CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status)');
  db.run('CREATE INDEX IF NOT EXISTS idx_trades_strategy ON trades(strategy_tag)');
  db.run('CREATE INDEX IF NOT EXISTS idx_trades_instrument ON trades(instrument)');
  db.run('CREATE INDEX IF NOT EXISTS idx_trades_opened ON trades(opened_at)');
  db.run('COMMIT');
} catch (err) {
  db.run('ROLLBACK');
  throw err;
} finally {
  db.run('PRAGMA foreign_keys = ON');
}
```

**2. New `rebuildLessonsTablePhase2()` migration** — same RENAME/CREATE/INSERT/DROP pattern, drop `position_c_outcome` and `pnl_c_r` columns. No FK to worry about.

**3. New `rebuildSlTpOrdersTablePhase2()` migration:**
```ts
db.run("DELETE FROM sl_tp_orders WHERE leg='C'"); // 3 historical rows
// Then RENAME/CREATE/INSERT pattern with new CHECK: leg IN ('A', 'B') only.
```

**4. Update static schema definitions:**
- Line ~142 (rebuildTradesTable's CREATE) — drop `'tp2_hit'` from CHECK + drop the C-columns. Now matches the new schema.
- Line ~215 (the IF NOT EXISTS path's CREATE) — same.
- Line ~84 (sl_tp_orders rebuild's CREATE) — drop `'C'` from leg CHECK.
- Line ~248-260 (lessons CREATE) — drop `position_c_outcome` and `pnl_c_r` columns.

**5. Update `OPEN_STATUSES_SQL` at line 539:**
```ts
const OPEN_STATUSES_SQL = "status IN ('open', 'tp1_hit')";
```

**6. Migration call site:** add the 3 new `rebuild*Phase2()` calls inside `initDatabase`, AFTER the existing rebuilds. They run on every boot but exit early via the idempotent guard.

**7. CRITICAL — Delete the legacy add-column migrations.** (BLOCKER caught by Codex 2026-05-09 audit — without this, Phase 2 silently undoes itself on every boot.)
- **Lines 322-332** — the 4 `if (!existingTradesCols.includes('tp3')) ...` / `position_c_id` / `size_c` / `pnl_c` add-column blocks → DELETE entirely. The columns are gone after Phase 2; re-adding them on next boot is the silent-undo footgun.
- **Lines 348-351** — the 2 `if (!existingLessonsCols.includes('position_c_outcome')) ...` / `pnl_c_r` add-column blocks → DELETE.
- **Keep** the `closure_reason` add-column at lines ~334-339 (independent column, in scope of original `rebuildTradesTable`, still load-bearing).

### `src/types.ts`

- **Drop `'tp2_hit'` from `TradeStatus` union (line ~242).** New union: `'open' | 'tp1_hit' | 'complete' | 'sl_hit' | 'closed_early'`.
- **Drop `tp3`, `position_c_id`, `size_c`, `pnl_c` from `TradeRecord`** (lines ~273-287). Drop the `@deprecated since 2026-05-08` JSDocs that pointed at these — the fields are gone.
- **Drop `position_c_outcome`, `pnl_c_r` from `Lesson`** (lines ~317-322). Drop their JSDocs.

### `src/mcp-server/tools/trading-tools.ts`

- Line ~21 — drop `'tp2_hit'` from the status enum reference (likely a Zod enum or array literal mirroring the TypeScript union).

### Dead-but-typed wires + missed C-field reads sweep

(The first 5 are Phase 1's "intentionally left for Phase 2" wires. The remaining 4 are real C-field reads that Phase 1 missed because they're typed against the still-nullable C-fields and degrade silently — Codex 2026-05-09 audit caught these.)

**Dead-but-typed wires (Phase 1 deferrals):**
- **`src/scheduler/index.ts:42`** — `import { realAlertTp3Hit } from ...` → delete.
- **`src/scheduler/index.ts:78`** — `alertTp3Hit?: (trade: TradeRecord) => Promise<void>` field on `MonitorDeps` interface → delete.
- **`src/scheduler/index.ts:278`** — `alertTp3Hit: realAlertTp3Hit` deps wiring → delete.
- **`src/notifications/telegram.ts`** — `export async function alertTp3Hit(...)` → delete the entire function. Verify no remaining importers via `grep -rE 'alertTp3Hit' src/ tests/` after the edit (expect zero matches).

**Missed C-field reads (Phase 1 oversight, must fix in Phase 2 BEFORE schema drop or runtime undefined):**
- **`src/agents/analyst-agent.ts:199`** — `size_c: t.size_c` in trade-projection map → DELETE the line. The projection feeds the analyst LLM context; without `size_c`, the LLM sees only A+B sizes (correct).
- **`src/agents/analyst-agent.ts:210`** — `leg_c: l.position_c_outcome` in recent-lessons-projection map → DELETE the line.
- **`src/scheduler/index.ts:195+253`** — `classifyCloseReason(... leg: 'A' | 'B' | 'C', ...)` parameter narrows AND the body's `leg === 'C' ? trade.tp3 ?? trade.tp2` ternary branch is now unreachable. **Narrow + simplify the ternary** to `leg === 'A' ? trade.tp1 : trade.tp2` (no fallback to tp3).
- **`src/notifications/telegram.ts`** — `alertNewTrade`, `alertTp1Hit`, `alertTp2Hit` ALL render 3-leg branches today (`isThreeLeg = trade.tp3 !== null && trade.position_c_id`, then conditional Position C / Leg C / TP3 strings). **Refactor each to drop the 3-leg branch entirely** — strip the `isThreeLeg` ternaries, keep only the 2-leg paths (`tpsLine` becomes unconditional `TP1: ${trade.tp1} | TP2: ${trade.tp2}`, `legsLine` drops the Leg C variant, `rrLine` drops `R:R to TP3`, `alertTp1Hit` drops the `legCLine` template, `alertTp2Hit` drops the `position_c_id && !isFinal` branch).

### Test updates

- **`tests/three-leg-removal.test.ts` test 4** — currently reads `tp3, position_c_id, size_c, pnl_c` from the live DB. **Replace** with a positive schema assertion:
  ```ts
  it('trades schema does not have 3-leg columns (Phase 2 dropped them)', async () => {
    // ... open DB with sql.js ...
    const cols = db.exec("PRAGMA table_info(trades)")[0].values.map(r => r[1]);
    expect(cols).not.toContain('tp3');
    expect(cols).not.toContain('position_c_id');
    expect(cols).not.toContain('size_c');
    expect(cols).not.toContain('pnl_c');
  });
  ```
  This test now verifies the migration ran successfully on the dev DB. Skipped if the DB file isn't present locally.

- **`tests/scheduler-tp1-be-offset.test.ts`** — `makeTrade` fixture has explicit `tp3: null, position_c_id: null, size_c: null, pnl_c: null` (Phase 1 left these for Phase 2). Drop the keys; TradeRecord no longer has them, TS will error otherwise.

- **`tests/scheduler.test.ts:187-221, 835-837`** — Codex audit citations: C-shaped `TradeRecord` fixtures and `tp2_hit` references. Drop the C-fields and any `'tp2_hit'` status values.

- **`tests/scheduler-tp1-be-offset.test.ts:68-72`** — `makeTrade` fixture has explicit `tp3: null, position_c_id: null, size_c: null, pnl_c: null` (Phase 1 left these for Phase 2). Drop the keys.

- **`tests/three-leg-removal.test.ts:54-64`** — old test 4 reads C-columns from the DB. Replace with the positive PRAGMA assertion described above.

- **`tests/trading-tools.test.ts:126`** — Codex flagged a fixture with C-fields. Inspect and drop.

- **`tests/database.test.ts`** — likely has CHECK-constraint or schema assertions touching `'tp2_hit'` or column lists. Update for the new schema.

- **Search-and-fix pass:** `grep -rE 'tp3|position_c_id|size_c|pnl_c|tp2_hit' tests/ | grep -v three-leg-removal` — every remaining hit needs cleanup unless it's documenting absence.

## Out of scope

- **Phase 1's @deprecated JSDocs in `src/types.ts`** — removed in Phase 2 (alongside the fields they documented).
- **`backtest-data/` and `backtest-results/`** — local cache, no schema dependency.
- **Capital.com server-side data.** Bot's local DB only.
- **`scripts/_phase0_recover_silver.mjs`** (untracked on VPS, mentioned in 2026-05-07 memory) — out of scope, deferred operational artifact.

## Failure modes considered

(Per the systematic-debugging discipline applied to this irreversible migration.)

1. **Partial migration (e.g., RENAME succeeds, CREATE fails).** **CORRECTED 2026-05-09 post Codex audit:** the existing `rebuildTradesTable` at `src/database/index.ts:120-181` DOES use `BEGIN TRANSACTION` / `COMMIT` / `ROLLBACK` (lines 120, 174, 178). Phase 2's migration follows the same pattern (already updated in Section 1). If CREATE fails after RENAME, ROLLBACK runs — table state restored, idempotent guard exits cleanly on next boot. **Recovery:** automatic via ROLLBACK; if ROLLBACK itself fails, restore from pre-deploy backup. SERIOUS but well-mitigated.

2. **FK from `sl_tp_orders.trade_id → trades(id)`.** sql.js + SQLite resolve FKs by table name at constraint-check time, not at definition time. The `PRAGMA foreign_keys = OFF` at migration start prevents constraint validation during the RENAME/CREATE/INSERT/DROP sequence. After re-enabling, the FK still references "trades" — the new table — by name. ✅ Safe.

3. **`lessons` has no FK to `trades`** (verified at `src/database/index.ts:230-260`). No FK concerns for the lessons rebuild.

4. **Idempotency on second boot.** The guard `if (!stillHas3LegCols && !stillHasTp2Hit) return;` exits before any destructive operation. A second boot of new code finds: no C-columns, no `'tp2_hit'` in the CHECK SQL → noop. ✅

5. **In-flight write during pm2 restart.** sql.js writes a single file via `fs.writeFileSync(db.export())`. Node atomic file writes are not actually atomic — a partial write on power-loss is theoretically possible. **In practice:** pm2 sends SIGINT, the bot's `Shutdown` handler drains in-flight critical sections (verified in 2026-05-07 logs). **Risk:** SERIOUS but rare. **Mitigation:** the pre-deploy DB backup. If a partial write happens, restore from backup.

6. **Concurrent reads during migration.** `initDatabase` runs at startup BEFORE the scheduler's `cron.schedule` calls. No concurrent reads possible. ✅ (Verified by reading `src/index.ts` startup order — out of scope to inline here, plan implementer should confirm.)

7. **Historical 3-leg rows querying.** After migration, the 3 historical rows have only A+B leg data (the rest is gone). Reflection-agent reads via `extractLessonFromTool`; weekly-review reads aggregates. None of them dereference `row.tp3` etc. anymore (Phase 1 removed those reads). ✅

8. **Index rebuild.** Migration explicitly recreates the 4 indexes (`idx_trades_status`, etc.). ✅ Tested via the Phase 1 negative-coverage test (just adapted for Phase 2 schema).

9. **Comments in `src/database/index.ts` referencing 3-leg.** Lines 112, 119, 189, 336, 357, 364, 536, 537 (per prior grep) — historical record. Keep them as audit trail. Plan implementer can prune the now-stale comments at their discretion.

10. **Test fixtures with C-fields.** Phase 1 already touched some; Phase 2's TypeScript type tightening surfaces any survivors at tsc time. Implementer fixes whatever tsc reports.

11. **`closure_reason` column added 2026-05-08.** Independent column, not in Phase 2 scope. The Phase 2 migration's INSERT SELECT explicitly includes `closure_reason` to preserve it. ✅

12. **Backup retention.** The `data/trading-bot.db` file is gitignored. Backup file `backup-pre-phase2-2026-05-09.db` lives at the repo root or any local path; user keeps it for at least until next deploy is verified stable.

## Tests / verification gates

- **Pre-deploy:** `scp bot@162.55.212.198:/home/bot/trading-bot/data/trading-bot.db ./backup-pre-phase2-2026-05-09.db` (one-shot DB backup, ~600KB).
- **Local:** `npm test` (~802 baseline, expect ~800-803 after Phase 2 test fixture updates), `npx tsc --noEmit` (zero errors), `npx tsx scripts/run-backtest.ts ...` (PF ≥ 0.61, no impact expected).
- **CI:** `Build + Test` green via GH Actions before deploy lands.
- **Post-deploy on VPS:**
  - `ssh bot@vps "cd /home/bot/trading-bot && node scripts/_check_phase2_schema.mjs"` (one-shot script that PRAGMA-table-infos `trades` / `lessons` / `sl_tp_orders` and asserts the new schema).
  - `pm2 status trading-bot` → `online`, no error spike.
  - `pm2 logs trading-bot --lines 50` → look for `[DB Migration] Phase 2: dropping ...` log line confirming the migration ran exactly once.
- **Acceptance grep:** `grep -rE 'tp3|position_c_id|size_c|pnl_c|tp2_hit|alertTp3Hit|realAlertTp3Hit' src/ prompts/` returns ZERO matches.

## Rollout

Single PR, single push. Pre-deploy DB backup. CI auto-deploys. pm2 restarts. Migration runs at startup. Verify schema and pm2 status.

**Rollback** (if migration breaks startup or test fails):
1. `git revert <phase2-commits>` + `git push origin master` — CI redeploys old code.
2. SSH to VPS: `pm2 stop trading-bot`.
3. SCP the backup: `scp ./backup-pre-phase2-2026-05-09.db bot@vps:/home/bot/trading-bot/data/trading-bot.db`.
4. `pm2 start trading-bot` → bot resumes on the old schema with old code.

Window of risk is roughly the time between push and VPS verification — typically <2 minutes.

## Acceptance criteria

1. `PRAGMA table_info(trades)` returns no `tp3` / `position_c_id` / `size_c` / `pnl_c`.
2. `PRAGMA table_info(lessons)` returns no `position_c_outcome` / `pnl_c_r`.
3. `INSERT INTO trades (... status ...) VALUES (... 'tp2_hit' ...)` fails the CHECK constraint.
4. `INSERT INTO sl_tp_orders (... leg ...) VALUES (... 'C' ...)` fails the CHECK constraint.
5. `grep -rE 'tp3|position_c_id|size_c|pnl_c|tp2_hit|alertTp3Hit|realAlertTp3Hit' src/ prompts/` → zero matches.
6. The startup log shows `[DB Migration] Phase 2: dropping ...` exactly once on the first boot of new code, then never again.
7. Bot continues operating normally — next ICT cycle opens a 2-leg trade, no errors at startup, no errors writing/reading trades.

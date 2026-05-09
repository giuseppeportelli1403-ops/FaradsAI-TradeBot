# 3-Leg Legacy Code Removal — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drop the 3-leg surface from the database schema, the TypeScript types, the Telegram alert templates, the analyst projection map, and the scheduler's classifyCloseReason — so `grep -rE 'tp3|position_c_id|size_c|pnl_c|tp2_hit|alertTp3Hit|realAlertTp3Hit' src/ prompts/` returns ZERO matches.

**Architecture:** TDD where new tests are added (the schema-assertion replacement for old test 4 in `three-leg-removal.test.ts`). Atomic removal where dead reads + types go away. The schema migration itself runs at startup — idempotent, ROLLBACK-on-failure, transaction-wrapped per the existing `rebuildTradesTable` pattern. The 6 legacy add-column migrations MUST be deleted in the same atomic database change as the rebuilds — without that, the migration silently undoes itself on every boot (Codex audit BLOCKER, 2026-05-09).

**Tech Stack:** TypeScript, Node 22.22.2 (auto-recovers via deploy.sh nvm fix), vitest 4.1.4, sql.js, Capital.com REST API.

**Critical ordering constraint:** all C-field READS (Tasks 2-5) must be removed BEFORE the TypeScript type tightening (Task 7), otherwise `tsc --noEmit` fails. The plan is sequential by design.

---

## File map

- **Modify:** `src/agents/analyst-agent.ts` — drop `size_c` from trade-projection map (line ~199), drop `leg_c: position_c_outcome` from lesson-projection map (line ~210)
- **Modify:** `src/notifications/telegram.ts` — refactor `alertNewTrade` / `alertTp1Hit` / `alertTp2Hit` to drop 3-leg branches; **delete** `alertTp3Hit` function entirely
- **Modify:** `src/scheduler/index.ts` — narrow `classifyCloseReason` parameter to `'A' | 'B'` + simplify ternary; drop `realAlertTp3Hit` import + `alertTp3Hit?` interface field + deps wiring (5 sites total — the Phase 1 deferrals)
- **Modify:** `src/database/index.ts` — atomic: add 3 new `rebuild*Phase2()` migrations, DELETE the 6 legacy add-column blocks, update 2 static CHECK constraint definitions, refactor `OPEN_STATUSES_SQL`
- **Modify:** `src/types.ts` — drop `'tp2_hit'` from `TradeStatus`; drop 4 nullable C-fields from `TradeRecord`; drop 2 nullable C-fields from `Lesson`; drop the now-irrelevant `@deprecated since 2026-05-08` JSDocs
- **Modify:** `src/mcp-server/tools/trading-tools.ts` — drop `'tp2_hit'` from line ~21 enum reference
- **Modify:** `tests/scheduler.test.ts` — drop C-fields and `'tp2_hit'` from fixtures (Codex citations: lines 187-221, 835-837)
- **Modify:** `tests/scheduler-tp1-be-offset.test.ts` — drop `tp3:null/position_c_id:null/size_c:null/pnl_c:null` from `makeTrade` (line ~68-72)
- **Modify:** `tests/three-leg-removal.test.ts` — replace test 4 (was DB column read) with PRAGMA-table-info schema assertion
- **Modify:** `tests/trading-tools.test.ts:126` — drop C-field fixture if any
- **Modify:** `tests/database.test.ts` — drop any 3-leg / `tp2_hit` schema assertions
- **Backup:** `data/trading-bot.db` → `backup-pre-phase2-2026-05-09.db` (one-shot `scp` from VPS, not a code change)

---

## Task 1: Pre-flight DB backup + state confirmation

**Files:** none (operational only)

- [ ] **Step 1: Backup VPS DB to local repo root**

```
scp bot@162.55.212.198:/home/bot/trading-bot/data/trading-bot.db ./backup-pre-phase2-2026-05-09.db
```

Expected: ~600KB file appears at the working tree root. **DO NOT** `git add` it — `.gitignore` already covers `*.db` patterns; verify with `git status` showing it as untracked.

- [ ] **Step 2: Re-confirm 0 in-flight 3-leg trades**

```
ssh bot@162.55.212.198 "cd /home/bot/trading-bot && node -e \"
const initSqlJs = require('sql.js'); const fs = require('fs');
initSqlJs().then(SQL => {
  const db = new SQL.Database(fs.readFileSync('data/trading-bot.db'));
  const r = db.exec(\\\"SELECT count(*) FROM trades WHERE position_c_id IS NOT NULL AND status NOT IN ('complete','sl_hit','closed_early')\\\");
  console.log('IN_FLIGHT_3LEG:', r[0].values[0][0]);
});\""
```

Expected: `IN_FLIGHT_3LEG: 0`. If non-zero, **STOP** and re-design the migration to handle the open positions.

- [ ] **Step 3: No commit — verification only**

Record both findings in the report: backup file size + `IN_FLIGHT_3LEG: 0`.

---

## Task 2: analyst-agent.ts — drop C-field projection reads

**Files:**
- Modify: `src/agents/analyst-agent.ts` (lines ~199, ~210)

- [ ] **Step 1: Locate the C-projection sites**

```
grep -nE 'size_c|position_c_outcome|leg_c' src/agents/analyst-agent.ts
```

Expected: 2 hits at lines ~199 (`size_c: t.size_c`) and ~210 (`leg_c: l.position_c_outcome`).

- [ ] **Step 2: Read the surrounding projection blocks**

Read lines 195-220 to see the full trade-projection and lesson-projection map blocks. The map output goes into the analyst LLM context, so dropping these fields means the LLM sees cleaner 2-leg data.

- [ ] **Step 3: Delete both lines**

Use `Edit` to remove `size_c: t.size_c,` from the trade map and `leg_c: l.position_c_outcome,` from the lesson map. Preserve trailing commas / object syntax of neighboring fields.

- [ ] **Step 4: Run analyst tests + tsc**

```
npx vitest run tests/analyst.test.ts tests/analyst-parse.test.ts
npx tsc --noEmit
```

Expected: pass. tsc clean (TradeRecord.size_c and Lesson.position_c_outcome are still nullable, so dropping the read is safe).

- [ ] **Step 5: Commit**

```
git add src/agents/analyst-agent.ts
git commit -m "refactor(analyst): drop size_c/position_c_outcome from LLM projection maps"
```

---

## Task 3: telegram alerts refactor

**Files:**
- Modify: `src/notifications/telegram.ts` (4 functions: `alertNewTrade`, `alertTp1Hit`, `alertTp2Hit`, delete `alertTp3Hit`)

- [ ] **Step 1: Read the current 4 alert functions**

```
grep -n 'alertNewTrade\|alertTp1Hit\|alertTp2Hit\|alertTp3Hit\|isThreeLeg\|position_c_id\|tp3\|size_c' src/notifications/telegram.ts
```

Read each function in full. Each currently has `isThreeLeg = trade.tp3 !== null && trade.position_c_id` plus conditional templates rendering Position C / Leg C / TP3 strings.

- [ ] **Step 2: Refactor `alertNewTrade`**

Remove the `isThreeLeg` constant and the 3-leg ternaries. The function becomes:

```ts
export async function alertNewTrade(trade: TradeRecord, strategy: string): Promise<void> {
  const emoji = '📊';
  const riskDist = Math.abs(trade.entry - trade.sl);
  const rrTp2 = riskDist > 0
    ? Math.abs((trade.tp2 - trade.entry) / riskDist).toFixed(1)
    : 'N/A';

  await send(`${emoji} *NEW TRADE — ${strategy}*

*${trade.instrument}* ${trade.direction.toUpperCase()}
Score: ${trade.composite_score}/100
Entry: ${trade.entry}
SL: ${trade.sl}
TP1: ${trade.tp1} | TP2: ${trade.tp2}
Leg A: ${trade.size_a} units | Leg B: ${trade.size_b} units
R:R to TP2: ${rrTp2}:1
Setup: ${trade.setup_type}
Kill Zone: ${trade.kill_zone}`);
}
```

(Drop `rrTp3`, `tpsLine`, `legsLine`, `rrLine` constants — they're unconditional now.)

- [ ] **Step 3: Refactor `alertTp1Hit`**

Drop the `legCLine` template. Function becomes:

```ts
export async function alertTp1Hit(trade: TradeRecord): Promise<void> {
  // Leg A closed at TP1 — partial profit locked in, Leg B now risk-free
  // at break-even. Trade still running.
  await send(`🎯 *TP1 HIT — ${trade.instrument}*

Position A closed at TP1 (${trade.tp1})
Position B SL → BE (${trade.entry}), heading for TP2 (${trade.tp2})
Strategy: ${trade.strategy_tag}`);
}
```

- [ ] **Step 4: Refactor `alertTp2Hit`**

Drop the `position_c_id && !isFinal` branch. Function becomes:

```ts
export async function alertTp2Hit(trade: TradeRecord): Promise<void> {
  // 2-leg full close: Leg A already TP'd, Leg B now closed at TP2.
  // Or partial-win finale (Leg B SL'd at BE after Leg A TP'd).
  const pnl = trade.pnl_total?.toFixed(2) || 'pending';

  await send(`🏆 *TRADE COMPLETE — ${trade.instrument}*

All legs closed.
P&L: ${pnl}R
Strategy: ${trade.strategy_tag}
Duration: ${trade.opened_at} → ${trade.closed_at ?? 'now'}`);
}
```

- [ ] **Step 5: Delete `alertTp3Hit` entirely**

Use `Edit` to remove the entire `export async function alertTp3Hit(trade: TradeRecord): Promise<void> { ... }` block (typically ~10 lines including the comment header).

- [ ] **Step 6: Verify no remaining references**

```
grep -rE 'alertTp3Hit' src/ tests/
```

Expected: ZERO matches. (Phase 1 already removed all callers; this just confirms.)

- [ ] **Step 7: Run telegram tests + tsc**

```
npx vitest run tests/telegram.test.ts
npx tsc --noEmit
```

Expected: pass. If any test asserts on the 3-leg variant of an alert template, update its expected substring or delete the test (it was testing removed code).

- [ ] **Step 8: Commit**

```
git add src/notifications/telegram.ts tests/telegram.test.ts
git commit -m "refactor(telegram): strip 3-leg branches from alertNewTrade/Tp1Hit/Tp2Hit; delete alertTp3Hit"
```

(Stage `tests/telegram.test.ts` only if you actually modified it — `git diff --cached --stat` should show only the files you intended.)

---

## Task 4: scheduler classifyCloseReason narrow + tp3 fallback removal

**Files:**
- Modify: `src/scheduler/index.ts` (lines ~195 + ~253)

- [ ] **Step 1: Locate the function**

```
grep -nE 'classifyCloseReason|trade\.tp3 \?\? trade\.tp2|leg === .C.' src/scheduler/index.ts | head -10
```

Expected: function declaration at ~line 195 with parameter `leg: 'A' | 'B' | 'C'`, and a ternary inside at ~line 253: `leg === 'A' ? trade.tp1 : leg === 'B' ? trade.tp2 : (trade.tp3 ?? trade.tp2)`.

- [ ] **Step 2: Narrow signature**

Change `leg: 'A' | 'B' | 'C'` → `leg: 'A' | 'B'`.

- [ ] **Step 3: Simplify ternary**

Change:
```ts
const tpLevel =
  leg === 'A' ? trade.tp1
  : leg === 'B' ? trade.tp2
  : (trade.tp3 ?? trade.tp2);
```
to:
```ts
const tpLevel = leg === 'A' ? trade.tp1 : trade.tp2;
```

The third branch was unreachable after Phase 1's monitor Pass 3 deletion — Codex audit confirmed.

- [ ] **Step 4: Run scheduler tests + tsc**

```
npx vitest run tests/scheduler.test.ts tests/scheduler-tp1-be-offset.test.ts
npx tsc --noEmit
```

Expected: pass. (89 - 4 = 85 pass per Phase 1 ledger, plus the new test 4 in `three-leg-removal.test.ts` still works since it still queries the OLD DB — Task 7 will refactor that test.)

- [ ] **Step 5: Commit**

```
git add src/scheduler/index.ts
git commit -m "refactor(scheduler): narrow classifyCloseReason to 'A'|'B'; drop tp3 fallback"
```

---

## Task 5: scheduler dead-but-typed wires sweep (3 sites + telegram export drop)

**Files:**
- Modify: `src/scheduler/index.ts` (lines ~42 import, ~78 interface, ~278 deps wiring)

- [ ] **Step 1: Grep the 3 wires**

```
grep -nE 'realAlertTp3Hit|alertTp3Hit' src/scheduler/index.ts
```

Expected: 3 hits — import at ~42, `alertTp3Hit?:` field on `MonitorDeps` interface at ~78, deps wiring at ~278.

- [ ] **Step 2: Delete the import**

Find the line `import { realAlertTp3Hit } from '...'` (or it may be one of several names in a destructured import block). Remove just that name. If it leaves the import block with one fewer item, ensure trailing-comma syntax stays valid.

- [ ] **Step 3: Delete the interface field**

In `MonitorDeps` interface, remove `alertTp3Hit?: (trade: TradeRecord) => Promise<void>;` (or whatever the exact signature is — read the interface and remove the line cleanly).

- [ ] **Step 4: Delete the deps wiring**

In `defaultMonitorDeps()` (or wherever the `MonitorDeps` object is constructed), remove the `alertTp3Hit: realAlertTp3Hit,` line.

- [ ] **Step 5: Verify no surviving references**

```
grep -nE 'realAlertTp3Hit|alertTp3Hit' src/
```

Expected: ZERO matches across the entire `src/` tree (Task 3 deleted the function in `notifications/telegram.ts`, this task removes its scheduler wiring).

- [ ] **Step 6: Run scheduler tests + tsc**

```
npx vitest run tests/scheduler.test.ts
npx tsc --noEmit
```

Expected: pass.

- [ ] **Step 7: Commit**

```
git add src/scheduler/index.ts
git commit -m "refactor(scheduler): drop alertTp3Hit/realAlertTp3Hit wiring (Phase 1 deferral, no callers)"
```

---

## Task 6: ATOMIC database changes — migrations, legacy-add-column delete, static CHECKs, OPEN_STATUSES_SQL

**Files:**
- Modify: `src/database/index.ts` (multiple sites — see below)

This is the LARGEST task in the plan. **All 4 sub-changes commit together** because they are interdependent: shipping the new migration without deleting the legacy add-column would silently undo Phase 2 on every boot.

### Step 1: Read the existing pattern at `rebuildTradesTable`

```
sed -n '118,182p' src/database/index.ts
```

Confirm the existing pattern uses `BEGIN TRANSACTION` / `COMMIT` / `ROLLBACK` (lines 120, 174, 178). Phase 2 follows the same pattern.

### Step 2: Add `rebuildTradesTablePhase2()` function

Insert this function adjacent to `rebuildTradesTable` (e.g., immediately after it):

```ts
function rebuildTradesTablePhase2(): void {
  const cols = db.exec("PRAGMA table_info(trades)")[0]?.values.map((r) => String(r[1])) ?? [];
  const stillHas3LegCols = cols.includes('tp3') || cols.includes('position_c_id')
    || cols.includes('size_c') || cols.includes('pnl_c');
  const checkSql = String(db.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='trades'")[0]?.values[0][0] ?? '');
  const stillHasTp2Hit = checkSql.includes("'tp2_hit'");
  if (!stillHas3LegCols && !stillHasTp2Hit) return; // already migrated

  console.log("[DB Migration] Phase 2: dropping tp3/position_c_id/size_c/pnl_c columns + 'tp2_hit' status");
  db.run('PRAGMA foreign_keys = OFF');
  db.run('BEGIN TRANSACTION');
  try {
    db.run("UPDATE trades SET status='closed_early' WHERE status='tp2_hit'");
    db.run('ALTER TABLE trades RENAME TO trades_old_phase2');
    db.run(`
      CREATE TABLE trades (
        id TEXT PRIMARY KEY,
        strategy_tag TEXT NOT NULL CHECK(strategy_tag IN ('ICT_INTRADAY', 'SWING')),
        instrument TEXT NOT NULL,
        instrument_category TEXT NOT NULL,
        direction TEXT NOT NULL CHECK(direction IN ('long', 'short')),
        setup_type TEXT NOT NULL,
        entry REAL NOT NULL,
        sl REAL NOT NULL,
        tp1 REAL NOT NULL,
        tp2 REAL NOT NULL,
        position_a_id TEXT,
        position_b_id TEXT,
        size_a REAL NOT NULL,
        size_b REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'tp1_hit', 'complete', 'sl_hit', 'closed_early')),
        pnl_a REAL,
        pnl_b REAL,
        pnl_total REAL,
        composite_score INTEGER NOT NULL,
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
}
```

### Step 3: Add `rebuildLessonsTablePhase2()` function

```ts
function rebuildLessonsTablePhase2(): void {
  const cols = db.exec("PRAGMA table_info(lessons)")[0]?.values.map((r) => String(r[1])) ?? [];
  if (!cols.includes('position_c_outcome') && !cols.includes('pnl_c_r')) return; // already migrated

  console.log("[DB Migration] Phase 2: dropping position_c_outcome/pnl_c_r columns from lessons");
  db.run('BEGIN TRANSACTION');
  try {
    db.run('ALTER TABLE lessons RENAME TO lessons_old_phase2');
    db.run(`
      CREATE TABLE lessons (
        lesson_id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        strategy_tag TEXT NOT NULL,
        instrument TEXT NOT NULL,
        instrument_category TEXT NOT NULL,
        direction TEXT NOT NULL,
        setup_type TEXT NOT NULL,
        kill_zone TEXT,
        hold_duration TEXT,
        news_category TEXT,
        news_description TEXT,
        composite_score INTEGER,
        analyst_decision TEXT,
        position_a_outcome TEXT,
        position_b_outcome TEXT,
        pnl_a_r REAL,
        pnl_b_r REAL,
        pnl_total_r REAL,
        was_bias_correct INTEGER,
        was_trigger_valid INTEGER,
        was_news_correctly_weighted INTEGER,
        was_split_execution_clean INTEGER,
        score_accuracy_notes TEXT,
        lesson TEXT NOT NULL,
        rule_suggestion TEXT
      )
    `);
    db.run(`
      INSERT INTO lessons (
        lesson_id, timestamp, strategy_tag, instrument, instrument_category, direction,
        setup_type, kill_zone, hold_duration, news_category, news_description,
        composite_score, analyst_decision, position_a_outcome, position_b_outcome,
        pnl_a_r, pnl_b_r, pnl_total_r, was_bias_correct, was_trigger_valid,
        was_news_correctly_weighted, was_split_execution_clean, score_accuracy_notes,
        lesson, rule_suggestion
      )
      SELECT
        lesson_id, timestamp, strategy_tag, instrument, instrument_category, direction,
        setup_type, kill_zone, hold_duration, news_category, news_description,
        composite_score, analyst_decision, position_a_outcome, position_b_outcome,
        pnl_a_r, pnl_b_r, pnl_total_r, was_bias_correct, was_trigger_valid,
        was_news_correctly_weighted, was_split_execution_clean, score_accuracy_notes,
        lesson, rule_suggestion
      FROM lessons_old_phase2
    `);
    db.run('DROP TABLE lessons_old_phase2');
    db.run('COMMIT');
  } catch (err) {
    db.run('ROLLBACK');
    throw err;
  }
}
```

### Step 4: Add `rebuildSlTpOrdersTablePhase2()` function

```ts
function rebuildSlTpOrdersTablePhase2(): void {
  const checkSql = String(db.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='sl_tp_orders'")[0]?.values[0][0] ?? '');
  const stillAllowsLegC = checkSql.includes("'C'");
  if (!stillAllowsLegC) return; // already migrated

  console.log("[DB Migration] Phase 2: dropping leg='C' from sl_tp_orders + deleting historical Leg C rows");
  db.run('PRAGMA foreign_keys = OFF');
  db.run('BEGIN TRANSACTION');
  try {
    db.run("DELETE FROM sl_tp_orders WHERE leg='C'");
    db.run('ALTER TABLE sl_tp_orders RENAME TO sl_tp_orders_old_phase2');
    db.run(`
      CREATE TABLE sl_tp_orders (
        order_id TEXT PRIMARY KEY,
        trade_id TEXT NOT NULL,
        leg TEXT NOT NULL CHECK(leg IN ('A', 'B')),
        order_type TEXT NOT NULL CHECK(order_type IN ('SL', 'TP')),
        deal_id TEXT,
        price REAL NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        deactivated_at TEXT,
        FOREIGN KEY (trade_id) REFERENCES trades(id)
      )
    `);
    db.run(`
      INSERT INTO sl_tp_orders SELECT * FROM sl_tp_orders_old_phase2
    `);
    db.run('DROP TABLE sl_tp_orders_old_phase2');
    db.run('COMMIT');
  } catch (err) {
    db.run('ROLLBACK');
    throw err;
  } finally {
    db.run('PRAGMA foreign_keys = ON');
  }
}
```

(Note: the `sl_tp_orders` schema definition above mirrors what's at `database/index.ts:286-300`. If the actual schema has additional columns, **read that block first** and copy the column list verbatim — the only changes from the existing schema should be the `CHECK(leg IN ('A', 'B'))` constraint.)

### Step 5: Wire the new migrations into `initDatabase`

Find the `initDatabase` function. After the existing `rebuildTradesTable()` call (and any other rebuilds), add:

```ts
rebuildTradesTablePhase2();
rebuildLessonsTablePhase2();
rebuildSlTpOrdersTablePhase2();
```

### Step 6: DELETE the 6 legacy add-column blocks (BLOCKER fix)

```
sed -n '317,355p' src/database/index.ts
```

Delete the following blocks **entirely**:
- Lines ~322-324: `if (!existingTradesCols.includes('tp3')) { db.run('ALTER TABLE trades ADD COLUMN tp3 REAL'); }`
- Lines ~325-327: `if (!existingTradesCols.includes('position_c_id')) { ... }`
- Lines ~328-330: `if (!existingTradesCols.includes('size_c')) { ... }`
- Lines ~331-332: `if (!existingTradesCols.includes('pnl_c')) { ... }`
- Lines ~348-350: `if (!existingLessonsCols.includes('position_c_outcome')) { ... }`
- Lines ~351-353: `if (!existingLessonsCols.includes('pnl_c_r')) { ... }`

**KEEP** the `closure_reason` add-column block at lines ~334-339 (independent column, still load-bearing).

If the surrounding 3-leg comment block (at ~line 317) becomes meaningless after these deletions, replace it with a brief one-liner: `// Legacy 3-leg add-column migrations removed in Phase 2 (2026-05-09).`

### Step 7: Update the static CHECK constraint definitions

Two sites in `src/database/index.ts`:
- **Line ~142** (`rebuildTradesTable`'s CREATE) — drop `'tp2_hit'` from CHECK and drop the 4 C-columns from the column list. After Phase 2, this rebuild path matches the new schema.
- **Line ~215** (the IF NOT EXISTS path's CREATE) — same edits.
- **Line ~84** (`sl_tp_orders` rebuild's CREATE) — drop `'C'` from leg CHECK.
- **Line ~248-260** (`lessons` CREATE — IF NOT EXISTS path) — drop `position_c_outcome` and `pnl_c_r` columns.

These updates ensure that a fresh install (where the new tables are created from scratch by these blocks) gets the correct Phase-2 schema directly without going through the rebuild migrations.

### Step 8: Refactor `OPEN_STATUSES_SQL` at line 539

```ts
// Before
const OPEN_STATUSES_SQL = "status IN ('open', 'tp1_hit', 'tp2_hit')";
// After
const OPEN_STATUSES_SQL = "status IN ('open', 'tp1_hit')";
```

### Step 9: Run the full test suite + tsc

```
npm test
npx tsc --noEmit
```

Expected counts: tests around 802 (unchanged — Task 6 doesn't add or remove tests). tsc clean.

If any test fails because it asserts on the old schema or `tp2_hit` membership, **note them in the report but DO NOT fix in this task** — Task 7 handles all test fixture updates atomically.

If tsc reports type errors about C-fields being missing... wait, no — at this point in the plan, `src/types.ts` still has the nullable C-fields. tsc should pass.

### Step 10: Commit

```
git add src/database/index.ts
git commit -m "refactor(database): Phase 2 — add rebuild migrations for trades/lessons/sl_tp_orders, delete legacy 3-leg add-column blocks, update static CHECKs, narrow OPEN_STATUSES_SQL"
```

---

## Task 7: ATOMIC type tightening + test fixture cleanup

**Files:**
- Modify: `src/types.ts` (drop fields and JSDocs)
- Modify: `src/mcp-server/tools/trading-tools.ts:21` (drop `'tp2_hit'`)
- Modify: `tests/scheduler.test.ts` (Codex citations 187-221, 835-837)
- Modify: `tests/scheduler-tp1-be-offset.test.ts` (line ~68-72)
- Modify: `tests/three-leg-removal.test.ts` (replace test 4)
- Modify: `tests/trading-tools.test.ts:126`
- Modify: `tests/database.test.ts` (any 3-leg / `tp2_hit` schema assertions)

This task lands type changes + test fixture updates in ONE atomic commit. Splitting them would create an intermediate state where tsc fails (types tightened but fixtures still feed the old shape), which violates "each task leaves the codebase in a passing state."

### Step 1: Tighten `src/types.ts`

(a) Drop `'tp2_hit'` from `TradeStatus` (line ~242). Drop the `@deprecated` JSDoc above it (was added in Phase 1 Task 8). The union becomes:
```ts
export type TradeStatus = 'open' | 'tp1_hit' | 'complete' | 'sl_hit' | 'closed_early';
```

(b) Drop the 4 C-fields from `TradeRecord` (lines ~273-287) AND their `@deprecated` JSDocs:
- `tp3: number | null;`
- `position_c_id: string | null;`
- `size_c: number | null;`
- `pnl_c: number | null;`

(c) Drop the 2 C-fields from `Lesson` (lines ~317-322) AND their `@deprecated` JSDocs:
- `position_c_outcome: string | null;`
- `pnl_c_r: number | null;`

### Step 2: Drop `'tp2_hit'` from `src/mcp-server/tools/trading-tools.ts:21`

```
grep -n "'tp2_hit'" src/mcp-server/tools/trading-tools.ts
```

Find the enum / array literal at line ~21 that mirrors `TradeStatus`. Drop `'tp2_hit'` from the list. Preserve trailing-comma syntax.

### Step 3: Update `tests/scheduler-tp1-be-offset.test.ts` `makeTrade` fixture

```
grep -n 'tp3:\|position_c_id:\|size_c:\|pnl_c:' tests/scheduler-tp1-be-offset.test.ts
```

In the `makeTrade` factory (around line 68-72 per Codex), drop the lines:
```ts
tp3: null,
position_c_id: null,
size_c: null,
pnl_c: null,
```

These fields are no longer in `TradeRecord` so tsc would reject them.

### Step 4: Update `tests/scheduler.test.ts` fixtures

```
grep -nE 'tp3:|position_c_id:|size_c:|pnl_c:|tp2_hit' tests/scheduler.test.ts
```

Codex cited lines 187-221 and 835-837. Inspect each, drop the C-fields and any `'tp2_hit'` status values from fixtures. If a fixture's `'tp2_hit'` was load-bearing (e.g., a test specifically about a trade in `tp2_hit` state), the test was testing dead code and should be deleted.

### Step 5: Replace `tests/three-leg-removal.test.ts` test 4

Find the existing test at lines ~54-64 (per Codex) that reads C-columns from the live DB. Replace with:

```ts
it('trades schema does not have 3-leg columns (Phase 2 dropped them)', async () => {
  const SQL = await initSqlJs();
  const dbPath = 'data/trading-bot.db';
  if (!fs.existsSync(dbPath)) return; // skip if DB not present locally
  const db = new SQL.Database(fs.readFileSync(dbPath));
  const cols = db.exec("PRAGMA table_info(trades)")[0]?.values.map((r) => String(r[1])) ?? [];
  expect(cols).not.toContain('tp3');
  expect(cols).not.toContain('position_c_id');
  expect(cols).not.toContain('size_c');
  expect(cols).not.toContain('pnl_c');
});
```

Also add a sibling test for `lessons` schema:

```ts
it('lessons schema does not have C-outcome columns (Phase 2 dropped them)', async () => {
  const SQL = await initSqlJs();
  const dbPath = 'data/trading-bot.db';
  if (!fs.existsSync(dbPath)) return;
  const db = new SQL.Database(fs.readFileSync(dbPath));
  const cols = db.exec("PRAGMA table_info(lessons)")[0]?.values.map((r) => String(r[1])) ?? [];
  expect(cols).not.toContain('position_c_outcome');
  expect(cols).not.toContain('pnl_c_r');
});
```

These tests pass only AFTER the migration runs locally (which happens once the new code is checked out and the bot's `initDatabase` function is invoked, e.g. via the test harness importing `database/index.ts`). Worst case: the tests skip gracefully if the local DB is in pre-migration state.

### Step 6: Update `tests/trading-tools.test.ts:126`

```
grep -n 'tp3:\|position_c_id:\|size_c:\|pnl_c:' tests/trading-tools.test.ts
```

Inspect line ~126's fixture. Drop any C-field entries.

### Step 7: Update `tests/database.test.ts`

```
grep -nE 'tp3|position_c_id|size_c|pnl_c|tp2_hit' tests/database.test.ts
```

Inspect each hit. Drop fixtures with C-fields, drop `'tp2_hit'` status assertions. If a test specifically validated the 3-leg schema (e.g., asserted column existence), DELETE the test — it was testing the removed schema.

### Step 8: Run full test suite + tsc

```
npm test
npx tsc --noEmit
```

Expected: ALL pass. tsc clean.

If any test fails, the fixture has surviving 3-leg references — re-grep and clean. If tsc errors persist, a TradeRecord consumer somewhere reads a now-missing field — trace and fix.

### Step 9: Final acceptance grep

```
grep -rE 'tp3|position_c_id|size_c|pnl_c|tp2_hit|alertTp3Hit|realAlertTp3Hit' src/ prompts/
```

Expected: ZERO matches. (Tests/ may contain references in `three-leg-removal.test.ts` documenting absence — that's fine.)

### Step 10: Commit

```
git add src/types.ts src/mcp-server/tools/trading-tools.ts tests/scheduler.test.ts tests/scheduler-tp1-be-offset.test.ts tests/three-leg-removal.test.ts tests/trading-tools.test.ts tests/database.test.ts
git commit -m "refactor: Phase 2 — drop tp2_hit + 6 C-fields from types; clean test fixtures; refactor three-leg-removal schema test"
```

---

## Task 8: Full test suite + tsc + backtest sanity gate

**Files:** none (verification only)

- [ ] **Step 1: Full test suite**

```
npm test
```

Expected: pass. Pin exact count for the report.

- [ ] **Step 2: TypeScript typecheck**

```
npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 3: Backtest sanity gate**

```
npx tsx scripts/run-backtest.ts --start 2024 --end 2025 --tickers EURUSD,GBPUSD,GOLD,AUDUSD,OIL_CRUDE
```

Expected: PF ≥ 0.61 (Phase 2 baseline). Backtest engine is already 2-leg-only post-Phase-Phase-2, so the C-removal has zero impact on backtest math.

- [ ] **Step 4: Acceptance grep**

```
grep -rE 'tp3|position_c_id|size_c|pnl_c|tp2_hit|alertTp3Hit|realAlertTp3Hit' src/ prompts/
```

Expected: ZERO matches. Confirms the full removal landed.

- [ ] **Step 5: If anything fails — STOP**

Do not proceed to Task 9. Re-enter `superpowers:systematic-debugging` Phase 1.

- [ ] **Step 6: No commit (verification only)**

---

## Task 9: Commit spec/plan + push to master + verify live deploy

**Files:** none (commits + ops)

- [ ] **Step 1: Stage and commit the spec + plan**

```
git add docs/superpowers/specs/2026-05-09-3-leg-removal-phase-2-design.md docs/superpowers/plans/2026-05-09-3-leg-removal-phase-2.md
git commit -m "docs: 3-leg removal Phase 2 — design and 9-task plan"
```

- [ ] **Step 2: Push to master**

```
git push origin master
```

Branch protection bypass is the established pattern for this repo (admin push). CI auto-deploys on push.

- [ ] **Step 3: Watch GitHub Actions deploy**

```
gh run list --branch master --limit 1
gh run watch <run-id-from-step-3a> --exit-status
```

Expected: Build + Test green, Deploy to VPS in ~14-16s.

- [ ] **Step 4: Verify VPS picked up the new HEAD and migration ran**

```
ssh bot@162.55.212.198 "cd /home/bot/trading-bot && git rev-parse HEAD && pm2 status trading-bot && pm2 logs trading-bot --lines 50 --nostream"
```

In the logs, look for:
- `[DB Migration] Phase 2: dropping tp3/position_c_id/size_c/pnl_c columns + 'tp2_hit' status` — confirms the trades migration ran
- `[DB Migration] Phase 2: dropping position_c_outcome/pnl_c_r columns from lessons` — confirms the lessons migration ran
- `[DB Migration] Phase 2: dropping leg='C' from sl_tp_orders + deleting historical Leg C rows` — confirms the sl_tp_orders migration ran
- pm2 status `online`, no error spike post-restart

- [ ] **Step 5: Schema verification on VPS**

```
ssh bot@162.55.212.198 "cd /home/bot/trading-bot && node -e \"
const initSqlJs = require('sql.js'); const fs = require('fs');
initSqlJs().then(SQL => {
  const db = new SQL.Database(fs.readFileSync('data/trading-bot.db'));
  const tradesCols = db.exec(\\\"PRAGMA table_info(trades)\\\")[0].values.map(r => r[1]);
  const lessonsCols = db.exec(\\\"PRAGMA table_info(lessons)\\\")[0].values.map(r => r[1]);
  const tradesSql = db.exec(\\\"SELECT sql FROM sqlite_master WHERE name='trades'\\\")[0].values[0][0];
  console.log('TRADES_HAS_TP3:', tradesCols.includes('tp3'));
  console.log('TRADES_HAS_POSITION_C_ID:', tradesCols.includes('position_c_id'));
  console.log('LESSONS_HAS_POSITION_C_OUTCOME:', lessonsCols.includes('position_c_outcome'));
  console.log('TRADES_CHECK_HAS_TP2_HIT:', String(tradesSql).includes(\\\"'tp2_hit'\\\"));
});\""
```

Expected:
- TRADES_HAS_TP3: false
- TRADES_HAS_POSITION_C_ID: false
- LESSONS_HAS_POSITION_C_OUTCOME: false
- TRADES_CHECK_HAS_TP2_HIT: false

- [ ] **Step 6: Smoke test the next live trade (passive observation)**

When the bot opens its next trade, verify in pm2-out.log:
- DB write does not include `tp3`, `position_c_id`, `size_c`, `pnl_c` columns (or migration would fail)
- No `[TP1] ... Position C ...` lines (Phase 1 already ensured this)
- No `tp2_hit` status entries
- No errors from telegram alerts (the refactored `alertNewTrade` template fires)

If any of these fire as failures, the migration is incomplete and Phase 2 needs a follow-up patch.

- [ ] **Step 7: Keep the backup file**

The backup at `./backup-pre-phase2-2026-05-09.db` (from Task 1) should remain on the laptop until you're confident the migration stuck. Worth holding for at least 24 hours of live trading.

---

## Self-review

**Spec coverage check:**
- [x] Pre-flight DB backup → Task 1
- [x] analyst-agent.ts C-projection cleanup → Task 2
- [x] Telegram alerts refactor (alertNewTrade, Tp1Hit, Tp2Hit) + delete alertTp3Hit → Task 3
- [x] scheduler classifyCloseReason narrow + tp3 fallback → Task 4
- [x] Dead-but-typed wires sweep (3 in scheduler, 1 already in Task 3) → Task 5
- [x] Schema migrations (3 tables) → Task 6 sub-steps
- [x] CRITICAL: delete legacy add-column migrations (Codex BLOCKER) → Task 6 Step 6
- [x] Static CHECK constraint updates → Task 6 Step 7
- [x] OPEN_STATUSES_SQL refactor → Task 6 Step 8
- [x] TypeScript types tightening (drop tp2_hit + 6 C-fields, drop @deprecated JSDocs) → Task 7 Step 1
- [x] mcp-tools.ts:21 drop tp2_hit → Task 7 Step 2
- [x] Test fixture cleanup (5 files, Codex citations) → Task 7 Steps 3-7
- [x] Replace `three-leg-removal.test.ts` test 4 with PRAGMA assertion → Task 7 Step 5
- [x] Full test + tsc + backtest gate → Task 8
- [x] Push + verify migration on VPS → Task 9

**Placeholder scan:** None. Every step has exact file paths, exact commands, exact code blocks, or actual deletions called out.

**Type/method consistency:**
- `rebuildTradesTablePhase2` / `rebuildLessonsTablePhase2` / `rebuildSlTpOrdersTablePhase2` — declared in Task 6, called in Task 6 Step 5 with same names.
- `_assertTwoLegOnly` from Phase 1 Task 2 — referenced in `three-leg-removal.test.ts` tests 1+2 (kept from the original Phase 1 test file). Phase 2's Task 7 only replaces test 4, leaves tests 1-3 intact.
- `OPEN_STATUSES_SQL` — referenced in Task 6 Step 8 with the same name as the existing line 539.
- `TradeStatus`, `TradeRecord`, `Lesson` — names match Phase 1 spec / Codex inventory.

No drift detected.

**Ordering verified:**
- Task 7's type tightening REQUIRES Tasks 2-5 to land first (otherwise `analyst-agent.ts:199` reads `t.size_c` which would tsc-fail when `size_c` is dropped from `TradeRecord`).
- Task 6's atomic database changes can technically run before Tasks 2-5 (DB layer is independent of read-path code), but the plan keeps it after Task 5 so the implementer doesn't have to mentally juggle a partial state.
- Task 7's atomic type+test changes ALWAYS commit together — splitting them would leave the codebase in a tsc-failing state mid-task.

**Risk hot spots:**
- **Task 6 Step 6 (delete legacy add-columns)** — if forgotten, Phase 2 silently undoes itself on every boot. The plan calls this out explicitly with the "BLOCKER fix" tag.
- **Task 7 Step 5 (three-leg-removal.test.ts test 4 replacement)** — the new tests skip gracefully if the local DB hasn't been migrated. Production VPS will run the migration on first deploy. Local dev environments may need a one-time `rm data/trading-bot.db` + restart to trigger fresh init OR manually invoke the migration via a one-shot script.

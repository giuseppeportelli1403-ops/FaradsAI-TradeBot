// Database — SQLite Setup + Queries
// Uses sql.js (WASM-based SQLite) for local storage
//
// Tables:
//   trades          — split-leg trade records with full context
//   lessons         — structured JSON lessons from Reflection Agent
//   research_briefs — daily briefs from Market Researcher Agent
//   analyst_log     — approval/rejection log from Trade Analyst
//   sl_tp_orders    — audit of active split-position legs + deal_id for Capital.com position lookup
//   daily_pnl_log   — daily P&L snapshots for kill switch tracking

import initSqlJs, { type Database } from 'sql.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'node:crypto';
import { alertSystemWarning } from '../notifications/telegram.js';
import type {
  TradeRecord, TradeStatus, StrategyTag, Direction,
  Lesson, ResearchBrief, AnalystDecision,
} from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', '..', 'data', 'trading-bot.db');

let db: Database;

// ==================== INIT ====================

export function initDatabase(): void {
  // Sync wrapper — call initDatabaseAsync() instead for proper setup
  console.log('Database init requested. Call initDatabaseAsync() for full setup.');
}

export async function initDatabaseAsync(): Promise<void> {
  const SQL = await initSqlJs();

  if (existsSync(DB_PATH)) {
    const fileBuffer = readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  createTables();
  console.log(`Database initialised at ${DB_PATH}`);
}

// Exported as of 2026-04-29 (audit-3 fix scanner+misc P0-1) so the entry
// point can flush the in-memory sql.js database to disk on SIGTERM/SIGINT.
export function saveToFile(): void {
  const data = db.export();
  const buffer = Buffer.from(data);
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(DB_PATH, buffer);
}

// ==================== SCHEMA-VERSION HELPERS ====================
// SQLite cannot ALTER a CHECK constraint in place. For the 2-leg → 3-leg
// upgrade on 2026-04-21, we rebuild `sl_tp_orders` and `trades` if either
// still carries the old constraint. Standard SQLite recreate pattern: new
// table with updated schema, copy data, drop old, rename.

function sltpOrdersHasLegCCheck(): boolean {
  const rows = db.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='sl_tp_orders'");
  const schema = rows[0]?.values[0]?.[0] as string | undefined;
  return !!schema && /leg IN \('A', 'B', 'C'\)/.test(schema);
}

function rebuildSltpOrdersTable(): void {
  console.log('[DB Migration] Rebuilding sl_tp_orders with leg=\'A\'|\'B\'|\'C\' CHECK');
  db.run('BEGIN TRANSACTION');
  try {
    db.run('ALTER TABLE sl_tp_orders RENAME TO sl_tp_orders_old');
    db.run(`
      CREATE TABLE sl_tp_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trade_id TEXT NOT NULL,
        leg TEXT NOT NULL CHECK(leg IN ('A', 'B', 'C')),
        instrument TEXT NOT NULL,
        direction TEXT NOT NULL,
        quantity REAL NOT NULL,
        sl_price REAL,
        tp_price REAL,
        trailing_stop_distance REAL,
        deal_id TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        triggered_at TEXT,
        FOREIGN KEY (trade_id) REFERENCES trades(id)
      )
    `);
    db.run(`
      INSERT INTO sl_tp_orders (id, trade_id, leg, instrument, direction, quantity, sl_price, tp_price, trailing_stop_distance, deal_id, is_active, created_at, triggered_at)
      SELECT id, trade_id, leg, instrument, direction, quantity, sl_price, tp_price, trailing_stop_distance, deal_id, is_active, created_at, triggered_at FROM sl_tp_orders_old
    `);
    db.run('DROP TABLE sl_tp_orders_old');
    db.run('CREATE INDEX IF NOT EXISTS idx_sl_tp_active ON sl_tp_orders(is_active)');
    db.run('COMMIT');
  } catch (err) {
    db.run('ROLLBACK');
    throw err;
  }
}

function tradesHasClosedEarlyStatus(): boolean {
  // Strictest (newest) marker in the trades CHECK constraint. Any DB missing
  // it needs rebuildTradesTable — which produces a schema with every historical
  // addition (tp2_hit from 2026-04-21, closed_early from 2026-04-23).
  const rows = db.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='trades'");
  const schema = rows[0]?.values[0]?.[0] as string | undefined;
  return !!schema && /'closed_early'/.test(schema);
}

function rebuildTradesTable(): void {
  console.log('[DB Migration] Rebuilding trades with status including \'tp2_hit\' + \'closed_early\' + closure_reason column + 3-leg columns');
  db.run('BEGIN TRANSACTION');
  try {
    db.run('ALTER TABLE trades RENAME TO trades_old');
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
        tp3 REAL,
        position_a_id TEXT,
        position_b_id TEXT,
        position_c_id TEXT,
        size_a REAL NOT NULL,
        size_b REAL NOT NULL,
        size_c REAL,
        status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'tp1_hit', 'tp2_hit', 'complete', 'sl_hit', 'closed_early')),
        pnl_a REAL,
        pnl_b REAL,
        pnl_c REAL,
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
    // Copy existing rows, leaving tp3/position_c_id/size_c/pnl_c NULL.
    // 2026-04-29 audit-3 r4 fix (scanner+misc P1-8 / P0-3): preserve
    // closure_reason from the OLD table when present. Pre-fix the SELECT
    // omitted closure_reason entirely; if a partially-migrated DB had
    // closure_reason added via the ALTER block but later landed on the
    // rebuild path (e.g. older CHECK constraint missing 'closed_early'),
    // every historical closure_reason value would be silently dropped.
    // Detect the column on the OLD table; copy it through if present,
    // default NULL otherwise.
    const oldColsResult = db.exec("PRAGMA table_info(trades_old)");
    const oldCols: string[] = oldColsResult[0]?.values.map((row) => String(row[1])) ?? [];
    const oldHasClosureReason = oldCols.includes('closure_reason');
    const closureReasonSelect = oldHasClosureReason ? 'closure_reason' : 'NULL AS closure_reason';
    db.run(`
      INSERT INTO trades (id, strategy_tag, instrument, instrument_category, direction, setup_type, entry, sl, tp1, tp2, position_a_id, position_b_id, size_a, size_b, status, pnl_a, pnl_b, pnl_total, composite_score, kill_zone, news_category, analyst_decision, reasoning, closure_reason, opened_at, closed_at)
      SELECT id, strategy_tag, instrument, instrument_category, direction, setup_type, entry, sl, tp1, tp2, position_a_id, position_b_id, size_a, size_b, status, pnl_a, pnl_b, pnl_total, composite_score, kill_zone, news_category, analyst_decision, reasoning, ${closureReasonSelect}, opened_at, closed_at FROM trades_old
    `);
    db.run('DROP TABLE trades_old');
    db.run('CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status)');
    db.run('CREATE INDEX IF NOT EXISTS idx_trades_strategy ON trades(strategy_tag)');
    db.run('CREATE INDEX IF NOT EXISTS idx_trades_instrument ON trades(instrument)');
    db.run('CREATE INDEX IF NOT EXISTS idx_trades_opened ON trades(opened_at)');
    db.run('COMMIT');
  } catch (err) {
    db.run('ROLLBACK');
    throw err;
  }
}

// 2026-05-09 Phase 2 of 3-leg removal: drops tp3/position_c_id/size_c/pnl_c
// columns, drops 'tp2_hit' from status CHECK, drops 'C' from sl_tp_orders.leg
// CHECK, drops position_c_outcome/pnl_c_r from lessons. Idempotent: each
// rebuild's guard exits early once the new schema is in place. See
// docs/superpowers/specs/2026-05-09-3-leg-removal-phase-2-design.md.
function rebuildTradesTablePhase2(): void {
  const cols = db.exec('PRAGMA table_info(trades)')[0]?.values.map((r) => String(r[1])) ?? [];
  const stillHas3LegCols = cols.includes('tp3') || cols.includes('position_c_id')
    || cols.includes('size_c') || cols.includes('pnl_c');
  const checkSql = String(db.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='trades'")[0]?.values[0]?.[0] ?? '');
  const stillHasTp2Hit = checkSql.includes("'tp2_hit'");
  if (!stillHas3LegCols && !stillHasTp2Hit) return;

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

function rebuildLessonsTablePhase2(): void {
  const cols = db.exec('PRAGMA table_info(lessons)')[0]?.values.map((r) => String(r[1])) ?? [];
  if (!cols.includes('position_c_outcome') && !cols.includes('pnl_c_r')) return;

  console.log('[DB Migration] Phase 2: dropping position_c_outcome/pnl_c_r columns from lessons');
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

function rebuildSlTpOrdersTablePhase2(): void {
  const checkSql = String(db.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='sl_tp_orders'")[0]?.values[0]?.[0] ?? '');
  const stillAllowsLegC = checkSql.includes("'C'");
  if (!stillAllowsLegC) return;

  console.log("[DB Migration] Phase 2: dropping leg='C' from sl_tp_orders + deleting historical Leg C rows");
  db.run('PRAGMA foreign_keys = OFF');
  db.run('BEGIN TRANSACTION');
  try {
    db.run("DELETE FROM sl_tp_orders WHERE leg='C'");
    db.run('ALTER TABLE sl_tp_orders RENAME TO sl_tp_orders_old_phase2');
    db.run(`
      CREATE TABLE sl_tp_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trade_id TEXT NOT NULL,
        leg TEXT NOT NULL CHECK(leg IN ('A', 'B')),
        instrument TEXT NOT NULL,
        direction TEXT NOT NULL,
        quantity REAL NOT NULL,
        sl_price REAL,
        tp_price REAL,
        trailing_stop_distance REAL,
        deal_id TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        triggered_at TEXT,
        FOREIGN KEY (trade_id) REFERENCES trades(id)
      )
    `);
    db.run(`
      INSERT INTO sl_tp_orders (id, trade_id, leg, instrument, direction, quantity, sl_price, tp_price, trailing_stop_distance, deal_id, is_active, created_at, triggered_at)
      SELECT id, trade_id, leg, instrument, direction, quantity, sl_price, tp_price, trailing_stop_distance, deal_id, is_active, created_at, triggered_at
      FROM sl_tp_orders_old_phase2
    `);
    db.run('DROP TABLE sl_tp_orders_old_phase2');
    db.run('CREATE INDEX IF NOT EXISTS idx_sl_tp_active ON sl_tp_orders(is_active)');
    db.run('COMMIT');
  } catch (err) {
    db.run('ROLLBACK');
    throw err;
  } finally {
    db.run('PRAGMA foreign_keys = ON');
  }
}

function createTables(): void {
  // 2-leg split-position architecture (Phase 2 of 2026-05-07; 3-leg legacy
  // removed in Phase 1 (2026-05-08) and Phase 2 (2026-05-09)):
  //   Leg A (size_a, ~70%) closes at TP1 → status = tp1_hit, SL of B moved to BE+offset
  //   Leg B (size_b, ~30%) closes at TP2 → status = complete
  //   Any leg hitting SL → status = sl_hit (logged even if A already closed at TP)
  // Historical context: tp3/position_c_id/size_c/pnl_c columns + tp2_hit
  // status existed in the 3-leg era; both removed in Phase 2.
  db.run(`
    CREATE TABLE IF NOT EXISTS trades (
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
    CREATE TABLE IF NOT EXISTS lessons (
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
    CREATE TABLE IF NOT EXISTS research_briefs (
      brief_id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS analyst_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trade_id TEXT NOT NULL,
      strategy_tag TEXT NOT NULL,
      decision TEXT NOT NULL CHECK(decision IN ('APPROVE', 'REJECT', 'MODIFY')),
      reason TEXT,
      modifications TEXT,
      confidence REAL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS sl_tp_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trade_id TEXT NOT NULL,
      leg TEXT NOT NULL CHECK(leg IN ('A', 'B')),
      instrument TEXT NOT NULL,
      direction TEXT NOT NULL,
      quantity REAL NOT NULL,
      sl_price REAL,
      tp_price REAL,
      trailing_stop_distance REAL,
      deal_id TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      triggered_at TEXT,
      FOREIGN KEY (trade_id) REFERENCES trades(id)
    )
  `);

  // Idempotent migrations for pre-existing older DBs (sql.js has no
  // real migrations). PRAGMA table_info() lists every column; we ADD missing
  // columns. Safe to run on every boot — ALTER TABLE ADD COLUMN is a no-op if
  // the column already exists... except it isn't (SQLite throws "duplicate
  // column"), so we check first.
  const sltpCols = db.exec('PRAGMA table_info(sl_tp_orders)');
  const existingSltpCols = sltpCols[0]
    ? sltpCols[0].values.map((row) => row[1] as string)
    : [];
  if (!existingSltpCols.includes('deal_id')) {
    db.run('ALTER TABLE sl_tp_orders ADD COLUMN deal_id TEXT');
  }

  // Legacy 3-leg add-column migrations removed in Phase 2 (2026-05-09).
  // Phase 2 rebuild functions below (rebuildTradesTablePhase2 etc.) drop
  // those columns; re-adding them on every boot would silently undo the
  // migration. closure_reason is the only remaining add-column migration —
  // it's an independent column unrelated to the 3-leg surface.
  const tradesCols = db.exec('PRAGMA table_info(trades)');
  const existingTradesCols = tradesCols[0]
    ? tradesCols[0].values.map((row) => row[1] as string)
    : [];
  // 2026-04-23: closure_reason captures why an agent closed a trade before
  // any TP/SL trigger (e.g. fill-slippage R:R violation). Nullable; null on
  // legacy rows and on trades that exit cleanly via tp1_hit/complete/sl_hit.
  if (!existingTradesCols.includes('closure_reason')) {
    db.run('ALTER TABLE trades ADD COLUMN closure_reason TEXT');
  }

  // CHECK-constraint changes cannot be done via ALTER TABLE in SQLite. For
  // pre-existing DBs with older constraints, we rebuild via the standard
  // SQLite pattern: create new with updated schema, copy data, drop old,
  // rename. Each rebuild is idempotent.
  // Constraint history:
  //   - sl_tp_orders.leg: 'A'|'B' → 'A'|'B'|'C'              (2026-04-21)
  //   - trades.status:    added 'tp2_hit'                     (2026-04-21)
  //   - trades.status:    added 'closed_early'                (2026-04-23)
  //   - PHASE 2 (2026-05-09): drops tp2_hit + 3-leg cols + 'C' leg
  if (existingSltpCols.length > 0 && !sltpOrdersHasLegCCheck()) {
    rebuildSltpOrdersTable();
  }
  if (existingTradesCols.length > 0 && !tradesHasClosedEarlyStatus()) {
    rebuildTradesTable();
  }
  // Phase 2: drops 3-leg columns + 'tp2_hit' status + 'C' leg. Idempotent —
  // each function exits early once its target schema is already in place.
  rebuildTradesTablePhase2();
  rebuildLessonsTablePhase2();
  rebuildSlTpOrdersTablePhase2();

  db.run(`
    CREATE TABLE IF NOT EXISTS daily_pnl_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      realised_pnl REAL NOT NULL DEFAULT 0,
      unrealised_pnl REAL NOT NULL DEFAULT 0,
      total_pnl REAL NOT NULL DEFAULT 0,
      equity REAL NOT NULL,
      pnl_pct REAL NOT NULL DEFAULT 0,
      kill_switch_triggered INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // ==================== MIGRATION 007 (2026-05-12) ====================
  // Scoring pipeline audit + silent-rejection fix.
  // Spec: specs/001-scoring-pipeline-audit/spec.md
  // Adds:
  //   - score_breakdowns         (US-1: deterministic scoring audit trail)
  //   - trade_rejections         (US-2: categorised rejections at all 4 layers)
  //   - pm_state                 (key/value config — was implicit before)
  //   - 3 columns on analyst_log (category, is_fail_closed, subcategory)
  //   - 3 default pm_state rows  (cooldown + risk-budget config)
  // All operations idempotent. Safe to re-run on every boot.

  db.run(`
    CREATE TABLE IF NOT EXISTS score_breakdowns (
      trade_id TEXT PRIMARY KEY,
      instrument TEXT NOT NULL,
      composite_score INTEGER NOT NULL,
      tier INTEGER,
      breakdown_json TEXT NOT NULL,
      scored_at TEXT NOT NULL DEFAULT (datetime('now')),
      scorer_version TEXT NOT NULL,
      FOREIGN KEY (trade_id) REFERENCES trades(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS trade_rejections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      instrument TEXT NOT NULL,
      layer TEXT NOT NULL CHECK(layer IN ('scanner', 'executor', 'post_approval')),
      category TEXT NOT NULL,
      subcategory TEXT,
      reason_text TEXT NOT NULL,
      proposed_score INTEGER,
      proposed_tier INTEGER,
      request_id TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS pm_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // analyst_log columns — idempotent ADD COLUMN (mirrors the deal_id /
  // closure_reason pattern at lines 486-508 of this file).
  const analystLogCols = db.exec('PRAGMA table_info(analyst_log)');
  const existingAnalystLogCols = analystLogCols[0]
    ? analystLogCols[0].values.map((row) => row[1] as string)
    : [];
  if (!existingAnalystLogCols.includes('category')) {
    db.run('ALTER TABLE analyst_log ADD COLUMN category TEXT');
  }
  if (!existingAnalystLogCols.includes('is_fail_closed')) {
    db.run('ALTER TABLE analyst_log ADD COLUMN is_fail_closed INTEGER DEFAULT 0');
  }
  if (!existingAnalystLogCols.includes('subcategory')) {
    db.run('ALTER TABLE analyst_log ADD COLUMN subcategory TEXT');
  }

  // pm_state defaults — INSERT OR IGNORE preserves owner's custom values
  // across restarts.
  db.run(
    "INSERT OR IGNORE INTO pm_state (key, value) VALUES ('cooldown_max_consecutive_losses', '3')"
  );
  db.run(
    "INSERT OR IGNORE INTO pm_state (key, value) VALUES ('cooldown_clear_after_hours', '24')"
  );
  db.run(
    "INSERT OR IGNORE INTO pm_state (key, value) VALUES ('max_total_risk_pct', '0.0')"
  );

  // Indexes for the new tables
  db.run('CREATE INDEX IF NOT EXISTS idx_rejections_ts_layer ON trade_rejections (ts, layer)');
  db.run('CREATE INDEX IF NOT EXISTS idx_rejections_instrument_ts ON trade_rejections (instrument, ts)');
  db.run('CREATE INDEX IF NOT EXISTS idx_rejections_category ON trade_rejections (category)');
  db.run('CREATE INDEX IF NOT EXISTS idx_analyst_log_category ON analyst_log (category)');

  // ==================== END MIGRATION 007 ====================

  // Indexes for common query patterns
  db.run('CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status)');
  db.run('CREATE INDEX IF NOT EXISTS idx_trades_strategy ON trades(strategy_tag)');
  db.run('CREATE INDEX IF NOT EXISTS idx_trades_instrument ON trades(instrument)');
  db.run('CREATE INDEX IF NOT EXISTS idx_trades_opened ON trades(opened_at)');
  db.run('CREATE INDEX IF NOT EXISTS idx_lessons_strategy ON lessons(strategy_tag)');
  db.run('CREATE INDEX IF NOT EXISTS idx_lessons_setup ON lessons(setup_type)');
  db.run('CREATE INDEX IF NOT EXISTS idx_lessons_category ON lessons(instrument_category)');
  db.run('CREATE INDEX IF NOT EXISTS idx_lessons_killzone ON lessons(kill_zone)');
  db.run('CREATE INDEX IF NOT EXISTS idx_sl_tp_active ON sl_tp_orders(is_active)');
  db.run('CREATE INDEX IF NOT EXISTS idx_daily_pnl_date ON daily_pnl_log(date)');

  saveToFile();
}

// ==================== TRADES ====================

export function insertTrade(trade: Partial<Omit<TradeRecord, 'closed_at'>>): void {
  // Defensive normalization: the Claude agent's trade JSON payload to the
  // `log_trade` MCP tool may omit fields that the schema requires. sql.js
  // rejects `undefined` bind parameters with
  //   "Wrong API use: tried to bind a value of an unknown type (undefined)"
  // — a cryptic error that orphaned Farad's first live trade on 2026-04-21
  // 12:58 UTC (trade executed on Capital but local DB insert failed).
  //
  // We normalize before binding:
  //   - Required keys throw a clear error naming the missing field.
  //   - NOT-NULL aux text columns default to sentinel strings.
  //   - NOT-NULL numeric columns default to 0 (weird-but-inspectable).
  //   - Nullable columns null-coerce.
  //   - opened_at defaults to now().

  // id is the trades-table primary key. Convention is `trade-{hash}-{uuid8}`
  // assigned at proposal time. If a caller forgets it, self-heal with a
  // distinguishable fallback id and warn loudly — the fallback prefix makes
  // orphaned writes greppable so the missing caller can be tracked down.
  if (!trade.id) {
    const fallbackId = `trade-fallback-${randomUUID().slice(0, 8)}`;
    const payloadKeys = Object.keys(trade).join(',');
    console.warn(
      `[insertTrade] trade.id missing — generated fallback ${fallbackId}. ` +
        `Caller should supply an id (convention: trade-{hash}-{uuid8}). ` +
        `Payload keys: ${payloadKeys}`
    );
    // Fire-and-forget Telegram alert: a fallback id firing is a programming
    // error (some caller bypassed the id-setting contract), and console.warn
    // alone gets buried in pm2-out.log. Non-blocking by design.
    alertSystemWarning(
      `⚠️ insertTrade self-healed missing id → ${fallbackId}. ` +
        `A caller bypassed the trade-{hash}-{uuid8} convention. ` +
        `Payload keys: ${payloadKeys}. Check pm2-out.log for stack context.`
    ).catch(() => { /* alert failure non-blocking */ });
    trade.id = fallbackId;
  }

  const missing: string[] = [];
  if (!trade.strategy_tag) missing.push('strategy_tag');
  if (!trade.instrument) missing.push('instrument');
  if (!trade.direction) missing.push('direction');
  if (missing.length > 0) {
    throw new Error(
      `insertTrade: required field(s) missing: ${missing.join(', ')}. Payload: ${JSON.stringify(trade)}`
    );
  }

  const asNum = (v: unknown, fallback: number): number =>
    typeof v === 'number' && !isNaN(v) ? v : fallback;
  const asStrOrNull = (v: unknown): string | null =>
    v === undefined || v === null ? null : String(v);

  const row = {
    id: String(trade.id),
    strategy_tag: trade.strategy_tag!,
    instrument: String(trade.instrument),
    instrument_category: String(trade.instrument_category ?? 'unknown'),
    direction: trade.direction!,
    setup_type: String(trade.setup_type ?? 'unspecified'),
    entry: asNum(trade.entry, 0),
    sl: asNum(trade.sl, 0),
    tp1: asNum(trade.tp1, 0),
    tp2: asNum(trade.tp2, 0),
    position_a_id: asStrOrNull(trade.position_a_id),
    position_b_id: asStrOrNull(trade.position_b_id),
    size_a: asNum(trade.size_a, 0),
    size_b: asNum(trade.size_b, 0),
    status: trade.status ?? 'open',
    composite_score: asNum(trade.composite_score, 0),
    kill_zone: asStrOrNull(trade.kill_zone),
    news_category: asStrOrNull(trade.news_category),
    analyst_decision: asStrOrNull(trade.analyst_decision),
    reasoning: asStrOrNull(trade.reasoning),
    closure_reason: asStrOrNull(trade.closure_reason),     // NEW (2026-04-23)
    opened_at: String(trade.opened_at ?? new Date().toISOString()),
  };

  db.run(`
    INSERT INTO trades (id, strategy_tag, instrument, instrument_category, direction,
      setup_type, entry, sl, tp1, tp2, position_a_id, position_b_id,
      size_a, size_b,
      status, composite_score, kill_zone, news_category, analyst_decision, reasoning,
      closure_reason, opened_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    row.id, row.strategy_tag, row.instrument, row.instrument_category,
    row.direction, row.setup_type, row.entry, row.sl, row.tp1, row.tp2,
    row.position_a_id, row.position_b_id,
    row.size_a, row.size_b,
    row.status, row.composite_score, row.kill_zone, row.news_category,
    row.analyst_decision, row.reasoning, row.closure_reason, row.opened_at,
  ]);
  saveToFile();
}

export function updateTradeStatus(
  tradeId: string,
  status: TradeStatus,
  pnlA?: number,
  pnlB?: number,
): void {
  // pnl_total = sum of whichever leg pnls have been populated. COALESCE via the
  // existing stored values so partial updates don't clobber earlier leg
  // pnl_a/pnl_b that were set on previous calls.
  const closedAt = status === 'complete' || status === 'sl_hit' ? new Date().toISOString() : null;

  db.run(`
    UPDATE trades
    SET status = ?,
        pnl_a = COALESCE(?, pnl_a),
        pnl_b = COALESCE(?, pnl_b),
        pnl_total = COALESCE(pnl_a, 0) + COALESCE(pnl_b, 0),
        closed_at = COALESCE(?, closed_at)
    WHERE id = ?
  `, [status, pnlA ?? null, pnlB ?? null, closedAt, tradeId]);
  saveToFile();
}

// Status values that count as "still has live exposure on Capital.com":
//   - 'open'     — all 3 legs still active
//   - 'tp1_hit'  — Leg A closed, Legs B+C still running
//   - 'tp2_hit'  — Legs A+B closed, Leg C still running (added 2026-04-28
//                  audit; previously omitted, which made tp2_hit trades
//                  invisible to the coordination lock — Codex P1 #10)
const OPEN_STATUSES_SQL = "status IN ('open', 'tp1_hit')";

export function getOpenTrades(): TradeRecord[] {
  const result = db.exec(`SELECT * FROM trades WHERE ${OPEN_STATUSES_SQL} ORDER BY opened_at DESC`);
  return resultToObjects<TradeRecord>(result);
}

export function getTradeById(tradeId: string): TradeRecord | null {
  const result = db.exec('SELECT * FROM trades WHERE id = ?', [tradeId]);
  const rows = resultToObjects<TradeRecord>(result);
  return rows[0] || null;
}

export function getTradeHistory(limit: number, strategyTag?: StrategyTag): TradeRecord[] {
  const query = strategyTag
    ? 'SELECT * FROM trades WHERE strategy_tag = ? ORDER BY opened_at DESC LIMIT ?'
    : 'SELECT * FROM trades ORDER BY opened_at DESC LIMIT ?';
  const params = strategyTag ? [strategyTag, limit] : [limit];
  const result = db.exec(query, params);
  return resultToObjects<TradeRecord>(result);
}

export function getTradesForWeek(weekStart: string, weekEnd: string): TradeRecord[] {
  const result = db.exec(
    'SELECT * FROM trades WHERE opened_at >= ? AND opened_at < ? ORDER BY opened_at',
    [weekStart, weekEnd]
  );
  return resultToObjects<TradeRecord>(result);
}

export function getOpenTradesByInstrument(instrument: string): TradeRecord[] {
  const result = db.exec(
    `SELECT * FROM trades WHERE instrument = ? AND ${OPEN_STATUSES_SQL}`,
    [instrument]
  );
  return resultToObjects<TradeRecord>(result);
}

export function countOpenPositions(): number {
  const result = db.exec(`SELECT COUNT(*) as count FROM trades WHERE ${OPEN_STATUSES_SQL}`);
  return result[0]?.values[0]?.[0] as number || 0;
}

// ==================== LESSONS ====================

// 2026-04-29 audit fix (P0-RF1): the lessons table schema declares
// `position_c_outcome` and `pnl_c_r` columns (added 2026-04-21 with the
// 3-leg upgrade), the Lesson interface declares them, the prompt asks
// the LLM for them — but pre-fix this INSERT statement OMITTED both
// columns. Every Reflection run silently dropped the Leg-C outcome on
// the floor, leaving NULLs in the data the Weekly Review Agent learns
// from. Pre-fix shape: 25 columns, 25 placeholders. Post-fix: 27 each.
//
// 2026-04-29 audit fix (P1-RF3): boolean coercion. Pre-fix
// `lesson.was_bias_correct ? 1 : 0` would coerce the STRING "false" to
// 1 because non-empty strings are truthy in JS. The LLM occasionally
// emits stringy booleans. coerceBool() below strictly maps the
// recognised true-shapes only; everything else (including "false",
// null, undefined, NaN) maps to 0.
function coerceBool(v: unknown): 0 | 1 {
  if (v === true) return 1;
  if (typeof v === 'number') return v === 1 ? 1 : 0;
  if (typeof v === 'string') {
    const lower = v.toLowerCase().trim();
    return lower === 'true' || lower === 'yes' || lower === '1' ? 1 : 0;
  }
  return 0;
}

function asNumOrNull(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function asStrOrNull(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  return String(v);
}

export function insertLesson(lesson: Lesson): void {
  db.run(`
    INSERT INTO lessons (lesson_id, timestamp, strategy_tag, instrument, instrument_category,
      direction, setup_type, kill_zone, hold_duration, news_category, news_description,
      composite_score, analyst_decision, position_a_outcome, position_b_outcome,
      pnl_a_r, pnl_b_r, pnl_total_r, was_bias_correct, was_trigger_valid,
      was_news_correctly_weighted, was_split_execution_clean, score_accuracy_notes,
      lesson, rule_suggestion)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    lesson.lesson_id, lesson.timestamp, lesson.strategy_tag, lesson.instrument,
    lesson.instrument_category, lesson.direction, lesson.setup_type, lesson.kill_zone,
    asStrOrNull(lesson.hold_duration), asStrOrNull(lesson.news_category), asStrOrNull(lesson.news_description),
    asNumOrNull(lesson.composite_score), asStrOrNull(lesson.analyst_decision),
    asStrOrNull(lesson.position_a_outcome), asStrOrNull(lesson.position_b_outcome),
    asNumOrNull(lesson.pnl_a_r), asNumOrNull(lesson.pnl_b_r),
    asNumOrNull(lesson.pnl_total_r),
    coerceBool(lesson.was_bias_correct), coerceBool(lesson.was_trigger_valid),
    coerceBool(lesson.was_news_correctly_weighted), coerceBool(lesson.was_split_execution_clean),
    asStrOrNull(lesson.score_accuracy_notes), String(lesson.lesson ?? ''),
    asStrOrNull(lesson.rule_suggestion),
  ]);
  saveToFile();
}

export function getLessons(filters: {
  setup_type?: string;
  instrument_category?: string;
  kill_zone?: string;
  strategy_tag?: StrategyTag;
  limit?: number;
}): Lesson[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.setup_type) {
    conditions.push('setup_type = ?');
    params.push(filters.setup_type);
  }
  if (filters.instrument_category) {
    conditions.push('instrument_category = ?');
    params.push(filters.instrument_category);
  }
  if (filters.kill_zone) {
    conditions.push('kill_zone = ?');
    params.push(filters.kill_zone);
  }
  if (filters.strategy_tag) {
    conditions.push('strategy_tag = ?');
    params.push(filters.strategy_tag);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = filters.limit || 20;
  params.push(limit);

  const result = db.exec(
    `SELECT * FROM lessons ${where} ORDER BY timestamp DESC LIMIT ?`,
    params
  );
  return resultToObjects<Lesson>(result);
}

export function getLessonWinRate(filters: {
  setup_type?: string;
  instrument_category?: string;
  kill_zone?: string;
  strategy_tag?: StrategyTag;
}): { total: number; wins: number; win_rate: number } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.setup_type) { conditions.push('setup_type = ?'); params.push(filters.setup_type); }
  if (filters.instrument_category) { conditions.push('instrument_category = ?'); params.push(filters.instrument_category); }
  if (filters.kill_zone) { conditions.push('kill_zone = ?'); params.push(filters.kill_zone); }
  if (filters.strategy_tag) { conditions.push('strategy_tag = ?'); params.push(filters.strategy_tag); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const totalResult = db.exec(`SELECT COUNT(*) FROM lessons ${where}`, params);
  const total = totalResult[0]?.values[0]?.[0] as number || 0;

  const winConditions = [...conditions, 'pnl_total_r > 0'];
  const winWhere = `WHERE ${winConditions.join(' AND ')}`;
  const winsResult = db.exec(`SELECT COUNT(*) FROM lessons ${winWhere}`, [...params]);
  const wins = winsResult[0]?.values[0]?.[0] as number || 0;

  return { total, wins, win_rate: total > 0 ? Math.round((wins / total) * 1000) / 10 : 0 };
}

// ==================== CRITICAL-SECTION TRACKING ====================
// 2026-05-05 audit (B3): the shutdown race. Pre-fix the SIGTERM handler
// called saveToFile() and then setTimeout(exit, 500). If place_split_trade
// was mid-await between leg placement and insertTrade, the shutdown
// handler would flush the DB BEFORE the trade row was inserted, then exit
// before the function could resume. The trade was live on Capital but the
// DB had no record.
//
// This counter lets the agent flag "I'm in a critical section — don't
// shut down until I finish or timeout". The shutdown handler in src/index.ts
// polls getCriticalSectionDepth() and waits (up to ~1.4s, well under pm2's
// default 1.6s SIGKILL timeout) for it to reach 0 before saveToFile+exit.

let criticalSectionDepth = 0;

export function enterCriticalSection(): void {
  criticalSectionDepth++;
}

export function exitCriticalSection(): void {
  criticalSectionDepth = Math.max(0, criticalSectionDepth - 1);
}

export function getCriticalSectionDepth(): number {
  return criticalSectionDepth;
}

/**
 * Convenience wrapper: run an async function inside a critical section.
 * The counter is incremented before the function starts and decremented
 * in `finally` so it's always cleaned up, even on throw.
 */
export async function withCriticalSection<T>(fn: () => Promise<T>): Promise<T> {
  enterCriticalSection();
  try {
    return await fn();
  } finally {
    exitCriticalSection();
  }
}

// ==================== RESEARCH BRIEFS ====================

export function saveResearchBrief(brief: ResearchBrief): void {
  db.run(
    'INSERT OR REPLACE INTO research_briefs (brief_id, date, content) VALUES (?, ?, ?)',
    [brief.brief_id, brief.date, JSON.stringify(brief)]
  );
  saveToFile();
}

// Maximum age for a "fresh" research brief. Beyond this, getLatestBrief()
// returns null + logs a loud warning so the ICT cycle treats the brief as
// missing rather than stale-but-current. The Researcher cron runs daily at
// 05:30 UTC + Sunday 22:00 UTC; with the bot up, the latest brief is always
// < 24h old. After bot downtime, this guard prevents week-old briefs from
// silently shaping today's decisions. Codex P1 #7, 2026-04-28.
const BRIEF_FRESHNESS_MAX_MS = 24 * 60 * 60_000;

export function getLatestBrief(): ResearchBrief | null {
  const result = db.exec('SELECT content, created_at FROM research_briefs ORDER BY created_at DESC LIMIT 1');
  if (!result[0]?.values[0]?.[0]) return null;
  const createdAt = result[0].values[0][1] as string | undefined;
  if (createdAt) {
    const ageMs = Date.now() - Date.parse(createdAt);
    if (Number.isFinite(ageMs) && ageMs > BRIEF_FRESHNESS_MAX_MS) {
      console.warn(
        `[Database] Latest research brief is ${Math.round(ageMs / 60_000 / 60)}h old (cutoff ${BRIEF_FRESHNESS_MAX_MS / 60_000 / 60}h). ` +
          `Returning null — Researcher cron may be failing or bot was offline. Run: node check the scheduler logs.`,
      );
      return null;
    }
  }
  return JSON.parse(result[0].values[0][0] as string);
}

// ==================== ANALYST LOG ====================

export function logAnalystDecision(tradeId: string, strategyTag: StrategyTag, decision: AnalystDecision): void {
  db.run(
    // 2026-05-12 (Spec 002 / MODIFY removal): the `modifications` column
    // is preserved in the schema for historical readability but new rows
    // ALWAYS write the literal '{}'. The AnalystDecision type no longer
    // carries a `modifications` field; pre-2026-05-11 rows still carry
    // their original JSON. DB CHECK constraint kept permissive.
    'INSERT INTO analyst_log (trade_id, strategy_tag, decision, reason, modifications, confidence) VALUES (?, ?, ?, ?, ?, ?)',
    [tradeId, strategyTag, decision.decision, decision.reason, '{}', decision.confidence]
  );
  saveToFile();
}

// ==================== SL/TP MONITORING ====================

export function createSlTpOrder(params: {
  trade_id: string;
  leg: 'A' | 'B';
  instrument: string;
  direction: Direction;
  quantity: number;
  sl_price?: number;
  tp_price?: number;
  trailing_stop_distance?: number;
  deal_id?: string;
}): void {
  db.run(`
    INSERT INTO sl_tp_orders (trade_id, leg, instrument, direction, quantity, sl_price, tp_price, trailing_stop_distance, deal_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    params.trade_id, params.leg, params.instrument, params.direction,
    params.quantity, params.sl_price ?? null, params.tp_price ?? null,
    params.trailing_stop_distance ?? null, params.deal_id ?? null,
  ]);
  saveToFile();
}

export interface ActiveSlTpOrder {
  id: number;
  trade_id: string;
  leg: string;
  instrument: string;
  direction: string;
  quantity: number;
  sl_price: number | null;
  tp_price: number | null;
  trailing_stop_distance: number | null;
  deal_id: string | null;
}

export function getActiveSlTpOrders(): ActiveSlTpOrder[] {
  const result = db.exec('SELECT * FROM sl_tp_orders WHERE is_active = 1');
  return resultToObjects(result);
}

/**
 * Same as getActiveSlTpOrders but filtered to one trade. Used by
 * `update_sl` and `close_position` MCP tools to discover the live deal_ids
 * to push changes to on Capital.com.
 */
export function getActiveSlTpOrdersByTradeId(tradeId: string): ActiveSlTpOrder[] {
  const result = db.exec(
    'SELECT * FROM sl_tp_orders WHERE trade_id = ? AND is_active = 1',
    [tradeId],
  );
  return resultToObjects(result);
}

/**
 * Find which trade record (if any) owns this Capital deal_id by checking
 * the position_a_id / position_b_id columns. Used by the `close_position`
 * MCP tool so the LLM can pass the dealId and we can find the corresponding
 * trade row to mark closed_early.
 *
 * (Pre-2026-05-09 this also checked position_c_id, dropped by the Phase 2
 * 3-leg-removal migration at database/index.ts:191-261.)
 */
export function getTradeByDealId(dealId: string): TradeRecord | null {
  const result = db.exec(
    'SELECT * FROM trades WHERE position_a_id = ? OR position_b_id = ?',
    [dealId, dealId],
  );
  const rows = resultToObjects<TradeRecord>(result);
  return rows[0] || null;
}

/**
 * Mark a trade as `closed_early` (the existing schema enum value) and set
 * closure_reason for audit. Used by the `close_position` MCP tool when the
 * agent intentionally closes a position before any TP/SL trigger.
 */
export function markTradeClosedEarly(tradeId: string, reason: string): void {
  db.run(
    `UPDATE trades
     SET status = 'closed_early',
         closure_reason = ?,
         closed_at = COALESCE(closed_at, datetime('now'))
     WHERE id = ?`,
    [reason, tradeId],
  );
  saveToFile();
}

export function updateSlPrice(tradeId: string, leg: string, newSl: number): void {
  db.run('UPDATE sl_tp_orders SET sl_price = ? WHERE trade_id = ? AND leg = ? AND is_active = 1', [newSl, tradeId, leg]);
  saveToFile();
}

export function setTrailingStop(tradeId: string, leg: string, distance: number): void {
  db.run('UPDATE sl_tp_orders SET trailing_stop_distance = ? WHERE trade_id = ? AND leg = ? AND is_active = 1', [distance, tradeId, leg]);
  saveToFile();
}

export function deactivateSlTpOrder(tradeId: string, leg: string): void {
  db.run("UPDATE sl_tp_orders SET is_active = 0, triggered_at = datetime('now') WHERE trade_id = ? AND leg = ? AND is_active = 1", [tradeId, leg]);
  saveToFile();
}

// ==================== DAILY P&L ====================

export function upsertDailyPnl(date: string, realised: number, unrealised: number, equity: number): void {
  const total = realised + unrealised;
  const pct = equity > 0 ? (total / equity) * 100 : 0;
  // Daily kill-switch threshold: -6%. Matches the runtime gate in
  // trading-agent.ts and swing-agent.ts (both use `pct <= -6`). Pre-2026-04-22
  // this DB column logged -4; the trading agents had been overriding that in
  // their own executeTool paths, so the DB record lagged the real gate.
  const killSwitch = pct <= -6 ? 1 : 0;

  db.run(`
    INSERT INTO daily_pnl_log (date, realised_pnl, unrealised_pnl, total_pnl, equity, pnl_pct, kill_switch_triggered)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET
      realised_pnl = ?, unrealised_pnl = ?, total_pnl = ?, equity = ?,
      pnl_pct = ?, kill_switch_triggered = ?, updated_at = datetime('now')
  `, [date, realised, unrealised, total, equity, pct, killSwitch,
      realised, unrealised, total, equity, pct, killSwitch]);
  saveToFile();
}

export function getDailyPnl(date: string): {
  realised_pnl: number;
  unrealised_pnl: number;
  total_pnl: number;
  equity: number;
  pnl_pct: number;
  kill_switch_triggered: boolean;
} | null {
  const result = db.exec('SELECT * FROM daily_pnl_log WHERE date = ?', [date]);
  const rows = resultToObjects<Record<string, unknown>>(result);
  if (!rows[0]) return null;
  const row = rows[0];
  return {
    realised_pnl: row.realised_pnl as number,
    unrealised_pnl: row.unrealised_pnl as number,
    total_pnl: row.total_pnl as number,
    equity: row.equity as number,
    pnl_pct: row.pnl_pct as number,
    kill_switch_triggered: (row.kill_switch_triggered as number) === 1,
  };
}

export function getWeeklyPnl(weekStart: string, weekEnd: string): number {
  const result = db.exec(
    'SELECT SUM(total_pnl) as weekly_total FROM daily_pnl_log WHERE date >= ? AND date < ?',
    [weekStart, weekEnd]
  );
  return result[0]?.values[0]?.[0] as number || 0;
}

/**
 * Sum of realised P&L from `startDate` (inclusive, YYYY-MM-DD) through today.
 * Used by the weekly kill switch in trading-agent.ts (Phase A3, 2026-05-04):
 * we want realised-only because the caller adds current unrealised
 * (balance.profitLoss) on top to avoid double-counting today's open positions.
 *
 * getWeeklyPnl above sums total_pnl which includes EOD unrealised — fine for
 * historical weekly review reporting but would double-count today's open
 * positions if used for the live kill-switch check.
 */
export function getRealisedPnlSince(startDate: string): number {
  const result = db.exec(
    'SELECT SUM(realised_pnl) as realised_total FROM daily_pnl_log WHERE date >= ?',
    [startDate]
  );
  return result[0]?.values[0]?.[0] as number || 0;
}

// ==================== HELPERS ====================

function resultToObjects<T>(result: Array<{ columns: string[]; values: unknown[][] }>): T[] {
  if (!result[0]) return [];
  const { columns, values } = result[0];
  return values.map(row => {
    const obj: Record<string, unknown> = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj as T;
  });
}

// ==================== SCORING-AUDIT HELPERS (Migration 007 / Spec 001) ====================
// Inserts and queries for the score_breakdowns + trade_rejections tables.
// Used by src/scoring/, src/rejection-log/, and the daily digest.

export interface ScoreBreakdownRow {
  trade_id: string;
  instrument: string;
  composite_score: number;
  tier: 1 | 2 | 3 | null;
  breakdown_json: string;     // JSON.stringify(breakdown)
  scorer_version: string;
  scored_at?: string;          // defaults to now() in SQL
}

export function insertScoreBreakdown(row: ScoreBreakdownRow): void {
  db.run(
    `INSERT OR REPLACE INTO score_breakdowns
       (trade_id, instrument, composite_score, tier, breakdown_json, scorer_version, scored_at)
     VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`,
    [
      row.trade_id,
      row.instrument,
      row.composite_score,
      row.tier ?? null,
      row.breakdown_json,
      row.scorer_version,
      row.scored_at ?? null,
    ]
  );
  saveToFile();
}

export interface TradeRejectionRow {
  instrument: string;
  layer: 'scanner' | 'executor' | 'post_approval';
  category: string;
  subcategory?: string | null;
  reason_text: string;
  proposed_score?: number | null;
  proposed_tier?: number | null;
  request_id?: string | null;
  ts?: string;  // defaults to now() in SQL
}

export function insertRejection(row: TradeRejectionRow): void {
  db.run(
    `INSERT INTO trade_rejections
       (ts, instrument, layer, category, subcategory, reason_text, proposed_score, proposed_tier, request_id)
     VALUES (COALESCE(?, datetime('now')), ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.ts ?? null,
      row.instrument,
      row.layer,
      row.category,
      row.subcategory ?? null,
      row.reason_text,
      row.proposed_score ?? null,
      row.proposed_tier ?? null,
      row.request_id ?? null,
    ]
  );
  saveToFile();
}

/**
 * Update an existing analyst_log row with category metadata after the
 * verdict is logged. Called by analyst layer to attach the categorised
 * rejection class to the existing decision row (avoids a second table).
 */
export function updateAnalystLogCategory(
  analystLogId: number,
  category: string,
  isFailClosed: boolean,
  subcategory?: string | null
): void {
  db.run(
    'UPDATE analyst_log SET category = ?, is_fail_closed = ?, subcategory = ? WHERE id = ?',
    [category, isFailClosed ? 1 : 0, subcategory ?? null, analystLogId]
  );
  saveToFile();
}

/**
 * Get the rowid of the most recently inserted analyst_log row in this
 * session. Helper for the analyst-side categoriser which needs to attach
 * a category to the row it just wrote via logAnalystDecision().
 */
export function getLastInsertedAnalystLogId(): number | null {
  const result = db.exec('SELECT last_insert_rowid() AS id');
  const id = result[0]?.values[0]?.[0];
  return typeof id === 'number' ? id : null;
}

export interface DailyRejectionRow {
  category: string;
  count: number;
  is_fail_closed: 0 | 1;
}

/**
 * Sum rejections for a given UTC date (YYYY-MM-DD) across both
 * trade_rejections and analyst_log. Returns one row per category with
 * its count and fail-closed flag.
 */
export function getDailyRejections(dateUtc: string): DailyRejectionRow[] {
  const result = db.exec(
    `SELECT category, COUNT(*) as count, 0 as is_fail_closed
       FROM trade_rejections
      WHERE substr(ts, 1, 10) = ?
   GROUP BY category
      UNION ALL
     SELECT category, COUNT(*) as count, COALESCE(is_fail_closed, 0) as is_fail_closed
       FROM analyst_log
      WHERE substr(created_at, 1, 10) = ?
        AND category IS NOT NULL
   GROUP BY category, is_fail_closed`,
    [dateUtc, dateUtc]
  );
  if (!result[0]) return [];
  return result[0].values.map((row) => ({
    category: String(row[0]),
    count: Number(row[1]),
    is_fail_closed: (Number(row[2]) === 1 ? 1 : 0) as 0 | 1,
  }));
}

export interface PmStateRow {
  key: string;
  value: string;
}

export function getPmState(key: string): string | null {
  const result = db.exec('SELECT value FROM pm_state WHERE key = ?', [key]);
  const value = result[0]?.values[0]?.[0];
  return value === undefined || value === null ? null : String(value);
}

export function setPmState(key: string, value: string): void {
  db.run(
    `INSERT INTO pm_state (key, value, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    [key, value]
  );
  saveToFile();
}

/**
 * For US-7: sum the deployed risk-pct of all currently-open trades.
 * The trades table has no explicit risk_pct column (yet) — it's derived
 * from the tier mapping at execution time. We approximate by joining to
 * score_breakdowns for new trades; for legacy trades without a breakdown
 * we infer from composite_score using the same tier mapping the scanner
 * uses. Range-mode setups deploy 0.25% (half-size); detect from setup_type.
 */
export function getOpenTradesRiskPctSum(): number {
  const result = db.exec(`
    SELECT t.composite_score, t.setup_type
      FROM trades t
     WHERE t.closed_at IS NULL
  `);
  const rows = result[0]?.values ?? [];
  let total = 0;
  for (const [scoreVal, setupTypeVal] of rows) {
    const score = Number(scoreVal);
    const setupType = String(setupTypeVal ?? '').toLowerCase();
    const isRange = setupType.startsWith('range');
    if (isRange) {
      total += 0.25;
      continue;
    }
    if (score >= 80) total += 1.5;
    else if (score >= 60) total += 1.0;
    else total += 0.5;
  }
  return total;
}
// ==================== END SCORING-AUDIT HELPERS ====================

// ==================== EXPORT DB REFERENCE ====================

export function getDb(): Database {
  return db;
}

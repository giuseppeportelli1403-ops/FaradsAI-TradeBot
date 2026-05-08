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

function createTables(): void {
  // 3-leg split-position architecture (upgraded from 2-leg on 2026-04-21):
  //   Leg A (partial: size_a) closes at TP1 → status = tp1_hit, SL of B+C moved to entry
  //   Leg B (partial: size_b) closes at TP2 → status = tp2_hit, SL of C moved to TP1 level
  //   Leg C (partial: size_c) closes at TP3 → status = complete
  //   Any leg hitting SL → status = sl_hit (logged even if A/B already closed at TP)
  //
  // tp3 / position_c_id / size_c / pnl_c are nullable to accommodate legacy
  // 2-leg rows from before the upgrade. New rows always populate all three
  // legs (see insertTrade defensive defaults).
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
      position_c_outcome TEXT,
      pnl_a_r REAL,
      pnl_b_r REAL,
      pnl_c_r REAL,
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

  // 3-leg schema migration: add tp3/position_c_id/size_c/pnl_c if missing.
  const tradesCols = db.exec('PRAGMA table_info(trades)');
  const existingTradesCols = tradesCols[0]
    ? tradesCols[0].values.map((row) => row[1] as string)
    : [];
  if (!existingTradesCols.includes('tp3')) {
    db.run('ALTER TABLE trades ADD COLUMN tp3 REAL');
  }
  if (!existingTradesCols.includes('position_c_id')) {
    db.run('ALTER TABLE trades ADD COLUMN position_c_id TEXT');
  }
  if (!existingTradesCols.includes('size_c')) {
    db.run('ALTER TABLE trades ADD COLUMN size_c REAL');
  }
  if (!existingTradesCols.includes('pnl_c')) {
    db.run('ALTER TABLE trades ADD COLUMN pnl_c REAL');
  }
  // 2026-04-23: closure_reason captures why an agent closed a trade before
  // any TP/SL trigger (e.g. fill-slippage R:R violation). Nullable; null on
  // legacy rows and on trades that exit cleanly via tp1_hit/tp2_hit/complete/
  // sl_hit.
  if (!existingTradesCols.includes('closure_reason')) {
    db.run('ALTER TABLE trades ADD COLUMN closure_reason TEXT');
  }

  // Lessons table: add position_c_outcome, pnl_c_r for 3-leg reflection.
  const lessonsCols = db.exec('PRAGMA table_info(lessons)');
  const existingLessonsCols = lessonsCols[0]
    ? lessonsCols[0].values.map((row) => row[1] as string)
    : [];
  if (!existingLessonsCols.includes('position_c_outcome')) {
    db.run('ALTER TABLE lessons ADD COLUMN position_c_outcome TEXT');
  }
  if (!existingLessonsCols.includes('pnl_c_r')) {
    db.run('ALTER TABLE lessons ADD COLUMN pnl_c_r REAL');
  }

  // CHECK-constraint changes cannot be done via ALTER TABLE in SQLite. Three
  // constraint changes so far:
  //   - sl_tp_orders.leg: 'A'|'B' → 'A'|'B'|'C'              (2026-04-21)
  //   - trades.status:    added 'tp2_hit'                     (2026-04-21)
  //   - trades.status:    added 'closed_early'                (2026-04-23)
  // For pre-existing DBs with older constraints, we rebuild via the standard
  // SQLite pattern: create new with updated schema, copy data, drop old,
  // rename. The rebuild is idempotent — once the current schema is in place
  // the trigger predicate returns false and no further work is done.
  // `tradesHasClosedEarlyStatus` is the strictest (newest) check; DBs missing
  // it also miss tp2_hit on older installations, and rebuildTradesTable
  // produces a schema containing both.
  if (existingSltpCols.length > 0 && !sltpOrdersHasLegCCheck()) {
    rebuildSltpOrdersTable();
  }
  if (existingTradesCols.length > 0 && !tradesHasClosedEarlyStatus()) {
    rebuildTradesTable();
  }

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

  // Helper: treat undefined/null as null, otherwise coerce to Number. Used
  // for tp3 / size_c / pnl_c where a legacy 2-leg trade may omit the field.
  const asNumOrNull = (v: unknown): number | null =>
    v === undefined || v === null ? null : (typeof v === 'number' && !isNaN(v) ? v : null);

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
    tp3: asNumOrNull(trade.tp3),                           // NEW (3-leg)
    position_a_id: asStrOrNull(trade.position_a_id),
    position_b_id: asStrOrNull(trade.position_b_id),
    position_c_id: asStrOrNull(trade.position_c_id),       // NEW (3-leg)
    size_a: asNum(trade.size_a, 0),
    size_b: asNum(trade.size_b, 0),
    size_c: asNumOrNull(trade.size_c),                     // NEW (3-leg)
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
      setup_type, entry, sl, tp1, tp2, tp3, position_a_id, position_b_id, position_c_id,
      size_a, size_b, size_c,
      status, composite_score, kill_zone, news_category, analyst_decision, reasoning,
      closure_reason, opened_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    row.id, row.strategy_tag, row.instrument, row.instrument_category,
    row.direction, row.setup_type, row.entry, row.sl, row.tp1, row.tp2, row.tp3,
    row.position_a_id, row.position_b_id, row.position_c_id,
    row.size_a, row.size_b, row.size_c,
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
  pnlC?: number,    // NEW (3-leg) — P&L on Leg C in R units once it closes
): void {
  // pnl_total = sum of whichever leg pnls have been populated. COALESCE via the
  // existing stored values so partial updates (e.g. only leg C this call)
  // don't clobber earlier leg pnl_a/pnl_b that were set on previous calls.
  const closedAt = status === 'complete' || status === 'sl_hit' ? new Date().toISOString() : null;

  db.run(`
    UPDATE trades
    SET status = ?,
        pnl_a = COALESCE(?, pnl_a),
        pnl_b = COALESCE(?, pnl_b),
        pnl_c = COALESCE(?, pnl_c),
        pnl_total = COALESCE(pnl_a, 0) + COALESCE(pnl_b, 0) + COALESCE(pnl_c, 0),
        closed_at = COALESCE(?, closed_at)
    WHERE id = ?
  `, [status, pnlA ?? null, pnlB ?? null, pnlC ?? null, closedAt, tradeId]);
  saveToFile();
}

// Status values that count as "still has live exposure on Capital.com":
//   - 'open'     — all 3 legs still active
//   - 'tp1_hit'  — Leg A closed, Legs B+C still running
//   - 'tp2_hit'  — Legs A+B closed, Leg C still running (added 2026-04-28
//                  audit; previously omitted, which made tp2_hit trades
//                  invisible to the coordination lock — Codex P1 #10)
const OPEN_STATUSES_SQL = "status IN ('open', 'tp1_hit', 'tp2_hit')";

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
      composite_score, analyst_decision, position_a_outcome, position_b_outcome, position_c_outcome,
      pnl_a_r, pnl_b_r, pnl_c_r, pnl_total_r, was_bias_correct, was_trigger_valid,
      was_news_correctly_weighted, was_split_execution_clean, score_accuracy_notes,
      lesson, rule_suggestion)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    lesson.lesson_id, lesson.timestamp, lesson.strategy_tag, lesson.instrument,
    lesson.instrument_category, lesson.direction, lesson.setup_type, lesson.kill_zone,
    asStrOrNull(lesson.hold_duration), asStrOrNull(lesson.news_category), asStrOrNull(lesson.news_description),
    asNumOrNull(lesson.composite_score), asStrOrNull(lesson.analyst_decision),
    asStrOrNull(lesson.position_a_outcome), asStrOrNull(lesson.position_b_outcome),
    asStrOrNull(lesson.position_c_outcome), // 2026-04-29 audit fix
    asNumOrNull(lesson.pnl_a_r), asNumOrNull(lesson.pnl_b_r),
    asNumOrNull(lesson.pnl_c_r), // 2026-04-29 audit fix
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
    'INSERT INTO analyst_log (trade_id, strategy_tag, decision, reason, modifications, confidence) VALUES (?, ?, ?, ?, ?, ?)',
    [tradeId, strategyTag, decision.decision, decision.reason, JSON.stringify(decision.modifications), decision.confidence]
  );
  saveToFile();
}

// ==================== SL/TP MONITORING ====================

export function createSlTpOrder(params: {
  trade_id: string;
  leg: 'A' | 'B' | 'C';        // NEW 2026-04-21: 'C' added for 3-leg split-position
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
 * the position_a_id / position_b_id / position_c_id columns. Used by the
 * `close_position` MCP tool so the LLM can pass the dealId and we can
 * find the corresponding trade row to mark closed_early.
 */
export function getTradeByDealId(dealId: string): TradeRecord | null {
  const result = db.exec(
    'SELECT * FROM trades WHERE position_a_id = ? OR position_b_id = ? OR position_c_id = ?',
    [dealId, dealId, dealId],
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

// ==================== EXPORT DB REFERENCE ====================

export function getDb(): Database {
  return db;
}

// Database — SQLite Setup + Queries
// Uses sql.js (WASM-based SQLite) for local storage
//
// Tables:
//   trades          — split-leg trade records with full context
//   lessons         — structured JSON lessons from Reflection Agent
//   research_briefs — daily briefs from Market Researcher Agent
//   analyst_log     — approval/rejection log from Trade Analyst
//   sl_tp_orders    — active SL/TP levels monitored by scheduler (T212 doesn't support native SL/TP)
//   daily_pnl_log   — daily P&L snapshots for kill switch tracking

import initSqlJs, { type Database } from 'sql.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
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

function saveToFile(): void {
  const data = db.export();
  const buffer = Buffer.from(data);
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(DB_PATH, buffer);
}

function createTables(): void {
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
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'tp1_hit', 'complete', 'sl_hit')),
      pnl_a REAL,
      pnl_b REAL,
      pnl_total REAL,
      composite_score INTEGER NOT NULL,
      kill_zone TEXT,
      news_category TEXT,
      analyst_decision TEXT,
      reasoning TEXT,
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
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      triggered_at TEXT,
      FOREIGN KEY (trade_id) REFERENCES trades(id)
    )
  `);

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

export function insertTrade(trade: Omit<TradeRecord, 'closed_at'>): void {
  db.run(`
    INSERT INTO trades (id, strategy_tag, instrument, instrument_category, direction,
      setup_type, entry, sl, tp1, tp2, position_a_id, position_b_id, size_a, size_b,
      status, composite_score, kill_zone, news_category, analyst_decision, reasoning, opened_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    trade.id, trade.strategy_tag, trade.instrument, trade.instrument_category,
    trade.direction, trade.setup_type, trade.entry, trade.sl, trade.tp1, trade.tp2,
    trade.position_a_id, trade.position_b_id, trade.size_a, trade.size_b,
    trade.status, trade.composite_score, trade.kill_zone, trade.news_category,
    trade.analyst_decision, trade.reasoning, trade.opened_at,
  ]);
  saveToFile();
}

export function updateTradeStatus(tradeId: string, status: TradeStatus, pnlA?: number, pnlB?: number): void {
  const pnlTotal = (pnlA ?? 0) + (pnlB ?? 0);
  const closedAt = status === 'complete' || status === 'sl_hit' ? new Date().toISOString() : null;

  db.run(`
    UPDATE trades SET status = ?, pnl_a = COALESCE(?, pnl_a), pnl_b = COALESCE(?, pnl_b),
      pnl_total = CASE WHEN ? IS NOT NULL OR ? IS NOT NULL THEN ? ELSE pnl_total END,
      closed_at = COALESCE(?, closed_at)
    WHERE id = ?
  `, [status, pnlA ?? null, pnlB ?? null, pnlA ?? null, pnlB ?? null, pnlTotal, closedAt, tradeId]);
  saveToFile();
}

export function getOpenTrades(): TradeRecord[] {
  const result = db.exec("SELECT * FROM trades WHERE status IN ('open', 'tp1_hit') ORDER BY opened_at DESC");
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
    "SELECT * FROM trades WHERE instrument = ? AND status IN ('open', 'tp1_hit')",
    [instrument]
  );
  return resultToObjects<TradeRecord>(result);
}

export function countOpenPositions(): number {
  const result = db.exec("SELECT COUNT(*) as count FROM trades WHERE status IN ('open', 'tp1_hit')");
  return result[0]?.values[0]?.[0] as number || 0;
}

// ==================== LESSONS ====================

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
    lesson.hold_duration, lesson.news_category, lesson.news_description,
    lesson.composite_score, lesson.analyst_decision, lesson.position_a_outcome,
    lesson.position_b_outcome, lesson.pnl_a_r, lesson.pnl_b_r, lesson.pnl_total_r,
    lesson.was_bias_correct ? 1 : 0, lesson.was_trigger_valid ? 1 : 0,
    lesson.was_news_correctly_weighted ? 1 : 0, lesson.was_split_execution_clean ? 1 : 0,
    lesson.score_accuracy_notes, lesson.lesson, lesson.rule_suggestion,
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

  const winsResult = db.exec(`SELECT COUNT(*) FROM lessons ${where} ${where ? 'AND' : 'WHERE'} pnl_total_r > 0`, params);
  const wins = winsResult[0]?.values[0]?.[0] as number || 0;

  return { total, wins, win_rate: total > 0 ? Math.round((wins / total) * 1000) / 10 : 0 };
}

// ==================== RESEARCH BRIEFS ====================

export function saveResearchBrief(brief: ResearchBrief): void {
  db.run(
    'INSERT OR REPLACE INTO research_briefs (brief_id, date, content) VALUES (?, ?, ?)',
    [brief.brief_id, brief.date, JSON.stringify(brief)]
  );
  saveToFile();
}

export function getLatestBrief(): ResearchBrief | null {
  const result = db.exec('SELECT content FROM research_briefs ORDER BY created_at DESC LIMIT 1');
  if (!result[0]?.values[0]?.[0]) return null;
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
  leg: 'A' | 'B';
  instrument: string;
  direction: Direction;
  quantity: number;
  sl_price?: number;
  tp_price?: number;
  trailing_stop_distance?: number;
}): void {
  db.run(`
    INSERT INTO sl_tp_orders (trade_id, leg, instrument, direction, quantity, sl_price, tp_price, trailing_stop_distance)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    params.trade_id, params.leg, params.instrument, params.direction,
    params.quantity, params.sl_price ?? null, params.tp_price ?? null,
    params.trailing_stop_distance ?? null,
  ]);
  saveToFile();
}

export function getActiveSlTpOrders(): Array<{
  id: number;
  trade_id: string;
  leg: string;
  instrument: string;
  direction: string;
  quantity: number;
  sl_price: number | null;
  tp_price: number | null;
  trailing_stop_distance: number | null;
}> {
  const result = db.exec('SELECT * FROM sl_tp_orders WHERE is_active = 1');
  return resultToObjects(result);
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
  const killSwitch = pct <= -4 ? 1 : 0;

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

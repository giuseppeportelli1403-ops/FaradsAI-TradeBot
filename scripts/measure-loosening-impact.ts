// scripts/measure-loosening-impact.ts
//
// Daily post-ship measurement for the PR 1 trade-frequency loosening
// initiative (see docs/superpowers/specs/2026-05-12-trade-frequency-
// loosening-design.md §7). Queries the trades + analyst_log tables and
// pm2-out.log, computes per-instrument metrics, flags any of the 6
// rollback triggers from design v2 §7.
//
// Run via cron: 5 0 * * * runs nightly, output to data/metrics/
// loosening-daily.log. Exit 1 if any rollback trigger fires.
//
// Manual: npx tsx scripts/measure-loosening-impact.ts [--days N]

import 'dotenv/config';
import { readFileSync, existsSync } from 'node:fs';
import initSqlJs from 'sql.js';

interface PerInstrument {
  trades: number;
  wins: number;
  losses: number;
  totalR: number;
  avgWinR: number;
  avgLossR: number;
  expectedR: number;
  winRate: number;
}

interface DailyReport {
  generatedAt: string;
  windowDays: number;
  windowStart: string;
  // Aggregate
  totalTrades: number;
  tradesPerDay: number;
  totalAnalystCalls: number;
  candidatesReviewedPerTrade: number;
  wins: number;
  losses: number;
  open: number;
  winRate: number;
  avgWinR: number;
  avgLossR: number;
  expectedR: number;
  killSwitchHits: number;
  coercionLogCount: number;
  loadCapHits: number;
  perInstrument: Record<string, PerInstrument>;
  rollbackTriggers: string[];
}

function parseDaysArg(): number {
  const i = process.argv.indexOf('--days');
  if (i !== -1 && process.argv[i + 1]) return Number(process.argv[i + 1]);
  return 3;
}

function computeStats(trades: Array<{ pnl_total: number; entry: number; sl: number }>): {
  wins: number;
  losses: number;
  open: number;
  totalR: number;
  winR: number;
  lossR: number;
  winCount: number;
  lossCount: number;
} {
  let wins = 0,
    losses = 0,
    open = 0;
  let totalR = 0;
  let winR = 0,
    winCount = 0;
  let lossR = 0,
    lossCount = 0;
  for (const t of trades) {
    if (t.pnl_total === null || t.pnl_total === undefined) {
      open++;
      continue;
    }
    // R = pnl_total / (|entry - sl|). pnl_total is in account currency;
    // |entry - sl| is the per-unit stop distance. For simplicity we assume
    // pnl_total is already in R-equivalents OR we use the raw P&L sign as
    // win/loss classifier. Sign-based classification is robust to the
    // exact R-conversion math.
    const stopDist = Math.abs(t.entry - t.sl);
    const rEquiv = stopDist > 0 ? t.pnl_total / stopDist : t.pnl_total;
    totalR += rEquiv;
    if (t.pnl_total > 0) {
      wins++;
      winR += rEquiv;
      winCount++;
    } else if (t.pnl_total < 0) {
      losses++;
      lossR += Math.abs(rEquiv);
      lossCount++;
    } else {
      // breakeven — count as a no-op
    }
  }
  return { wins, losses, open, totalR, winR, lossR, winCount, lossCount };
}

async function buildReport(days: number): Promise<DailyReport> {
  const DB_PATH = '/home/bot/trading-bot/data/trading-bot.db';
  const LOG_PATH = '/home/bot/trading-bot/data/pm2-out.log';

  const SQL = await initSqlJs();
  const db = new SQL.Database(readFileSync(DB_PATH));

  // Trades in window — opened OR closed within `days` ago
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);

  const tradeRows = db.exec(
    `SELECT id, instrument, pnl_total, entry, sl, status, opened_at, closed_at FROM trades WHERE opened_at > '${cutoff}' ORDER BY opened_at`,
  );
  const trades: Array<{ id: string; instrument: string; pnl_total: number | null; entry: number; sl: number; status: string }> =
    tradeRows.length
      ? tradeRows[0].values.map((r: any) => ({
          id: String(r[0]),
          instrument: String(r[1]),
          pnl_total: r[2] === null ? null : Number(r[2]),
          entry: Number(r[3]),
          sl: Number(r[4]),
          status: String(r[5]),
        }))
      : [];

  // Analyst calls in window
  const analystRows = db.exec(
    `SELECT COUNT(*) FROM analyst_log WHERE created_at > '${cutoff}'`,
  );
  const totalAnalystCalls = analystRows.length ? Number(analystRows[0].values[0][0]) : 0;

  // Aggregate stats
  const agg = computeStats(trades.map((t) => ({ pnl_total: t.pnl_total as number, entry: t.entry, sl: t.sl })));
  const tradeCount = trades.length;
  const closedCount = agg.wins + agg.losses;
  const winRate = closedCount > 0 ? agg.wins / closedCount : 0;
  const avgWinR = agg.winCount > 0 ? agg.winR / agg.winCount : 0;
  const avgLossR = agg.lossCount > 0 ? agg.lossR / agg.lossCount : 0;
  const expectedR = closedCount > 0 ? (agg.winR - agg.lossR) / closedCount : 0;

  // Per-instrument breakdown
  const perInstrument: Record<string, PerInstrument> = {};
  for (const t of trades) {
    if (!perInstrument[t.instrument]) {
      perInstrument[t.instrument] = {
        trades: 0,
        wins: 0,
        losses: 0,
        totalR: 0,
        avgWinR: 0,
        avgLossR: 0,
        expectedR: 0,
        winRate: 0,
      };
    }
    perInstrument[t.instrument].trades++;
  }
  for (const instr of Object.keys(perInstrument)) {
    const tThis = trades
      .filter((t) => t.instrument === instr)
      .map((t) => ({ pnl_total: t.pnl_total as number, entry: t.entry, sl: t.sl }));
    const s = computeStats(tThis);
    const closed = s.wins + s.losses;
    perInstrument[instr] = {
      trades: tThis.length,
      wins: s.wins,
      losses: s.losses,
      totalR: s.totalR,
      avgWinR: s.winCount > 0 ? s.winR / s.winCount : 0,
      avgLossR: s.lossCount > 0 ? s.lossR / s.lossCount : 0,
      expectedR: closed > 0 ? (s.winR - s.lossR) / closed : 0,
      winRate: closed > 0 ? s.wins / closed : 0,
    };
  }

  // pm2-out.log grep counters
  let killSwitchHits = 0;
  let coercionLogCount = 0;
  let loadCapHits = 0;
  if (existsSync(LOG_PATH)) {
    const content = readFileSync(LOG_PATH, 'utf-8');
    const lines = content.split('\n');
    const cutoffDateStr = cutoff.split(' ')[0]; // YYYY-MM-DD
    for (const line of lines) {
      // Only count log lines on or after the cutoff date
      if (!line.startsWith('2026') && !line.startsWith('2025')) continue;
      const dateMatch = line.match(/^(\d{4}-\d{2}-\d{2})/);
      if (!dateMatch || dateMatch[1] < cutoffDateStr) continue;
      if (line.includes('Daily kill switch triggered') || line.includes('DAILY_KILL_SWITCH_ACTIVE')) killSwitchHits++;
      if (line.includes('[analyst-coercion]')) coercionLogCount++;
      if (line.includes('ANALYST_LOAD_CAP_EXCEEDED')) loadCapHits++;
    }
  }

  const report: DailyReport = {
    generatedAt: new Date().toISOString(),
    windowDays: days,
    windowStart: cutoff,
    totalTrades: tradeCount,
    tradesPerDay: tradeCount / days,
    totalAnalystCalls,
    candidatesReviewedPerTrade: tradeCount > 0 ? totalAnalystCalls / tradeCount : 0,
    wins: agg.wins,
    losses: agg.losses,
    open: agg.open,
    winRate,
    avgWinR,
    avgLossR,
    expectedR,
    killSwitchHits,
    coercionLogCount,
    loadCapHits,
    perInstrument,
    rollbackTriggers: [],
  };

  // Rollback triggers per design v2 §7
  if (report.tradesPerDay < 1 && days >= 3) {
    report.rollbackTriggers.push(`trades/day = ${report.tradesPerDay.toFixed(2)} < 1 for ${days} consecutive days`);
  }
  if (report.tradesPerDay > 8 && days >= 2) {
    report.rollbackTriggers.push(`trades/day = ${report.tradesPerDay.toFixed(2)} > 8 for ${days} consecutive days`);
  }
  if (report.winRate < 0.35 && closedCount >= 5) {
    report.rollbackTriggers.push(`rolling win rate ${(report.winRate * 100).toFixed(1)}% < 35% (closed=${closedCount})`);
  }
  if (report.expectedR < 0.2 && closedCount >= 10) {
    report.rollbackTriggers.push(`rolling expected R/trade ${report.expectedR.toFixed(3)}R < 0.2R (closed=${closedCount})`);
  }
  if (report.killSwitchHits >= 2) {
    report.rollbackTriggers.push(`daily kill switch fired ${report.killSwitchHits} times in window`);
  }
  // FP-from-audit not directly measurable here — requires running the audit
  // script as a separate step. Documented but not enforced from this script.

  return report;
}

async function main() {
  const days = parseDaysArg();
  let report: DailyReport;
  try {
    report = await buildReport(days);
  } catch (err) {
    console.error('measure-loosening-impact failed:', err);
    process.exit(2);
  }

  console.log(JSON.stringify(report, null, 2));

  if (report.rollbackTriggers.length > 0) {
    console.error('\n🚨 ROLLBACK TRIGGERS FIRED:');
    report.rollbackTriggers.forEach((t) => console.error('  - ' + t));
    process.exit(1);
  } else {
    console.error('\n✅ All rollback triggers clear.');
  }
}

main();

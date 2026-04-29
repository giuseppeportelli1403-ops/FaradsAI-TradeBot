#!/usr/bin/env node
// Capital <-> DB reconciliation diagnostic.
//
// Compares Capital.com's actual state (open positions + recent trade
// transactions) against the bot's local SQLite trades table, surfacing:
//   - open positions on Capital with no DB row (orphans -> kill-switch /
//     monitor are blind to them)
//   - DB trades stuck at status='open' but Capital shows the position
//     gone (stale rows -> blocks coordination lock unnecessarily)
//   - clusters of simultaneous Capital TRADE transactions (likely
//     3-leg place_split_trade events) for cross-referencing
//
// Usage:
//   node scripts/reconcile-capital.mjs                         (last 10 days)
//   node scripts/reconcile-capital.mjs --days 30
//   node scripts/reconcile-capital.mjs --json                  (machine-readable)
//
// READ-ONLY by design. To recover from orphans, write the missing rows
// manually after manual inspection — auto-repair is intentionally absent
// because guessing trade.entry/sl/tp/size from transaction data alone
// is unreliable (Capital transactions only carry post-fill cash deltas,
// not the leg structure).

import 'dotenv/config';
import initSqlJs from 'sql.js';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { CapitalClient } from '../dist/mcp-server/capital-client.js';

function parseArgs(argv) {
  const days = (() => {
    const i = argv.indexOf('--days');
    if (i !== -1 && argv[i + 1]) return parseInt(argv[i + 1], 10);
    return 10;
  })();
  const json = argv.includes('--json');
  const dbPath = (() => {
    const i = argv.indexOf('--db');
    if (i !== -1 && argv[i + 1]) return resolve(process.cwd(), argv[i + 1]);
    return resolve(process.cwd(), 'data/trading-bot.db');
  })();
  return { days, json, dbPath };
}

function clusterTransactions(txs, gapSeconds = 5) {
  // Cluster TRADE-type transactions whose timestamps are within `gapSeconds`
  // of each other. A 3-leg place_split_trade fires 3 positions within ~200ms,
  // so the cluster size and timestamp delta are reliable signals.
  const trades = txs.filter((t) => t.transactionType === 'TRADE');
  trades.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  const clusters = [];
  let current = [];
  for (const t of trades) {
    if (current.length === 0) {
      current.push(t);
      continue;
    }
    const dt = (new Date(t.date).getTime() - new Date(current[current.length - 1].date).getTime()) / 1000;
    if (dt <= gapSeconds) current.push(t);
    else {
      clusters.push(current);
      current = [t];
    }
  }
  if (current.length > 0) clusters.push(current);
  return clusters;
}

async function main() {
  const { days, json, dbPath } = parseArgs(process.argv.slice(2));

  const c = new CapitalClient({
    apiKey: process.env.CAPITAL_API_KEY,
    identifier: process.env.CAPITAL_IDENTIFIER,
    password: process.env.CAPITAL_API_KEY_PASSWORD,
    baseURL: process.env.CAPITAL_API_URL || 'https://demo-api-capital.backend-capital.com',
  });

  const SQL = await initSqlJs();
  const db = new SQL.Database(readFileSync(dbPath));

  const positions = await c.getOpenPositions();
  const fromIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, '');
  const txs = await c.getTransactionHistory(fromIso);
  const acts = await c.getActivityHistory(fromIso);
  const clusters = clusterTransactions(txs);

  const dbTradesAll = db.exec(
    'SELECT id, instrument, direction, status, position_a_id, position_b_id, position_c_id, opened_at, closed_at FROM trades',
  );
  const dbTrades = (dbTradesAll[0]?.values ?? []).map((row) => ({
    id: row[0], instrument: row[1], direction: row[2], status: row[3],
    position_a_id: row[4], position_b_id: row[5], position_c_id: row[6],
    opened_at: row[7], closed_at: row[8],
  }));
  const allDbDealIds = new Set(
    dbTrades.flatMap((t) => [t.position_a_id, t.position_b_id, t.position_c_id]).filter(Boolean),
  );

  const liveOrphans = positions.filter((p) => !allDbDealIds.has(p.position?.dealId));
  const stuckDbRows = dbTrades.filter(
    (t) => t.status === 'open' && !positions.some((p) =>
      p.position?.dealId === t.position_a_id ||
      p.position?.dealId === t.position_b_id ||
      p.position?.dealId === t.position_c_id,
    ),
  );

  await c.logout();

  const report = {
    generated_at: new Date().toISOString(),
    window_days: days,
    capital_open_positions: positions.length,
    capital_transactions_window: txs.length,
    capital_activities_window: acts.length,
    capital_trade_clusters: clusters.length,
    db_trades_total: dbTrades.length,
    db_trades_open: dbTrades.filter((t) => t.status === 'open').length,
    live_orphans_on_capital: liveOrphans.map((p) => ({
      dealId: p.position?.dealId,
      epic: p.market?.epic,
      direction: p.position?.direction,
      size: p.position?.size,
      entry: p.position?.openLevel,
      sl: p.position?.stopLevel,
      tp: p.position?.profitLevel,
      createdUTC: p.position?.createdDateUTC,
    })),
    stuck_open_in_db: stuckDbRows.map((t) => ({
      id: t.id,
      instrument: t.instrument,
      direction: t.direction,
      opened_at: t.opened_at,
      legs: [t.position_a_id, t.position_b_id, t.position_c_id].filter(Boolean),
    })),
    transaction_clusters: clusters.map((cluster) => ({
      first_at: cluster[0].date,
      legs: cluster.length,
      total_cash: cluster.reduce((acc, t) => acc + Number(t.size || 0), 0).toFixed(2),
      currency: cluster[0].currency,
      references: cluster.map((t) => t.reference),
    })),
  };

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log('============================================');
  console.log(' Capital <-> DB Reconciliation Report');
  console.log('============================================');
  console.log(`Generated: ${report.generated_at}`);
  console.log(`Window:    last ${report.window_days} days`);
  console.log('');
  console.log('Capital live state:');
  console.log(`  Open positions:                       ${report.capital_open_positions}`);
  console.log(`  TRADE+SWAP txs in window:             ${report.capital_transactions_window}`);
  console.log(`  Activity events in window:            ${report.capital_activities_window}`);
  console.log(`  Trade clusters (likely place events): ${report.capital_trade_clusters}`);
  console.log('');
  console.log('DB state:');
  console.log(`  Total trade rows:      ${report.db_trades_total}`);
  console.log(`  Status=open:           ${report.db_trades_open}`);
  console.log('');

  if (report.live_orphans_on_capital.length > 0) {
    console.log('!! LIVE ORPHANS on Capital (no DB row, monitor blind):');
    for (const o of report.live_orphans_on_capital) {
      console.log(`  - dealId=${o.dealId} ${o.epic} ${o.direction} size=${o.size} entry=${o.entry} sl=${o.sl} tp=${o.tp} created=${o.createdUTC}`);
    }
    console.log('');
  } else {
    console.log('OK: No live orphans. Capital open positions all reflected in DB.');
    console.log('');
  }

  if (report.stuck_open_in_db.length > 0) {
    console.log('!! STUCK OPEN in DB (Capital says position closed):');
    for (const s of report.stuck_open_in_db) {
      console.log(`  - ${s.id} ${s.instrument} ${s.direction} opened_at=${s.opened_at} legs=${s.legs.join(',')}`);
    }
    console.log('  -> Investigate close events in /history/activity for these dealIds.');
    console.log('  -> Manual fix: update trades set status=closed_early, closed_at=<time> where id=...');
    console.log('');
  } else {
    console.log('OK: No stuck rows. DB open trades all match a Capital open position.');
    console.log('');
  }

  if (clusters.length > 0) {
    console.log(`Recent transaction clusters (${clusters.length} total):`);
    for (const cluster of clusters.slice(0, 10)) {
      const c0 = cluster[0];
      console.log(`  ${c0.date}  legs=${cluster.length}  cash=${cluster.reduce((a, t) => a + Number(t.size || 0), 0).toFixed(2)} ${c0.currency}  refs=[${cluster.map((t) => t.reference).join(', ')}]`);
    }
    console.log('');
  }
}

main().catch((err) => {
  console.error('[reconcile-capital] FAILED:', err);
  process.exit(1);
});

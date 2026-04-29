// One-shot maintenance: deactivate sl_tp_orders rows for instruments that
// have been removed from INSTRUMENT_UNIVERSE.
//
// Background: the 2026-04-22 indices removal (US30, US100, US500, DE40, UK100)
// left at least one orphaned row in the production DB with `is_active=1` and
// NULL deal_id. Caught 2026-04-28 while pulling the prod DB for diagnosis.
// These rows would never trigger a real action — but they pollute monitoring
// dashboards and `getActiveSlTpOrders()` results.
//
// Usage:
//   npx tsx scripts/cleanup-orphan-sltp.ts                       # default: data/trading-bot.db
//   npx tsx scripts/cleanup-orphan-sltp.ts --db data/trading-bot-prod.db
//   npx tsx scripts/cleanup-orphan-sltp.ts --dry-run              # report only, no writes

import initSqlJs from 'sql.js';
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { INSTRUMENT_UNIVERSE } from '../src/scanner/index.js';

interface Args {
  dbPath: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const dbFlag = argv.indexOf('--db');
  const dbPath = dbFlag !== -1 && argv[dbFlag + 1]
    ? resolve(process.cwd(), argv[dbFlag + 1])
    : resolve(process.cwd(), 'data/trading-bot.db');
  const dryRun = argv.includes('--dry-run');
  return { dbPath, dryRun };
}

async function main(): Promise<void> {
  const { dbPath, dryRun } = parseArgs(process.argv.slice(2));

  console.log(`[cleanup-orphan-sltp] Opening ${dbPath}${dryRun ? ' (DRY RUN)' : ''}`);
  const SQL = await initSqlJs();
  const db = new SQL.Database(readFileSync(dbPath));

  const validInstruments = new Set(INSTRUMENT_UNIVERSE.map((i) => i.ticker));
  console.log(`[cleanup-orphan-sltp] Current universe (${validInstruments.size}): ${[...validInstruments].join(', ')}`);

  const result = db.exec(
    "SELECT id, trade_id, leg, instrument, deal_id, sl_price, tp_price FROM sl_tp_orders WHERE is_active = 1",
  );
  const rows = result[0]?.values ?? [];

  // Codex M (2026-04-29): only deactivate rows with NULL deal_id. A row with
  // a live deal_id on a removed-from-universe instrument indicates a real
  // open position on Capital that needs MANUAL reconciliation, not silent
  // deactivation. The original 2026-04-28 incident was specifically NULL-
  // deal_id orphans (US100/US30/etc placeholder rows). Live-deal cleanup
  // must remain a separate, explicit operator decision.
  const allOrphans = rows.filter((row) => !validInstruments.has(row[3] as string));
  const liveDealOrphans = allOrphans.filter((row) => row[4] != null && String(row[4]).length > 0);
  const orphans = allOrphans.filter((row) => row[4] == null || String(row[4]).length === 0);

  if (liveDealOrphans.length > 0) {
    console.warn(`[cleanup-orphan-sltp] WARNING: ${liveDealOrphans.length} out-of-universe row(s) have live deal_id — NOT touching:`);
    for (const row of liveDealOrphans) {
      const [id, trade_id, leg, instrument, deal_id, sl, tp] = row;
      console.warn(`  id=${id} trade_id=${trade_id} leg=${leg} instrument=${instrument} deal_id=${deal_id} sl=${sl ?? 'NULL'} tp=${tp ?? 'NULL'}  ← reconcile manually on Capital`);
    }
  }

  if (orphans.length === 0) {
    console.log('[cleanup-orphan-sltp] No NULL-deal_id orphan rows to deactivate. DB unchanged.');
    return;
  }

  console.log(`[cleanup-orphan-sltp] Found ${orphans.length} NULL-deal_id orphan row(s):`);
  for (const row of orphans) {
    const [id, trade_id, leg, instrument, deal_id, sl, tp] = row;
    console.log(`  id=${id} trade_id=${trade_id} leg=${leg} instrument=${instrument} deal_id=${deal_id ?? 'NULL'} sl=${sl ?? 'NULL'} tp=${tp ?? 'NULL'}`);
  }

  if (dryRun) {
    console.log('[cleanup-orphan-sltp] --dry-run: no changes written.');
    return;
  }

  // Use parameterised IN clause so removed-instrument names can't break out.
  // AND deal_id IS NULL guard added per Codex M 2026-04-29 review.
  const placeholders = [...validInstruments].map(() => '?').join(',');
  db.run(
    `UPDATE sl_tp_orders
     SET is_active = 0,
         triggered_at = COALESCE(triggered_at, datetime('now'))
     WHERE is_active = 1
       AND deal_id IS NULL
       AND instrument NOT IN (${placeholders})`,
    [...validInstruments],
  );

  writeFileSync(dbPath, Buffer.from(db.export()));
  console.log(`[cleanup-orphan-sltp] Deactivated ${orphans.length} row(s). DB saved.`);
}

main().catch((err) => {
  console.error('[cleanup-orphan-sltp] FAILED:', err);
  process.exit(1);
});

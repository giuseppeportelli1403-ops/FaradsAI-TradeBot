// Extract historical scoring snapshots from a Farad VPS DB snapshot
// (T013/T014 / Spec 001).
//
// Reads the trades + score_breakdowns tables from a local copy of the
// VPS sqlite file and emits frozen scanner-input snapshots to
// tests/fixtures/scoring/historical-snapshots.json. The fixture is
// then consumed by tests/scoring/historical-replay.test.ts to verify
// SC-006 (>= 80% of historical Tier 1 trades retain Tier 1 under the
// new deterministic scorer).
//
// Usage:
//   1. Pull a fresh DB snapshot from the VPS:
//        ssh bot@162.55.212.198 'cat /home/bot/trading-bot/data/trading-bot.db' \
//          > /tmp/farad-snapshot.db
//   2. Run this script:
//        npx tsx scripts/extract-historical-snapshots.ts --db /tmp/farad-snapshot.db --days 30
//   3. Commit the updated fixture (gated on changes being expected).
//
// The script does NOT touch the VPS or modify any data — read-only on
// a local copy.

import 'dotenv/config';
import initSqlJs from 'sql.js';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const args = process.argv.slice(2);
const getArg = (flag: string, def: string): string => {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : def;
};

const DB_PATH = getArg('--db', '');
const DAYS = parseInt(getArg('--days', '30'), 10);
const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT = join(here, '..', 'tests', 'fixtures', 'scoring', 'historical-snapshots.json');
const OUTPUT_PATH = getArg('--out', DEFAULT_OUTPUT);

if (!DB_PATH) {
  console.error('ERROR: --db <path-to-vps-snapshot> is required');
  console.error('Usage: npx tsx scripts/extract-historical-snapshots.ts --db /tmp/farad-snapshot.db [--days 30] [--out path]');
  process.exit(1);
}

interface SnapshotRow {
  trade_id: string;
  instrument: string;
  original_score: number;
  original_tier: number | null;
  setup_type: string;
  kill_zone: string | null;
  outcome: string;
  pnl_total: number | null;
  closed_at: string;
  // From score_breakdowns (if present):
  breakdown?: Record<string, number | boolean>;
  scorer_version?: string;
}

async function main(): Promise<void> {
  const SQL = await initSqlJs();
  const buffer = readFileSync(DB_PATH);
  const db = new SQL.Database(buffer);

  // Pull last DAYS days of CLOSED trades. Join score_breakdowns where
  // available (newer trades after Migration 007 will have it).
  const cutoff = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);

  const result = db.exec(
    `SELECT
       t.id, t.instrument, t.composite_score, t.setup_type, t.kill_zone,
       t.status, t.pnl_total, t.closed_at,
       sb.breakdown_json, sb.scorer_version
     FROM trades t
       LEFT JOIN score_breakdowns sb ON sb.trade_id = t.id
     WHERE t.closed_at IS NOT NULL
       AND substr(t.closed_at, 1, 10) >= ?
     ORDER BY t.closed_at DESC`,
    [cutoff],
  );

  if (!result[0]) {
    console.error(`No closed trades found in last ${DAYS} days. Aborting.`);
    process.exit(1);
  }

  const rows: SnapshotRow[] = result[0].values.map((row) => {
    const score = Number(row[2]);
    const tier: number | null = score >= 80 ? 1 : score >= 60 ? 2 : score >= 40 ? 3 : null;
    let breakdown: Record<string, number | boolean> | undefined;
    if (row[8]) {
      try { breakdown = JSON.parse(String(row[8])); } catch { breakdown = undefined; }
    }
    return {
      trade_id: String(row[0]),
      instrument: String(row[1]),
      original_score: score,
      original_tier: tier,
      setup_type: String(row[3] ?? 'unspecified'),
      kill_zone: row[4] ? String(row[4]) : null,
      outcome: String(row[5]),
      pnl_total: row[6] === null ? null : Number(row[6]),
      closed_at: String(row[7]),
      ...(breakdown !== undefined && { breakdown }),
      ...(row[9] ? { scorer_version: String(row[9]) } : {}),
    };
  });

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(rows, null, 2), 'utf-8');

  const t1 = rows.filter((r) => r.original_tier === 1).length;
  const t2 = rows.filter((r) => r.original_tier === 2).length;
  const t3 = rows.filter((r) => r.original_tier === 3).length;
  const wins = rows.filter((r) => (r.pnl_total ?? 0) > 0).length;

  console.log(`[extract-snapshots] Wrote ${rows.length} snapshots → ${OUTPUT_PATH}`);
  console.log(`[extract-snapshots] Tier breakdown: T1=${t1}, T2=${t2}, T3=${t3}, no-tier=${rows.length - t1 - t2 - t3}`);
  console.log(`[extract-snapshots] Win rate: ${wins}/${rows.length} (${rows.length > 0 ? ((wins / rows.length) * 100).toFixed(1) : '0'}%)`);
  console.log(`[extract-snapshots] Snapshots with Migration 007 breakdown: ${rows.filter((r) => r.breakdown).length}`);
  console.log(`\nNext: run tests/scoring/historical-replay.test.ts to verify SC-006.`);
}

main().catch((err) => {
  console.error('[extract-snapshots] Fatal error:', err);
  process.exit(1);
});

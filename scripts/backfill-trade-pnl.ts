// scripts/backfill-trade-pnl.ts
//
// One-shot backfill: for every closed trade in [FROM, TO) whose pnl_total is
// NULL or 0, fetch broker P&L via Capital /history/transactions and (when
// --apply is passed) write it via setTradePnl. Dry-run by default.
//
// Date range covers the audit gap documented in project_farad_logging_gap_rca.md.
// Adjust FROM / TO constants below if rerunning for a different window.
//
// Usage:
//   npx tsx scripts/backfill-trade-pnl.ts            # dry-run (no DB writes)
//   npx tsx scripts/backfill-trade-pnl.ts --apply    # commit changes to DB
//
// After --apply, re-run the daily aggregator for each backfilled date:
//   for d in 2026-04-21 ... 2026-05-08; do
//     npx tsx -e "import('./src/database/index.js').then(m => \
//       m.initDatabaseAsync().then(() => m.aggregateAndUpsertDailyPnl('$d', 5000)))";
//   done

import 'dotenv/config';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDatabaseAsync, getTradeHistory, setTradePnl } from '../src/database/index.js';
import { CapitalClient } from '../src/mcp-server/capital-client.js';
import { capturePnlForTrade } from '../src/scheduler/pnl-capture.js';
import type { TradeRecord } from '../src/types.js';

// ==================== CONSTANTS ====================

/** Inclusive start of the backfill window (ISO date, UTC). */
export const FROM = '2026-04-21';

/**
 * Exclusive end of the backfill window (ISO date, UTC).
 * Trades whose closed_at falls on 2026-05-08 ARE included
 * (closed_at starts with '2026-05-08' which is < '2026-05-09').
 */
export const TO = '2026-05-09'; // exclusive upper bound so May 8 is included

// ==================== PURE HELPERS (exported for unit tests) ====================

/**
 * Filters a list of trade records down to the backfill candidates:
 * - Terminal status (complete / sl_hit / closed_early)
 * - closed_at falls within [FROM, TO)  — semantically correct for closed trades
 * - pnl_total is NULL or 0
 *
 * The comparison is a simple string prefix check on ISO dates, which works
 * reliably because sql.js stores closed_at as ISO-8601 strings and the range
 * constants are YYYY-MM-DD prefixes.
 */
export function filterCandidates(
  trades: TradeRecord[],
  from: string,
  to: string,
): TradeRecord[] {
  return trades.filter((t) => {
    if (!t.closed_at) return false;
    const closedDay = t.closed_at.substring(0, 10); // YYYY-MM-DD
    if (closedDay < from || closedDay >= to) return false;
    if (t.status !== 'complete' && t.status !== 'sl_hit' && t.status !== 'closed_early') return false;
    if (t.pnl_total !== null && t.pnl_total !== 0) return false;
    return true;
  });
}

// ==================== MAIN ====================

export async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');

  console.log('[backfill-trade-pnl] Starting...');
  console.log(`  Window  : ${FROM} → ${TO} (exclusive upper bound, so ${FROM} to 2026-05-08 inclusive)`);
  console.log(`  Mode    : ${apply ? 'APPLY (DB writes enabled)' : 'DRY-RUN (no DB writes)'}`);
  console.log('');

  // --- DB init ---
  // initDatabaseAsync() uses the hardcoded DB_PATH from src/database/index.ts
  // (data/trading-bot.db relative to the project root). No path argument needed.
  await initDatabaseAsync();

  // --- Capital client ---
  const apiKey = process.env.CAPITAL_API_KEY ?? '';
  const identifier = process.env.CAPITAL_IDENTIFIER ?? '';
  const password = process.env.CAPITAL_API_KEY_PASSWORD ?? '';
  const baseURL = process.env.CAPITAL_API_URL ?? 'https://demo-api-capital.backend-capital.com';
  const accountCurrency = process.env.CAPITAL_ACCOUNT_CURRENCY ?? 'EUR';

  if (!apiKey || !identifier || !password) {
    console.error(
      '[backfill-trade-pnl] Missing Capital.com credentials. ' +
      'Set CAPITAL_API_KEY, CAPITAL_IDENTIFIER, CAPITAL_API_KEY_PASSWORD in .env.',
    );
    process.exit(1);
  }

  const capital = new CapitalClient({ apiKey, identifier, password, baseURL });

  // --- Fetch + filter trades ---
  // 500 is well above the ~17 trades in a 17-day window (bot does ≤1/day).
  const all = getTradeHistory(500);
  const candidates = filterCandidates(all, FROM, TO);

  console.log(`[backfill-trade-pnl] ${all.length} total trades in DB. ` +
    `${candidates.length} candidate(s) in window with missing P&L.`);

  if (candidates.length === 0) {
    console.log('[backfill-trade-pnl] Nothing to backfill. Done.');
    await capital.logout();
    return;
  }

  console.log('');

  // --- Per-trade loop ---
  let updated = 0;
  let skipped = 0;

  for (const t of candidates) {
    let result;
    try {
      result = await capturePnlForTrade({
        trade: t,
        capital,
        accountCurrency,
        windowMode: 'terminal',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  FAIL  ${t.id} ${t.instrument} (${t.closed_at?.substring(0, 10)}) — capture threw: ${msg}`);
      skipped += 1;
      continue;
    }

    if (!result.found) {
      console.log(`  SKIP  ${t.id} ${t.instrument} (${t.closed_at?.substring(0, 10)}) — no broker P&L (${result.note})`);
      skipped += 1;
      continue;
    }

    const split = result.pnlA !== null || result.pnlB !== null;
    const legInfo = split
      ? `[A=${result.pnlA ?? 'null'}, B=${result.pnlB ?? 'null'}]`
      : '[total-only]';

    console.log(
      `  ${apply ? 'APPLY' : 'DRY  '} ${t.id} ${t.instrument} (${t.closed_at?.substring(0, 10)})` +
      ` → total=${result.pnlTotal} ${legInfo}`,
    );

    if (apply) {
      if (split) {
        setTradePnl(t.id, {
          pnlA: result.pnlA ?? undefined,
          pnlB: result.pnlB ?? undefined,
        });
      } else {
        setTradePnl(t.id, { pnlTotalOverride: result.pnlTotal });
      }
      updated += 1;
    }
  }

  // --- Summary ---
  console.log('');
  console.log(
    `[backfill-trade-pnl] Done. ` +
    `updated=${apply ? updated : 0} ` +
    `skipped=${skipped} ` +
    `dry-run=${!apply}` +
    (apply ? '' : ` (${candidates.length - skipped} would be written with --apply)`),
  );

  await capital.logout();
}

// ==================== CLI ENTRY POINT ====================
//
// Only runs main() when invoked directly (not when imported by tests).
// Windows-safe: compare resolved absolute paths rather than URL-encoding.
const scriptPath = resolve(fileURLToPath(import.meta.url));
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
const isMain = scriptPath === invokedPath;

if (isMain) {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[backfill-trade-pnl] FATAL: ${msg}`);
    process.exit(1);
  });
}

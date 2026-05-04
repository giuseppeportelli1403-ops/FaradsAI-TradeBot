// BetterOpsAI Trading Bot — Main Entry Point
// Initialises database, Telegram, starts scheduler, connects all agents

import { runPreflight } from './preflight.js';
import { initDatabaseAsync, saveToFile } from './database/index.js';
import { initTelegram, alertSystemWarning } from './notifications/telegram.js';
import { startScheduler } from './scheduler/index.js';

// 2026-04-29 audit-3 fix (scanner+misc P0-1): graceful shutdown handler.
// Pre-fix: pm2 SIGTERM during a restart killed the process mid-cycle;
// in-flight Capital API calls aborted, sql.js DB held in-memory could lose
// the last write batch since the previous saveToFile, and Capital sessions
// stayed alive on the broker side. Now: install SIGTERM/SIGINT handlers
// that flush the DB to disk before exiting.
//
// 2026-04-29 r7: removed Telegram alert from this path. The original
// alertSystemWarning fired on every signal, which meant a development
// burst of 5 pm2 restarts in 39 minutes flooded Telegram with 5
// identical "Shutting down" messages. The DB flush is the load-bearing
// fix; the alert was just noise. If genuine crash detection is wanted
// later, layer it as a separate heartbeat/uptime watchdog rather than
// on the shutdown path.
let shuttingDown = false;
function installShutdownHandlers(): void {
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[Shutdown] Received ${signal} — flushing DB and exiting.`);
    try {
      saveToFile();
      console.log('[Shutdown] DB flushed.');
    } catch (e) {
      console.error('[Shutdown] DB flush failed:', e);
    }
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

async function main(): Promise<void> {
  console.log('='.repeat(50));
  console.log('BetterOpsAI Trading Bot v0.1.0');
  console.log('='.repeat(50));

  installShutdownHandlers();

  // Step 0: Preflight environment checks
  await runPreflight();
  console.log('[OK] Preflight checks passed.');

  // Step 1: Initialise database
  await initDatabaseAsync();
  console.log('[OK] Database initialised.');

  // Step 2: Initialise Telegram notifications
  initTelegram();
  console.log('[OK] Telegram initialised.');

  // Log demo-phase flag status so ops can see at-a-glance whether the
  // relaxed gates are active (expected during the 2-week demo window only).
  const demoRelaxed = process.env.DEMO_RELAXED_GATES === 'true';
  console.log(`[Config] DEMO_RELAXED_GATES: ${demoRelaxed ? 'ACTIVE (Tier 3 at 40-59 [Phase E 2026-05-04], R:R 1.5:1 for tight-spread symbols)' : 'inactive (default strict gates)'}`);

  // Step 3: Start scheduler (candle detection, position monitoring, agent triggers)
  try {
    startScheduler();
  } catch (e) {
    console.error('[FATAL] Scheduler init failed:', e);
    await alertSystemWarning(`Trading bot scheduler failed to start: ${e instanceof Error ? e.message : String(e)}`).catch(() => {});
    process.exit(1);
  }
  console.log('[OK] Scheduler running. Bot is live.');
  console.log('='.repeat(50));
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

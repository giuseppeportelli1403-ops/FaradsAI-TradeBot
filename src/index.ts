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
// that flush the DB to disk and notify ops via Telegram before exiting.
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
    // Best-effort heads-up to Telegram. Don't block exit on it.
    alertSystemWarning(`Trading bot received ${signal}. Shutting down. DB flushed.`)
      .catch(() => { /* swallow — process exiting anyway */ });
    setTimeout(() => process.exit(0), 1500);
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
  console.log(`[Config] DEMO_RELAXED_GATES: ${demoRelaxed ? 'ACTIVE (kill-zone bonus 15/10, Tier 3 at 45-64, R:R 1.5:1 for tight-spread symbols)' : 'inactive (default strict gates)'}`);

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

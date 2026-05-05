// BetterOpsAI Trading Bot — Main Entry Point
// Initialises database, Telegram, starts scheduler, connects all agents

import { runPreflight } from './preflight.js';
import { initDatabaseAsync, saveToFile, getCriticalSectionDepth } from './database/index.js';
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

// 2026-05-05 audit (B3): drain in-flight critical sections before flushing.
// pm2's default kill_timeout is 1600ms; we wait up to 1400ms (poll every
// 100ms) for getCriticalSectionDepth() to reach 0, leaving a 200ms margin
// for the DB flush + exit. Pre-fix a SIGTERM mid-place_split_trade could
// leave a position live on Capital with no DB row.
const SHUTDOWN_DRAIN_MAX_MS = 1400;
const SHUTDOWN_DRAIN_POLL_MS = 100;

function installShutdownHandlers(): void {
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[Shutdown] Received ${signal} — draining in-flight critical sections.`);

    // Poll for criticalSectionDepth=0 with a hard timeout. If anything is
    // still in-flight at the timeout, we proceed anyway — a partial flush
    // is better than an empty one.
    const drainStart = Date.now();
    while (Date.now() - drainStart < SHUTDOWN_DRAIN_MAX_MS) {
      if (getCriticalSectionDepth() === 0) break;
      await new Promise((r) => setTimeout(r, SHUTDOWN_DRAIN_POLL_MS));
    }
    const remainingDepth = getCriticalSectionDepth();
    if (remainingDepth > 0) {
      console.warn(
        `[Shutdown] ${remainingDepth} critical section(s) still in flight after ${SHUTDOWN_DRAIN_MAX_MS}ms drain timeout. Flushing anyway — risk of partial state.`,
      );
    } else {
      const drainMs = Date.now() - drainStart;
      console.log(`[Shutdown] Drain complete in ${drainMs}ms (no in-flight sections${drainMs > 0 ? ' after wait' : ''}).`);
    }

    try {
      saveToFile();
      console.log('[Shutdown] DB flushed.');
    } catch (e) {
      console.error('[Shutdown] DB flush failed:', e);
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
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
  console.log(`[Config] DEMO_RELAXED_GATES: ${demoRelaxed ? 'ACTIVE (Tier 3 floor: 40 tight-spread / 45 medium-spread per spread-aware carve-out 2026-05-04; R:R 1.5:1 for tight-spread symbols)' : 'inactive (default strict gates)'}`);

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

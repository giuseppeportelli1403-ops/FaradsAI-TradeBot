// BetterOpsAI Trading Bot — Main Entry Point
// Initialises database, Telegram, starts scheduler, connects all agents

import { runPreflight } from './preflight.js';
import { initDatabaseAsync } from './database/index.js';
import { initTelegram } from './notifications/telegram.js';
import { startScheduler } from './scheduler/index.js';

async function main(): Promise<void> {
  console.log('='.repeat(50));
  console.log('BetterOpsAI Trading Bot v0.1.0');
  console.log('='.repeat(50));

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
  console.log(`[Config] DEMO_RELAXED_GATES: ${demoRelaxed ? 'ACTIVE (kill-zone bonus 15/10, Tier 3 at 50-64, R:R 1.5:1 for tight-spread symbols)' : 'inactive (default strict gates)'}`);

  // Step 3: Start scheduler (candle detection, position monitoring, agent triggers)
  startScheduler();
  console.log('[OK] Scheduler running. Bot is live.');
  console.log('='.repeat(50));
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

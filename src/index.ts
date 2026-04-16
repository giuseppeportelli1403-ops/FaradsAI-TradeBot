// BetterOpsAI Trading Bot — Main Entry Point
// Initialises database, Telegram, starts scheduler, connects all agents

import { initDatabaseAsync } from './database/index.js';
import { initTelegram } from './notifications/telegram.js';
import { startScheduler } from './scheduler/index.js';

async function main(): Promise<void> {
  console.log('='.repeat(50));
  console.log('BetterOpsAI Trading Bot v0.1.0');
  console.log('='.repeat(50));

  // Step 1: Initialise database
  await initDatabaseAsync();
  console.log('[OK] Database initialised.');

  // Step 2: Initialise Telegram notifications
  initTelegram();
  console.log('[OK] Telegram initialised.');

  // Step 3: Start scheduler (candle detection, position monitoring, agent triggers)
  startScheduler();
  console.log('[OK] Scheduler running. Bot is live.');
  console.log('='.repeat(50));
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

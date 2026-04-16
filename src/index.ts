// BetterOpsAI Trading Bot — Main Entry Point
// Initialises database, starts scheduler, connects all agents

import { initDatabase } from './database/index.js';
import { startScheduler } from './scheduler/index.js';

async function main(): Promise<void> {
  console.log('BetterOpsAI Trading Bot starting...');

  // Step 1: Initialise database
  initDatabase();
  console.log('Database initialised.');

  // Step 2: Start scheduler (candle detection, position monitoring, agent triggers)
  startScheduler();
  console.log('Scheduler running. Bot is live.');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

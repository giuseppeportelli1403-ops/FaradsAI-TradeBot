// scripts/_displacement-backtest.ts
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import process from 'node:process';
import { CapitalClient } from '../src/mcp-server/capital-client.js';
import type { Candle } from '../src/types.js';

const SUPPORTED_TICKERS = [
  'EURUSD', 'GBPUSD', 'AUDUSD', 'USDJPY',
  'GOLD', 'SILVER', 'OIL_CRUDE',
] as const;
type Ticker = (typeof SUPPORTED_TICKERS)[number];

const TYPICAL_SPREAD: Record<Ticker, number> = {
  EURUSD: 0.00010, GBPUSD: 0.00015, AUDUSD: 0.00015, USDJPY: 0.010,
  GOLD: 0.30, SILVER: 0.020, OIL_CRUDE: 0.030,
};

const RATE_LIMIT_MS = 250;

function parseArgs(argv: string[]) {
  const days = Number(argv.find((_, i) => argv[i - 1] === '--days') ?? 30);
  const outDir = argv.find((_, i) => argv[i - 1] === '--out') ?? 'data/metrics';
  const horizon = Number(argv.find((_, i) => argv[i - 1] === '--horizon') ?? 8);
  return { days, outDir, horizon };
}

async function main() {
  const { days, outDir, horizon } = parseArgs(process.argv.slice(2));
  console.log(`Displacement Continuation backtest — days=${days}, horizon=${horizon}×15M`);
  // TODO: fill in with Tasks 2-8
}

main().catch(e => { console.error(e); process.exit(1); });

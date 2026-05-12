// Range-Mode Backtest Runner (US-4 / Spec 001 / T075).
//
// Usage:
//   npx tsx scripts/backtest-range-mode.ts [--start 2019] [--end 2025] [--tickers EURUSD,GBPUSD] [--report path]
//
// Replays historical 1H candles through the range-mode backtest engine
// (src/backtest/range-engine.ts) and writes a markdown report comparing
// cap-on (current behaviour) vs cap-off (experimental). The report's
// verdict block applies the FR-012 decision rule.
//
// Mirrors scripts/run-backtest.ts so the data fetching + INSTRUMENT_UNIVERSE
// resolution behaves consistently across both backtests.

import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { join } from 'path';
import { fetchHistorical } from '../src/backtest/fetcher.js';
import { runRangeBacktest, renderRangeReport, type RangeBacktestResult } from '../src/backtest/range-engine.js';
import { INSTRUMENT_UNIVERSE } from '../src/scanner/index.js';

const args = process.argv.slice(2);
const getArg = (flag: string, def: string): string => {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : def;
};

const START_YEAR = parseInt(getArg('--start', '2019'), 10);
const END_YEAR = parseInt(getArg('--end', '2025'), 10);
const FORCE_REFRESH = args.includes('--refresh');

const tickerArg = getArg('--tickers', '');
const TICKERS: string[] = tickerArg
  ? tickerArg.split(',').map((t) => t.trim().toUpperCase())
  : INSTRUMENT_UNIVERSE.map((i) => i.ticker);

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPORT_PATH = join(here, '..', 'specs', '001-scoring-pipeline-audit', 'range-mode-backtest.md');
const REPORT_PATH = getArg('--report', DEFAULT_REPORT_PATH);

const API_KEY = process.env.TWELVE_DATA_API_KEY;
if (!API_KEY) {
  console.error('ERROR: TWELVE_DATA_API_KEY not set in environment or .env file');
  console.error('Range-mode backtest needs the same data source as run-backtest. Aborting.');
  process.exit(1);
}

async function main(): Promise<void> {
  console.log(`\nRange-Mode Backtest (US-4) — ${START_YEAR} to ${END_YEAR}`);
  console.log(`Instruments: ${TICKERS.join(', ')}`);
  console.log(`Report: ${REPORT_PATH}\n`);

  const results: RangeBacktestResult[] = [];

  for (const ticker of TICKERS) {
    const inst = INSTRUMENT_UNIVERSE.find((i) => i.ticker === ticker);
    if (!inst) {
      console.warn(`[Range Runner] ${ticker}: not in INSTRUMENT_UNIVERSE — skipping`);
      continue;
    }

    console.log(`\n[Range Runner] Processing ${ticker}...`);
    const candles = await fetchHistorical(ticker, '1h', START_YEAR, END_YEAR, API_KEY, FORCE_REFRESH);

    if (candles.length < 100) {
      console.warn(`[Range Runner] ${ticker}: insufficient candle data (${candles.length}) — skipping`);
      continue;
    }

    const result = runRangeBacktest(ticker, candles, inst.spread_quality === 'tight');
    results.push(result);
    console.log(
      `[Range Runner] ${ticker}: ${result.trades_simulated} setups | ` +
      `cap-on WR ${(result.cap_on.win_rate * 100).toFixed(1)}% | ` +
      `cap-off WR ${(result.cap_off.win_rate * 100).toFixed(1)}%`,
    );
  }

  if (results.length === 0) {
    console.error('No range-mode results — all instruments skipped or failed.');
    process.exit(1);
  }

  const report = renderRangeReport(results, new Date().toISOString());
  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, report, 'utf-8');
  console.log(`\n[Range Runner] Wrote report → ${REPORT_PATH}`);
}

main().catch((err) => {
  console.error('[Range Runner] Fatal error:', err);
  process.exit(1);
});

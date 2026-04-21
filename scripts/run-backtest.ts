// FARADBOT Backtest Runner
// Usage: npx tsx scripts/run-backtest.ts [--start 2019] [--end 2025] [--tickers EURUSD,GBPUSD]
//
// Downloads historical 1H candles from Twelve Data (cached to backtest-data/ after first run),
// replays them through the scoring and ICT simulation engine, and prints a full report.
//
// Requires TWELVE_DATA_API_KEY in .env or environment.

import 'dotenv/config';
import { fetchHistorical } from '../src/backtest/fetcher.js';
import { runBacktest } from '../src/backtest/engine.js';
import { buildCombinedReport, printReport, saveReport } from '../src/backtest/report.js';
import { INSTRUMENT_UNIVERSE } from '../src/scanner/index.js';

const args = process.argv.slice(2);
const getArg = (flag: string, def: string) => {
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

const API_KEY = process.env.TWELVE_DATA_API_KEY;
if (!API_KEY) {
  console.error('ERROR: TWELVE_DATA_API_KEY not set in environment or .env file');
  process.exit(1);
}

async function main() {
  console.log(`\nFARADBOT Backtest — ${START_YEAR} to ${END_YEAR}`);
  console.log(`Instruments: ${TICKERS.join(', ')}`);
  console.log(`Force refresh: ${FORCE_REFRESH}\n`);

  const results = [];

  for (const ticker of TICKERS) {
    const inst = INSTRUMENT_UNIVERSE.find((i) => i.ticker === ticker);
    if (!inst) {
      console.warn(`[Runner] ${ticker}: not in INSTRUMENT_UNIVERSE — skipping`);
      continue;
    }

    console.log(`\n[Runner] Processing ${ticker}...`);
    const candles = await fetchHistorical(ticker, '1h', START_YEAR, END_YEAR, API_KEY, FORCE_REFRESH);

    if (candles.length < 50) {
      console.warn(`[Runner] ${ticker}: insufficient candle data (${candles.length}) — skipping`);
      continue;
    }

    const result = runBacktest(ticker, candles, inst.spread_quality === 'tight');
    results.push(result);
    console.log(
      `[Runner] ${ticker}: ${result.total_trades} trades | WR ${result.win_rate}% | ` +
      `PF ${result.profit_factor} | Total ${result.total_r}R`,
    );
  }

  if (results.length === 0) {
    console.error('No results to report — all instruments skipped or failed.');
    process.exit(1);
  }

  const report = buildCombinedReport(results, START_YEAR, END_YEAR);
  printReport(report);
  saveReport(report);
}

main().catch((err) => {
  console.error('[Runner] Fatal error:', err);
  process.exit(1);
});

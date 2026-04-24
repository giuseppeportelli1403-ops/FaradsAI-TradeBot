// Historical Candle Fetcher — Downloads multi-year data from Twelve Data
// Saves to disk so backtest runs don't burn API credits on every execution.
// Cache lives in backtest-data/<ticker>_<interval>.json

import axios from 'axios';
import fs from 'fs';
import path from 'path';
import type { Candle } from '../types.js';
import { _mapToTwelveDataSymbol } from '../mcp-server/market-data.js';

const TWELVE_DATA_BASE = 'https://api.twelvedata.com';
const CACHE_DIR = path.resolve('backtest-data');

// Single source of truth for TD routing lives in market-data.ts; importing
// the mapper keeps backtest in sync with live (including GOLD→XAU/USD,
// SILVER→XAG/USD, and the UNAVAILABLE cohort for NAS100/SPX plus the
// defensively-included VIX/DXY).
// The original local SYMBOL_MAP here was missing GOLD/SILVER and the alias
// coverage, so backtest was scoring commodities against the wrong TD
// listings (Barrick Gold common stock, NSE-listed silver ETF in INR).
function resolveTdSymbol(ticker: string): string {
  const mapped = _mapToTwelveDataSymbol(ticker);
  if (mapped === null) {
    throw new Error(
      `[Backtest] ${ticker} is unavailable on the current Twelve Data tier ` +
        `(see TWELVE_DATA_UNAVAILABLE in market-data.ts). Either upgrade the ` +
        `plan or pick a different ticker.`,
    );
  }
  return mapped;
}

function cachePath(ticker: string, interval: string): string {
  return path.join(CACHE_DIR, `${ticker}_${interval}.json`);
}

export function loadCached(ticker: string, interval: string): Candle[] | null {
  const p = cachePath(ticker, interval);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Candle[];
    return raw;
  } catch {
    return null;
  }
}

function saveCache(ticker: string, interval: string, candles: Candle[]): void {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cachePath(ticker, interval), JSON.stringify(candles, null, 2));
}

async function fetchPage(
  symbol: string,
  interval: string,
  startDate: string,
  endDate: string,
  apiKey: string,
): Promise<Candle[]> {
  const url = `${TWELVE_DATA_BASE}/time_series`;
  const resp = await axios.get(url, {
    params: {
      symbol,
      interval,
      start_date: startDate,
      end_date: endDate,
      outputsize: 5000,
      order: 'ASC',
      apikey: apiKey,
    },
    timeout: 30_000,
  });

  const data = resp.data as { status?: string; message?: string; values?: Array<Record<string, string>> };

  if (data.status === 'error') {
    throw new Error(`Twelve Data error for ${symbol}: ${data.message}`);
  }

  const values = data.values ?? [];
  return values.map((v) => ({
    datetime: v.datetime,
    open: parseFloat(v.open),
    high: parseFloat(v.high),
    low: parseFloat(v.low),
    close: parseFloat(v.close),
    volume: parseFloat(v.volume ?? '0'),
  }));
}

// Fetch all candles between startYear and endYear, paginating if needed.
// Twelve Data returns up to 5000 candles per call; for 1h data over 6 years
// (~52k candles) we need multiple pages offset by date.
export async function fetchHistorical(
  ticker: string,
  interval: string,
  startYear: number,
  endYear: number,
  apiKey: string,
  forceRefresh = false,
): Promise<Candle[]> {
  if (!forceRefresh) {
    const cached = loadCached(ticker, interval);
    if (cached && cached.length > 0) {
      console.log(`[Fetcher] ${ticker} ${interval}: loaded ${cached.length} candles from cache`);
      return cached;
    }
  }

  const tdSymbol = resolveTdSymbol(ticker);
  const all: Candle[] = [];

  // Walk year by year to stay within 5000-candle limit per request (1h: ~8760/yr)
  for (let year = startYear; year <= endYear; year++) {
    const startDate = `${year}-01-01 00:00:00`;
    const endDate = `${year}-12-31 23:59:59`;
    console.log(`[Fetcher] ${ticker} ${interval} ${year}...`);

    try {
      // Twelve Data rate limit: 8 req/min on Grow tier
      await new Promise((r) => setTimeout(r, 8_000));
      const page = await fetchPage(tdSymbol, interval, startDate, endDate, apiKey);
      all.push(...page);
      console.log(`[Fetcher]   ${year}: ${page.length} candles`);
    } catch (err) {
      console.warn(`[Fetcher]   ${year} failed: ${(err as Error).message}`);
    }
  }

  // Sort ascending by datetime
  all.sort((a, b) => a.datetime.localeCompare(b.datetime));

  if (all.length > 0) {
    saveCache(ticker, interval, all);
    console.log(`[Fetcher] ${ticker}: ${all.length} total candles cached`);
  }

  return all;
}

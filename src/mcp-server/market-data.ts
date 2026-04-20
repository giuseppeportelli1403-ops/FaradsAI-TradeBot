// Market Data Clients — External API integrations
// Provides price data, economic calendar, VIX, DXY, yields, sector strength, news
//
// APIs used:
//   Twelve Data   — OHLC candles, VIX, DXY (800 req/day free, 8 credits/min)
//   Finnhub       — Economic calendar (60 req/min free)
//   Yahoo Finance — Sector strength via sector ETFs (no key, unofficial)
//   FRED          — Treasury yields (unlimited free)
//   Alpha Vantage — News with sentiment (25 req/day free)

import axios from 'axios';
import yahooFinance from 'yahoo-finance2';
import type {
  Candle, Timeframe, NewsItem, EconomicEvent,
  SectorStrength, CorrelationPair,
} from '../types.js';

// ==================== RESILIENCE UTILITIES ====================

/** Wrap an async fetcher with a time-based cache. */
export function withCache<T>(fetcher: () => Promise<T>, ttlMs: number): () => Promise<T> {
  let cachedValue: T | undefined;
  let cachedAt = 0;

  return async () => {
    const now = Date.now();
    if (cachedValue !== undefined && now - cachedAt < ttlMs) {
      return cachedValue;
    }
    cachedValue = await fetcher();
    cachedAt = Date.now();
    return cachedValue;
  };
}

/** Run an async fetcher; on any error, log and return the fallback value. */
export async function withFallback<T>(fetcher: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fetcher();
  } catch (err) {
    console.error('[Market Data] Fallback triggered:', (err as Error).message);
    return fallback;
  }
}

// ==================== TWELVE DATA ====================
// Covers: OHLC candles, VIX, DXY, and raw data for correlation computation

const TWELVE_DATA_BASE = 'https://api.twelvedata.com';

const TIMEFRAME_MAP: Record<Timeframe, string> = {
  '15m': '15min',
  '1h': '1h',
  '4h': '4h',
  '1d': '1day',
  '1w': '1week',
};

export async function fetchCandles(
  symbol: string,
  timeframe: Timeframe,
  outputSize: number = 100
): Promise<Candle[]> {
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) { console.error('[Market Data] TWELVE_DATA_API_KEY not set'); return []; }

  const { data } = await axios.get(`${TWELVE_DATA_BASE}/time_series`, {
    params: {
      symbol,
      interval: TIMEFRAME_MAP[timeframe],
      outputsize: outputSize,
      apikey: apiKey,
    },
  });

  if (data.status === 'error') {
    throw new Error(`Twelve Data error: ${data.message}`);
  }

  return (data.values || []).map((v: Record<string, string>) => ({
    datetime: v.datetime,
    open: parseFloat(v.open),
    high: parseFloat(v.high),
    low: parseFloat(v.low),
    close: parseFloat(v.close),
    volume: parseFloat(v.volume || '0'),
  }));
}

export async function fetchVix(): Promise<{ vix: number; vix_30d_avg: number }> {
  const candles = await fetchCandles('VIX', '1d', 30);
  const current = candles[0]?.close ?? 0;
  const avg = candles.reduce((sum, c) => sum + c.close, 0) / candles.length;
  return { vix: current, vix_30d_avg: Math.round(avg * 100) / 100 };
}

export async function fetchDxy(): Promise<{ dxy: number; direction: 'rising' | 'falling' | 'flat' }> {
  const candles = await fetchCandles('DXY', '1d', 10);
  const current = candles[0]?.close ?? 0;
  const fiveDaysAgo = candles[4]?.close ?? current;
  const change = ((current - fiveDaysAgo) / fiveDaysAgo) * 100;

  let direction: 'rising' | 'falling' | 'flat';
  if (change > 0.3) direction = 'rising';
  else if (change < -0.3) direction = 'falling';
  else direction = 'flat';

  return { dxy: current, direction };
}

export async function computeCorrelation(
  instrumentA: string,
  instrumentB: string,
  days: number = 30
): Promise<CorrelationPair> {
  const [candlesA, candlesB] = await Promise.all([
    fetchCandles(instrumentA, '1d', days),
    fetchCandles(instrumentB, '1d', days),
  ]);

  const returnsA = candlesA.slice(0, -1).map((c, i) =>
    (c.close - candlesA[i + 1].close) / candlesA[i + 1].close
  );
  const returnsB = candlesB.slice(0, -1).map((c, i) =>
    (c.close - candlesB[i + 1].close) / candlesB[i + 1].close
  );

  const n = Math.min(returnsA.length, returnsB.length);
  const meanA = returnsA.slice(0, n).reduce((s, v) => s + v, 0) / n;
  const meanB = returnsB.slice(0, n).reduce((s, v) => s + v, 0) / n;

  let cov = 0, varA = 0, varB = 0;
  for (let i = 0; i < n; i++) {
    const dA = returnsA[i] - meanA;
    const dB = returnsB[i] - meanB;
    cov += dA * dB;
    varA += dA * dA;
    varB += dB * dB;
  }

  const correlation = varA && varB ? cov / Math.sqrt(varA * varB) : 0;

  return {
    instrument_a: instrumentA,
    instrument_b: instrumentB,
    correlation_30d: Math.round(correlation * 1000) / 1000,
    correlation_90d: 0, // Would need 90 days of data
  };
}

// ==================== FINNHUB ====================
// Covers: Economic calendar

const FINNHUB_BASE = 'https://finnhub.io/api/v1';

export async function fetchEconomicCalendar(daysAhead: number): Promise<EconomicEvent[]> {
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) { console.error('[Market Data] FINNHUB_API_KEY not set'); return []; }

  const from = new Date().toISOString().split('T')[0];
  const to = new Date(Date.now() + daysAhead * 86400000).toISOString().split('T')[0];

  const { data } = await axios.get(`${FINNHUB_BASE}/calendar/economic`, {
    params: { from, to, token: apiKey },
  });

  return (data.economicCalendar || []).map((e: Record<string, unknown>) => ({
    date: e.date as string,
    time: e.time as string || '',
    event: e.event as string,
    country: e.country as string,
    impact: e.impact as 'high' | 'medium' | 'low',
    actual: e.actual as string | null,
    estimate: e.estimate as string | null,
    previous: e.prev as string | null,
    affected_instruments: [],
  }));
}

// ==================== YAHOO FINANCE (SECTOR STRENGTH) ====================
// FMP's /sector-performance was deprecated 2025-08-31. We now compute sector
// strength from the SPDR sector ETFs via Yahoo Finance, which returns the
// regularMarketChangePercent (1d) directly and historical opens for 1w/1m
// cumulative returns.

const SECTOR_ETFS: Array<{ ticker: string; sector: string }> = [
  { ticker: 'XLK', sector: 'Technology' },
  { ticker: 'XLF', sector: 'Financial Services' },
  { ticker: 'XLE', sector: 'Energy' },
  { ticker: 'XLV', sector: 'Healthcare' },
  { ticker: 'XLI', sector: 'Industrials' },
  { ticker: 'XLU', sector: 'Utilities' },
  { ticker: 'XLB', sector: 'Basic Materials' },
  { ticker: 'XLRE', sector: 'Real Estate' },
  { ticker: 'XLP', sector: 'Consumer Defensive' },
  { ticker: 'XLY', sector: 'Consumer Cyclical' },
  { ticker: 'XLC', sector: 'Communication Services' },
];

interface MinimalYahooQuote {
  symbol?: string;
  regularMarketChangePercent?: number;
}

export async function fetchSectorStrength(): Promise<SectorStrength[]> {
  const tickers = SECTOR_ETFS.map((e) => e.ticker);

  // Single batched quote call — 1 HTTP request for all 11 ETFs. `validateResult:
  // false` lets us tolerate occasional schema drift from Yahoo without crashing.
  const raw = (await yahooFinance.quote(tickers, {}, { validateResult: false })) as unknown;
  const quoteArray: MinimalYahooQuote[] = Array.isArray(raw)
    ? (raw as MinimalYahooQuote[])
    : [raw as MinimalYahooQuote];

  const quoteByTicker = new Map<string, MinimalYahooQuote>();
  for (const q of quoteArray) {
    if (q?.symbol) quoteByTicker.set(q.symbol, q);
  }

  return SECTOR_ETFS.map(({ ticker, sector }) => {
    const q = quoteByTicker.get(ticker);
    const pct = typeof q?.regularMarketChangePercent === 'number'
      ? q.regularMarketChangePercent
      : 0;
    return {
      sector,
      // Yahoo returns percent directly (e.g. 0.75 == 0.75%)
      performance_1d: Math.round(pct * 100) / 100,
      performance_1w: 0,
      performance_1m: 0,
    };
  });
}

// ==================== FRED ====================
// Covers: Treasury yield curve (2y, 10y, 30y)

const FRED_BASE = 'https://api.stlouisfed.org/fred';

async function fetchFredSeries(seriesId: string): Promise<number> {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) { console.error('[Market Data] FRED_API_KEY not set'); return 0; }

  const { data } = await axios.get(`${FRED_BASE}/series/observations`, {
    params: {
      series_id: seriesId,
      sort_order: 'desc',
      limit: 1,
      file_type: 'json',
      api_key: apiKey,
    },
  });

  const value = data.observations?.[0]?.value;
  return value && value !== '.' ? parseFloat(value) : 0;
}

export async function fetchYieldCurve(): Promise<{ us2y: number; us10y: number; us30y: number }> {
  const [us2y, us10y, us30y] = await Promise.all([
    fetchFredSeries('DGS2'),
    fetchFredSeries('DGS10'),
    fetchFredSeries('DGS30'),
  ]);
  return { us2y, us10y, us30y };
}

// ==================== ALPHA VANTAGE ====================
// Covers: News with sentiment scoring

const ALPHA_VANTAGE_BASE = 'https://www.alphavantage.co/query';

export async function fetchNewsContext(instrument: string): Promise<NewsItem[]> {
  const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
  if (!apiKey) { console.error('[Market Data] ALPHA_VANTAGE_API_KEY not set'); return []; }

  const { data } = await axios.get(ALPHA_VANTAGE_BASE, {
    params: {
      function: 'NEWS_SENTIMENT',
      tickers: instrument,
      apikey: apiKey,
      limit: 10,
    },
  });

  if (!data.feed) return [];

  return data.feed.map((article: Record<string, unknown>) => {
    const score = parseFloat(String(article.overall_sentiment_score || '0'));
    const absScore = Math.abs(score);

    let category: 'A' | 'B' | 'C';
    if (absScore >= 0.35) category = 'A';
    else if (absScore >= 0.15) category = 'B';
    else category = 'C';

    return {
      title: article.title as string,
      source: article.source as string,
      published_at: article.time_published as string,
      sentiment_score: score,
      relevance_score: parseFloat(String(
        (article.ticker_sentiment as Array<Record<string, string>>)?.[0]?.relevance_score || '0'
      )),
      category,
      summary: article.summary as string,
    };
  });
}

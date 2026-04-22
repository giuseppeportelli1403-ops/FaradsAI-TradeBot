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
import YahooFinance from 'yahoo-finance2';
import type {
  Candle, Timeframe, NewsItem, EconomicEvent,
  SectorStrength, CorrelationPair,
} from '../types.js';
import { TokenBucket } from './rate-limiter.js';
import { CandleCache, TIMEFRAME_INTERVAL } from './candle-cache.js';

export { RateLimitQueuedError } from './rate-limiter.js';

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

// Free tier: 8 credits/min. One /time_series call = 1 credit. Module-level
// singletons so all callers share the same bucket and cache (pm2 fork mode =
// single process, so no cross-process concerns).
const twelveDataBucket = new TokenBucket(8, 60_000);
const candleCache = new CandleCache();

// Daily-cap circuit breaker. Twelve Data signals exhaustion with HTTP 200 +
// {status:'error', message:'...out of API credits...'}, so neither axios nor
// the TokenBucket catches it — and each post-exhaustion call STILL counts
// toward the daily counter. Once tripped, fetchCandles short-circuits without
// hitting the network; auto-resets at Twelve Data's daily boundary (UTC 00:00).
let twelveDataDailyCap: { resetsAt: number } | null = null;

function nextUtcMidnight(): number {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
}

function isDailyCapTripped(): boolean {
  if (!twelveDataDailyCap) return false;
  if (Date.now() >= twelveDataDailyCap.resetsAt) {
    twelveDataDailyCap = null;
    return false;
  }
  return true;
}

function tripDailyCap(): void {
  if (twelveDataDailyCap) return;
  twelveDataDailyCap = { resetsAt: nextUtcMidnight() };
  console.warn(
    `[Market Data] Twelve Data daily cap tripped — short-circuiting until ${new Date(twelveDataDailyCap.resetsAt).toISOString()}`
  );
}

/** Exposed for tests and agents that want to warm/inspect the cache. */
export function _getCandleCache(): CandleCache {
  return candleCache;
}

/** Exposed for tests — reset the daily-cap breaker. */
export function _resetTwelveDataDailyCap(): void {
  twelveDataDailyCap = null;
}

/** Exposed for tests/monitoring — current breaker state. */
export function _getTwelveDataDailyCap(): { resetsAt: number } | null {
  return twelveDataDailyCap;
}

// Twelve Data symbol format differs from Farad's internal ticker convention
// (which mirrors Capital.com's `epic` field — mostly no slashes, mostly
// uppercase-concatenated). This mapper converts a Farad ticker to the symbol
// Twelve Data's /time_series endpoint accepts. Validated by hand 2026-04-21
// against the Grow-tier key; free tier was silently 404-ing on forex/indices
// (scanner swallowed errors via `catch { return null }` making it look like
// bias=neutral skipping — actually TD was refusing the requests).
//
// Returns null when the symbol is not available on the current tier (currently:
// VIX requires Pro tier). Callers MUST treat null as "no data available, not
// an error" — fetchCandles returns an empty array in that case.
const TWELVE_DATA_SYMBOL_MAP: Record<string, string> = {
  // Forex — TD requires slash
  EURUSD: 'EUR/USD',
  GBPUSD: 'GBP/USD',
  USDJPY: 'USD/JPY',
  GBPJPY: 'GBP/JPY',
  AUDUSD: 'AUD/USD',
  NZDUSD: 'NZD/USD',
  USDCAD: 'USD/CAD',
  USDCHF: 'USD/CHF',
  EURJPY: 'EUR/JPY',
  EURGBP: 'EUR/GBP',
  // Indices — TD uses academic/exchange tickers, not broker-style
  US30: 'DJIA',
  DE40: 'DAX',
  UK100: 'UKX',
  // Commodities — Farad/Capital tickers → TD spot symbols. Raw "GOLD" / "SILVER"
  // resolve on TD to a NYSE common stock (Barrick Gold) and a Bombay-listed ETF
  // respectively, not the spot metal — scanner bias was being computed from
  // unrelated series before 2026-04-22. WTI/USD is TD's crude oil spot.
  OIL_CRUDE: 'WTI/USD',
  GOLD: 'XAU/USD',
  SILVER: 'XAG/USD',
  // Macro — DXY is USDX or DX on TD
  DXY: 'DX',
  // Aliases — LLM agents and correlation defaults sometimes reach for the
  // common cross-broker names rather than Farad's universe tickers. Map them
  // to the same TD destinations so an "XAUUSD" / "USOIL" call doesn't fall
  // through to a raw ticker TD rejects with "symbol or figi missing".
  XAUUSD: 'XAU/USD',
  XAGUSD: 'XAG/USD',
  USOIL: 'WTI/USD',
  WTIUSD: 'WTI/USD',
};

// Symbols that are simply not available on the Grow tier. If we see one of
// these, return empty candles (which downstream consumers handle gracefully —
// e.g. fetchVix returns vix=0). Upgrading to Pro tier ($229/mo) unlocks VIX.
//
// NAS100 / SPX are here because TD's Grow tier has no reliable US equity
// index feed — IXIC is rejected outright, NDX resolves to a Frankfurt ADR,
// and SPX resolves to a Toronto penny stock. Returning [] makes the scanner
// and correlation fallbacks degrade cleanly instead of throwing "symbol or
// figi missing" or, worse, silently scoring on unrelated listings.
const TWELVE_DATA_UNAVAILABLE = new Set<string>(['VIX', 'NAS100', 'SPX']);

/** Exposed for tests — expose the mapper to verify coverage. */
export function _mapToTwelveDataSymbol(ticker: string): string | null {
  const upper = ticker.toUpperCase();
  if (TWELVE_DATA_UNAVAILABLE.has(upper)) return null;
  return TWELVE_DATA_SYMBOL_MAP[upper] ?? ticker;
}

export async function fetchCandles(
  symbol: string,
  timeframe: Timeframe,
  outputSize: number = 100
): Promise<Candle[]> {
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) { console.error('[Market Data] TWELVE_DATA_API_KEY not set'); return []; }

  const interval = TIMEFRAME_INTERVAL[timeframe];
  const cacheKey = CandleCache.key(symbol, interval, outputSize);

  // 1. Cache first — if we already fetched this (symbol,interval,size) inside
  //    the TTL window, serve it without burning a credit.
  const cached = candleCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  // 2. Map to Twelve Data's symbol format. Returns null for symbols not
  //    available on the current tier (e.g. VIX needs Pro). We return an empty
  //    array in that case so callers like fetchVix degrade gracefully instead
  //    of the Market Researcher crashing on an unhandled throw.
  const tdSymbol = _mapToTwelveDataSymbol(symbol);
  if (tdSymbol === null) {
    console.warn(`[Market Data] ${symbol} is not available on the current Twelve Data plan tier — returning empty candles.`);
    return [];
  }

  // 3. Circuit-breaker: skip the network call entirely if we've already hit
  //    the daily cap. Twelve Data still counts post-exhaustion calls, so this
  //    is how we stop bleeding credits (and log noise) until UTC midnight.
  if (isDailyCapTripped()) {
    throw new Error(
      `Twelve Data daily cap reached — resets at ${new Date(twelveDataDailyCap!.resetsAt).toISOString()}`
    );
  }

  // 4. Await a rate-limit token. Throws RateLimitQueuedError if the 60s wait
  //    expires; callers decide whether to surface the error or skip the step.
  await twelveDataBucket.acquire(60_000);

  let data: { status?: string; message?: string; values?: Array<Record<string, string>> };
  try {
    ({ data } = await axios.get(`${TWELVE_DATA_BASE}/time_series`, {
      params: {
        symbol: tdSymbol,
        interval,
        outputsize: outputSize,
        apikey: apiKey,
      },
    }));
  } catch (err) {
    // Defensive: if Twelve Data ever switches to real HTTP 429s, trip too.
    if (axios.isAxiosError(err) && err.response?.status === 429) {
      tripDailyCap();
    }
    throw err;
  }

  if (data.status === 'error') {
    // Daily credit exhaustion comes back as HTTP 200 + status:'error'. Detect
    // by message content and trip the breaker so we stop hitting the API.
    if (/out of api credits/i.test(data.message ?? '')) {
      tripDailyCap();
    }
    throw new Error(`Twelve Data error: ${data.message}`);
  }

  const candles: Candle[] = (data.values || []).map((v: Record<string, string>) => ({
    datetime: v.datetime,
    open: parseFloat(v.open),
    high: parseFloat(v.high),
    low: parseFloat(v.low),
    close: parseFloat(v.close),
    volume: parseFloat(v.volume || '0'),
  }));

  candleCache.set(cacheKey, candles, CandleCache.ttlFor(interval));
  return candles;
}

// Each external-data wrapper below uses withFallback so that when an
// upstream failure occurs (circuit breaker tripped, rate-limit queue
// timeout, network error, API returns error, unavailable symbol on current
// tier), the caller gets a sensible default instead of a thrown exception.
//
// This is load-bearing for the Market Researcher (daily 05:30 UTC cron),
// which calls these in `Promise.all`; one rejection would otherwise tear
// down the whole research cycle. Observed failure on 2026-04-21 05:30 UTC
// when the Twelve Data daily cap was tripped — Researcher crashed before
// reaching Finnhub/FRED/Yahoo stages.
//
// The fallback log (`[Market Data] Fallback triggered: ...`) is intentionally
// loud so ops notices. If a brief is generated with multiple fallbacks,
// treat its macro inputs as UNRELIABLE for that cycle.

export async function fetchVix(): Promise<{ vix: number; vix_30d_avg: number }> {
  return withFallback(async () => {
    const candles = await fetchCandles('VIX', '1d', 30);
    if (candles.length === 0) {
      // VIX is Pro-tier-only on Twelve Data; Grow returns empty. Degrade gracefully
      // rather than crashing the Market Researcher (which fetches this at 05:30 UTC).
      return { vix: 0, vix_30d_avg: 0 };
    }
    const current = candles[0]?.close ?? 0;
    const avg = candles.reduce((sum, c) => sum + c.close, 0) / candles.length;
    return { vix: current, vix_30d_avg: Math.round(avg * 100) / 100 };
  }, { vix: 0, vix_30d_avg: 0 });
}

export async function fetchDxy(): Promise<{ dxy: number; direction: 'rising' | 'falling' | 'flat' }> {
  return withFallback(async () => {
    const candles = await fetchCandles('DXY', '1d', 10);
    if (candles.length === 0) {
      return { dxy: 0 as number, direction: 'flat' as const };
    }
    const current = candles[0]?.close ?? 0;
    const fiveDaysAgo = candles[4]?.close ?? current;
    const change = fiveDaysAgo === 0 ? 0 : ((current - fiveDaysAgo) / fiveDaysAgo) * 100;

    let direction: 'rising' | 'falling' | 'flat';
    if (change > 0.3) direction = 'rising';
    else if (change < -0.3) direction = 'falling';
    else direction = 'flat';

    return { dxy: current, direction };
  }, { dxy: 0, direction: 'flat' as const });
}

export async function computeCorrelation(
  instrumentA: string,
  instrumentB: string,
  days: number = 30
): Promise<CorrelationPair> {
  return withFallback(async () => {
    const [candlesA, candlesB] = await Promise.all([
      fetchCandles(instrumentA, '1d', days),
      fetchCandles(instrumentB, '1d', days),
    ]);

    if (candlesA.length < 2 || candlesB.length < 2) {
      // Not enough data for correlation — return neutral.
      return {
        instrument_a: instrumentA,
        instrument_b: instrumentB,
        correlation_30d: 0,
        correlation_90d: 0,
      };
    }

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
  }, {
    instrument_a: instrumentA,
    instrument_b: instrumentB,
    correlation_30d: 0,
    correlation_90d: 0,
  });
}

// ==================== FINNHUB ====================
// Covers: Economic calendar

const FINNHUB_BASE = 'https://finnhub.io/api/v1';

export async function fetchEconomicCalendar(daysAhead: number): Promise<EconomicEvent[]> {
  return withFallback(async () => {
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
      affected_instruments: [] as string[],
    })) as EconomicEvent[];
  }, [] as EconomicEvent[]);
}

// ==================== YAHOO FINANCE (SECTOR STRENGTH) ====================
// FMP's /sector-performance was deprecated 2025-08-31. We now compute sector
// strength from the SPDR sector ETFs via Yahoo Finance, which returns the
// regularMarketChangePercent (1d) directly and historical opens for 1w/1m
// cumulative returns.
//
// yahoo-finance2 v3 dropped the singleton default export — callers must now
// instantiate YahooFinance. Singleton is safe: no per-call state, no auth.
const yahooFinance = new YahooFinance();

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
  return withFallback(async () => {
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
  }, SECTOR_ETFS.map(({ sector }) => ({
    sector,
    performance_1d: 0,
    performance_1w: 0,
    performance_1m: 0,
  })));
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
  // fetchFredSeries itself can throw (network, 401, 500). Use allSettled so a
  // single bad series doesn't nuke the other two. Then withFallback catches any
  // residual parse/throw just in case.
  return withFallback(async () => {
    const [us2yR, us10yR, us30yR] = await Promise.allSettled([
      fetchFredSeries('DGS2'),
      fetchFredSeries('DGS10'),
      fetchFredSeries('DGS30'),
    ]);
    return {
      us2y: us2yR.status === 'fulfilled' ? us2yR.value : 0,
      us10y: us10yR.status === 'fulfilled' ? us10yR.value : 0,
      us30y: us30yR.status === 'fulfilled' ? us30yR.value : 0,
    };
  }, { us2y: 0, us10y: 0, us30y: 0 });
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

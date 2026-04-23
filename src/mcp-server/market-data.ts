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

/**
 * Thrown by fetchCandles when the Twelve Data daily-credit circuit breaker
 * has tripped. A dedicated class lets callers check `err instanceof
 * TwelveDataDailyCapError` rather than matching on the message string —
 * the message wording can change without silently breaking the scanner's
 * ops-signal log or any other downstream consumer.
 */
export class TwelveDataDailyCapError extends Error {
  public readonly resetsAt: Date;
  constructor(resetsAt: Date) {
    super(`Twelve Data daily cap reached — resets at ${resetsAt.toISOString()}`);
    this.name = 'TwelveDataDailyCapError';
    this.resetsAt = resetsAt;
  }
}

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

/**
 * Exposed for tests — reset BOTH the daily-cap breaker AND the candle cache.
 * Safer than calling _resetTwelveDataDailyCap alone, which leaves cached
 * candles in place and can poison the next test case with stale data.
 * Prefer this helper in beforeEach blocks going forward.
 */
export function _resetTwelveDataState(): void {
  twelveDataDailyCap = null;
  candleCache.clear();
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
  // Commodities — Farad/Capital tickers → TD spot symbols. Raw "GOLD" / "SILVER"
  // resolve on TD to a NYSE common stock (Barrick Gold) and a Bombay-listed ETF
  // respectively, not the spot metal — scanner bias was being computed from
  // unrelated series before 2026-04-22. WTI/USD is TD's crude oil spot.
  OIL_CRUDE: 'WTI/USD',
  GOLD: 'XAU/USD',
  SILVER: 'XAG/USD',
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
//
// DXY is here for the same class of reason — the previous 'DX' mapping
// actually resolved to a NYSE REIT (not the ICE dollar index), and the
// Grow-tier alternatives 'USDX' / 'USD' are both WisdomTree/Invesco ETFs
// that track DXY *directionally* but trade around 25–70 in dollar terms
// (real DXY is ~99). Rather than ship a misleading absolute level to the
// researcher brief, we return dxy=0/flat and let the agent treat USD as a
// neutral signal. A future Pro-tier upgrade or alternative provider
// (Fixer.io, Finnhub) can restore real DXY.
//
// US30 / US100 / US500 / DE40 / UK100 are here because every Grow-tier TD
// symbol we've tested for them resolves to an unrelated ETF:
//   - US30 → DJIA              → NYSE ARCX ETF (Dow Jones-tracking, but
//                                 traded at ~$40 in USD, not the ~$38k index)
//   - DE40 → DAX               → NASDAQ XNMS ETF in USD (~$45)
//   - UK100 → UKX              → Euronext XPAR ETF in EUR (~€120)
//   - US100 / US500 raw         → Euronext XPAR ETFs in EUR
// The scanner was computing 1H bias on these wrong series for weeks. Returning
// [] via UNAVAILABLE gives the scanner a clean 'neutral' for indices, matching
// the DXY/SPX/NAS100 handling. Re-enable when a real index feed is wired
// (Pro-tier TD has the indices; or add Finnhub's /indices endpoint).
const TWELVE_DATA_UNAVAILABLE = new Set<string>([
  'VIX',
  'NAS100', 'SPX',
  'DXY',
  'US30', 'US100', 'US500', 'DE40', 'UK100',
]);

/** Exposed for tests — expose the mapper to verify coverage. */
export function _mapToTwelveDataSymbol(ticker: string): string | null {
  const upper = ticker.toUpperCase();
  if (TWELVE_DATA_UNAVAILABLE.has(upper)) return null;
  // Fall through to the uppercased ticker (NOT the raw input) so that
  // fetchCandles('aapl') and fetchCandles('AAPL') resolve to the same TD
  // symbol and share the candle cache. Pre-2026-04-22 this returned the
  // raw `ticker` which created silent cache misses on lowercase inputs.
  return TWELVE_DATA_SYMBOL_MAP[upper] ?? upper;
}

export async function fetchCandles(
  symbol: string,
  timeframe: Timeframe,
  outputSize: number = 100
): Promise<Candle[]> {
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) { console.error('[Market Data] TWELVE_DATA_API_KEY not set'); return []; }

  const interval = TIMEFRAME_INTERVAL[timeframe];

  // 1. Map to Twelve Data's symbol format FIRST. Two reasons:
  //
  //    (a) UNAVAILABLE symbols (VIX / NAS100 / SPX / DXY on Grow tier) short-
  //        circuit here without consulting cache or network — fast path.
  //
  //    (b) The cache is keyed on the TD-side symbol so that aliases share
  //        entries. Pre-2026-04-22, fetchCandles('GOLD', ...) and
  //        fetchCandles('XAUUSD', ...) both mapped to TD's XAU/USD but were
  //        cached separately — ~2x credits for identical data. Routing the
  //        cache key through the mapper collapses that duplication.
  const tdSymbol = _mapToTwelveDataSymbol(symbol);
  if (tdSymbol === null) {
    console.warn(`[Market Data] ${symbol} is not available on the current Twelve Data plan tier — returning empty candles.`);
    return [];
  }

  const cacheKey = CandleCache.key(tdSymbol, interval, outputSize);

  // 2. Cache next — if we already fetched this (tdSymbol,interval,size)
  //    inside the TTL window, serve it without burning a credit.
  const cached = candleCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  // 3. Circuit-breaker: skip the network call entirely if we've already hit
  //    the daily cap. Twelve Data still counts post-exhaustion calls, so this
  //    is how we stop bleeding credits (and log noise) until UTC midnight.
  if (isDailyCapTripped()) {
    throw new TwelveDataDailyCapError(new Date(twelveDataDailyCap!.resetsAt));
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

  // Parse + validate. Twelve Data returns all numeric fields as strings;
  // parseFloat on a missing/empty field yields NaN, and NaN in a Candle
  // silently poisons every downstream consumer:
  //   - detectBias comparisons (NaN > x is always false → scanner bias flips
  //     silently to 'neutral' and the instrument gets filtered out)
  //   - ATR / SL / TP math (NaN * x = NaN → agent posts unplaceable orders)
  //   - computeCorrelation reducer (NaN propagates through mean / variance
  //     → returns correlation_30d = NaN → rounded to NaN)
  //
  // So: drop candles with any non-finite OHLC value. Volume defaulting to 0
  // is still allowed (TD omits it for FX pairs, which is fine — downstream
  // code already treats volume==0 as "unknown, not empty"). Finite-OHLC is
  // the contract Candle consumers rely on.
  const candles: Candle[] = [];
  let malformedCount = 0;
  for (const v of data.values || []) {
    const open = parseFloat(v.open);
    const high = parseFloat(v.high);
    const low = parseFloat(v.low);
    const close = parseFloat(v.close);
    const volume = parseFloat(v.volume || '0');
    if (
      !Number.isFinite(open) ||
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(close)
    ) {
      malformedCount++;
      continue;
    }
    candles.push({
      datetime: v.datetime,
      open,
      high,
      low,
      close,
      volume: Number.isFinite(volume) ? volume : 0,
    });
  }
  if (malformedCount > 0) {
    console.warn(
      `[Market Data] Dropped ${malformedCount} malformed ${tdSymbol} ${interval} candle(s) with non-finite OHLC values.`,
    );
  }

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

// One-shot flag so we loudly announce AV's daily-quota exhaustion the first
// time it's observed in this process, then fall silent on repeat responses.
// Same UX goal as the TwelveData daily-cap error — let ops see it without
// flooding the log when every subsequent cycle hits the same cap.
//
// Stores the UTC date (YYYY-MM-DD) of the last loud log so the flag
// auto-resets across day boundaries — otherwise a long-running process would
// only announce the FIRST day's exhaustion and silently swallow every
// subsequent day's. `null` = never logged.
let alphaVantageRateLimitLoggedForUtcDate: string | null = null;
let alphaVantageBurstLimitLoggedForUtcDate: string | null = null;

// AV free tier enforces a 1 req/sec burst limit in ADDITION to the 25 req/day
// daily quota. Parallel scanner calls (Promise.all across N instruments) would
// trip it and get an `Information` body back — no `feed`, no error, silent []
// downstream. Bucket: 1 token, refill every 1100 ms (1.1 s for margin). The
// TokenBucket.acquire() semantics queue concurrent callers automatically, so
// no caller changes are needed. Confirmed 2026-04-23 via live probe: with 3
// parallel AV calls, only the first succeeded; #2 and #3 came back with
// "spread out your requests more sparingly (1 request per second)".
//
// `let` (not const) so tests can swap to a permissive bucket — 22 sequential
// fetchNewsContext calls would otherwise take 24+ seconds at prod throttle,
// timing out the 10-second vitest default.
let alphaVantageBurstBucket = new TokenBucket(1, 1100);

/**
 * Exposed for tests — swap the AV burst bucket for a permissive one that
 * won't gate sequential test calls. Call with no args to restore defaults.
 */
export function _setAlphaVantageBurstBucketForTests(
  bucket: TokenBucket = new TokenBucket(1, 1100),
): void {
  alphaVantageBurstBucket = bucket;
}

// ========== News-resilience layers (added 2026-04-23) ==========
//
// Problem being solved: the AV free tier is 25 req/day. The bot was burning
// ~100/day (agent re-invokes get_news_context mid-reasoning; scanner + swing
// + researcher all call independently). Once exhausted, fetchNewsContext
// returned [] for EVERY ticker for the rest of the UTC day. With the news
// component contributing -15..+20 to composite score, that meant the bot
// was trading news-blind through the NY Open kill zone — including trading
// INTO bearish news it couldn't see.
//
// Layered defense:
//   1. Per-ticker 30-min TTL cache — repeat calls in the same window skip AV
//   2. Stale-cache extension — when AV returns exhausted OR burst-retry fails,
//      serve cached items up to 4 h old with stale_minutes tagged for scoring
//   3. Daily soft-cap at 22/25 — stops hitting AV past 22 calls per UTC day,
//      preserves headroom for the 05:30 Researcher + 21:30 Swing runs
//   4. stale_minutes tag on NewsItem flows to scoring — src/news/index.ts
//      dampens bearish aggregates when age > 60 min to prevent news-blind
//      bearish trades
//   5. One-shot Telegram alert per UTC day when news availability degrades

const NEWS_CACHE_FRESH_MS = 30 * 60 * 1000;         // 30 min — serve as-is
const NEWS_CACHE_STALE_MAX_MS = 4 * 60 * 60 * 1000; // 4 h — max tolerable staleness
const ALPHA_VANTAGE_DAILY_SOFT_CAP = 22;            // of 25 — reserve 3 for
                                                    // Researcher + Swing + buffer

type CachedNewsEntry = { fetchedAt: number; value: NewsItem[] };
const newsCache = new Map<string, CachedNewsEntry>();

let alphaVantageCallsByUtcDate: { date: string; count: number } | null = null;
let newsDegradedAlertFiredForUtcDate: string | null = null;

function currentUtcDateString(): string {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

/** Exposed for tests — reset the one-shot AV rate-limit log flag. */
export function _resetAlphaVantageRateLimitFlag(): void {
  alphaVantageRateLimitLoggedForUtcDate = null;
  alphaVantageBurstLimitLoggedForUtcDate = null;
}

/** Exposed for tests — clear news cache + daily counter + alert flag. */
export function _resetNewsResilienceState(): void {
  newsCache.clear();
  alphaVantageCallsByUtcDate = null;
  newsDegradedAlertFiredForUtcDate = null;
}

/** Exposed for tests — peek at current AV daily call count. */
export function _getAlphaVantageCallCount(): number {
  const today = currentUtcDateString();
  if (alphaVantageCallsByUtcDate?.date !== today) return 0;
  return alphaVantageCallsByUtcDate.count;
}

function bumpAlphaVantageCallCounter(): void {
  const today = currentUtcDateString();
  if (alphaVantageCallsByUtcDate?.date !== today) {
    alphaVantageCallsByUtcDate = { date: today, count: 0 };
  }
  alphaVantageCallsByUtcDate.count += 1;
}

function isAlphaVantageDailyCapReached(): boolean {
  const today = currentUtcDateString();
  if (alphaVantageCallsByUtcDate?.date !== today) return false;
  return alphaVantageCallsByUtcDate.count >= ALPHA_VANTAGE_DAILY_SOFT_CAP;
}

/**
 * Fire a Telegram alert (at most once per UTC day) that news availability is
 * degraded. Caller passes a short reason for the alert body. Dynamically
 * imported to avoid a static cycle with the notifications module and to keep
 * market-data.ts unit-testable without a Telegram mock.
 */
function fireNewsDegradedAlertOncePerDay(reason: string): void {
  const today = currentUtcDateString();
  if (newsDegradedAlertFiredForUtcDate === today) return;
  newsDegradedAlertFiredForUtcDate = today;
  console.error(
    `[Market Data] News feed degraded: ${reason}. Serving cached/empty for the rest of the UTC day.`,
  );
  // Fire-and-forget. Import dynamically so tests that don't configure
  // Telegram credentials aren't coupled to the notifications module. Any
  // failure is swallowed with a log — Telegram being down must not take
  // down the news fetch path.
  import('../notifications/telegram.js')
    .then(({ alertSystemWarning }) =>
      alertSystemWarning(
        `Farad news feed degraded — ${reason}. ` +
          `Serving stale cache where available, empty otherwise. ` +
          `Quota resets at UTC midnight.`,
      ),
    )
    .catch((err) => {
      console.error(`[Market Data] Telegram news-degraded alert failed: ${(err as Error).message}`);
    });
}

/**
 * Serve cached news items with their real age tagged in stale_minutes.
 * Returns [] if no cache or cache older than NEWS_CACHE_STALE_MAX_MS.
 */
function serveStaleOrEmpty(instrument: string): NewsItem[] {
  const key = instrument.toUpperCase();
  const cached = newsCache.get(key);
  if (!cached) return [];
  const ageMs = Date.now() - cached.fetchedAt;
  if (ageMs > NEWS_CACHE_STALE_MAX_MS) return [];
  const staleMinutes = Math.floor(ageMs / 60_000);
  console.log(
    `[Market Data] AV news for ${instrument}: serving stale cache (${staleMinutes} min old, ${cached.value.length} articles)`,
  );
  return cached.value.map((item) => ({ ...item, stale_minutes: staleMinutes }));
}

/**
 * Normalises a Farad ticker to the format Alpha Vantage's NEWS_SENTIMENT
 * endpoint expects in its `tickers` parameter.
 *
 *   - FX pairs       → "FOREX:X,FOREX:Y" (both sides; AV supports comma-list)
 *   - Commodities    → ETF proxy tickers (GLD / SLV / USO) since AV has no
 *                      commodity-specific prefix. News about the ETF is the
 *                      closest-available sentiment signal.
 *   - US stocks      → uppercased pass-through (AAPL / MSFT / NVDA work raw)
 *
 * Exported so tests can verify routing coverage. Mapping chosen from AV
 * docs 2026-04-22; live-probe verification happens 2026-04-23+ when the
 * free-tier 25-req daily quota resets. The per-call log inside
 * fetchNewsContext records `instrument → mapped → N articles` so any
 * entry returning empty feeds is visible immediately.
 */
export function normalizeForAlphaVantage(instrument: string): string {
  const upper = instrument.toUpperCase();

  const fxMap: Record<string, string> = {
    EURUSD: 'FOREX:EUR,FOREX:USD',
    GBPUSD: 'FOREX:GBP,FOREX:USD',
    USDJPY: 'FOREX:USD,FOREX:JPY',
    AUDUSD: 'FOREX:AUD,FOREX:USD',
    GBPJPY: 'FOREX:GBP,FOREX:JPY',
    NZDUSD: 'FOREX:NZD,FOREX:USD',
    USDCAD: 'FOREX:USD,FOREX:CAD',
    USDCHF: 'FOREX:USD,FOREX:CHF',
    EURJPY: 'FOREX:EUR,FOREX:JPY',
    EURGBP: 'FOREX:EUR,FOREX:GBP',
  };
  if (fxMap[upper]) return fxMap[upper];

  const commodityMap: Record<string, string> = {
    GOLD: 'GLD',
    XAUUSD: 'GLD',
    SILVER: 'SLV',
    XAGUSD: 'SLV',
    OIL_CRUDE: 'USO',
    USOIL: 'USO',
    WTIUSD: 'USO',
  };
  if (commodityMap[upper]) return commodityMap[upper];

  return upper;
}

export async function fetchNewsContext(instrument: string): Promise<NewsItem[]> {
  const mappedTicker = normalizeForAlphaVantage(instrument);
  const cacheKey = instrument.toUpperCase();

  // ===== Layer 1 — 30-min fresh cache =====
  // Absorb the agent's multi-call-per-cycle pattern (the ICT agent re-invokes
  // get_news_context several times within a single reasoning chain — logs
  // showed 5 SILVER + 4 GOLD calls in 90 min on 2026-04-23 morning). This is
  // the biggest burn reducer.
  const cached = newsCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < NEWS_CACHE_FRESH_MS) {
    return cached.value.map((item) => ({ ...item, stale_minutes: 0 }));
  }

  // ===== Layer 3 — daily soft-cap at 22/25 =====
  // Stop hitting AV past 22 calls/day so the 05:30 Researcher + 21:30 Swing
  // runs always have headroom. On cap-hit, fall through to stale cache then
  // []. Alert fires once per UTC day.
  if (isAlphaVantageDailyCapReached()) {
    fireNewsDegradedAlertOncePerDay(
      `daily soft cap of ${ALPHA_VANTAGE_DAILY_SOFT_CAP}/25 AV calls reached`,
    );
    const stale = serveStaleOrEmpty(instrument);
    if (stale.length === 0) {
      console.log(
        `[Market Data] AV news for ${instrument} (as ${mappedTicker}): 0 articles [daily soft-cap reached, no cache]`,
      );
    }
    return stale;
  }

  // ===== Fresh fetch path =====
  // Inline error handling (was withFallback) so we can route exceptions to
  // the stale-cache fallback instead of []. Any throw lands in the catch
  // and serves cached-if-available.
  try {
    const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
    if (!apiKey) {
      console.error('[Market Data] ALPHA_VANTAGE_API_KEY not set');
      return serveStaleOrEmpty(instrument);
    }

    await alphaVantageBurstBucket.acquire(10_000);

    const avCall = () =>
      axios.get(ALPHA_VANTAGE_BASE, {
        params: {
          function: 'NEWS_SENTIMENT',
          tickers: mappedTicker,
          apikey: apiKey,
          limit: 10,
        },
      });

    bumpAlphaVantageCallCounter();
    let { data } = await avCall();

    // ===== Layer 2 trigger — AV daily quota exhausted =====
    // Fall through to stale cache (up to 4 h old) instead of []. Alert Giuseppe
    // once. Previously this returned [] silently for the rest of the UTC day.
    if (
      !data.feed &&
      typeof data.Information === 'string' &&
      /standard api rate limit is \d+ requests per day/i.test(data.Information)
    ) {
      const today = currentUtcDateString();
      if (alphaVantageRateLimitLoggedForUtcDate !== today) {
        console.error(
          `[Market Data] Alpha Vantage daily rate limit reached (25 req/day on free tier). ` +
            `Serving stale cache for the rest of the UTC day. Quota resets at UTC midnight.`,
        );
        alphaVantageRateLimitLoggedForUtcDate = today;
      }
      fireNewsDegradedAlertOncePerDay('AV daily quota (25/day) exhausted');
      return serveStaleOrEmpty(instrument);
    }

    // ===== Burst limit detection + single retry (unchanged from 2026-04-23 fix) =====
    if (
      !data.feed &&
      typeof data.Information === 'string' &&
      /more sparingly|1 request per second/i.test(data.Information)
    ) {
      const today = currentUtcDateString();
      if (alphaVantageBurstLimitLoggedForUtcDate !== today) {
        console.error(
          `[Market Data] Alpha Vantage burst limit hit (1 req/sec). Retrying after delay. ` +
            `If this recurs, another process is likely sharing the AV key.`,
        );
        alphaVantageBurstLimitLoggedForUtcDate = today;
      }
      await new Promise((r) => setTimeout(r, 1500));
      await alphaVantageBurstBucket.acquire(10_000);
      bumpAlphaVantageCallCounter();
      ({ data } = await avCall());
    }

    if (!Array.isArray(data.feed)) {
      console.log(
        `[Market Data] AV news for ${instrument} (as ${mappedTicker}): 0 articles [unexpected response shape]`,
      );
      return serveStaleOrEmpty(instrument);
    }

    // ===== Success path — parse, cache, return fresh =====
    console.log(
      `[Market Data] AV news for ${instrument} (as ${mappedTicker}): ${data.feed.length} articles`,
    );

    const items: NewsItem[] = data.feed.map((article: Record<string, unknown>) => {
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
        relevance_score: parseFloat(
          String((article.ticker_sentiment as Array<Record<string, string>>)?.[0]?.relevance_score || '0'),
        ),
        category,
        summary: article.summary as string,
        stale_minutes: 0,
      };
    });

    newsCache.set(cacheKey, { fetchedAt: Date.now(), value: items });
    return items;
  } catch (err) {
    console.error(
      `[Market Data] AV news for ${instrument}: fetch error — ${(err as Error).message}. Falling back to cache.`,
    );
    return serveStaleOrEmpty(instrument);
  }
}

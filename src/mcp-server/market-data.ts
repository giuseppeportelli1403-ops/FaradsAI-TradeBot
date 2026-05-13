// Market Data Clients — External API integrations
// Provides price data, economic calendar, yields, sector strength, news
//
// APIs used:
//   Twelve Data   — OHLC candles (800 req/day free, 8 credits/min)
//   Finnhub       — Economic calendar (60 req/min free)
//   Yahoo Finance — Sector strength via sector ETFs (no key, unofficial)
//   FRED          — Treasury yields (unlimited free)
//   MarketAux     — News with per-entity sentiment (100 req/day free)

import axios from 'axios';
import YahooFinance from 'yahoo-finance2';
import type {
  Candle, Timeframe, NewsItem, EconomicEvent,
  SectorStrength, CorrelationPair,
} from '../types.js';
import { TokenBucket } from './rate-limiter.js';
import { CandleCache, TIMEFRAME_INTERVAL } from './candle-cache.js';
import { matchesHighImpactKeyword } from '../news/impact-classifier.js';
import { parseTwelveDataDatetime } from './td-datetime.js';
import { canonicalizeUrl } from '../news/url-canonical.js';
import { fetchArticleBody } from '../news/jina-reader.js';

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

/**
 * Race a promise against a wall-clock timeout. Used to bound third-party
 * libraries that lack their own timeout config (yahoo-finance2, axios in
 * specific paths) — see audit-3 r3 fix for market-data P1-10 / P1-4.
 *
 * Cleans the timer on resolve/reject so timers don't leak into the cron
 * cadence.
 */
export async function withWallClockTimeout<T>(
  fetcher: () => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([fetcher(), timeoutPromise]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

// ==================== TWELVE DATA ====================
// Covers: OHLC candles and raw data for correlation computation

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
// these, return empty candles (which downstream consumers handle gracefully).
//
// NAS100 / SPX are here because TD's Grow tier has no reliable US equity
// index feed — IXIC is rejected outright, NDX resolves to a Frankfurt ADR,
// and SPX resolves to a Toronto penny stock. Returning [] makes the scanner
// and correlation fallbacks degrade cleanly instead of throwing "symbol or
// figi missing" or, worse, silently scoring on unrelated listings.
//
// VIX and DXY are here defensively — no production code path calls them
// after the 2026-04-24 removal of fetchVix/fetchDxy (the free-tier proxies
// were misleading: DXY proxies traded at 25–70 vs real DXY ~99, and VIX
// required the $229/mo Pro tier). Left in UNAVAILABLE so any stray
// fetchCandles('VIX'|'DXY', ...) from an LLM-authored tool call returns
// empty candles rather than a hard error.
//
// US30 / US100 / US500 / DE40 / UK100 are here because every Grow-tier TD
// symbol we've tested for them resolves to an unrelated ETF:
//   - US30 → DJIA              → NYSE ARCX ETF (Dow Jones-tracking, but
//                                 traded at ~$40 in USD, not the ~$38k index)
//   - DE40 → DAX               → NASDAQ XNMS ETF in USD (~$45)
//   - UK100 → UKX              → Euronext XPAR ETF in EUR (~€120)
//   - US100 / US500 raw         → Euronext XPAR ETFs in EUR
// The scanner was computing 1H bias on these wrong series for weeks. Returning
// [] via UNAVAILABLE gives the scanner a clean 'neutral' for indices. Re-enable
// when a real index feed is wired (Pro-tier TD has the indices; or add
// Finnhub's /indices endpoint).
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

  // 2026-04-29 audit-3 fix (market-data audit P0-1): re-check breaker AFTER
  // bucket acquire. Pre-fix: parallel callers (e.g. Researcher's correlation
  // matrix Promise.all) could all pass the pre-acquire check, all acquire
  // tokens, all fire HTTP requests, with only the FIRST result tripping the
  // breaker — the other 7 in-flight calls bled credits past the cap. Now:
  // any caller whose acquire was queued behind a tripped sibling
  // short-circuits before hitting the network.
  if (isDailyCapTripped()) {
    throw new TwelveDataDailyCapError(new Date(twelveDataDailyCap!.resetsAt));
  }

  let data: { status?: string; message?: string; values?: Array<Record<string, string>> };
  try {
    // `timezone: 'UTC'` is load-bearing. Without it, TD returns datetimes in
    // the exchange's local timezone (or CEST for some commodity feeds —
    // observed on SILVER 2026-04-24 09:27 UTC). Mixing CEST strings with
    // downstream `new Date(datetime)` UTC interpretation is how the bot
    // pricing structures landed on bars that hadn't printed yet.
    ({ data } = await axios.get(`${TWELVE_DATA_BASE}/time_series`, {
      params: {
        symbol: tdSymbol,
        interval,
        outputsize: outputSize,
        apikey: apiKey,
        timezone: 'UTC',
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
  let futureDroppedCount = 0;
  let unparseableDatetimeCount = 0;
  // 60s tolerance: TD bars print at minute boundaries; a few hundred ms of
  // clock skew between the TD server and our VPS shouldn't cause the freshest
  // bar to be dropped as "future".
  const futureCutoff = Date.now() + 60_000;
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
    // Defense-in-depth on top of `timezone: 'UTC'` — drop any candle whose
    // datetime parses as future. parseTwelveDataDatetime handles bare
    // 'YYYY-MM-DD HH:mm:ss' AND ISO forms with Z or offset (CR-3); the
    // prior inline parse silently failed on TZ-qualified inputs and let
    // future candles slip through.
    //
    // CR-7 (2026-04-28): when datetime is unparseable, drop the candle
    // entirely. The prior wire-in only dropped on `tsMs > futureCutoff`,
    // letting unparseable inputs (epoch strings, malformed locales, junk)
    // bypass the future-drop guard — exactly the silent-admit class of
    // bug CR-3 was meant to close. Now: null tsMs → drop + warn.
    const tsMs = parseTwelveDataDatetime(v.datetime);
    if (tsMs === null) {
      unparseableDatetimeCount++;
      continue;
    }
    if (tsMs > futureCutoff) {
      futureDroppedCount++;
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
  if (futureDroppedCount > 0) {
    console.warn(
      `[Market Data] Dropped ${futureDroppedCount} future-dated ${tdSymbol} ${interval} candle(s) — TD timezone misconfig suspected.`,
    );
  }
  if (unparseableDatetimeCount > 0) {
    console.warn(
      `[Market Data] Dropped ${unparseableDatetimeCount} ${tdSymbol} ${interval} candle(s) with unparseable datetime — TD format change suspected.`,
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


// ==================== YAHOO FINANCE (SECTOR STRENGTH) ====================
// FMP's /sector-performance was deprecated 2025-08-31. We now compute sector
// strength from the SPDR sector ETFs via Yahoo Finance, which returns the
// regularMarketChangePercent (1d) directly and historical opens for 1w/1m
// cumulative returns.
//
// yahoo-finance2 v3 dropped the singleton default export — callers must now
// instantiate YahooFinance. Singleton is safe: no per-call state, no auth.
//
// Custom logger silences the "Requires Node >= 22.0.0, found 20.20.2.
// Things might break or work unexpectedly!" warning that yahoo-finance2 emits
// on every construction. The library's runtime check is stricter than its
// actual feature use — its package.json declares engines.node >=20 and the
// quote() endpoint we depend on works fine on Node 20 (verified live
// 2026-04-17 → 2026-04-25). The warning was spamming pm2-out.log dozens
// of times per day before being silenced. All other warns/errors flow
// through unchanged.
const yahooFinance = new YahooFinance({
  logger: {
    info: (...args: unknown[]) => console.info(...args),
    warn: (...args: unknown[]) => {
      const first = args[0];
      if (typeof first === 'string' && first.includes('[yahoo-finance2] Unsupported environment')) {
        return;
      }
      console.warn(...args);
    },
    error: (...args: unknown[]) => console.error(...args),
    debug: (...args: unknown[]) => console.debug(...args),
    dir: (...args: unknown[]) => console.dir(...args),
  },
});

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
    // 2026-04-29 audit-3 r3 fix (market-data P1-10): wrap in withWallClockTimeout.
    // yahoo-finance2 has no per-call timeout config; if Yahoo throttles or blocks
    // the IP, the call hangs indefinitely until Node's default socket timeout
    // (~120s on Linux). Researcher's Promise.all would stall the whole cron.
    const raw = (await withWallClockTimeout(
      () => yahooFinance.quote(tickers, {}, { validateResult: false }),
      10_000,
      'yahoo-finance.quote',
    )) as unknown;
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

// ==================== MARKETAUX ====================
// Covers: News with per-entity sentiment scoring.
//
// Free tier: 100 requests/day, 30 requests/minute burst. Swapped from
// Alpha Vantage 2026-04-24 — AV's 25/day quota was exhausted by 07:00 UTC
// every session, leaving the bot news-blind through NY open. MarketAux's
// 100/day comfortably covers the scanner's typical 50-80 daily calls,
// and the 5-layer resilience stack (30-min cache, 4-h stale, 90/100
// soft cap, stale-bearish dampening in news/index.ts, once-per-day
// Telegram alert) carries over unchanged.
//
// Contract preserved: fetchNewsContext(instrument) → NewsItem[] with
// the same { title, source, published_at, sentiment_score,
// relevance_score, category, summary, stale_minutes } shape as before.
// Category still derived from |sentiment_score| (A >= 0.35, B >= 0.15,
// else C). Callers in src/news/index.ts don't change.

const MARKETAUX_BASE = 'https://api.marketaux.com/v1/news/all';

// One-shot flag per UTC day for the loud daily-quota-exhausted log (402).
// Stores the UTC date so it auto-resets across day boundaries.
let marketAuxRateLimitLoggedForUtcDate: string | null = null;

// ========== News-resilience layers (carried over from Alpha Vantage 2026-04-23) ==========
// See git history pre-2026-04-24 for the full rationale on each layer. The
// layer structure is unchanged; only the provider-specific call + response
// parsing differ.

const NEWS_CACHE_FRESH_MS = 30 * 60 * 1000;         // 30 min — serve as-is
const NEWS_CACHE_STALE_MAX_MS = 4 * 60 * 60 * 1000; // 4 h — max tolerable staleness
const MARKETAUX_DAILY_SOFT_CAP = 90;                // of 100 — reserve 10 for
                                                    // Researcher / Swing / buffer

type CachedNewsEntry = { fetchedAt: number; value: NewsItem[] };
const newsCache = new Map<string, CachedNewsEntry>();

let marketAuxCallsByUtcDate: { date: string; count: number } | null = null;
let newsDegradedAlertFiredForUtcDate: string | null = null;

function currentUtcDateString(): string {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

/** Exposed for tests — reset the one-shot MarketAux rate-limit log flag. */
export function _resetMarketAuxRateLimitFlag(): void {
  marketAuxRateLimitLoggedForUtcDate = null;
}

/** Exposed for tests — clear news cache + daily counter + alert flag. */
export function _resetNewsResilienceState(): void {
  newsCache.clear();
  marketAuxCallsByUtcDate = null;
  newsDegradedAlertFiredForUtcDate = null;
}

/** Exposed for tests — peek at current MarketAux daily call count. */
export function _getMarketAuxCallCount(): number {
  const today = currentUtcDateString();
  if (marketAuxCallsByUtcDate?.date !== today) return 0;
  return marketAuxCallsByUtcDate.count;
}

function bumpMarketAuxCallCounter(): void {
  const today = currentUtcDateString();
  if (marketAuxCallsByUtcDate?.date !== today) {
    marketAuxCallsByUtcDate = { date: today, count: 0 };
  }
  marketAuxCallsByUtcDate.count += 1;
}

function isMarketAuxDailyCapReached(): boolean {
  const today = currentUtcDateString();
  if (marketAuxCallsByUtcDate?.date !== today) return false;
  return marketAuxCallsByUtcDate.count >= MARKETAUX_DAILY_SOFT_CAP;
}

/**
 * Fire a Telegram alert (at most once per UTC day) that news availability is
 * degraded. Dynamically imports the notifications module to avoid a static
 * cycle and to keep this file unit-testable without a Telegram mock.
 */
function fireNewsDegradedAlertOncePerDay(reason: string): void {
  const today = currentUtcDateString();
  if (newsDegradedAlertFiredForUtcDate === today) return;
  newsDegradedAlertFiredForUtcDate = today;
  console.error(
    `[Market Data] News feed degraded: ${reason}. Serving cached/empty for the rest of the UTC day.`,
  );
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
    `[Market Data] MarketAux news for ${instrument}: serving stale cache (${staleMinutes} min old, ${cached.value.length} articles)`,
  );
  return cached.value.map((item) => ({ ...item, stale_minutes: staleMinutes }));
}

/**
 * Maps a Farad internal ticker to MarketAux's `symbols` query parameter.
 *
 *   - FX pairs       → bare symbol (MarketAux recognises `EURUSD`, NOT `EURUSD=X`)
 *   - Commodities    → ETF proxy tickers (GLD / SLV / USO) — same mapping
 *                      the prior Alpha Vantage integration used
 *   - US stocks      → uppercased pass-through
 *
 * Exported so tests can verify routing coverage.
 */
export function normalizeForMarketAux(instrument: string): string {
  const upper = instrument.toUpperCase();

  const fxMap: Record<string, string> = {
    EURUSD: 'EURUSD',
    GBPUSD: 'GBPUSD',
    USDJPY: 'USDJPY',
    AUDUSD: 'AUDUSD',
    GBPJPY: 'GBPJPY',
    NZDUSD: 'NZDUSD',
    USDCAD: 'USDCAD',
    USDCHF: 'USDCHF',
    EURJPY: 'EURJPY',
    EURGBP: 'EURGBP',
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

/**
 * For commodities, return the SPOT MarketAux symbol (XAU/USD / XAG/USD /
 * WTI/USD). The bot trades spot CFDs but `normalizeForMarketAux` returns the
 * ETF proxy (GLD/SLV/USO) — the proxy works because MarketAux's entity
 * database is equity-centric, but US-equity ETF news is a poor proxy for
 * spot-commodity sentiment. Dual-source pattern (added 2026-04-28): query
 * BOTH the proxy AND the spot symbol, dedupe by article title, and let the
 * downstream Cat A/B/C classifier and aggregation logic see the union.
 *
 * Returns null when no spot variant applies (FX, equities, unknown). Callers
 * can use the null result as a "single-source path" branch flag.
 */
export function commoditySpotSymbol(instrument: string): string | null {
  const upper = instrument.toUpperCase();
  const spotMap: Record<string, string> = {
    GOLD: 'XAU/USD',
    XAUUSD: 'XAU/USD',
    SILVER: 'XAG/USD',
    XAGUSD: 'XAG/USD',
    OIL_CRUDE: 'WTI/USD',
    USOIL: 'WTI/USD',
    WTIUSD: 'WTI/USD',
  };
  return spotMap[upper] ?? null;
}

/**
 * Internal: one MarketAux query + parse pass. Bumps the daily call counter,
 * fires axios, validates the response shape, and maps each article to a
 * NewsItem with the new impact-keyword Cat A/B/C classifier. Returns []
 * when the response shape is unexpected. Throws on axios/network/HTTP errors —
 * callers handle (e.g. 402 → stale fallback). Extracted from fetchNewsContext
 * 2026-04-28 to support dual-source commodity fetching.
 */
async function fetchMarketAuxBatch(
  apiKey: string,
  mappedTicker: string,
  instrumentForLog: string,
): Promise<NewsItem[]> {
  // 2026-04-29 audit-3 r3 fix (market-data P1-9): only bump the daily counter
  // AFTER axios resolves successfully. Pre-fix, an unconditional bump
  // counted network failures (DNS, TCP RST, MarketAux 5xx) toward the soft
  // cap, tripping the "MarketAux quota near limit" alert prematurely while
  // the real successful-call quota was untouched. Also adds a 15s wall-clock
  // timeout to the axios call — MarketAux has been slow during outages and
  // the hang would block the news-fetch path of every ICT cycle.
  const { data } = await axios.get(MARKETAUX_BASE, {
    params: {
      api_token: apiKey,
      symbols: mappedTicker,
      language: 'en',
      filter_entities: true,
      limit: 10,
    },
    timeout: 15_000,
  });

  bumpMarketAuxCallCounter();

  if (!Array.isArray(data?.data)) {
    console.log(
      `[Market Data] MarketAux news for ${instrumentForLog} (as ${mappedTicker}): 0 articles [unexpected response shape]`,
    );
    return [];
  }

  console.log(
    `[Market Data] MarketAux news for ${instrumentForLog} (as ${mappedTicker}): ${data.data.length} articles`,
  );

  const items: NewsItem[] = data.data.map((article: Record<string, unknown>) => {
    const entities = (article.entities as Array<Record<string, unknown>>) || [];

    const matchedEntity =
      entities.find((e) => String(e.symbol ?? '').toUpperCase() === mappedTicker.toUpperCase())
      ?? [...entities].sort(
        (a, b) => (Number(b.match_score) || 0) - (Number(a.match_score) || 0),
      )[0];

    const sentiment = Number(matchedEntity?.sentiment_score ?? 0);
    // 2026-05-05 (Codex Round-4 review fix): clamp relevance to [0,1].
    // MarketAux currently returns match_score in 0-1 range, but a future
    // provider format change to 0-100 would saturate the tier-weighted
    // scoring formula in news/index.ts. Defensive clamp.
    const relevanceRaw = Number(matchedEntity?.match_score ?? 0);
    const relevance = Number.isFinite(relevanceRaw) ? Math.max(0, Math.min(1, relevanceRaw)) : 0;
    const absScore = Math.abs(sentiment);

    const title = (article.title as string | undefined) ?? '';
    const description = (article.description as string) ?? '';
    const snippet = (article.snippet as string) ?? '';
    const summary = description.length > 20 ? description : (snippet || description);

    let category: 'A' | 'B' | 'C';
    if (matchesHighImpactKeyword(title, summary)) {
      category = 'A';
    } else if (absScore >= 0.15) {
      category = 'B';
    } else {
      category = 'C';
    }

    const url = (article.url as string | undefined) ?? '';

    return {
      title,
      source: article.source as string,
      published_at: article.published_at as string,
      sentiment_score: sentiment,
      relevance_score: relevance,
      category,
      summary,
      stale_minutes: 0,
      url: url || undefined,
    };
  });

  // W4 (2026-04-28): enrich items whose snippet is too short for the impact
  // classifier to score reliably. Hit Jina Reader; concatenate the body
  // onto the summary; re-run the classifier on the enriched haystack.
  // Failures are silent (item keeps the original summary + category).
  // Caches per-URL for 30 min in jina-reader.
  //
  // CR-9 (2026-04-28): concurrency-cap added at 4. Codex flagged that
  // 10 short articles × 3s timeout = 30s worst-case stacked latency on
  // a single fetchNewsContext call (and double on the commodity dual-
  // source path). With concurrency=4, worst-case is ceil(10/4)*3s = 9s.
  // Bumped down further from 5s timeout to 3s in jina-reader.ts itself.
  const ENRICH_THRESHOLD = 300;
  const ENRICH_MAX_CONCURRENCY = 4;
  const enrichTargets: Array<{ index: number; url: string }> = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.url && item.summary.length < ENRICH_THRESHOLD) {
      enrichTargets.push({ index: i, url: item.url });
    }
  }
  const enrichments: Array<string | null> = new Array(items.length).fill(null);
  for (let cursor = 0; cursor < enrichTargets.length; cursor += ENRICH_MAX_CONCURRENCY) {
    const batch = enrichTargets.slice(cursor, cursor + ENRICH_MAX_CONCURRENCY);
    const results = await Promise.all(batch.map(({ url }) => fetchArticleBody(url)));
    for (let j = 0; j < batch.length; j++) {
      enrichments[batch[j].index] = results[j];
    }
  }

  const enriched: NewsItem[] = items.map((item, i) => {
    const body = enrichments[i];
    if (!body) return item;
    const enrichedSummary = `${item.summary}\n\n${body}`;
    // Re-classify on the full body. Same logic as the inline classifier
    // above — kept duplicated rather than extracting a helper because the
    // map above also assigns sentiment/relevance fields the helper
    // wouldn't have access to without a wider refactor.
    const absScore = Math.abs(item.sentiment_score);
    let newCategory: 'A' | 'B' | 'C';
    if (matchesHighImpactKeyword(item.title, enrichedSummary)) {
      newCategory = 'A';
    } else if (absScore >= 0.15) {
      newCategory = 'B';
    } else {
      newCategory = 'C';
    }
    return {
      ...item,
      summary: enrichedSummary.slice(0, 8500),
      category: newCategory,
    };
  });

  return enriched;
}

export async function fetchNewsContext(instrument: string): Promise<NewsItem[]> {
  const mappedTicker = normalizeForMarketAux(instrument);
  const cacheKey = instrument.toUpperCase();

  // ===== Layer 1 — 30-min fresh cache =====
  // Absorbs the agent's multi-call-per-cycle pattern (the ICT agent re-invokes
  // get_news_context several times within a single reasoning chain). Biggest
  // quota-saver.
  const cached = newsCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < NEWS_CACHE_FRESH_MS) {
    return cached.value.map((item) => ({ ...item, stale_minutes: 0 }));
  }

  // ===== Layer 3 — daily soft-cap at 90/100 =====
  // Stop hitting MarketAux past 90 calls/day so Researcher + Swing runs always
  // have headroom. On cap hit, serve stale cache or []. Alert fires once.
  if (isMarketAuxDailyCapReached()) {
    fireNewsDegradedAlertOncePerDay(
      `daily soft cap of ${MARKETAUX_DAILY_SOFT_CAP}/100 MarketAux calls reached`,
    );
    const stale = serveStaleOrEmpty(instrument);
    if (stale.length === 0) {
      console.log(
        `[Market Data] MarketAux news for ${instrument} (as ${mappedTicker}): 0 articles [daily soft-cap reached, no cache]`,
      );
    }
    return stale;
  }

  // 2026-05-05 audit (Phase 2 / Round 2 / item 2.2): missing API key is a
  // configuration failure, NOT a quota/network failure. Check OUTSIDE the
  // try block so the throw isn't caught and degraded to stale-cache. The
  // throw bubbles to getNewsContext's catch → marketauxFailed=true →
  // news_unavailable=true on the returned ScoredNews. Pre-fix this path
  // silently served stale cached news → bot traded on 4h-old bearish news
  // the market had already priced in.
  const apiKey = process.env.MARKETAUX_API_KEY;
  if (!apiKey) {
    console.error('[Market Data] MARKETAUX_API_KEY not set — throwing so news_unavailable propagates.');
    throw new Error('MARKETAUX_API_KEY not configured');
  }

  // ===== Fresh fetch path =====
  // Inline error handling (was withFallback in AV code) so we can route HTTP 402
  // responses to stale cache with a distinct log, and everything else to the
  // generic cache-fallback catch.
  try {
    // ===== Dual-source for commodities (P1 #7, 2026-04-28) =====
    // The bot trades spot CFDs (XAU/USD, XAG/USD, WTI/USD) but normalizeForMarketAux
    // returns the US-equity ETF proxy (GLD/SLV/USO) — that's MarketAux's strongest
    // entity coverage for these names. Querying ALSO with the spot symbol picks up
    // any additional spot-coverage MarketAux has, deduped by canonical URL
    // against the ETF results. If spot returns nothing (likely on the free
    // tier), the result is unchanged — no harm, modest cost (1 extra API call
    // per cache miss).
    //
    // 2026-04-29 audit-3 r3 fix (market-data P1-4): the two MarketAux fetches
    // now run in parallel via Promise.allSettled instead of sequential awaits.
    // Pre-fix: a hung spot fetch (MarketAux outage on a single endpoint) held
    // the whole news-fetch hostage even though the ETF result had already
    // arrived. allSettled lets the slow one fail/timeout independently while
    // the primary result still flows through. axios per-call timeout (15s) on
    // each batch caps the worst case.
    const spotTicker = commoditySpotSymbol(instrument);
    let items: NewsItem[];
    if (spotTicker && spotTicker !== mappedTicker) {
      const [primaryRes, spotRes] = await Promise.allSettled([
        fetchMarketAuxBatch(apiKey, mappedTicker, instrument),
        fetchMarketAuxBatch(apiKey, spotTicker, instrument),
      ]);
      // Primary failure must propagate to outer try/catch so 402 routing
      // and stale-cache fallback still work.
      if (primaryRes.status === 'rejected') {
        throw primaryRes.reason;
      }
      const primaryItems = primaryRes.value;
      const spotItems = spotRes.status === 'fulfilled' ? spotRes.value : [];
      if (spotRes.status === 'rejected') {
        const msg = spotRes.reason instanceof Error ? spotRes.reason.message : String(spotRes.reason);
        console.warn(
          `[Market Data] Commodity spot fetch failed for ${instrument} (${spotTicker}): ${msg}. Falling back to ETF-only result.`,
        );
      }
      // CR-4 (2026-04-28): dedup primarily by article URL when present —
      // exact same wire story re-broadcast through different MarketAux
      // entity hits has a stable URL even when title text drifts. Falls
      // back to (lowercased title | source | published_at) for items
      // missing a URL. Empty-title items are kept (untitled tickers
      // sometimes produce empty title strings, dropping them lost legit
      // signal in the prior version).
      const seen = new Set<string>();
      const merged: NewsItem[] = [];
      // Primary (ETF) first to preserve existing rank ordering on conflict;
      // unique spot items are appended after.
      for (const item of [...primaryItems, ...spotItems]) {
        // CR-8 (2026-04-28): canonicalize URLs before keying so http/https
        // case, trailing slash, fragments, and utm_* tracking params don't
        // produce different keys for the same wire story.
        const canonicalUrl = item.url ? canonicalizeUrl(item.url) : '';
        const key = canonicalUrl.length > 0
          ? `url:${canonicalUrl}`
          : `tsd:${(item.title ?? '').toLowerCase().trim()}|${item.source ?? ''}|${item.published_at ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(item);
      }
      items = merged;
    } else {
      items = await fetchMarketAuxBatch(apiKey, mappedTicker, instrument);
    }

    if (items.length === 0) {
      // Both sources empty → fall back to stale cache if available.
      return serveStaleOrEmpty(instrument);
    }

    newsCache.set(cacheKey, { fetchedAt: Date.now(), value: items });
    return items;
  } catch (err) {
    // ===== Layer 2 trigger — MarketAux daily quota exhausted (HTTP 402) =====
    // Fall through to stale cache (up to 4 h old) instead of []. Alert once.
    const axiosErr = err as { response?: { status?: number } };
    if (axiosErr?.response?.status === 402) {
      const today = currentUtcDateString();
      if (marketAuxRateLimitLoggedForUtcDate !== today) {
        console.error(
          `[Market Data] MarketAux daily rate limit reached (100 req/day on free tier). ` +
            `Serving stale cache for the rest of the UTC day. Quota resets at UTC midnight.`,
        );
        marketAuxRateLimitLoggedForUtcDate = today;
      }
      fireNewsDegradedAlertOncePerDay('MarketAux daily quota (100/day) exhausted');
      return serveStaleOrEmpty(instrument);
    }

    console.error(
      `[Market Data] MarketAux news for ${instrument}: fetch error — ${(err as Error).message}. Falling back to cache.`,
    );
    return serveStaleOrEmpty(instrument);
  }
}

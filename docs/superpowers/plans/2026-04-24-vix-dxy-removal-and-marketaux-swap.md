# VIX/DXY Removal + Alpha Vantage → MarketAux News Swap

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove VIX and DXY macro inputs from the Market Researcher and the MCP tool surface, and replace Alpha Vantage (25 req/day) as the news provider with MarketAux (100 req/day), preserving the existing `fetchNewsContext` public contract and all resilience layers.

**Architecture:**
- **VIX/DXY removal** — delete `fetchVix`/`fetchDxy`, their MCP tools, and their usage in `researcher-agent.ts`. Keep `VIX`/`DXY` in `TWELVE_DATA_UNAVAILABLE` as a defensive allow-null for any stray `fetchCandles('VIX', ...)` call from an LLM-authored prompt. Mark `RegimeData.vix*` / `dxy*` fields optional so historical briefs in SQLite still parse.
- **MarketAux swap** — introduce a new provider module, route `fetchNewsContext` through it, keep the public contract and `NewsItem` shape identical. Preserve all 5 resilience layers (30 min fresh cache, 4 h stale cache, daily soft-cap now 90/100, stale-bearish dampening, once-per-day Telegram alert). Alpha Vantage code is deleted in this pass — no dual-provider scaffolding (YAGNI; revert via git if needed).

**Tech Stack:** TypeScript, Node 20 (VPS), vitest, axios, Alpha Vantage → MarketAux REST API, pm2 on Hetzner VPS.

**Demo-safety constraints (do not violate):**
- Atomic commits per concern (one for VIX/DXY, one for MarketAux).
- `npm run build && npm test` must pass locally before pushing.
- VPS deploy is `git pull && npm ci && npm run build && pm2 restart trading-bot` — seconds of downtime.
- Do NOT upgrade Node (tracked separately for demo-end).
- Do NOT weaken the live-trading preflight gate.

---

## File Structure

**Files modified:**
- `src/mcp-server/market-data.ts` — delete `fetchVix`, `fetchDxy`; replace AV section with MarketAux section; keep all resilience layer code and public API.
- `src/mcp-server/tools/market-data-tools.ts` — delete `get_vix` and `get_dxy` tool registrations; update `get_prices` and `get_correlation_matrix` tool descriptions; drop `VIX`/`DXY` from `MACRO_ONLY`.
- `src/mcp-server/index.ts` — update docstring tool list.
- `src/agents/researcher-agent.ts` — delete `fetchVix`/`fetchDxy` imports and calls; simplify `detectRegime` to return `{ yields }` only; drop VIX warnings from `generateWarnings`; drop VIX/DXY from theme-extraction prompt.
- `src/types.ts` — make `RegimeData.vix`, `vix_30d_avg`, `vix_regime`, `dxy`, `dxy_direction` optional.
- `src/preflight.ts` — drop `VIX/DXY` mention from Twelve Data feature label; add optional `MARKETAUX_API_KEY` warning.
- `src/backtest/fetcher.ts` — update the comment (line 16) that references VIX/NAS100/SPX/DXY to drop VIX/DXY (keep NAS100/SPX since they're still in UNAVAILABLE).
- `prompts/researcher-agent.md` — strip VIX/DXY from Phase 1, Phase 2 examples, Phase 4 warnings, output schema.
- `prompts/reflection-agent.md` — rewrite the DXY example on line 57 to use a non-DXY instrument-correlation example.
- `tests/market-data.test.ts` — delete VIX/DXY tests in "Researcher-facing fetcher resilience" block; replace the entire AV-specific test suite with MarketAux equivalents (same semantics).
- `.env.example` (if present) — add `MARKETAUX_API_KEY=`; remove `ALPHA_VANTAGE_API_KEY=`.

**Files created:**
- None. MarketAux client lives in `market-data.ts` alongside Twelve Data / Finnhub / FRED / Yahoo for consistency with the existing structure.

**Files NOT touched:**
- `src/scanner/index.ts` — does not reference VIX/DXY directly; consumes `getNewsContext` from `src/news/index.ts`, whose contract does not change.
- `src/news/index.ts` — no changes. It calls `fetchNewsContext(instrument)` and consumes `NewsItem[]`; both remain identical.
- Agents (`ict-agent.ts`, `swing-agent.ts`) and their prompts — they only use `get_news_context` tool; nothing VIX/DXY-specific.

---

## Pre-flight

### Task 0: Verify MarketAux API contract with a live probe

**Files:**
- None (read-only shell).

- [ ] **Step 1: Obtain a MarketAux free-tier API key**

Sign up at https://www.marketaux.com/ → copy the API token. Set locally:

```bash
export MARKETAUX_API_KEY="<token>"
```

- [ ] **Step 2: Probe the /v1/news/all endpoint for forex, commodity, and US-equity tickers**

Run from bash:

```bash
curl -s "https://api.marketaux.com/v1/news/all?api_token=$MARKETAUX_API_KEY&symbols=EURUSD=X&limit=3&language=en&filter_entities=true" | head -c 2000
curl -s "https://api.marketaux.com/v1/news/all?api_token=$MARKETAUX_API_KEY&symbols=GC=F&limit=3&language=en&filter_entities=true" | head -c 2000
curl -s "https://api.marketaux.com/v1/news/all?api_token=$MARKETAUX_API_KEY&symbols=AAPL&limit=3&language=en&filter_entities=true" | head -c 2000
```

Expected: `{"meta":{"found":...,"returned":...},"data":[{"uuid":"...","title":"...","description":"...","source":"...","published_at":"2026-...","entities":[{"symbol":"...","sentiment_score":0.NN,"match_score":0.NN,...}],...}]}`

- [ ] **Step 3: Confirm the three fields we need exist on every probed article**

For each response, confirm the presence of:
- `data[n].title`, `data[n].source`, `data[n].published_at`, `data[n].description`
- `data[n].entities[]` — and within at least one entity matching our requested symbol: `sentiment_score`, `match_score` (or `relevance_score`)

If any field is missing or the endpoint shape differs, STOP and update this plan. Record the exact observed shape in a short note below this task so later code matches the real contract, not a guessed one.

- [ ] **Step 4: Probe daily quota headers**

Inspect response headers with `-v`:

```bash
curl -sv "https://api.marketaux.com/v1/news/all?api_token=$MARKETAUX_API_KEY&symbols=EURUSD=X&limit=1" 2>&1 | grep -iE "x-ratelimit|x-requests|^< HTTP"
```

Record what MarketAux returns on quota exhaustion (HTTP 429? 200 + error body?). Used to design the quota detection in Task 6.

- [ ] **Step 5: Document findings inline**

Append a "### MarketAux API findings (2026-04-24)" section at the bottom of this plan file with:
- Exact field names confirmed
- Quota behavior on limit hit
- Any symbol-mapping gotchas for our 7 instruments (EURUSD / GBPUSD / USDJPY / AUDUSD / GOLD / SILVER / OIL_CRUDE)

Commit the updated plan file before proceeding:

```bash
git add docs/superpowers/plans/2026-04-24-vix-dxy-removal-and-marketaux-swap.md
git commit -m "docs: record MarketAux API findings before implementation"
```

---

## Part A — VIX/DXY Removal (atomic commit)

### Task 1: Make RegimeData VIX/DXY fields optional in types.ts

**Files:**
- Modify: `src/types.ts:327-333`

- [ ] **Step 1: Update the RegimeData interface**

Change from:

```ts
export interface RegimeData {
  vix: number;
  vix_30d_avg: number;
  vix_regime: 'low' | 'normal' | 'elevated' | 'crisis';
  dxy: number;
  dxy_direction: 'rising' | 'falling' | 'flat';
  yields: {
    us2y: number;
    us10y: number;
    us30y: number;
  };
}
```

To:

```ts
export interface RegimeData {
  // VIX/DXY removed from the live feed path 2026-04-24 — Twelve Data
  // Grow tier doesn't serve them and the free-tier proxies were
  // misleading. Kept optional so historical ResearchBriefs persisted
  // to SQLite before the cutover still parse.
  vix?: number;
  vix_30d_avg?: number;
  vix_regime?: 'low' | 'normal' | 'elevated' | 'crisis';
  dxy?: number;
  dxy_direction?: 'rising' | 'falling' | 'flat';
  yields: {
    us2y: number;
    us10y: number;
    us30y: number;
  };
}
```

- [ ] **Step 2: Confirm the file compiles**

Run:

```bash
cd "C:/Users/user/Desktop/Trade Bot/Trade Bot" && npx tsc --noEmit
```

Expected: Any errors reported here are from Task 2/3 consumers — that's fine, we'll fix them next. Errors only from `src/types.ts` itself would indicate a typo — fix before moving on.

No commit yet — we bundle with Task 2/3/4 as a single atomic VIX/DXY removal commit.

---

### Task 2: Delete fetchVix/fetchDxy from market-data.ts

**Files:**
- Modify: `src/mcp-server/market-data.ts:357-388` (delete both functions)
- Modify: `src/mcp-server/market-data.ts:1-9` (update file-header API list)
- Modify: `src/mcp-server/market-data.ts:66-67` (update Twelve Data section banner)
- Modify: `src/mcp-server/market-data.ts:172-207` (update the `TWELVE_DATA_UNAVAILABLE` comment block)

- [ ] **Step 1: Remove the two exported functions**

Delete lines 357 through 388 inclusive (the `export async function fetchVix` and `export async function fetchDxy` blocks).

- [ ] **Step 2: Keep VIX and DXY in `TWELVE_DATA_UNAVAILABLE` as defensive null-return**

The `TWELVE_DATA_UNAVAILABLE` set (around line 202) currently contains `'VIX', 'NAS100', 'SPX', 'DXY', 'US30', 'US100', 'US500', 'DE40', 'UK100'`. Leave it as-is. Rationale: nothing in the bot calls `fetchCandles('VIX', ...)` or `fetchCandles('DXY', ...)` directly after the removal, but an LLM-authored prompt or backtest path might. Returning empty candles is a safer "no data" signal than a confusing 404.

- [ ] **Step 3: Update the surrounding comment block (lines 172-207)**

Replace the VIX/DXY rationale paragraphs with:

```ts
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
```

- [ ] **Step 4: Update the file-header API-list comment**

Part A keeps the news-source line unchanged — it is overwritten in Part B (Task 10). Only the Twelve Data line changes in Part A.

Change the top-of-file banner (lines 1-9) from:

```ts
// Market Data Clients — External API integrations
// Provides price data, economic calendar, VIX, DXY, yields, sector strength, news
//
// APIs used:
//   Twelve Data   — OHLC candles, VIX, DXY (800 req/day free, 8 credits/min)
//   Finnhub       — Economic calendar (60 req/min free)
//   Yahoo Finance — Sector strength via sector ETFs (no key, unofficial)
//   FRED          — Treasury yields (unlimited free)
//   Alpha Vantage — News with sentiment (25 req/day free)
```

To:

```ts
// Market Data Clients — External API integrations
// Provides price data, economic calendar, yields, sector strength, news
//
// APIs used:
//   Twelve Data   — OHLC candles (800 req/day free, 8 credits/min)
//   Finnhub       — Economic calendar (60 req/min free)
//   Yahoo Finance — Sector strength via sector ETFs (no key, unofficial)
//   FRED          — Treasury yields (unlimited free)
//   Alpha Vantage — News with sentiment (25 req/day free)
```

(Alpha Vantage line is rewritten to MarketAux in Part B. Leaving it for now means Part A can ship and roll back independently.)

- [ ] **Step 5: Update the Twelve Data section banner**

Change line 67 from:

```ts
// Covers: OHLC candles, VIX, DXY, and raw data for correlation computation
```

To:

```ts
// Covers: OHLC candles and raw data for correlation computation
```

No commit yet.

---

### Task 3: Delete get_vix / get_dxy MCP tools and update neighbors

**Files:**
- Modify: `src/mcp-server/tools/market-data-tools.ts:14-15` (imports)
- Modify: `src/mcp-server/tools/market-data-tools.ts:30` (MACRO_ONLY set)
- Modify: `src/mcp-server/tools/market-data-tools.ts:53` (get_prices description)
- Modify: `src/mcp-server/tools/market-data-tools.ts:55` (get_prices inputSchema description)
- Modify: `src/mcp-server/tools/market-data-tools.ts:134` (get_correlation_matrix description)
- Modify: `src/mcp-server/tools/market-data-tools.ts:140-147` (correlation defaults comment)
- Modify: `src/mcp-server/tools/market-data-tools.ts:170-201` (delete get_vix + get_dxy blocks)
- Modify: `src/mcp-server/tools/market-data-tools.ts:1-7` (file-header tool list)
- Modify: `src/mcp-server/index.ts:6-7` (tool-list docstring)

- [ ] **Step 1: Remove fetchVix / fetchDxy from the import statement**

Change:

```ts
import {
  fetchCandles, fetchVix, fetchDxy, fetchYieldCurve,
  fetchEconomicCalendar, fetchSectorStrength, fetchNewsContext,
  // ...
```

To:

```ts
import {
  fetchCandles, fetchYieldCurve,
  fetchEconomicCalendar, fetchSectorStrength, fetchNewsContext,
  // ...
```

- [ ] **Step 2: Drop VIX and DXY from `MACRO_ONLY`**

Change:

```ts
const MACRO_ONLY = new Set<string>(['VIX', 'DXY', 'US2Y', 'US10Y', 'US30Y']);
```

To:

```ts
const MACRO_ONLY = new Set<string>(['US2Y', 'US10Y', 'US30Y']);
```

- [ ] **Step 3: Update `get_prices` description**

Change line 53 from:

```ts
description: 'Fetch OHLCV candle data. Prefers Capital.com for tradeable instruments (by epic) and falls back to Twelve Data for macro symbols (VIX, DXY, yield curve) or anything Capital does not serve. Supports 15m, 1h, 4h, 1d, 1w timeframes.',
```

To:

```ts
description: 'Fetch OHLCV candle data. Prefers Capital.com for tradeable instruments (by epic) and falls back to Twelve Data for macro symbols (yield curve series) or anything Capital does not serve. Supports 15m, 1h, 4h, 1d, 1w timeframes.',
```

And line 55 from:

```ts
instrument: z.string().describe('Instrument ticker / Capital.com epic (e.g. GOLD, US100, AAPL, EURUSD, VIX)'),
```

To:

```ts
instrument: z.string().describe('Instrument ticker / Capital.com epic (e.g. GOLD, US100, AAPL, EURUSD)'),
```

- [ ] **Step 4: Update `get_correlation_matrix` description and comment**

Change line 134 from:

```ts
description: 'Compute 30-day Pearson correlation between an instrument and major assets. On the current Twelve Data tier the default comparison set is USDJPY, XAUUSD, USOIL, EURUSD (USD-strength proxy via USDJPY; DXY/SPX/NAS100 are unavailable).',
```

To:

```ts
description: 'Compute 30-day Pearson correlation between an instrument and major assets. Default comparison set is USDJPY, XAUUSD, USOIL, EURUSD (USD-strength proxy via USDJPY; US equity indices are unavailable on the current Twelve Data tier).',
```

Replace the 8-line comment block at lines 142-147 (starting with `// DXY / SPX / NAS100 are TWELVE_DATA_UNAVAILABLE...`) with:

```ts
      // SPX / NAS100 are TWELVE_DATA_UNAVAILABLE on the current tier — the
      // correlation call for each would return neutral (0). USDJPY is a
      // workable USD-strength proxy that IS available on Grow, so it sits
      // in the default set as the macro anchor. Indices have no clean
      // substitute at this tier, so we drop them rather than burn cycles
      // on known-zero results.
```

- [ ] **Step 5: Delete the `get_vix` and `get_dxy` tool registrations**

Delete lines 170-201 (the two `server.registerTool('get_vix', ...)` and `server.registerTool('get_dxy', ...)` blocks) entirely.

- [ ] **Step 6: Update the tool-list docstring at the top of the file**

Change lines 2-3 from:

```ts
// Tools: get_prices, get_news_context, get_economic_calendar, get_correlation_matrix,
//        get_sector_strength, get_vix, get_dxy, get_yield_curve, get_client_sentiment,
```

To:

```ts
// Tools: get_prices, get_news_context, get_economic_calendar, get_correlation_matrix,
//        get_sector_strength, get_yield_curve, get_client_sentiment,
```

And line 7 from:

```ts
// to Twelve Data for macro instruments (VIX, DXY, yield curve).
```

To:

```ts
// to Twelve Data for macro instruments (yield curve series).
```

- [ ] **Step 7: Update mcp-server/index.ts docstring**

Change line 7 from:

```ts
//                                    get_sector_strength, get_vix, get_dxy, get_yield_curve, write_research_brief)
```

To:

```ts
//                                    get_sector_strength, get_yield_curve, write_research_brief)
```

And if there's a nearby tool-count total (e.g. "9 tools"), decrement it by 2.

- [ ] **Step 8: Verify the project type-checks**

Run:

```bash
cd "C:/Users/user/Desktop/Trade Bot/Trade Bot" && npx tsc --noEmit
```

Expected: errors only from `researcher-agent.ts` (fixed in Task 4) and `tests/market-data.test.ts` (fixed in Task 5).

No commit yet.

---

### Task 4: Strip VIX/DXY from researcher-agent.ts

**Files:**
- Modify: `src/agents/researcher-agent.ts:12` (import)
- Modify: `src/agents/researcher-agent.ts:22-43` (`detectRegime`)
- Modify: `src/agents/researcher-agent.ts:57-72` (`extractThemes`)
- Modify: `src/agents/researcher-agent.ts:85-108` (`generateWarnings`)

- [ ] **Step 1: Update the import**

Change:

```ts
import { fetchVix, fetchDxy, fetchYieldCurve, fetchEconomicCalendar, fetchSectorStrength } from '../mcp-server/market-data.js';
```

To:

```ts
import { fetchYieldCurve, fetchEconomicCalendar, fetchSectorStrength } from '../mcp-server/market-data.js';
```

- [ ] **Step 2: Simplify `detectRegime`**

Replace the entire `detectRegime` function with:

```ts
async function detectRegime(): Promise<RegimeData> {
  const yields = await fetchYieldCurve();
  return { yields };
}
```

- [ ] **Step 3: Update `extractThemes` user-message template**

Change the `content` template-literal to drop VIX/DXY references:

```ts
      content: `Regime: 10Y yield ${regime.yields.us10y}%, 2Y/10Y spread ${Math.round((regime.yields.us10y - regime.yields.us2y) * 100) / 100}%
Top sectors: ${topSectors.join(', ')}
Bottom sectors: ${bottomSectors.join(', ')}
High-impact events next 5 days: ${highImpactEvents.map(e => `${e.date} ${e.event} (${e.country})`).join(', ') || 'None'}

List 3-5 themes as a JSON array of strings.`,
```

- [ ] **Step 4: Drop VIX warnings from `generateWarnings`**

Replace the `generateWarnings` body with:

```ts
function generateWarnings(calendar: EconomicEvent[], _regime: RegimeData): string[] {
  const warnings: string[] = [];

  // High-impact event warnings
  const highImpact = calendar.filter(e => e.impact === 'high');
  for (const event of highImpact) {
    const eventDate = new Date(event.date);
    const now = new Date();
    const hoursUntil = (eventDate.getTime() - now.getTime()) / (1000 * 60 * 60);

    if (hoursUntil > 0 && hoursUntil < 48) {
      warnings.push(`${event.event} on ${event.date} — no new swing positions in affected instruments until after release`);
    }
  }

  return warnings;
}
```

(Keep the `_regime` parameter to avoid a callsite change; the leading underscore signals "unused" to eslint/tsc.)

- [ ] **Step 5: Type-check**

Run:

```bash
cd "C:/Users/user/Desktop/Trade Bot/Trade Bot" && npx tsc --noEmit
```

Expected: only remaining errors should be in `tests/market-data.test.ts` (fixed in Task 5).

No commit yet.

---

### Task 5: Update tests — delete VIX/DXY regression tests

**Files:**
- Modify: `tests/market-data.test.ts:8-9` (imports)
- Modify: `tests/market-data.test.ts:78-148` (Researcher-facing fetcher resilience block — delete VIX/DXY-specific tests)

- [ ] **Step 1: Remove `fetchVix, fetchDxy` from the test-file imports**

Change the import block to:

```ts
import {
  withCache,
  withFallback,
  fetchCandles,
  computeCorrelation,
  _getTwelveDataDailyCap,
  _resetTwelveDataDailyCap,
  _resetTwelveDataState,
  _getCandleCache,
  _mapToTwelveDataSymbol,
  _resetAlphaVantageRateLimitFlag,
  _resetNewsResilienceState,
  _getAlphaVantageCallCount,
  _setAlphaVantageBurstBucketForTests,
  fetchNewsContext,
  normalizeForAlphaVantage,
} from '../src/mcp-server/market-data.js';
```

- [ ] **Step 2: Delete the three VIX/DXY tests and rewrite the Promise.all regression**

In the `describe('Researcher-facing fetcher resilience (regression test for 2026-04-21 05:30 UTC crash)', ...)` block:

Delete these three tests entirely:
- `it('fetchVix returns zero-defaults when the upstream fetchCandles throws', ...)` (~lines 101-105)
- `it('fetchDxy returns zero-defaults when the upstream fetchCandles throws', ...)` (~lines 107-111)
- `it('fetchVix degrades when the breaker is tripped (exact crash scenario)', ...)` (~lines 122-136)

Replace the `it('Promise.all of [fetchVix, fetchDxy, computeCorrelation] never rejects — Researcher invariant', ...)` test (~lines 138-148) with an equivalent invariant written against the surviving researcher fetchers:

```ts
  it('Promise.all of [fetchYieldCurve, fetchSectorStrength, computeCorrelation] never rejects — Researcher invariant', async () => {
    // The researcher's Phase 1 `Promise.all` must never reject, even when
    // every external call is failing. This is the regression invariant that
    // originally crashed the 2026-04-21 05:30 UTC Researcher cycle.
    vi.spyOn(axios, 'get').mockRejectedValue(new Error('Everything is on fire'));
    await expect(
      Promise.all([fetchYieldCurve(), fetchSectorStrength(), computeCorrelation('EURUSD', 'USDJPY')])
    ).resolves.toBeDefined();
  });
```

(Import `fetchYieldCurve` and `fetchSectorStrength` in the test-file imports — add them to the existing block.)

- [ ] **Step 3: Update the `_mapToTwelveDataSymbol` tests**

The existing test asserting `_mapToTwelveDataSymbol('VIX')` and `_mapToTwelveDataSymbol('DXY')` return null stays — we keep both in `TWELVE_DATA_UNAVAILABLE` defensively. Leave that test as-is.

- [ ] **Step 4: Run the test suite**

```bash
cd "C:/Users/user/Desktop/Trade Bot/Trade Bot" && npm test
```

Expected: all tests green. If anything fails, the error points at a VIX/DXY reference we missed — grep and fix.

- [ ] **Step 5: Type-check clean**

```bash
npx tsc --noEmit
```

Expected: zero errors.

No commit yet.

---

### Task 6: Update prompts and preflight

**Files:**
- Modify: `prompts/researcher-agent.md` (strip VIX/DXY from Phase 1, 2, 4, output schema)
- Modify: `prompts/reflection-agent.md:57` (rewrite DXY example)
- Modify: `src/preflight.ts:28` (Twelve Data feature label)
- Modify: `src/backtest/fetcher.ts:16` (comment)

- [ ] **Step 1: Rewrite `prompts/researcher-agent.md` Phase 1**

Replace lines 17-25 with:

```md
### Phase 1 — Regime Detection
Gather regime data in parallel:
- **Yield Curve**: US 10Y, 2Y, 30Y, and 2y/10y spread (inverted/flat/normal)
- **Sector strength**: 1-day % move across the 11 SPDR sector ETFs
- **Economic calendar**: high/medium-impact events for next 5 days

Note: the former VIX / DXY inputs were removed 2026-04-24 — the free-tier Twelve Data proxies were misleading. Regime classification now uses the yield curve and sector rotation as primary macro signals.
```

- [ ] **Step 2: Update `prompts/researcher-agent.md` Phase 2 example themes**

Replace the "DXY breakdown below 104..." theme example (around line 32) with:

```md
- Identify 3-5 concise, actionable themes for the day/week
- Each theme is one sentence. No filler. Factual.
- Examples: "Tech earnings season driving sector rotation out of defensives."
  "2y/10y spread narrowing below 50bps suggesting late-cycle positioning."
  "NFP Friday — reduce new positions Thursday afternoon."
```

- [ ] **Step 3: Update `prompts/researcher-agent.md` Phase 4**

Replace the "VIX regime warnings" bullet (around line 43) with:

```md
- High-impact event warnings (no new positions before release)
- Correlation warnings (clustered exposure risk)
- Yield-curve warnings (inversion / steepening regime shifts)
```

- [ ] **Step 4: Update `prompts/researcher-agent.md` output schema**

Replace the `"regime"` block in the JSON schema (around lines 57-68) with:

```json
  "regime": {
    "yields": {
      "us10y": 4.25,
      "us2y": 4.85,
      "us30y": 4.45
    }
  },
```

And delete the `"VIX elevated (20-30) — reduce ICT position size by 25%",` example from the warnings array (around line 87). Replace it with:

```json
  "warnings": [
    "FOMC Wednesday — no new ICT positions until Thursday",
    "2y/10y spread inverted — favour defensive rotation this week"
  ]
```

- [ ] **Step 5: Rewrite `prompts/reflection-agent.md` line 57 example**

Replace:

```md
**GOOD**: "EMA pullback entries on EURUSD during DXY strength days have failed 4 of the last 5 times. The correlation filter should have caught this — DXY was rising while we went long EUR. Add a rule: skip EUR longs when DXY has been rising for 3+ consecutive days."
```

With:

```md
**GOOD**: "EMA pullback entries on EURUSD during USDJPY-strength days have failed 4 of the last 5 times. The correlation filter should have caught this — USDJPY was trending up while we went long EUR. Add a rule: skip EUR longs when USDJPY has closed higher 3+ consecutive days."
```

- [ ] **Step 6: Update preflight label**

Change `src/preflight.ts:28` from:

```ts
  { key: 'TWELVE_DATA_API_KEY', feature: 'Twelve Data candles/VIX/DXY' },
```

To:

```ts
  { key: 'TWELVE_DATA_API_KEY', feature: 'Twelve Data candles' },
```

- [ ] **Step 7: Update backtest comment**

Change `src/backtest/fetcher.ts:16` from:

```ts
// SILVER→XAG/USD, and the UNAVAILABLE cohort for VIX/NAS100/SPX/DXY).
```

To:

```ts
// SILVER→XAG/USD, and the UNAVAILABLE cohort for NAS100/SPX plus the
// defensively-included VIX/DXY).
```

- [ ] **Step 8: Run build + tests + type-check**

```bash
cd "C:/Users/user/Desktop/Trade Bot/Trade Bot" && npm run build && npm test
```

Expected: all green.

- [ ] **Step 9: Commit Part A as a single atomic change**

```bash
git add src/types.ts src/mcp-server/market-data.ts src/mcp-server/tools/market-data-tools.ts src/mcp-server/index.ts src/agents/researcher-agent.ts src/preflight.ts src/backtest/fetcher.ts prompts/researcher-agent.md prompts/reflection-agent.md tests/market-data.test.ts
git commit -m "refactor: remove VIX/DXY from researcher and MCP surface

Free-tier Twelve Data proxies for VIX/DXY were misleading (DXY proxies
traded at 25-70 vs real ~99; VIX required Pro tier). Drop fetchVix,
fetchDxy, their MCP tools, and their usage in the Market Researcher.
VIX/DXY remain in TWELVE_DATA_UNAVAILABLE defensively so stray
fetchCandles calls return empty rather than error. RegimeData VIX/DXY
fields are now optional so historical briefs in SQLite still parse."
```

---

## Part B — Alpha Vantage → MarketAux Swap

> **Pre-requisite:** Task 0 must be complete (API contract verified and documented at the bottom of this plan). Do not proceed if the MarketAux findings section is empty.

### Task 7: Add MARKETAUX_API_KEY to env and preflight

**Files:**
- Modify: `src/preflight.ts` (env block)
- Modify: `.env.example` if present — check with `ls`; if missing, skip. Also update `.env` on the local dev machine (not committed).

- [ ] **Step 1: Add MARKETAUX_API_KEY to preflight required/optional lists**

In `src/preflight.ts`, replace the `ALPHA_VANTAGE_API_KEY` entry in the env list with:

```ts
  { key: 'MARKETAUX_API_KEY', feature: 'News feed (sentiment)' },
```

If `ALPHA_VANTAGE_API_KEY` doesn't exist in preflight.ts, add the MARKETAUX entry to the appropriate required/optional block — match the style of the other entries.

- [ ] **Step 2: Update `.env.example` if it exists**

```bash
ls "C:/Users/user/Desktop/Trade Bot/Trade Bot/.env.example" 2>&1
```

If present, replace the `ALPHA_VANTAGE_API_KEY=` line with:

```
MARKETAUX_API_KEY=
```

If absent, skip this step.

- [ ] **Step 3: Add MARKETAUX_API_KEY to local .env**

```bash
# Append to local .env only — NEVER commit this file
echo "MARKETAUX_API_KEY=<your-token>" >> "C:/Users/user/Desktop/Trade Bot/Trade Bot/.env"
```

(Replace `<your-token>` with the actual token obtained in Task 0.)

- [ ] **Step 4: Record the VPS update step for later**

Note for Task 12: the VPS `.env` at `/home/bot/trading-bot/.env` must be updated to add `MARKETAUX_API_KEY=...` and remove `ALPHA_VANTAGE_API_KEY=...` before the `pm2 restart`.

No commit here — we bundle with Tasks 8-11 as Part B.

---

### Task 8: Write MarketAux resilience layer tests first (TDD)

**Files:**
- Modify: `tests/market-data.test.ts` (replace AV tests with MarketAux equivalents)

> **Note:** The resilience-layer behavior is identical to Alpha Vantage's (30-min fresh cache, 4-h stale, daily soft-cap, Telegram one-shot, burst detection). Only the provider name, API shape, and daily-cap ceiling change (22→90 of 100/day).

- [ ] **Step 1: Replace the AV rate-limit detection test**

Delete the test `it('fetchNewsContext returns [] + logs once when AV rate-limit response is detected', ...)` (around lines 287-315) and replace with:

```ts
  it('fetchNewsContext returns stale/[] + logs once when MarketAux daily quota is exhausted', async () => {
    resetNewsTest();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // MarketAux quota-exhaustion shape — HTTP 402 with `error` body.
    // (Adjust to match the findings recorded in Task 0 if different.)
    vi.spyOn(axios, 'get').mockRejectedValue(
      Object.assign(new Error('Request failed with status code 402'), {
        isAxiosError: true,
        response: {
          status: 402,
          data: { error: { code: 'usage_limit_reached', message: 'Daily limit reached' } },
        },
      }),
    );

    const first = await fetchNewsContext('EURUSD');
    const second = await fetchNewsContext('GOLD');
    const third = await fetchNewsContext('OIL_CRUDE');

    expect(first).toEqual([]);
    expect(second).toEqual([]);
    expect(third).toEqual([]);

    const rateLimitLogCalls = errSpy.mock.calls.filter((args) =>
      typeof args[0] === 'string' && args[0].includes('MarketAux daily rate limit reached'),
    );
    expect(rateLimitLogCalls).toHaveLength(1);
  });
```

- [ ] **Step 2: Update the fallback-on-throw test**

Change the `fetchNewsContext wraps in withFallback — axios throws degrade to []` test so the provider name in the comment becomes "MarketAux" — the test body stays the same.

- [ ] **Step 3: Update Layer-1 cache test expectations**

The Layer 1 cache test uses a fake `successResponse` shaped like AV's `feed`. Replace the `successResponse` definitions throughout the layer tests with the MarketAux shape:

```ts
    const successResponse = {
      data: {
        meta: { found: 1, returned: 1, limit: 3, page: 1 },
        data: [{
          uuid: 'aaaa-bbbb',
          title: 'Headline A',
          description: 'Summary A',
          source: 'Wire',
          published_at: '2026-04-23T08:00:00.000Z',
          entities: [{
            symbol: 'EURUSD=X',
            sentiment_score: 0.2,
            match_score: 0.9,
          }],
        }],
      },
    };
```

Apply this shape replacement everywhere the AV `feed` shape appears in the layer tests.

- [ ] **Step 4: Update Layer 3 daily-cap test to use 90 instead of 22**

The MarketAux plan has 100 req/day free. Soft cap at 90.

Change:

```ts
  it('Layer 3: daily soft-cap at 22 — 23rd attempt skips axios and serves stale/[] instead', ...)
```

To:

```ts
  it('Layer 3: daily soft-cap at 90 — 91st attempt skips axios and serves stale/[] instead', ...)
```

And change the `for (let i = 0; i < 22; i++)` loops to `for (let i = 0; i < 90; i++)` with all matching assertions (22 → 90, 23rd → 91st).

- [ ] **Step 5: Rename the burst-limit test — MarketAux does not enforce a 1 req/sec burst**

Delete the entire `it('fetchNewsContext detects AV burst-limit message, retries once, and logs once per day', ...)` test. MarketAux free tier does not have a per-second burst cap (only the per-day cap), so there is no burst path to test.

If Task 0 findings show MarketAux DOES rate-limit per-second, RESTORE this test with MarketAux's exact response shape and keep the burst-retry logic in Task 10. Otherwise, delete.

- [ ] **Step 6: Replace the `normalizeForAlphaVantage` test block**

Delete the `describe('normalizeForAlphaVantage', ...)` block entirely. It will be replaced in Task 9 by a `describe('normalizeForMarketAux', ...)` suite with the new mapping assertions.

- [ ] **Step 7: Run tests and confirm they FAIL as expected**

```bash
cd "C:/Users/user/Desktop/Trade Bot/Trade Bot" && npm test -- tests/market-data.test.ts
```

Expected: all MarketAux-suite tests FAIL because the production code still uses AV. That's the TDD red step — proceed to Task 9.

No commit yet.

---

### Task 9: Add `normalizeForMarketAux` test suite to the already-failing test file

**Files:**
- Modify: `tests/market-data.test.ts` (add `describe('normalizeForMarketAux', ...)` block + update imports)

> **Note:** Task 8 already replaced all the AV layer tests. This step adds the mapper test suite as a final red-state addition before Task 10 implements everything in one atomic rewrite. No production code changes in this task — that's Task 10.

- [ ] **Step 1: Update the test-file imports**

Replace this line:

```ts
  normalizeForAlphaVantage,
```

With:

```ts
  normalizeForMarketAux,
```

- [ ] **Step 2: Append the mapper test block**

Add a new describe block near where the old `describe('normalizeForAlphaVantage', ...)` block lived (or at the bottom of the file):

```ts
describe('normalizeForMarketAux', () => {
  it('maps FX pairs to Yahoo =X suffix', () => {
    expect(normalizeForMarketAux('EURUSD')).toBe('EURUSD=X');
    expect(normalizeForMarketAux('GBPUSD')).toBe('GBPUSD=X');
    expect(normalizeForMarketAux('USDJPY')).toBe('USDJPY=X');
    expect(normalizeForMarketAux('AUDUSD')).toBe('AUDUSD=X');
  });

  it('maps commodities to Yahoo futures tickers', () => {
    expect(normalizeForMarketAux('GOLD')).toBe('GC=F');
    expect(normalizeForMarketAux('SILVER')).toBe('SI=F');
    expect(normalizeForMarketAux('OIL_CRUDE')).toBe('CL=F');
  });

  it('maps cross-broker aliases to the same destinations', () => {
    expect(normalizeForMarketAux('XAUUSD')).toBe('GC=F');
    expect(normalizeForMarketAux('XAGUSD')).toBe('SI=F');
    expect(normalizeForMarketAux('USOIL')).toBe('CL=F');
    expect(normalizeForMarketAux('WTIUSD')).toBe('CL=F');
  });

  it('passes US equities through uppercased', () => {
    expect(normalizeForMarketAux('AAPL')).toBe('AAPL');
    expect(normalizeForMarketAux('msft')).toBe('MSFT');
  });
});
```

- [ ] **Step 3: Confirm the tests fail cleanly with a "not exported" / "not defined" error**

```bash
cd "C:/Users/user/Desktop/Trade Bot/Trade Bot" && npm test -- tests/market-data.test.ts 2>&1 | tail -40
```

Expected: errors about `normalizeForMarketAux` not being exported from `../src/mcp-server/market-data.js`. That's the TDD red state Task 10 will satisfy.

> **Important:** If the Task 0 findings recorded different MarketAux symbol requirements (e.g. forex via `currencies=` instead of `symbols=`), update the mapper tests here AND the implementation in Task 10 accordingly before proceeding. The tests are the ground truth for what Task 10 must produce.

No commit yet.

---

### Task 10: Delete the AV section and implement the MarketAux equivalent in one rewrite

**Files:**
- Modify: `src/mcp-server/market-data.ts` (the entire Alpha Vantage section)

- [ ] **Step 1: Delete the `// ==================== ALPHA VANTAGE ====================` section entirely**

Delete from the section banner down to (but not including) the `export async function fetchNewsContext` definition — wait, scratch that. `fetchNewsContext` lives inside the AV section. Delete the entire AV section (banner to closing brace of `fetchNewsContext`), approximately lines 585-930. We rewrite it fresh below.

- [ ] **Step 2: Replace with the MarketAux section**

Insert in the same location:

```ts
// ==================== MARKETAUX ====================
// Covers: News with per-entity sentiment scoring.
//
// Free tier: 100 requests/day. Swapped from Alpha Vantage 2026-04-24 —
// AV's 25/day quota was exhausted by 07:00 UTC every session, leaving
// the bot news-blind through NY open. MarketAux's 100/day comfortably
// covers the scanner's ~50-80 daily calls across the 7-instrument
// universe, and the 5-layer resilience stack (30-min cache, 4-h stale,
// 90/100 soft cap, stale-bearish dampening, one-shot Telegram alert)
// carries over unchanged.
//
// Contract preserved: fetchNewsContext(instrument) → NewsItem[] with
// the same { title, source, published_at, sentiment_score,
// relevance_score, category, summary, stale_minutes } shape as before.
// category still derived from |sentiment_score| (A >= 0.35, B >= 0.15,
// else C). Callers in src/news/index.ts don't change.

const MARKETAUX_BASE = 'https://api.marketaux.com/v1/news/all';

let marketAuxRateLimitLoggedForUtcDate: string | null = null;

// ========== News-resilience layers (carried over from AV 2026-04-23) ==========
// Unchanged from the AV implementation — see the git history of this file
// pre-2026-04-24 for the full rationale on each layer.

const NEWS_CACHE_FRESH_MS = 30 * 60 * 1000;         // 30 min
const NEWS_CACHE_STALE_MAX_MS = 4 * 60 * 60 * 1000; // 4 h
const MARKETAUX_DAILY_SOFT_CAP = 90;                // of 100 — reserves 10 for
                                                    // Researcher / Swing / buffer

type CachedNewsEntry = { fetchedAt: number; value: NewsItem[] };
const newsCache = new Map<string, CachedNewsEntry>();

let marketAuxCallsByUtcDate: { date: string; count: number } | null = null;
let newsDegradedAlertFiredForUtcDate: string | null = null;

function currentUtcDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Exposed for tests — reset the one-shot rate-limit log flag. */
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
 * MarketAux uses Yahoo-style tickers: `=X` suffix for FX pairs, `=F` for
 * commodity futures, bare ticker for US equities. This mapping was verified
 * via live probe 2026-04-24 — see plan findings section.
 *
 *   - FX pairs       → "<PAIR>=X" (e.g. EURUSD=X)
 *   - Commodities    → Yahoo futures tickers (GC=F / SI=F / CL=F)
 *   - US stocks      → uppercased pass-through
 *
 * Exported so tests can verify routing coverage.
 */
export function normalizeForMarketAux(instrument: string): string {
  const upper = instrument.toUpperCase();

  const fxMap: Record<string, string> = {
    EURUSD: 'EURUSD=X', GBPUSD: 'GBPUSD=X', USDJPY: 'USDJPY=X', AUDUSD: 'AUDUSD=X',
    GBPJPY: 'GBPJPY=X', NZDUSD: 'NZDUSD=X', USDCAD: 'USDCAD=X', USDCHF: 'USDCHF=X',
    EURJPY: 'EURJPY=X', EURGBP: 'EURGBP=X',
  };
  if (fxMap[upper]) return fxMap[upper];

  const commodityMap: Record<string, string> = {
    GOLD: 'GC=F', XAUUSD: 'GC=F', SILVER: 'SI=F', XAGUSD: 'SI=F',
    OIL_CRUDE: 'CL=F', USOIL: 'CL=F', WTIUSD: 'CL=F',
  };
  if (commodityMap[upper]) return commodityMap[upper];

  return upper;
}

export async function fetchNewsContext(instrument: string): Promise<NewsItem[]> {
  const mappedTicker = normalizeForMarketAux(instrument);
  const cacheKey = instrument.toUpperCase();

  // Layer 1 — 30-min fresh cache
  const cached = newsCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < NEWS_CACHE_FRESH_MS) {
    return cached.value.map((item) => ({ ...item, stale_minutes: 0 }));
  }

  // Layer 3 — daily soft-cap
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

  try {
    const apiKey = process.env.MARKETAUX_API_KEY;
    if (!apiKey) {
      console.error('[Market Data] MARKETAUX_API_KEY not set');
      return serveStaleOrEmpty(instrument);
    }

    bumpMarketAuxCallCounter();

    const { data } = await axios.get(MARKETAUX_BASE, {
      params: {
        api_token: apiKey,
        symbols: mappedTicker,
        language: 'en',
        filter_entities: true,
        limit: 10,
      },
    });

    if (!Array.isArray(data?.data)) {
      console.log(
        `[Market Data] MarketAux news for ${instrument} (as ${mappedTicker}): 0 articles [unexpected response shape]`,
      );
      return serveStaleOrEmpty(instrument);
    }

    console.log(
      `[Market Data] MarketAux news for ${instrument} (as ${mappedTicker}): ${data.data.length} articles`,
    );

    const items: NewsItem[] = data.data.map((article: Record<string, unknown>) => {
      const entities = (article.entities as Array<Record<string, unknown>>) || [];
      // Pick the entity whose symbol matches our mappedTicker, else the
      // highest match_score entity. MarketAux returns per-entity sentiment,
      // so the representative score for THIS instrument is the one we
      // asked about.
      const target = entities.find((e) => (e.symbol as string)?.toUpperCase() === mappedTicker.toUpperCase())
        ?? entities.sort((a, b) => (Number(b.match_score) || 0) - (Number(a.match_score) || 0))[0];

      const sentiment = Number(target?.sentiment_score ?? 0);
      const relevance = Number(target?.match_score ?? 0);
      const absScore = Math.abs(sentiment);

      let category: 'A' | 'B' | 'C';
      if (absScore >= 0.35) category = 'A';
      else if (absScore >= 0.15) category = 'B';
      else category = 'C';

      return {
        title: article.title as string,
        source: article.source as string,
        published_at: article.published_at as string,
        sentiment_score: sentiment,
        relevance_score: relevance,
        category,
        summary: (article.description ?? article.snippet ?? '') as string,
        stale_minutes: 0,
      };
    });

    newsCache.set(cacheKey, { fetchedAt: Date.now(), value: items });
    return items;
  } catch (err) {
    // Layer 2 — MarketAux quota exhausted (402) or network error → stale cache
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
```

> **Important:** If the Task 0 findings recorded a different quota-exhaustion response (e.g. HTTP 200 with `error` body, or HTTP 429), adjust the `catch` block's detection predicate accordingly. The status code and response shape MUST match what MarketAux actually returns.

- [ ] **Step 3: Update the file-header API-list comment**

Change the top-of-file banner line from:

```ts
//   Alpha Vantage — News with sentiment (25 req/day free)
```

To:

```ts
//   MarketAux     — News with per-entity sentiment (100 req/day free)
```

- [ ] **Step 4: Remove the now-orphan AV test helpers from the test imports**

In `tests/market-data.test.ts`, change:

```ts
  _resetAlphaVantageRateLimitFlag,
  _resetNewsResilienceState,
  _getAlphaVantageCallCount,
  _setAlphaVantageBurstBucketForTests,
```

To:

```ts
  _resetMarketAuxRateLimitFlag,
  _resetNewsResilienceState,
  _getMarketAuxCallCount,
```

And update all callsites — `_getAlphaVantageCallCount()` → `_getMarketAuxCallCount()`, `_resetAlphaVantageRateLimitFlag()` → `_resetMarketAuxRateLimitFlag()`. Delete any call to `_setAlphaVantageBurstBucketForTests`.

- [ ] **Step 5: Run the full test suite**

```bash
npm test
```

Expected: all tests green. If any fail, the errors should be specific (schema mismatch, a missing helper) — fix in place.

- [ ] **Step 6: Type-check**

```bash
npx tsc --noEmit
```

Expected: zero errors.

No commit yet.

---

### Task 11: Update preflight + live smoke-probe locally

**Files:**
- Modify: `src/preflight.ts` (drop AV entry if still present)

- [ ] **Step 1: Delete any remaining ALPHA_VANTAGE_API_KEY references**

Grep the repo for leftover AV references:

```bash
cd "C:/Users/user/Desktop/Trade Bot/Trade Bot" && grep -rn "ALPHA_VANTAGE\|alpha.vantage\|alphavantage" src/ tests/ prompts/ --exclude-dir=node_modules 2>&1 | head -40
```

Expected: zero matches. If any are found, delete each one and re-run the grep.

- [ ] **Step 2: Run a local live smoke probe**

```bash
cd "C:/Users/user/Desktop/Trade Bot/Trade Bot" && node --env-file=.env -e "
import('./dist/mcp-server/market-data.js').then(async ({ fetchNewsContext }) => {
  const eur = await fetchNewsContext('EURUSD');
  const gold = await fetchNewsContext('GOLD');
  console.log('EURUSD:', eur.length, 'articles', eur[0]?.title);
  console.log('GOLD:', gold.length, 'articles', gold[0]?.title);
});
" 2>&1 | head -20
```

Expected: two lines showing ≥1 article each with real recent headlines. If either returns 0, investigate the symbol mapping before proceeding.

- [ ] **Step 3: Full build + test final pass**

```bash
npm run build && npm test
```

Expected: both green.

- [ ] **Step 4: Commit Part B**

```bash
git add src/mcp-server/market-data.ts src/preflight.ts tests/market-data.test.ts .env.example
git commit -m "refactor: swap news provider from Alpha Vantage to MarketAux

AV free tier's 25 req/day was exhausted by 07:00 UTC every session,
leaving the bot news-blind through NY open. MarketAux free tier is
100 req/day — comfortably above our typical 50-80 call usage.

Preserves the fetchNewsContext(instrument) → NewsItem[] contract and
all 5 resilience layers (30-min fresh cache, 4-h stale cache, daily
soft-cap now 90/100, stale-bearish dampening in src/news/index.ts,
once-per-day Telegram alert). Category derivation unchanged
(|sentiment_score| ≥ 0.35 = A, ≥ 0.15 = B, else C).

Symbol mapping uses Yahoo-style tickers (EURUSD=X, GC=F, CL=F)
verified via live probe 2026-04-24. VPS env must be updated to add
MARKETAUX_API_KEY before the next pm2 restart."
```

---

## Part C — VPS Deploy

### Task 12: Deploy both parts to the Hetzner VPS and verify

**Files:**
- VPS only (no repo files)

- [ ] **Step 1: Push commits to master**

```bash
cd "C:/Users/user/Desktop/Trade Bot/Trade Bot" && git push origin master
```

Expected: two commits pushed (Part A + Part B).

- [ ] **Step 2: Update VPS .env to add MARKETAUX_API_KEY**

```bash
ssh bot@162.55.212.198 "cd /home/bot/trading-bot && cp .env .env.bak-$(date +%Y%m%d-%H%M%S) && grep -v '^ALPHA_VANTAGE_API_KEY=' .env > .env.new && echo 'MARKETAUX_API_KEY=<token>' >> .env.new && mv .env.new .env && grep -E '^(MARKETAUX|ALPHA)_API_KEY' .env || echo 'key swap confirmed'"
```

Replace `<token>` with the actual MarketAux key. Expected: output `key swap confirmed` and a backup `.env.bak-...` sits next to the live `.env`.

- [ ] **Step 3: Pull, install, build on VPS**

```bash
ssh bot@162.55.212.198 "cd /home/bot/trading-bot && git pull origin master && npm ci && npm run build"
```

Expected: both commits pulled, deps up to date, clean TypeScript build.

- [ ] **Step 4: Restart pm2 and watch logs for one cycle**

```bash
ssh bot@162.55.212.198 "pm2 restart trading-bot && sleep 2 && pm2 info trading-bot | head -20"
```

Expected: status `online`, uptime resets, no immediate restart loop.

- [ ] **Step 5: Tail logs for 3-5 min to observe first scanner cycle**

```bash
ssh bot@162.55.212.198 "timeout 300 tail -f /home/bot/trading-bot/data/pm2-out.log /home/bot/trading-bot/data/pm2-err.log"
```

Watch for:
- `[Market Data] MarketAux news for EURUSD (as EURUSD=X): N articles` — positive
- No `yahoo-finance2` new errors (same old warnings are OK)
- No `VIX is not available` or `DXY is not available` warnings (both removed)
- No `Alpha Vantage daily rate limit reached` (source gone)
- No unexpected ECONNABORTED or 4xx storms

If anything looks wrong, `pm2 restart trading-bot` to a known-good state — we still have the prior `dist/` on disk if `git reset --hard HEAD~2` is needed (only do that with Giuseppe's confirmation).

- [ ] **Step 6: Update `.claude/project-status.md` in the repo**

Append a session entry to `.claude/project-status.md` documenting:
- Part A shipped: VIX/DXY removed from live path
- Part B shipped: news source swapped AV → MarketAux
- New daily-quota ceiling and soft-cap
- Any follow-ups (Node 22 still pending for demo-end; `.env` backup at `.env.bak-<timestamp>` on VPS)

Then commit and push:

```bash
cd "C:/Users/user/Desktop/Trade Bot/Trade Bot" && git add .claude/project-status.md && git commit -m "chore: record VIX/DXY removal + MarketAux swap deploy" && git push origin master
```

- [ ] **Step 7: Report status to Giuseppe**

Summarise in chat:
- Both commits deployed, bot online, first cycle healthy
- Before/after log comparison (one "news feed degraded" line gone, one VIX warning gone)
- Any unexpected behaviour that needs eyes

---

## Rollback plan

If Part B breaks news retrieval entirely and is not fixable within one debug cycle (≤ 15 min):

```bash
ssh bot@162.55.212.198 "cd /home/bot/trading-bot && git reset --hard <Part-A-commit-sha> && npm run build && mv .env.bak-<latest> .env && pm2 restart trading-bot"
```

This keeps Part A (VIX/DXY removal, low risk) while reverting Part B (MarketAux, unknown risk). Part A has been tested end-to-end by then — only Part B is at risk.

---

## MarketAux API findings (2026-04-24)

_Populated by Task 0 live probe on 2026-04-24. All observations are from actual curl responses against the production endpoint._

### Endpoint

`GET https://api.marketaux.com/v1/news/all` — HTTP 200 on success. Confirmed.

### Required query params

- `api_token` — 40-char token from env.
- `symbols` — see Symbol mapping section below for the exact format that actually returns articles.

### Optional params worth setting

- `language=en` — confirmed to filter to English articles.
- `filter_entities=true` — confirmed: narrows the `entities[]` array to only entities matching the requested symbol. Without it the entity list includes all named entities in the article.
- `limit=10` — confirmed working. Default not tested.

### Response shape (exact field names observed)

Top level:
```
{ meta: { found: number, returned: number, limit: number, page: number }, data: [...] }
```

Article object — all fields present on every probed article:
```
{
  uuid: string,
  title: string,
  description: string,   ← present on all observed articles; may be very short
                           (sometimes just the pair name, e.g. "EUR/USD")
  snippet: string,       ← also always present; 163-char truncated excerpt
  keywords: string,      ← present but often empty string ""
  url: string,
  image_url: string,
  language: string,
  published_at: string,  ← ISO 8601 UTC, e.g. "2026-04-24T07:28:42.000000Z"
  source: string,        ← domain name, e.g. "financefeeds.com"
  relevance_score: null, ← ALWAYS null when using symbols= param; only
                           populated when using the search= param
  entities: [...],
  similar: []
}
```

Entity object:
```
{
  symbol: string,           ← MarketAux's own symbol, e.g. "EURUSD" not "EURUSD=X"
  name: string,             ← human name, e.g. "EUR/USD"
  exchange: null,           ← always null on observed FX/currency entities
  exchange_long: null,
  country: string,          ← "global" for FX, "us" for equities
  type: string,             ← "currency" for FX pairs, "equity" for stocks/ETFs
  industry: string,         ← "N/A" for FX, industry name for equities
  match_score: number,      ← float, e.g. 187.35521 — NOT normalised 0-1
  sentiment_score: number,  ← float in [-1, 1], e.g. 0.12955
  highlights: [             ← array of sentiment-tagged text fragments
    { highlight: string, sentiment: number, highlighted_in: string }
  ]
}
```

Key field name observations:
- The sentiment field IS `sentiment_score` (plan's assumption correct).
- The relevance field IS `match_score` (NOT `relevance_score` — the article-level `relevance_score` is a separate field that is always `null` when using `symbols=`).
- `description` is always present but can be extremely thin (e.g. "EUR/USD" — 7 chars). `snippet` is a 163-char truncated body extract and is more useful as a summary. Task 10's `summary` field should prefer `description` when it has substance and fall back to `snippet`.
- No `category` field in the raw response — the A/B/C category is derived in our code from `|sentiment_score|`.

### Quota-exhaustion response

Could not trigger today (quota had 71 requests remaining as of the probe). From response headers observed on each successful call:

```
x-usagelimit-limit: 100       ← daily ceiling
x-usagelimit-remaining: 71    ← calls left today (decremented each probe)
x-ratelimit-limit: 30         ← per-minute burst ceiling
x-ratelimit-remaining: 24     ← burst tokens remaining
```

The plan's Task 8 test assumes HTTP 402 with `{ error: { code: 'usage_limit_reached' } }` body on quota exhaustion. This could NOT be verified live. The `x-usagelimit-remaining` header reaching 0 is the best available signal before triggering 402. The 402 assumption is reasonable based on the invalid-key response structure (same `error` envelope — see below), but the error `code` string for quota is assumed, not confirmed. Flag for Task 8: either accept the assumption or add a guard that checks for `error.code.includes('limit')` rather than exact-matching `usage_limit_reached`.

### Invalid-key response

```
HTTP 401
{ "error": { "code": "invalid_api_token", "message": "An invalid API token was supplied." } }
```

Error detection should check for `response.status === 401` (auth) and `response.status === 402` (quota). The `error.code` field exists and is machine-readable.

### Symbol mapping confirmations — BREAKING FINDING

**The plan's assumed symbol format is wrong for all non-equity instruments.**

The plan (including the `normalizeForMarketAux` sketch in Task 9/10) maps Farad tickers to Yahoo-style symbols (`EURUSD=X`, `GC=F`, `SI=F`, `CL=F`) and assumes MarketAux accepts them. The live probe found that **MarketAux does NOT recognise Yahoo-suffixed symbols**. Every probe using `=X` or `=F` format returned `{ meta: { found: 0 }, data: [] }`.

Results per instrument, with actual working symbol shown:

- **EURUSD=X** ✗ — 0 results. Working symbol: `EURUSD` (bare, no suffix). `found: 23001`.
- **GBPUSD=X** ✗ — 0 results. Working symbol: `GBPUSD`. `found: 10890`. Note: entity returned as `symbol: "GBPUSD"` AND a mirrored `symbol: "USDGBP"` entity is also present in the same article.
- **USDJPY=X** ✗ — 0 results. Working symbol: `USDJPY`. `found: 19088`.
- **AUDUSD=X** ✗ — 0 results. Working symbol: `AUDUSD`. `found: 11756`.
- **GC=F (gold)** ✗ — 0 results. `XAUUSD` also returns 0 results. `GOLD` returns results (`found: 3084`) BUT the entity is `{ symbol: "GOLD", name: "Barrick Gold Corporation", type: "equity" }` — Barrick Gold Corp stock, NOT the gold commodity. There is no confirmed working symbol for gold-the-commodity in MarketAux's `symbols=` param.
- **SI=F (silver)** ✗ — 0 results. `SILVER` returns 0 results. `XAGUSD` returns 0 results. No working symbol found for silver.
- **CL=F (oil)** ✗ — 0 results. `OIL` returns results (`found: 43`) BUT the entity is `{ symbol: "OIL", name: "iPath Pure Beta Crude Oil ETN", type: "etf" }` — an ETF, not crude oil futures. `WTI` returns results (`found: 417`) BUT the entity is `{ symbol: "WTI", name: "W&T Offshore, Inc.", type: "equity" }` — an offshore drilling company. `USOIL` returns 0. No working symbol found for crude oil as a commodity.

Summary table:

| Farad instrument | Plan's assumed symbol | Actually works? | Working symbol / notes |
|---|---|---|---|
| EURUSD | EURUSD=X | NO | Use `EURUSD` |
| GBPUSD | GBPUSD=X | NO | Use `GBPUSD` |
| USDJPY | USDJPY=X | NO | Use `USDJPY` |
| AUDUSD | AUDUSD=X | NO | Use `AUDUSD` |
| GOLD | GC=F | NO | No commodity symbol found; `GOLD` resolves to Barrick Gold equity |
| SILVER | SI=F | NO | No working symbol found at all |
| OIL_CRUDE | CL=F | NO | No commodity symbol found; `OIL` = ETF, `WTI` = equity |

### Gotchas — what Tasks 8-10 must change

1. **All FX symbol mappings must drop the `=X` suffix.** `normalizeForMarketAux` must return `EURUSD` not `EURUSD=X`, `GBPUSD` not `GBPUSD=X`, etc. The Task 9 test block (normalizeForMarketAux suite) must be rewritten — it currently asserts `toBe('EURUSD=X')` which would fail against the real API.

2. **Commodity mappings are broken as designed.** `GC=F`, `SI=F`, `CL=F` all return 0 results. Alternative strategies for Tasks 8-10 to consider:
   - Use the `search=` param with `filter_entities=false` for gold/silver/oil (keyword search without entity filtering). The probe showed `search=gold+price` returns substantive articles. Downside: no per-entity `sentiment_score` — the article-level `relevance_score` is populated (`found: 33.1`) but there are no entity objects. The implementation would fall back to using the article's raw text as the summary with `sentiment_score: 0` and `category: 'C'`.
   - Accept that commodities get no sentiment data from MarketAux and serve empty (`[]`) for GOLD/SILVER/OIL_CRUDE, relying on the stale-bearish dampening in `src/news/index.ts` as the safe fallback.
   - This is a design decision for Giuseppe, not to be silently resolved by the implementing agent.

3. **`match_score` is not normalised to 0-1.** Observed values include `187.35521`, `76.65626`, `16.07`. Do not threshold or compare against a 0-1 scale.

4. **`relevance_score` at article level is always `null` when using `symbols=`.** Only populated when using the `search=` param. The entity-level `match_score` is the correct field for per-instrument relevance.

5. **`description` can be degenerate.** On FX articles it is sometimes just the pair name ("EUR/USD"). Task 10's `summary` mapping should be `description || snippet` — use `description` if it has enough content (e.g. `length > 20`) else fall back to `snippet`.

6. **The `normalizeForMarketAux` test in Task 9 must be rewritten before Task 10 is implemented.** The current sketch asserts Yahoo-style suffixes which are wrong. New assertions: `EURUSD → 'EURUSD'`, `GBPUSD → 'GBPUSD'`, etc. Commodity assertions should reflect whatever strategy is chosen in point 2 above.

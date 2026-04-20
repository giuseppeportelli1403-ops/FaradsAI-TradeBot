# Project Status — Auto-Updated
Last updated: 2026-04-20 (morning, Malta) — end of blocker-fix session, bot trading on VPS
Project: BetterOpsAI Trading Bot ("Farad")
Branch: master (pushed to https://github.com/giuseppeportelli1403-ops/FaradsAI-TradeBot)
Last commit: e094240 — "feat(market-data): throttle + cache Twelve Data calls to fit 8 credits/min"

## What We Did This Session

Two production blockers surfaced on the 2-week demo's first real trade window
(Monday 2026-04-20 07:00 UTC London Open). Both fixed, deployed, live-verified.

### Blocker A — FMP deprecated endpoint (403)
- `/api/v3/sector-performance` dead since 2025-08-31 (legacy endpoint)
- Swapped to `yahoo-finance2` npm package with SPDR sector ETFs
  (XLK/XLF/XLE/XLV/XLI/XLU/XLB/XLRE/XLP/XLY/XLC)
- Single batched `quote()` call returns regularMarketChangePercent for all 11 sectors
- `SectorStrength[]` contract preserved — no downstream call-site changes needed
- Removed `FMP_API_KEY` from preflight OPTIONAL_KEYS
- Commit: **d421f03** `fix(market-data): migrate sector strength from FMP to Yahoo Finance`

### Blocker B — Twelve Data rate limit (8 credits/min vs 21-41 burned per cycle)
- New `TokenBucket` in `src/mcp-server/rate-limiter.ts` — 8 tokens / 60s refill,
  FIFO `acquire()` with `RateLimitQueuedError` on deadline miss
- New `CandleCache` in `src/mcp-server/candle-cache.ts` — in-memory TTL Map
  keyed by `symbol:interval:outputsize`, TTLs 60s (15m) → 4h (1w)
- `fetchCandles()` now wraps cache-first → token-second. Public signature
  unchanged so scanner/agents need no adaptation
- Agent `executeTool` sites in `trading-agent.ts` + `swing-agent.ts` wrapped
  in try/catch — any tool failure now returns structured error JSON instead
  of crashing the decision cycle
- Commit: **e094240** `feat(market-data): throttle + cache Twelve Data calls`

### Test coverage
- +12 tests (113 total): `tests/rate-limiter.test.ts` (refill rate, capacity
  cap, queued wait, deadline timeout) + `tests/candle-cache.test.ts` (hit/miss,
  TTL expiry, eviction, key shape)
- `npm test`: 113/113 passing on laptop and VPS
- `tsc --noEmit`: 0 errors

## Current State — Fixes deployed & live-verified

- ✅ **VPS updated:** pulled master, `npm install`, `npm run build`, `pm2 restart`
  at 08:07:34 UTC; bot now at PID 35957
- ✅ **Preflight clean:** 0 warnings (down from 1 — FMP_API_KEY dropped),
  0 errors, Capital.com session OK
- ✅ **First post-fix cycle (08:15:00 UTC) SUCCEEDED end-to-end:**
    - Scanner returned 4 real candidates: NVDA 85, META 85, TSLA 80, GOLD 75
      (was empty all morning pre-fix)
    - Rate limiter queued the ~25 credits across 90s without a single 429
    - 8 parallel `get_prices` calls for 4 candidates × 2 timeframes completed
    - ICT Agent ran full 5-step cycle in 7m 26s
    - Decision: `NO TRADE — No confirmed trigger on any instrument`
    - Zero errors in pm2-err.log after 08:07:34 restart
- ✅ **GitHub remote:** master up-to-date, both commits pushed
- ⏳ **2-week demo (Step 13):** now properly running. Clock effectively
  restarted 2026-04-20 as today is the first day the bot can actually
  evaluate real instruments

## Deferred / Known Issues

### Unchanged from previous session (still valid)
- Secret rotation (Capital API creds) deferred per Giuseppe's call
- VPS `.env` still has dead `CAPITAL_PASSWORD` line (harmless)
- GitHub default branch still `main` (code on `master`)
- MCP SDK version drift in package.json vs historical CLAUDE.md claim
- `BROKER_MIGRATION_PROMPT.md` etc. reference historical CAPITAL_PASSWORD
- `scripts/epic-mapping.json` gitignored artefact

### Introduced this session
- VPS lockfile re-diverged from Windows-generated one (ran `npm install`
  on VPS to satisfy Linux transitive deps). Old Linux lockfile stashed in
  VPS's git stash stack as "vps-linux-lockfile" — can be dropped next visit.
- Yahoo Finance is an unofficial/scraped endpoint. If it ever rate-limits
  or breaks shape, swap path: Alpha Vantage `SECTOR` endpoint or compute
  from cached 1d ETF candles. Not urgent.

## Next Steps (Giuseppe)

### Today / this week
1. Let the bot run autonomously during kill zones:
   - London Open 07:00–10:00 UTC
   - NY Open 12:00–15:00 UTC (today)
   - NY PM 15:00–17:00 UTC (today)
   Each 15m candle close within those windows triggers an ICT cycle.
2. Monitor with `ssh bot@162.55.212.198 'pm2 logs trading-bot --lines 100'`
3. If an agent places a trade: verify on Capital.com web UI; confirm SL/TP
   shown; watch scheduler's monitor loop for any TP1→BE event

### 2-week demo window (now Apr 20 → May 4)
4. Let demo accumulate trades, reflections, lessons
5. Once a real TP1 hits, verify `handleTp1Hit` moves Position B's SL to
   break-even on Capital side
6. Weekly review agent fires Sundays 00:00 UTC

### After the 2-week demo (Step 15)
7. Tune strategy files from accumulated reflection lessons
8. Decide whether to enable live trading (requires explicit
   `LIVE_TRADING_OK=true` + live URL swap; preflight refuses without both)

## Key Decisions This Session

- **Yahoo Finance over paid FMP tier** — zero cost, zero API key, same data
  shape via sector ETFs. `yahoo-finance2` npm package is stable and widely used.
- **Token bucket + TTL cache over Twelve Data tier upgrade** — stays on
  free tier (8 credits/min). Cache removes duplicate fetches inside a cycle;
  bucket paces what remains. 60s deadline before RateLimitQueuedError gives
  the agent a clean signal to skip rather than hang indefinitely.
- **Structured error returns over crash** — wrapped `executeTool` in try/catch
  so any tool failure is surfaced to Claude as JSON the agent can reason
  about, instead of unwinding the cycle.
- **Two atomic commits instead of one** — used selective `git stash --keep-index`
  to isolate each fix into its own commit, keeping both independently green
  for bisect. Slight process cost, large debugging benefit.

## Session Reliability Notes

- All live verification stayed on Capital.com demo URL (no live trades possible
  — preflight gate intact).
- One 08:07:34 restart counted against the "uptime" stat but was the deliberate
  deploy restart; zero unplanned restarts since.
- Rate limiter behavior observed live: scanner's internal get_ranked_instruments
  call (20 instruments × 1 candle) took ~1m 45s to serve (about 8 credits/min
  pacing), proving the queue is working as designed. First `get_prices` call
  after the scanner was served instantly — cache hit from the scanner's fetches.

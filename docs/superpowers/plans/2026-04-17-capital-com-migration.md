# Capital.com Migration — Implementation Plan

**Date:** 2026-04-17
**Spec:** `BROKER_MIGRATION_PROMPT.md` (project root)
**Estimated effort:** 6–10 hours (single session with parallel coders) + ~30 min manual demo verification
**Risk level:** Medium (session auth + async deal confirmation are the failure modes)

---

## Summary

Replace Trading 212's REST API client with a Capital.com client. Capital.com natively supports everything T212 forced us to hack: SL/TP on open, trailing stops, OHLC candles, modify-position, close-position. After this migration, the scheduler's local SL/TP monitoring loop is **mostly deleted** — execution moves to Capital.com's server, and our loop only needs to detect TP1 hit → move Position B SL to break-even.

**What changes:** broker client (new), 2 of 3 tool files, preflight, scheduler SL/TP loop, scanner epic names, types, .env.example, affected tests, docs.
**What stays:** 6 AI agents and all V3 prompts, database schema (audit columns unchanged), universe scanner scoring logic, news system, Telegram alerts, split-position method, composite scoring, Weekly Review loop.

**Wave 2 ships:** working Capital.com integration behind new env vars, all 43 existing tests updated and green, `npx tsc --noEmit` = 0, `grep -r "t212" src/` = 0 results. **Does NOT** include live demo-account smoke test (Giuseppe's manual step).

---

## Dependency graph (order of operations)

```
1. types.ts (new Capital types)          ─┐
                                           ├─► capital-client.ts
2. (nothing — axios already available)    ─┘            │
                                                        ▼
                                   ┌─── trading-tools.ts
                                   ├─── market-data-tools.ts
                                   ├─── scheduler/index.ts (SL/TP simplify + ping)
                                   └─── mcp-server/index.ts (swap import, shutdown hook)

3. scanner/index.ts (epic stubs)   — independent, parallel
4. preflight.ts                    — independent, parallel
5. .env.example                    — independent, parallel
6. scripts/discover-epics.ts       — independent, parallel
7. tests updates                   — AFTER the production code

After all green:
8. DELETE t212-client.ts
9. DELETE T212_MODE, T212_API_KEY from preflight's REQUIRED_KEYS
10. Docs update (CLAUDE.md + TRADING_BOT_MASTER.md + Obsidian)
```

---

## File-by-file change list

### NEW: `src/mcp-server/capital-client.ts`

**Purpose:** Capital.com REST API wrapper with session management.
**Est. LOC:** ~350

**Public interface (typed methods exported from the `CapitalClient` class):**

```typescript
// Session (internal, not exported to consumers)
private async createSession(): Promise<void>
private async ensureSession(): Promise<void>  // called before every request
private async request<T>(method: HttpMethod, path: string, body?: unknown): Promise<T>

// Account
async getAccounts(): Promise<CapitalAccount[]>
async ping(): Promise<void>  // keep-alive
async logout(): Promise<void>  // DELETE /api/v1/session

// Positions
async getOpenPositions(): Promise<CapitalPosition[]>
async getPosition(dealId: string): Promise<CapitalPosition>
async openPosition(params: OpenPositionParams): Promise<DealConfirmation>
  // internally: POST /positions → dealReference → poll GET /confirms/:ref → return dealConfirmation
async updatePosition(dealId: string, params: UpdatePositionParams): Promise<DealConfirmation>
async closePosition(dealId: string): Promise<DealConfirmation>
async partialClosePosition(dealId: string, size: number): Promise<DealConfirmation>
  // tries DELETE with size param; on 400/422 falls back to close+reopen with saved SL/TP

// Working orders (limit/stop) — not used by current agents but expose for parity
async getWorkingOrders(): Promise<WorkingOrder[]>
async createWorkingOrder(params: CreateWorkingOrderParams): Promise<DealConfirmation>
async updateWorkingOrder(dealId: string, params: UpdateWorkingOrderParams): Promise<DealConfirmation>
async deleteWorkingOrder(dealId: string): Promise<DealConfirmation>

// Market data
async searchMarkets(searchTerm: string): Promise<Market[]>
async getMarketDetails(epic: string): Promise<MarketDetail>
async getCandles(epic: string, resolution: Resolution, max: number, from?: string, to?: string): Promise<CapitalCandle[]>

// History
async getActivityHistory(from?: string, to?: string): Promise<Activity[]>
async getTransactionHistory(from?: string, to?: string): Promise<Transaction[]>

// Sentiment
async getClientSentiment(marketIds: string[]): Promise<Sentiment[]>
```

**Session management spec (critical — easy to get wrong):**

- On construction, client is **unauthenticated**. Session is created lazily on first `request()` call via `ensureSession()`.
- After successful session create, store `CST`, `X-SECURITY-TOKEN`, and `lastActivityAt = Date.now()`.
- Every outbound request adds both tokens as headers.
- `ensureSession()` logic:
  - If no tokens yet → call `createSession()`.
  - If tokens exist AND `(Date.now() - lastActivityAt) > 9 minutes` → call `ping()` to refresh; update `lastActivityAt`.
  - If `ping()` returns non-200 → tokens are stale; call `createSession()` again.
- Every API response updates `lastActivityAt`.
- `request()` wraps axios. On `401 Unauthorized`: clear tokens, `createSession()`, retry ONCE with exponential backoff (50ms). If retry also 401, throw `CapitalAuthError`.
- `logout()` called on graceful shutdown only; swallow errors.

**Deal confirmation polling (for openPosition/updatePosition/closePosition):**

```
POST /positions → { dealReference: "ABC..." }
Poll GET /confirms/:dealReference every 200ms, max 10 attempts (2 seconds total)
Return DealConfirmation with dealStatus: ACCEPTED | REJECTED
On REJECTED → throw CapitalDealError with reason
```

**Partial close fallback strategy:**

```typescript
async partialClosePosition(dealId, size) {
  // Step 1: try DELETE /positions/:dealId with { size } body
  try {
    return await this.request('DELETE', `/api/v1/positions/${dealId}`, { size });
  } catch (e) {
    if (!isRejectedAsUnsupported(e)) throw e;
    // Step 2: fallback — read position, full-close, reopen with (original_size - size)
    const pos = await this.getPosition(dealId);
    const { epic, direction, stopLevel, profitLevel, trailingStop, trailingStopDistance } = pos.position;
    await this.closePosition(dealId);
    return await this.openPosition({
      direction,
      epic,
      size: pos.position.size - size,
      stopLevel, profitLevel, trailingStop, stopDistance: trailingStopDistance,
    });
  }
}
```

**Constructor params:** `{ apiKey, identifier, password, baseURL }`. Base URL defaults to demo.

**Tests required:**
- session creation success → tokens stored
- session re-auth on 401 → retry succeeds
- ping after 9 minutes idle
- openPosition → deal confirmation polling → returns dealId
- deal rejection → throws CapitalDealError
- partialClosePosition happy path (DELETE with size)
- partialClosePosition fallback path (close + reopen)
- logout clears tokens

---

### NEW: `scripts/discover-epics.ts`

**Purpose:** One-shot utility Giuseppe runs after adding creds. Queries `GET /markets?searchTerm=` for each of the 20 scanner instruments, prints the mapping, writes JSON to `scripts/epic-mapping.json`.

**Est. LOC:** ~80

Usage: `npx tsx scripts/discover-epics.ts`

It reads `INSTRUMENT_UNIVERSE` from `src/scanner/index.ts` (or a mirrored constant), calls the Capital client, prints a markdown table to stdout, and writes JSON. Does NOT modify source files — Giuseppe pastes the mapping in manually (or a follow-up script can auto-patch scanner).

---

### MODIFIED: `src/types.ts`

**Remove (lines 18–43):** `T212Position`, `T212Balance`, `T212Instrument`.

**Add (after line 14, before trade records):**

```typescript
// ==================== CAPITAL.COM ====================

export type Resolution = 'MINUTE' | 'MINUTE_5' | 'MINUTE_15' | 'MINUTE_30' | 'HOUR' | 'HOUR_4' | 'DAY' | 'WEEK';

export interface CapitalAccount {
  accountId: string;
  accountName: string;
  accountType: string;
  preferred: boolean;
  balance: { balance: number; deposit: number; profitLoss: number; available: number };
  currency: string;
}

export interface CapitalPosition {
  position: {
    dealId: string;
    dealReference: string;
    direction: 'BUY' | 'SELL';
    size: number;
    openLevel: number;
    stopLevel: number | null;
    profitLevel: number | null;
    trailingStop: boolean;
    trailingStopDistance: number | null;
    guaranteedStop: boolean;
    createdDateUTC: string;
    controlledRisk: boolean;
  };
  market: {
    instrumentName: string;
    epic: string;
    bid: number;
    offer: number;
    marketStatus: string;
  };
}

export interface OpenPositionParams {
  direction: 'BUY' | 'SELL';
  epic: string;
  size: number;
  stopLevel?: number;
  profitLevel?: number;
  stopDistance?: number;
  profitDistance?: number;
  trailingStop?: boolean;
  guaranteedStop?: boolean;
}

export interface UpdatePositionParams {
  stopLevel?: number;
  profitLevel?: number;
  stopDistance?: number;
  profitDistance?: number;
  trailingStop?: boolean;
}

export interface DealConfirmation {
  dealId: string;
  dealReference: string;
  dealStatus: 'ACCEPTED' | 'REJECTED';
  reason: string;
  status: 'OPEN' | 'AMENDED' | 'DELETED' | 'FULLY_CLOSED' | 'PARTIALLY_CLOSED';
  direction: 'BUY' | 'SELL';
  epic: string;
  size: number;
  level: number;
  stopLevel: number | null;
  profitLevel: number | null;
  affectedDeals: Array<{ dealId: string; status: string }>;
}

export interface CapitalCandle {
  snapshotTime: string;
  snapshotTimeUTC: string;
  openPrice: { bid: number; ask: number };
  highPrice: { bid: number; ask: number };
  lowPrice: { bid: number; ask: number };
  closePrice: { bid: number; ask: number };
  lastTradedVolume: number;
}

export interface Market {
  epic: string;
  instrumentName: string;
  instrumentType: string;
  marketStatus: string;
  bid: number;
  offer: number;
}

export interface WorkingOrder {
  workingOrderData: {
    dealId: string;
    direction: 'BUY' | 'SELL';
    epic: string;
    orderType: 'LIMIT' | 'STOP';
    orderLevel: number;
    size: number;
    timeInForce: 'GOOD_TILL_CANCELLED' | 'GOOD_TILL_DATE';
  };
}

export interface CreateWorkingOrderParams {
  direction: 'BUY' | 'SELL';
  epic: string;
  size: number;
  level: number;
  type: 'LIMIT' | 'STOP';
  stopLevel?: number;
  profitLevel?: number;
}

export interface UpdateWorkingOrderParams {
  level?: number;
  stopLevel?: number;
  profitLevel?: number;
}

export interface Activity {
  date: string;
  epic: string;
  dealId: string;
  activity: string;
  status: string;
  size: number;
  level: number;
}

export interface Transaction {
  date: string;
  reference: string;
  transactionType: string;
  size: number;
  currency: string;
}

export interface Sentiment {
  marketId: string;
  longPositionPercentage: number;
  shortPositionPercentage: number;
}
```

Also in types.ts: `Candle` interface stays the same (shared shape across broker + Twelve Data). Capital candles are converted to this shape by `capital-client.getCandles()`.

---

### MODIFIED: `src/mcp-server/tools/trading-tools.ts`

**Line 1–17: header comments + imports**
Replace `T212Client` import with `CapitalClient`. Replace the `t212 = new T212Client(...)` singleton with:

```typescript
import { CapitalClient } from '../capital-client.js';
const capital = new CapitalClient({
  apiKey: process.env.CAPITAL_API_KEY || '',
  identifier: process.env.CAPITAL_IDENTIFIER || '',
  password: process.env.CAPITAL_PASSWORD || '',
  baseURL: process.env.CAPITAL_API_URL || 'https://demo-api-capital.backend-capital.com',
});
```

**Tool `place_order` (lines 21–50):**
- Input schema: change `instrument` to `epic`, keep direction/size/sl/tp/label.
- Call `capital.openPosition({ direction: direction === 'long' ? 'BUY' : 'SELL', epic, size, stopLevel: sl, profitLevel: tp })`.
- The tool now gets back a `DealConfirmation` with `dealId` — return that as the primary field (agents use it as position_a_id / position_b_id in the DB).
- Remove the "SL/TP tracked locally" note — they're server-side now.

**Tool `partial_close` (lines 52–67):**
- Input schema: replace `instrument`/`units` with `dealId`/`size`.
- Call `capital.partialClosePosition(dealId, size)`.

**Tool `close_position` (lines 69–84):**
- Input schema: replace `instrument`/`quantity` with `dealId`.
- Call `capital.closePosition(dealId)`.

**Tool `set_trailing_stop` (lines 86–106):**
- Input schema: replace `trade_id`/`distance` with `dealId`/`distance`.
- This becomes a REAL API call: `capital.updatePosition(dealId, { trailingStop: true, stopDistance: distance })`.
- Also update the DB for audit (`dbSetTrailingStop`), but the API call is now authoritative.

**Tool `update_sl` (lines 108–129):**
- Input schema: replace `trade_id`/`new_sl` with `dealId`/`new_sl` (keep `trade_id` optional for DB audit).
- This becomes a REAL API call: `capital.updatePosition(dealId, { stopLevel: new_sl })`.
- If `trade_id` provided, also update DB via `updateSlPrice` for the matching leg.

**Tool `log_trade` (lines 131–164):**
- Schema change: add optional `position_a_deal_id` and `position_b_deal_id` fields (from the earlier place_order confirmations).
- When creating `sl_tp_orders` rows, include `deal_id` (new DB column — see DB section below).
- Rest of the logic stays the same (audit trail).

---

### MODIFIED: `src/mcp-server/tools/market-data-tools.ts`

(Not read directly in this plan — Coder-B must read it first.)

Expected changes:
- `get_prices` tool: prefer `capital.getCandles(epic, resolution, max)` for tradeable instruments; fall back to Twelve Data for VIX, DXY, yield curve, or any instrument Capital doesn't serve.
- Capital returns OHLC as `{ bid, ask }` per price — the wrapper in `capital-client.getCandles()` converts to our `Candle` shape using **mid-price** (`(bid + ask) / 2`).
- Timeframe mapping helper: `'15m' → 'MINUTE_15'`, `'1h' → 'HOUR'`, `'4h' → 'HOUR_4'`, `'1d' → 'DAY'`, `'1w' → 'WEEK'`.
- NEW tool `get_client_sentiment(market_ids: string[])` → calls `capital.getClientSentiment()`. Optional but useful for agents.

---

### MODIFIED: `src/scheduler/index.ts`

**Massive simplification.**

**Remove/simplify `monitorSlTpOrders()` (lines 66–153):**
- SL-hit and TP-hit detection is **no longer needed** — Capital's server does this.
- Trailing-stop price updates are **no longer needed** — Capital handles it natively.
- The remaining responsibility: detect **TP1 hit → move Position B SL to break-even**. This is OUR custom logic (the split-position method).

**New `monitorSplitPositions()` logic:**

```
1. Fetch active sl_tp_orders from DB where leg='A' AND status='active'.
2. For each: call capital.getOpenPositions() (cached per tick).
3. If position_a_deal_id NOT in open positions list → Position A was closed by Capital.
4. Check activity history to determine why (SL or TP). If TP:
   a. updateTradeStatus(trade_id, 'tp1_hit')
   b. Call capital.updatePosition(position_b_deal_id, { stopLevel: trade.entry }) to move B to BE
   c. Mark leg A inactive in sl_tp_orders
   d. Log to Telegram
5. If both legs now closed → updateTradeStatus(trade_id, 'complete'), trigger reflection agent.
```

**New cron: session keep-alive (every 8 minutes):**

```typescript
cron.schedule('*/8 * * * *', async () => {
  try { await capital.ping(); }
  catch (e) { console.error('[Scheduler] Capital ping failed:', e); }
});
```

**Line 12–17: replace T212Client import and instantiation** with `CapitalClient`.

**Line 173–184: main `*/5 * * * *` job:** replace `monitorSlTpOrders()` with `monitorSplitPositions()`.

---

### MODIFIED: `src/scanner/index.ts`

**Lines 22–55: update the `INSTRUMENT_UNIVERSE` constant.**

The `ticker` field becomes the Capital.com `epic`. Keep `name` and `category` as-is.

**Stubbed map (VERIFY ALL ON DEMO — run `scripts/discover-epics.ts`):**

| Internal name | Old T212 ticker | Capital.com epic (STUBBED) | Notes |
|---------------|-----------------|----------------------------|-------|
| Nasdaq 100    | NAS100          | `US100`                    | Common Capital naming |
| S&P 500       | SPX500          | `US500`                    | |
| Dow Jones 30  | US30            | `US30`                     | Likely same |
| DAX 40        | DE40            | `DE40`                     | Sometimes `DAX` |
| FTSE 100      | UK100           | `UK100`                    | |
| Gold          | XAUUSD          | `GOLD`                     | |
| Silver        | XAGUSD          | `SILVER`                   | |
| Crude Oil WTI | USOIL           | `OIL_CRUDE`                | Spec confirms |
| EUR/USD       | EURUSD          | `EURUSD`                   | No underscore for forex |
| GBP/USD       | GBPUSD          | `GBPUSD`                   | |
| USD/JPY       | USDJPY          | `USDJPY`                   | |
| GBP/JPY       | GBPJPY          | `GBPJPY`                   | |
| AUD/USD       | AUDUSD          | `AUDUSD`                   | |
| Apple         | AAPL            | `AAPL`                     | US stocks likely same |
| Microsoft     | MSFT            | `MSFT`                     | |
| NVIDIA        | NVDA            | `NVDA`                     | |
| Amazon        | AMZN            | `AMZN`                     | |
| Alphabet      | GOOGL           | `GOOGL`                    | Might be `GOOG` |
| Meta          | META            | `META`                     | |
| Tesla         | TSLA            | `TSLA`                     | |

Add a top-of-file comment block:

```typescript
// IMPORTANT: These epics are STUBBED based on Capital.com naming conventions.
// Run `npx tsx scripts/discover-epics.ts` with valid Capital credentials to
// verify each epic against the live market catalog. Update this table before
// going live on the practice account.
```

---

### MODIFIED: `src/preflight.ts`

**Replace entire file.** New behaviour:

- REQUIRED_KEYS: `CAPITAL_API_KEY`, `CAPITAL_IDENTIFIER`, `CAPITAL_PASSWORD`, `ANTHROPIC_API_KEY`.
- OPTIONAL_KEYS: `CAPITAL_API_URL` (default to demo), all the market-data keys as before.
- `runPreflight()` becomes async. If `--skip-broker-check` CLI flag is not set:
  - Instantiate a `CapitalClient`
  - Call `createSession()`, then `getAccounts()` to verify.
  - Assert at least one account is in `accountType: 'DEMO'` mode if `CAPITAL_API_URL` is the demo URL.
  - Call `logout()` to clean up.
  - On any failure → `process.exit(1)` with clear error.
- Remove `T212_API_KEY` references.

---

### MODIFIED: `.env.example`

Replace lines 1–3 with:

```
# Capital.com
CAPITAL_API_KEY=your_capital_com_api_key
CAPITAL_IDENTIFIER=your_login_email
CAPITAL_PASSWORD=your_password
CAPITAL_API_URL=https://demo-api-capital.backend-capital.com
```

Everything else stays.

---

### MODIFIED: `src/mcp-server/index.ts`

(Not read directly — Coder-C must read first.)

Expected changes:
- Swap `T212Client` import for `CapitalClient`.
- Initialize the capital singleton on boot, trigger a warm-up `createSession()` if not already done by first tool call.
- Register a graceful-shutdown hook (SIGTERM/SIGINT) that calls `capital.logout()`.

---

### MODIFIED: `src/database/index.ts`

**Schema change:** add `deal_id` column to `sl_tp_orders` table.

```sql
ALTER TABLE sl_tp_orders ADD COLUMN deal_id TEXT;
```

- Update `createSlTpOrder()` signature to accept optional `deal_id`.
- This is needed because Capital's PUT/DELETE endpoints are keyed by `dealId`, not by instrument ticker.
- Add a `migrations/001-add-deal-id.sql` file OR do the `ALTER TABLE IF NOT EXISTS` inline in the init code (since sql.js lacks real migrations).

---

### MODIFIED: tests

**`tests/scheduler.test.ts`** — likely mocks T212 for the SL/TP monitor. Replace mocks with Capital mocks; the monitor loop is now much simpler (only TP1 → BE logic).

**`tests/preflight.test.ts`** — update required-keys list to the Capital trio + ANTHROPIC_API_KEY. Add a test that preflight fails fast with missing Capital creds.

**NEW: `tests/capital-client.test.ts`** — unit tests listed under the capital-client section above. Use axios mocking adapter.

**Other test files** (analyst, database, market-data, news, scanner, telegram) — only touch if they reference T212. Most should be untouched.

---

### DELETE: `src/mcp-server/t212-client.ts`

Only after all green (`npm test` passes, `tsc --noEmit` = 0, no references found via grep). Perform this as the FINAL commit of the migration.

---

### MODIFIED: `CLAUDE.md`

Update these sections:
- Header paragraph: "connects to **Capital.com** via their REST API" (was T212).
- "Tech Stack" → no specific changes, axios still in use.
- "MCP Server Architecture" block: rename `t212-client.ts` → `capital-client.ts`, bump LOC estimate.
- **Delete the "CRITICAL: T212 API Limitations" block** — replace with a short "Capital.com Notes" block describing session auth + deal confirmation flow.
- API Keys table: replace T212 row with 3 Capital rows (KEY, IDENTIFIER, PASSWORD) + URL.
- "Key Rules" — no changes to rules themselves, but rule #3 mentions "T212 positions" — change to "Capital.com positions".

---

### MODIFIED: `TRADING_BOT_MASTER.md`

- All mentions of Trading 212 → Capital.com.
- "Broker API limitations" section → rewrite to reflect Capital's native features.
- If there's a section describing the sl_tp_orders monitoring loop, note that server-side SL/TP has simplified this.

---

## Wave 2 agent assignments

| Agent | Files | Approx LOC touched |
|-------|-------|-------------------|
| Coder-A | `capital-client.ts` (new), `types.ts`, `scripts/discover-epics.ts` (new) | ~500 new, ~50 modified |
| Coder-B | `trading-tools.ts`, `market-data-tools.ts` | ~150 modified |
| Coder-C | `preflight.ts`, `scheduler/index.ts`, `scanner/index.ts`, `mcp-server/index.ts`, `.env.example`, `database/index.ts` (deal_id column) | ~180 modified |
| Tester  | All updated tests + new `capital-client.test.ts` | ~300 new/modified |

**Coder-B depends on Coder-A's exported client interface.** Start Coder-A slightly ahead OR have Coder-B stub with `CapitalClient` type-only import + agreed interface.

**Tester depends on all three Coders.** Runs last.

---

## Verification checklist (Wave 3)

- [ ] `npm test` → 43+ tests pass
- [ ] `npx tsc --noEmit` → 0 errors
- [ ] `grep -ri "t212" src/` → 0 results
- [ ] `grep -ri "trading 212" src/` → 0 results
- [ ] `grep -ri "T212" docs/` → only historical references in migration log
- [ ] `src/mcp-server/t212-client.ts` no longer exists
- [ ] `.env.example` only shows Capital vars, no T212 vars
- [ ] Capital client has type-safe public methods matching spec
- [ ] Session auto-reauth on 401 is tested
- [ ] Deal confirmation polling is tested
- [ ] Partial close fallback is tested

**Giuseppe's manual verification (deferred to post-merge):**
- [ ] Run `npx tsx scripts/discover-epics.ts` → verify epic mapping for all 20 instruments. Fix any mismatches.
- [ ] With creds in `.env`: start the bot, watch preflight succeed, confirm a session is created.
- [ ] Place a small test trade on demo via the bot: verify SL/TP appear on Capital.com web platform.
- [ ] Manually trigger a TP1 hit on demo → verify Position B SL moves to break-even via the scheduler.
- [ ] Run for 24 hours, confirm ping keeps session alive.

---

## Risks + mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Session auth edge cases (401 storms, race conditions) | Med | High (bot halts) | Single-flight session creation with a mutex. Backoff on repeat 401. Log + Telegram alert on repeated failures. |
| Deal confirmation never returns ACCEPTED | Low | High (positions stuck) | Max 10 poll attempts. On timeout, throw `CapitalDealError` with the dealReference — agents retry at next cycle. |
| Partial close fallback corrupts split-position semantics | Low | Med | Fallback preserves original SL/TP/trailing on the reopened leg. Unit test the full round-trip. |
| Epic naming mismatch on demo → orders rejected | High | Med | `discover-epics.ts` script + mandatory manual verification before going live. Scanner has TODO markers. |
| Capital rate limit (1000 positions/hour, 1 session/sec) | Low | Low | Our bot opens ≤5 trades = 10 positions/day. Session cache prevents re-creation spam. |
| TP1-hit detection lags → Position B SL doesn't move to BE fast enough | Low | Med | Detection runs every 5 min. Worst case: Position B SL stays at original until next cycle. Document as known limitation; re-evaluate after 2 weeks of demo. |

---

## Deferred to post-merge

- Live demo epic discovery (Giuseppe runs `scripts/discover-epics.ts`).
- Manual demo round-trip trade test.
- Consider adding WebSocket streaming for real-time position updates (currently polling `getOpenPositions()` every 5 min is fine).
- VPS deployment + Docker.

---

## Out of scope (explicitly NOT changed)

- All 6 AI agents and their V3 prompts (they invoke tools by name).
- Database schema beyond the `deal_id` column addition.
- Universe scanner scoring logic (bias detection, news scoring, kill zones).
- News system (Alpha Vantage integration).
- Research/Analyst/Reflection/Review agent cycles.
- Telegram alert format.
- Composite scoring rubric.
- Split-position method (still 2 positions per trade).
- `memory/strategy.md` and `memory/swing_strategy.md`.

---

## Ready for Wave 2?

All four agents (Coder-A, Coder-B, Coder-C, Tester) have enough detail to execute in parallel. Gate: Giuseppe approves this plan + rotates the compromised API key + puts new creds in `.env`.

After approval, spawn Wave 2 with clear file ownership and the instruction **"implement EXACTLY what the plan specifies — no scope expansion, no refactors outside listed files."**

# Master Prompt: Migrate Trading Bot from Trading 212 to Capital.com

## Context

Read CLAUDE.md first. This is a self-learning AI trading bot with 6 agents, 21 MCP tools, and ~4,500 lines of TypeScript. It was originally built for Trading 212's beta API, but we discovered T212's API does NOT support CFD accounts — only Invest and ISA accounts. We are migrating to Capital.com's REST API.

We initially considered OANDA but their EU entity (OANDA TMS) only offers MetaTrader 5 — no REST API for EU residents. Capital.com is EU-regulated, has a full REST API, and supports demo accounts with API access.

## Why Capital.com is better for this bot

Capital.com's API natively supports everything T212 forced us to hack around:
- **Native SL/TP on positions** — set `stopLevel` and `profitLevel` directly when opening a position
- **Native trailing stops** — `trailingStop: true` + `stopDistance` on create AND update
- **OHLC candle data** — `GET /prices/:epic?resolution=MINUTE_15&max=100`
- **Modify positions** — `PUT /positions/:dealId` to update SL/TP/trailing stop on existing positions
- **Close positions** — `DELETE /positions/:dealId`
- **Demo account** — `demo-api-capital.backend-capital.com` (same API as live)

## Capital.com REST API Reference

### Base URLs
- Demo: `https://demo-api-capital.backend-capital.com`
- Live: `https://api-capital.backend-capital.com`

### Authentication (Session-based)

Capital.com uses session-based auth, NOT bearer tokens. You must create a session first:

1. Generate an API key in Capital.com platform: Settings → API integrations
2. Enable Two-Factor Authentication (2FA) — required for API access
3. Start a session:

```
POST /api/v1/session
Headers:
  X-CAP-API-KEY: {your_api_key}
Body:
  { "identifier": "{your_login_email}", "password": "{your_password}" }
```

Response headers contain two tokens:
- `CST` — authorization token (client session token)
- `X-SECURITY-TOKEN` — account token identifying the financial account

**Both tokens must be sent on ALL subsequent requests.** Sessions expire after 10 minutes of inactivity — use `GET /api/v1/ping` to keep alive.

### Key Endpoints

**Session Management:**
- `POST /api/v1/session` — create session (returns CST + X-SECURITY-TOKEN in headers)
- `GET /api/v1/session` — get session details
- `PUT /api/v1/session` — switch active account
- `DELETE /api/v1/session` — log out
- `GET /api/v1/ping` — keep session alive
- `GET /api/v1/session/encryptionKey` — get encryption key for encrypted password auth

**Accounts:**
- `GET /api/v1/accounts` — all accounts (balance, equity, margin, profit/loss)
- `GET /api/v1/accounts/preferences` — account preferences (hedging mode, leverage)
- `PUT /api/v1/accounts/preferences` — update preferences

**Positions (Trades):**
- `GET /api/v1/positions` — all open positions
- `GET /api/v1/positions/:dealId` — single position details
- `POST /api/v1/positions` — open a new position (with SL/TP/trailing stop)
- `PUT /api/v1/positions/:dealId` — update SL/TP/trailing stop on existing position
- `DELETE /api/v1/positions/:dealId` — close position

**Working Orders (Limit/Stop):**
- `GET /api/v1/workingorders` — all pending orders
- `POST /api/v1/workingorders` — create limit/stop order
- `PUT /api/v1/workingorders/:dealId` — update order
- `DELETE /api/v1/workingorders/:dealId` — cancel order

**Order Confirmation:**
- `GET /api/v1/confirms/:dealReference` — confirm order execution (check status after POST /positions)

**Market Data:**
- `GET /api/v1/markets?searchTerm=gold` — search instruments
- `GET /api/v1/markets?epics=GOLD,OIL_CRUDE` — get details for specific instruments (max 40)
- `GET /api/v1/markets/:epic` — single instrument details (spreads, margin, trading hours)
- `GET /api/v1/marketnavigation` — browse market categories
- `GET /api/v1/marketnavigation/:nodeId` — browse subcategories

**Historical Prices (OHLC Candles):**
- `GET /api/v1/prices/:epic?resolution=MINUTE_15&max=100&from=2026-01-01T00:00:00&to=2026-04-17T00:00:00`

Resolutions: `MINUTE`, `MINUTE_5`, `MINUTE_15`, `MINUTE_30`, `HOUR`, `HOUR_4`, `DAY`, `WEEK`

Max values per request: 1000 (default: 10)

**Client Sentiment:**
- `GET /api/v1/clientsentiment?marketIds=GOLD,OIL_CRUDE` — % long vs short
- `GET /api/v1/clientsentiment/:marketId` — single instrument sentiment

**Account History:**
- `GET /api/v1/history/activity` — trade activity (with filters: date range, dealId, epic, status)
- `GET /api/v1/history/transactions` — financial transactions (deposits, withdrawals, P&L)

### Create Position Parameters (POST /api/v1/positions)

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| direction | string | YES | `BUY` or `SELL` |
| epic | string | YES | Instrument identifier (e.g. `GOLD`, `EURUSD`, `OIL_CRUDE`) |
| size | number | YES | Deal size (number of contracts/units) |
| guaranteedStop | boolean | NO | Guaranteed stop (default: false). Cannot combine with trailingStop |
| trailingStop | boolean | NO | Trailing stop (default: false). If true, must set stopDistance |
| stopLevel | number | NO | Price level for stop loss |
| stopDistance | number | NO | Distance from current price for stop loss. Required if trailingStop=true |
| stopAmount | number | NO | Loss amount for stop loss trigger |
| profitLevel | number | NO | Price level for take profit |
| profitDistance | number | NO | Distance from current price for take profit |
| profitAmount | number | NO | Profit amount for take profit trigger |

### Update Position Parameters (PUT /api/v1/positions/:dealId)

Same SL/TP/trailing stop parameters as Create — allows full modification of risk levels on existing positions.

### Instrument Format (Epics)

Capital.com uses "epics" as instrument identifiers. Format varies by asset class:
- Forex: `EURUSD`, `GBPUSD`, `USDJPY` (no underscore for forex)
- Commodities: `GOLD`, `SILVER`, `OIL_CRUDE`, `NATURALGAS`
- Indices: likely `US500`, `US30`, `UK100` (verify via GET /markets?searchTerm=)
- Stocks: `AAPL`, `TSLA`, `MSFT` (verify via GET /markets?searchTerm=)

**IMPORTANT:** Use `GET /api/v1/markets?searchTerm=` to discover the exact epic for each instrument in our scanner. The naming may differ from T212. Build a mapping during migration.

### Rate Limits

- `POST /session`: 1 request per second per API key
- `POST /positions` and `POST /workingorders`: 1,000 requests per hour
- Session timeout: 10 minutes (keep alive with ping)
- Max price subscriptions (WebSocket): 40 instruments at a time

### Key Differences from T212

| Feature | T212 | Capital.com |
|---------|------|-------------|
| SL/TP on order | NOT supported | Native (stopLevel, profitLevel) |
| Trailing stop | NOT supported | Native (trailingStop + stopDistance) |
| OHLC candles | NOT supported | Native (GET /prices/:epic) |
| Modify position | NOT supported | PUT /positions/:dealId |
| Close position | Opposite order hack | DELETE /positions/:dealId |
| Direction | Separate field | `BUY` / `SELL` direction field |
| Auth | Bearer token | Session-based (CST + X-SECURITY-TOKEN) |
| Session mgmt | None | Must create/maintain session, 10min timeout |
| Deal confirmation | Immediate | Async — POST returns dealReference, check with GET /confirms/:ref |

## What needs to change

### 1. Environment variables (.env.example)

Replace:
```
T212_API_KEY=your_trading212_api_key
```
With:
```
CAPITAL_API_KEY=your_capital_com_api_key
CAPITAL_IDENTIFIER=your_login_email
CAPITAL_PASSWORD=your_password
CAPITAL_API_URL=https://demo-api-capital.backend-capital.com
```

### 2. Rewrite t212-client.ts → capital-client.ts

Create a new `src/mcp-server/capital-client.ts` that wraps Capital.com's REST API. This replaces `t212-client.ts` entirely.

The client MUST handle session management internally:
- On first API call, create a session via POST /api/v1/session
- Store CST and X-SECURITY-TOKEN tokens
- Track last request time — if >9 minutes since last call, ping to keep alive
- If a request gets a 401, automatically re-create the session and retry
- On shutdown, call DELETE /api/v1/session to clean up

The client should export typed methods for:

```typescript
// Session management (internal, not exported)
private createSession(): Promise<void>
private ensureSession(): Promise<void>  // auto-create or ping
private request(method, path, body?): Promise<any>  // wrapper that adds auth headers

// Account
getAccounts(): Promise<Account[]>  // GET /api/v1/accounts

// Positions
getOpenPositions(): Promise<Position[]>  // GET /api/v1/positions
getPosition(dealId: string): Promise<Position>  // GET /api/v1/positions/:dealId
openPosition(params: OpenPositionParams): Promise<DealReference>  // POST /api/v1/positions
  // params: { direction, epic, size, stopLevel?, profitLevel?, trailingStop?, stopDistance? }
updatePosition(dealId: string, params: UpdatePositionParams): Promise<DealReference>  // PUT /api/v1/positions/:dealId
  // params: { stopLevel?, profitLevel?, trailingStop?, stopDistance? }
closePosition(dealId: string): Promise<DealReference>  // DELETE /api/v1/positions/:dealId
confirmDeal(dealReference: string): Promise<DealConfirmation>  // GET /api/v1/confirms/:dealReference

// Working Orders
getWorkingOrders(): Promise<WorkingOrder[]>  // GET /api/v1/workingorders
createWorkingOrder(params): Promise<DealReference>  // POST /api/v1/workingorders
updateWorkingOrder(dealId, params): Promise<DealReference>  // PUT /api/v1/workingorders/:dealId
deleteWorkingOrder(dealId): Promise<DealReference>  // DELETE /api/v1/workingorders/:dealId

// Market Data
searchMarkets(searchTerm: string): Promise<Market[]>  // GET /api/v1/markets?searchTerm=
getMarketDetails(epic: string): Promise<MarketDetail>  // GET /api/v1/markets/:epic
getCandles(epic: string, resolution: string, max: number, from?: string, to?: string): Promise<Candle[]>
  // GET /api/v1/prices/:epic?resolution=MINUTE_15&max=100

// History
getActivityHistory(from?: string, to?: string): Promise<Activity[]>  // GET /api/v1/history/activity
getTransactionHistory(from?: string, to?: string): Promise<Transaction[]>  // GET /api/v1/history/transactions

// Sentiment
getClientSentiment(marketIds: string[]): Promise<Sentiment[]>  // GET /api/v1/clientsentiment

// Utilities
ping(): Promise<void>  // GET /api/v1/ping
```

### 3. Update MCP tools (trading-tools.ts)

The 6 trading tools need to call capital-client instead of t212-client:

- `place_order` → calls `openPosition()` with direction, epic, size, stopLevel, profitLevel
  - After POST, call `confirmDeal()` with the returned dealReference to verify execution
  - Map the bot's instrument names to Capital.com epics
- `close_position` → calls `closePosition(dealId)`
- `partial_close` → Capital.com may not support partial close natively. Options:
  - Check if DELETE /positions/:dealId accepts a size parameter (test on demo)
  - If not: close full position, re-open smaller position with same SL/TP
  - This is critical for our split-position method — TEST THIS ON DEMO FIRST
- `update_sl` → calls `updatePosition(dealId, { stopLevel })` — now a REAL API call
- `set_trailing_stop` → calls `updatePosition(dealId, { trailingStop: true, stopDistance })` — now a REAL API call
- `get_portfolio` → calls `getOpenPositions()`
- `get_balance` → calls `getAccounts()`

**CRITICAL: Deal Confirmation Flow**
Capital.com's position creation is asynchronous. When you POST /positions, you get back a `dealReference` (not a confirmed deal). You MUST then call `GET /confirms/:dealReference` to get the actual `dealId` and confirm the trade was filled. Build a helper that:
1. Opens position → gets dealReference
2. Polls GET /confirms/:dealReference (with short delay)
3. Returns confirmed dealId + status
4. Handles rejection (insufficient margin, market closed, etc.)

### 4. Update market-data-tools.ts

`get_prices` can now use Capital.com's native candle endpoint for tradeable instruments:
- `GET /api/v1/prices/:epic?resolution=MINUTE_15&max=100`
- Resolutions: MINUTE, MINUTE_5, MINUTE_15, MINUTE_30, HOUR, HOUR_4, DAY, WEEK
- Keep Twelve Data as fallback for VIX, DXY, yield curve data, and any instruments not on Capital.com

Add a new tool or enhance existing ones:
- `get_client_sentiment` → calls `getClientSentiment()` — useful market data that Capital.com provides for free

### 5. Simplify the sl_tp_orders system

Since Capital.com supports native SL/TP and trailing stops:
- When placing an order, set SL and TP directly via `stopLevel` and `profitLevel`
- The scheduler no longer needs to poll prices and manually trigger SL/TP
- The sl_tp_orders table can still track our intended levels for logging/audit, but execution is handled by Capital.com's server
- Keep the scheduler monitoring for the TP1-hit → move-Position-B-to-break-even logic (this still needs our custom logic since it involves managing split positions)
- The TP1-hit detection can use `GET /api/v1/history/activity` to check for closed positions, or poll `GET /api/v1/positions` to detect when Position A disappears

### 6. Update instrument names in scanner/index.ts

Change instrument naming convention from T212 format to Capital.com epic format:
- EURUSD → `EURUSD` (forex stays the same, no underscore)
- XAUUSD → `GOLD` (commodities use common names)
- US30 → verify with `GET /markets?searchTerm=dow` or `GET /markets?searchTerm=us30`
- SPX500 → verify with `GET /markets?searchTerm=sp500` or `GET /markets?searchTerm=us500`
- AAPL → `AAPL` (stocks likely same)
- OIL → `OIL_CRUDE`

**IMPORTANT:** Build an instrument discovery step early in the migration:
1. Call `GET /api/v1/markets?searchTerm=` for each instrument in our scanner
2. Map our internal names to Capital.com epics
3. Store the mapping in a config file or constant
4. Some instruments may not be available — log these and remove from scanner

### 7. Update preflight.ts

Change the API key validation from T212 to Capital.com:
- Test with POST /api/v1/session (create session)
- If session succeeds, the API key + credentials are valid
- Check that the account is in demo mode (for safety during testing)
- Call GET /api/v1/accounts to verify account details
- Clean up session after validation

New required env vars to validate:
- `CAPITAL_API_KEY` (required)
- `CAPITAL_IDENTIFIER` (required)
- `CAPITAL_PASSWORD` (required)
- `CAPITAL_API_URL` (required, default to demo)

### 8. Update types.ts

Update any T212-specific types to match Capital.com's response structures:

```typescript
interface CapitalAccount {
  accountId: string;
  accountName: string;
  balance: { balance: number; deposit: number; profitLoss: number; available: number };
  currency: string;
}

interface CapitalPosition {
  position: {
    dealId: string;
    dealReference: string;
    direction: 'BUY' | 'SELL';
    size: number;
    stopLevel: number | null;
    profitLevel: number | null;
    trailingStop: boolean;
    trailingStopDistance: number | null;
    createdDateUTC: string;
  };
  market: {
    instrumentName: string;
    epic: string;
    bid: number;
    offer: number;
  };
}

interface CapitalCandle {
  snapshotTime: string;
  snapshotTimeUTC: string;
  openPrice: { bid: number; ask: number };
  highPrice: { bid: number; ask: number };
  lowPrice: { bid: number; ask: number };
  closePrice: { bid: number; ask: number };
  lastTradedVolume: number;
}

interface DealReference {
  dealReference: string;
}

interface DealConfirmation {
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

type Resolution = 'MINUTE' | 'MINUTE_5' | 'MINUTE_15' | 'MINUTE_30' | 'HOUR' | 'HOUR_4' | 'DAY' | 'WEEK';
```

### 9. Add session keep-alive to scheduler

Add a new cron job or integrate into existing scheduler:
- Every 8 minutes, call `ping()` on the Capital.com client to keep the session alive
- Handle session expiry gracefully — if any API call fails with 401, re-authenticate automatically

### 10. Update all references in CLAUDE.md, TRADING_BOT_MASTER.md

Replace all mentions of "Trading 212" with "Capital.com". Update:
- API key tables (T212_API_KEY → CAPITAL_API_KEY, CAPITAL_IDENTIFIER, CAPITAL_PASSWORD)
- Tool descriptions
- Architecture notes about SL/TP monitoring (now server-side)
- The "CRITICAL: T212 API Limitations" section → replace with Capital.com capabilities
- MCP server file listing (t212-client.ts → capital-client.ts)

### 11. Update tests

Update any tests that mock T212 responses to use Capital.com response structures:
- Mock session creation (CST + X-SECURITY-TOKEN headers)
- Mock position responses with Capital.com's nested structure
- Mock deal confirmation flow (dealReference → confirms → dealId)
- Add tests for session management (auto-reconnect, ping, expiry)

## What does NOT change

- The 6 agents and their system prompts (they call MCP tools by name, they don't know which broker is behind them)
- The database schema (trades, lessons, research_briefs, analyst_log, daily_pnl_log)
- The scheduler logic (candle close detection, agent triggers, weekly review timing)
- The universe scanner logic (scoring, bias detection, kill zones)
- The news context system
- The Telegram alerts
- The learning/reflection/weekly review loop
- The split-position execution method (still needed for multi-TP)
- The composite scoring system

## Execution order

1. **Discover instruments** — call Capital.com API on demo to map our 20 scanner instruments to their epics
2. **Create capital-client.ts** (new file) — with full session management
3. **Update types.ts** — Capital.com response types
4. **Update trading-tools.ts** — rewire to capital-client with deal confirmation flow
5. **Update market-data-tools.ts** — use Capital.com candles, keep Twelve Data fallback
6. **Update scanner instrument names** — use epic mapping from step 1
7. **Update preflight.ts** — Capital.com session validation
8. **Update .env.example** — new env vars
9. **Add session keep-alive** to scheduler
10. **Simplify sl_tp_orders logic** in scheduler
11. **Delete t212-client.ts**
12. **Update tests** — Capital.com response structures + session mocks
13. **Update CLAUDE.md and TRADING_BOT_MASTER.md**
14. **Run npm test and npx tsc --noEmit** to verify everything passes
15. **Test on demo account** — place a test trade, verify SL/TP, close it

## Critical things to test on demo FIRST

Before trusting the migration, manually test these via the API:
1. Create session → verify CST + X-SECURITY-TOKEN returned
2. Open a position with stopLevel and profitLevel → verify SL/TP set
3. Update position SL/TP → verify modification works
4. Set trailing stop on position → verify it trails
5. Close position → verify it closes
6. Check if partial close is possible (close with reduced size) — if not, design workaround
7. Get candle data → verify OHLC format
8. Session timeout handling → verify auto-reconnect works

## Important: Ask before building

Read all the files that need changing first. Confirm your understanding of the migration plan. Then build step by step, running tests after each change. Log the migration to the Obsidian vault at C:\Users\user\Desktop\Brain\Trading Bot\Build Progress.md when complete.

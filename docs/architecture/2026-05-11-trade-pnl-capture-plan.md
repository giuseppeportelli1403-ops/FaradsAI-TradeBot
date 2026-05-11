# Trade P&L Capture & Daily Aggregator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture realised broker P&L from Capital.com on every trade close, populate `trades.pnl_total` + `daily_pnl_log`, and backfill the 2026-04-21 → 2026-05-07 audit gap.

**Architecture:** Each terminal close path (handleTp2Hit, terminal handleSlOnLeg branch, agent-initiated close_position) calls a new `capturePnlForTrade()` helper after the status update. The helper queries Capital `/history/transactions` in a tight window around `closed_at`, sums `profitAndLoss`, and writes via a new `setTradePnl()` DB function that bypasses the broken `updateTradeStatus` formula. A new cron job (00:05 UTC) aggregates closed trades into `daily_pnl_log`. A one-shot backfill script handles historical trades.

**Tech Stack:** TypeScript, sql.js (pure JS SQLite), Capital.com REST API, node-cron, vitest.

**Source of truth findings (triangulated 2026-05-11 by Explore + codex:rescue twin):**
- `trades.pnl_total = COALESCE(pnl_a, 0) + COALESCE(pnl_b, 0)` at `src/database/index.ts:674` → always 0 because the three close paths never pass pnlA/pnlB.
- `getTransactionHistory()` at `src/mcp-server/capital-client.ts:788` returns `Transaction[]` with `profitAndLoss?: string` field but has **zero runtime callers**.
- `daily_pnl_log` writer `upsertDailyPnl()` at `src/database/index.ts:1050` only ever called from MCP tool — no scheduled job.
- Three close paths to wire: `scheduler/index.ts:563` (handleTp2Hit), `scheduler/index.ts:602` (handleSlOnLeg terminal), `agents/trading-agent.ts:1722` (markTradeClosedEarly).

**Capital.com transaction matching strategy:** The `Transaction` type (`src/types.ts:217`) lacks `dealId` and `instrument`. Match by:
1. Query window depends on capture variant:
   - **Terminal capture** (TP2 / terminal SL / fully-closed early): `[opened_at, now+5min]` — catches all legs that closed during the trade's lifetime.
   - **Partial capture** (TP1 leg-A close / agent partial leg close while other legs still active): `[now−1min, now+5min]` — tight window isolates the single close transaction that just landed, avoiding accidentally absorbing other trades' P&L on the same account.
2. Filter to entries where `profitAndLoss != null && currency === accountCurrency`.
3. Match by `size` against `trade.size_a` / `trade.size_b` where possible; tag remainder as `unmatched`.
4. **Aggregate fallback:** if leg-level split fails, sum all P&Ls in window and write to `pnl_total` directly via the new `pnlTotalOverride` path. Leg-level `pnl_a` / `pnl_b` stay null in this fallback — better incomplete than wrong.
5. **Self-healing retry:** any close that fails to capture P&L (broker error, no match in window) leaves `pnl_total = 0`. The daily aggregator (Task 8) scans the past 7 days for such rows pre-aggregation and re-attempts capture. This is the "dead-letter queue" — the trade row itself is the queue.

**Capital `/history/transactions` range/pagination — unverifiable locally:** the bot's client at `src/mcp-server/capital-client.ts:788-796` passes `from`/`to` straight through with no pagination handling. Capital's documented page cap and per-request range limit are not testable from local files. **Gate:** Task 3 cannot be marked done until a live dry-run against the demo API confirms the window strategy returns the expected transaction(s) for a recent closed trade (instructions in Task 3 step 5).

---

## File Structure

**Create:**
- `src/scheduler/pnl-capture.ts` — pure functions: `matchTransactionsToLegs()`, `parsePnlString()`, `capturePnlForTrade()` (orchestrator).
- `tests/pnl-capture.test.ts` — unit tests for matching + parsing.
- `tests/scheduler-pnl-wire.test.ts` — integration tests that `handleTp2Hit` / `handleSlOnLeg` / `close_position` write pnl_total on close.
- `tests/daily-pnl-aggregator.test.ts` — aggregator + cron wiring tests.
- `scripts/backfill-trade-pnl.ts` — one-shot CLI script (dry-run by default).

**Modify:**
- `src/database/index.ts` — add `setTradePnl()` writer; add `aggregateAndUpsertDailyPnl(date, equity)`; add `getTradesWithMissingPnl(sinceDays)` helper used by the self-healing retry path.
- `src/scheduler/index.ts` — wire `handleTp1Hit` (line ~494, leg-A partial), `handleTp2Hit` (line 563, terminal), `handleSlOnLeg` (line 602, terminal); add daily aggregator cron that pre-runs P&L retry on the last 7 days.
- `src/agents/trading-agent.ts` — wire `close_position` tool (line 1722) — both partial (line ~1715 deactivate path) and terminal (line ~1722 markTradeClosedEarly path) — to capture P&L post-close.
- `src/scheduler/index.ts` (MonitorDeps) — add `capturePnl` to the DI surface so tests can stub it; supports both `terminal` and `partial` window modes.

---

## Task 1: P&L string parser

**Files:**
- Create: `src/scheduler/pnl-capture.ts`
- Test: `tests/pnl-capture.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/pnl-capture.test.ts
import { describe, it, expect } from 'vitest';
import { parsePnlString } from '../src/scheduler/pnl-capture.js';

describe('parsePnlString', () => {
  it('parses plain positive numbers', () => {
    expect(parsePnlString('12.50')).toBe(12.5);
  });
  it('parses plain negative numbers', () => {
    expect(parsePnlString('-3.21')).toBe(-3.21);
  });
  it('parses comma-thousand-separator format', () => {
    expect(parsePnlString('1,234.56')).toBe(1234.56);
  });
  it('strips leading currency symbols if Capital includes them', () => {
    expect(parsePnlString('€19.22')).toBe(19.22);
    expect(parsePnlString('$-3.21')).toBe(-3.21);
  });
  it('returns null on empty / non-numeric inputs', () => {
    expect(parsePnlString('')).toBeNull();
    expect(parsePnlString(undefined)).toBeNull();
    expect(parsePnlString('N/A')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/pnl-capture.test.ts`
Expected: FAIL with "Cannot find module '../src/scheduler/pnl-capture.js'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/scheduler/pnl-capture.ts
// P&L capture: pulls realised broker P&L from Capital.com's
// /history/transactions after a trade closes locally and persists it
// into the trades table. See 2026-05-11-trade-pnl-capture-plan.md.

/**
 * Capital.com returns `profitAndLoss` as a free-form string. Live demo
 * accounts have been observed emitting plain numerics ("12.50",
 * "-3.21"); live accounts sometimes prefix the account currency
 * symbol. This parser is conservative: strip whitespace, strip leading
 * currency symbol if present, strip thousand-separator commas, then
 * parseFloat. Returns null if the result is not a finite number — the
 * caller treats null as "no P&L data" and falls back accordingly.
 */
export function parsePnlString(raw: string | undefined): number | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.toUpperCase() === 'N/A') return null;
  // Strip a single leading currency symbol if present.
  const stripped = trimmed.replace(/^[€$£¥]/, '');
  // Drop thousand separators.
  const normalised = stripped.replace(/,/g, '');
  const n = parseFloat(normalised);
  return Number.isFinite(n) ? n : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/pnl-capture.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/pnl-capture.ts tests/pnl-capture.test.ts
git commit -m "feat(pnl): add parsePnlString — tolerant Capital.com P&L string parser"
```

---

## Task 2: Transaction → leg matcher

**Files:**
- Modify: `src/scheduler/pnl-capture.ts`
- Test: `tests/pnl-capture.test.ts`

- [ ] **Step 1: Add failing test**

```typescript
// Append to tests/pnl-capture.test.ts
import { matchTransactionsToLegs } from '../src/scheduler/pnl-capture.js';
import type { Transaction, TradeRecord } from '../src/types.js';

const baseTx = (over: Partial<Transaction>): Transaction => ({
  date: '2026-05-07T13:35:00.000',
  reference: 'REF-DEFAULT',
  transactionType: 'TRADE',
  size: 1,
  currency: 'EUR',
  profitAndLoss: '0',
  ...over,
});

const baseTrade = (over: Partial<TradeRecord>): TradeRecord => ({
  id: 'trade-1',
  strategy_tag: 'ICT_INTRADAY',
  instrument: 'GOLD',
  instrument_category: 'COMMODITY',
  direction: 'long',
  setup_type: 'OB_RETEST',
  entry: 4735,
  sl: 4723,
  tp1: 4748,
  tp2: 4760,
  position_a_id: 'DEAL-A',
  position_b_id: 'DEAL-B',
  size_a: 0.5,
  size_b: 0.3,
  status: 'complete',
  pnl_a: null,
  pnl_b: null,
  pnl_total: null,
  composite_score: 65,
  kill_zone: 'NY_OPEN',
  news_category: null,
  analyst_decision: 'APPROVE',
  reasoning: '',
  closure_reason: null,
  opened_at: '2026-05-07T13:16:50.502Z',
  closed_at: '2026-05-07T13:35:01.106Z',
  ...over,
} as TradeRecord);

describe('matchTransactionsToLegs', () => {
  it('matches by exact size when both legs differ', () => {
    const trade = baseTrade({});
    const txs = [
      baseTx({ size: 0.5, profitAndLoss: '10.50', reference: 'X' }),
      baseTx({ size: 0.3, profitAndLoss: '8.72', reference: 'Y' }),
    ];
    const result = matchTransactionsToLegs(txs, trade, 'EUR');
    expect(result.pnlA).toBeCloseTo(10.5);
    expect(result.pnlB).toBeCloseTo(8.72);
    expect(result.pnlTotal).toBeCloseTo(19.22);
    expect(result.unmatched).toBe(0);
  });

  it('falls back to total-only when sizes are ambiguous', () => {
    const trade = baseTrade({ size_a: 0.5, size_b: 0.5 });
    const txs = [
      baseTx({ size: 0.5, profitAndLoss: '6.00' }),
      baseTx({ size: 0.5, profitAndLoss: '6.01' }),
    ];
    const result = matchTransactionsToLegs(txs, trade, 'EUR');
    expect(result.pnlA).toBeNull();
    expect(result.pnlB).toBeNull();
    expect(result.pnlTotal).toBeCloseTo(12.01);
  });

  it('filters by currency', () => {
    const trade = baseTrade({});
    const txs = [
      baseTx({ size: 0.5, profitAndLoss: '10.50', currency: 'USD' }), // wrong currency
      baseTx({ size: 0.3, profitAndLoss: '8.72', currency: 'EUR' }),
    ];
    const result = matchTransactionsToLegs(txs, trade, 'EUR');
    expect(result.pnlTotal).toBeCloseTo(8.72);
  });

  it('skips rows with null profitAndLoss', () => {
    const trade = baseTrade({});
    const txs = [
      baseTx({ size: 0.5, profitAndLoss: undefined }),
      baseTx({ size: 0.3, profitAndLoss: '5.00' }),
    ];
    const result = matchTransactionsToLegs(txs, trade, 'EUR');
    expect(result.pnlTotal).toBeCloseTo(5);
  });

  it('returns zero matches when no transactions in window', () => {
    const trade = baseTrade({});
    const result = matchTransactionsToLegs([], trade, 'EUR');
    expect(result.pnlTotal).toBe(0);
    expect(result.matched).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/pnl-capture.test.ts`
Expected: FAIL with "matchTransactionsToLegs is not exported"

- [ ] **Step 3: Add the implementation**

```typescript
// Append to src/scheduler/pnl-capture.ts
import type { Transaction, TradeRecord } from '../types.js';

export interface MatchResult {
  /** Realised P&L attributed to leg A, or null if unmatched. */
  pnlA: number | null;
  /** Realised P&L attributed to leg B, or null if unmatched. */
  pnlB: number | null;
  /** Sum of all matched P&L lines (may include legs we couldn't attribute). */
  pnlTotal: number;
  /** Count of transactions that contributed to pnlTotal. */
  matched: number;
  /** Count of transactions skipped (wrong currency / null pnl / not a match). */
  unmatched: number;
  /** Free-form note for the audit log. */
  note: string;
}

/**
 * Match a list of Capital.com transactions against a trade record's
 * known legs. Capital's Transaction type lacks dealId / instrument, so
 * we match by `size` against the trade's recorded leg sizes. When leg
 * sizes are equal (ambiguous), we fall back to a total-only attribution
 * — pnl_total gets the sum, pnl_a / pnl_b stay null. This is "incomplete
 * but correct" — preferable to guessing which side got which.
 */
export function matchTransactionsToLegs(
  txs: Transaction[],
  trade: TradeRecord,
  accountCurrency: string,
): MatchResult {
  let pnlA: number | null = null;
  let pnlB: number | null = null;
  let pnlTotal = 0;
  let matched = 0;
  let unmatched = 0;
  const notes: string[] = [];

  const sizeA = trade.size_a;
  const sizeB = trade.size_b;
  const ambiguousSizes = Number.isFinite(sizeA) && Number.isFinite(sizeB) && sizeA === sizeB;

  for (const tx of txs) {
    if (tx.currency !== accountCurrency) {
      unmatched += 1;
      continue;
    }
    const pnl = parsePnlString(tx.profitAndLoss);
    if (pnl === null) {
      unmatched += 1;
      continue;
    }
    pnlTotal += pnl;
    matched += 1;

    if (ambiguousSizes) {
      continue; // can't attribute to a specific leg — pnlTotal still updated
    }
    if (Number.isFinite(sizeA) && tx.size === sizeA && pnlA === null) {
      pnlA = pnl;
    } else if (Number.isFinite(sizeB) && tx.size === sizeB && pnlB === null) {
      pnlB = pnl;
    }
  }

  if (ambiguousSizes && matched > 0) {
    notes.push('ambiguous leg sizes — pnl_total only');
  }

  return {
    pnlA,
    pnlB,
    pnlTotal,
    matched,
    unmatched,
    note: notes.join('; '),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/pnl-capture.test.ts`
Expected: PASS (10 tests total — 5 from Task 1 + 5 from Task 2)

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/pnl-capture.ts tests/pnl-capture.test.ts
git commit -m "feat(pnl): match Capital transactions to trade legs by size"
```

---

## Task 3: Orchestrator — capturePnlForTrade

**Files:**
- Modify: `src/scheduler/pnl-capture.ts`
- Test: `tests/pnl-capture.test.ts`

- [ ] **Step 1: Add failing test**

```typescript
// Append to tests/pnl-capture.test.ts
import { capturePnlForTrade } from '../src/scheduler/pnl-capture.js';

describe('capturePnlForTrade', () => {
  it('returns pnl from broker transactions for a closed trade', async () => {
    const trade = baseTrade({});
    const capital = {
      getTransactionHistory: async (_from?: string, _to?: string) => ([
        baseTx({ size: 0.5, profitAndLoss: '10.50' }),
        baseTx({ size: 0.3, profitAndLoss: '8.72' }),
      ]),
    };
    const result = await capturePnlForTrade({
      trade,
      capital,
      accountCurrency: 'EUR',
      now: () => new Date('2026-05-07T13:40:00.000Z'),
    });
    expect(result.pnlTotal).toBeCloseTo(19.22);
    expect(result.pnlA).toBeCloseTo(10.5);
    expect(result.pnlB).toBeCloseTo(8.72);
    expect(result.matched).toBe(2);
  });

  it('returns zero-match result without throwing on Capital error', async () => {
    const trade = baseTrade({});
    const capital = {
      getTransactionHistory: async () => {
        throw new Error('Capital API down');
      },
    };
    const result = await capturePnlForTrade({
      trade,
      capital,
      accountCurrency: 'EUR',
      now: () => new Date('2026-05-07T13:40:00.000Z'),
    });
    expect(result.pnlTotal).toBe(0);
    expect(result.matched).toBe(0);
    expect(result.note).toContain('Capital API down');
  });

  it('uses [opened_at, now+5min] as the query window', async () => {
    const trade = baseTrade({});
    let capturedFrom = '';
    let capturedTo = '';
    const capital = {
      getTransactionHistory: async (from?: string, to?: string) => {
        capturedFrom = from ?? '';
        capturedTo = to ?? '';
        return [];
      },
    };
    await capturePnlForTrade({
      trade,
      capital,
      accountCurrency: 'EUR',
      now: () => new Date('2026-05-07T13:40:00.000Z'),
    });
    // Capital format strips milliseconds and Z (see scheduler/index.ts:299-301).
    expect(capturedFrom).toBe('2026-05-07T13:16:50');
    expect(capturedTo).toBe('2026-05-07T13:45:00');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/pnl-capture.test.ts`
Expected: FAIL with "capturePnlForTrade is not exported"

- [ ] **Step 3: Add the implementation**

```typescript
// Append to src/scheduler/pnl-capture.ts

export interface PnlCaptureDeps {
  trade: TradeRecord;
  capital: { getTransactionHistory: (from?: string, to?: string) => Promise<Transaction[]> };
  accountCurrency: string;
  /**
   * `terminal` — query [opened_at, now+5min]. Used by TP2 and the
   *   terminal SL branch — wants to catch every leg-close that
   *   happened during the trade's lifetime.
   * `partial` — query [now−1min, now+5min]. Used by TP1 leg-A close
   *   and agent-initiated partial leg close — isolates the single
   *   transaction that just landed.
   * Default: 'terminal'.
   */
  windowMode?: 'terminal' | 'partial';
  now?: () => Date;
}

export interface PnlCaptureResult extends MatchResult {
  /** Whether anything was found at all — drives whether the caller writes to DB. */
  found: boolean;
}

/**
 * Orchestrator: query Capital transactions in a window around the
 * trade's open + close, match to legs, return the result. Never
 * throws — broker errors are caught and surfaced via note. Caller
 * decides what to do with a zero-match result.
 *
 * Window:
 *   from = trade.opened_at (truncated to Capital's strict
 *          YYYY-MM-DDTHH:mm:ss format)
 *   to   = now + 5min (gives Capital settlement time to flush the
 *          last transaction; safe upper bound for monitor-driven
 *          closes which fire seconds after the broker fills)
 */
export async function capturePnlForTrade(deps: PnlCaptureDeps): Promise<PnlCaptureResult> {
  const { trade, capital, accountCurrency } = deps;
  const now = deps.now ? deps.now() : new Date();

  // Capital's /history/activity rejects ISO with milliseconds or Z
  // suffix (`error.invalid.from`). The Monitor uses the same strip
  // pattern at scheduler/index.ts:299-301; replicated here.
  const toCapitalDateFmt = (iso: string): string =>
    iso.replace(/\.\d{3}Z$/, '').replace(/Z$/, '');

  const windowMode = deps.windowMode ?? 'terminal';
  const from =
    windowMode === 'terminal'
      ? toCapitalDateFmt(trade.opened_at)
      : toCapitalDateFmt(new Date(now.getTime() - 60_000).toISOString());
  const toDate = new Date(now.getTime() + 5 * 60_000);
  const to = toCapitalDateFmt(toDate.toISOString());

  let txs: Transaction[] = [];
  try {
    txs = await capital.getTransactionHistory(from, to);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      pnlA: null,
      pnlB: null,
      pnlTotal: 0,
      matched: 0,
      unmatched: 0,
      note: `capital error: ${msg}`,
      found: false,
    };
  }

  const match = matchTransactionsToLegs(txs, trade, accountCurrency);
  return { ...match, found: match.matched > 0 };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/pnl-capture.test.ts`
Expected: PASS (13 tests total, includes terminal + partial windowMode variants)

- [ ] **Step 5: Live dry-run against Capital demo API (gate before commit)**

The `Transaction` API's pagination + range limits are not testable from local fixtures. Validate against the real demo endpoint before marking this task done:

```bash
# Pick the most recent CLOSED trade from production DB and dry-run capture against it.
ssh bot@162.55.212.198 "cd /home/bot/trading-bot && node --input-type=module -e \"
import 'dotenv/config';
import initSqlJs from 'sql.js';
import fs from 'fs';
import { CapitalClient } from './dist/mcp-server/capital-client.js';
import { capturePnlForTrade } from './dist/scheduler/pnl-capture.js';

const SQL = await initSqlJs();
const db = new SQL.Database(new Uint8Array(fs.readFileSync('./data/trading-bot.db')));
const r = db.exec(\\\"SELECT * FROM trades WHERE status IN ('complete','sl_hit','closed_early') ORDER BY closed_at DESC LIMIT 1\\\");
const cols = r[0].columns;
const trade = Object.fromEntries(cols.map((c,i) => [c, r[0].values[0][i]]));
const capital = new CapitalClient({
  apiKey: process.env.CAPITAL_API_KEY,
  identifier: process.env.CAPITAL_IDENTIFIER,
  password: process.env.CAPITAL_API_KEY_PASSWORD,
  baseURL: process.env.CAPITAL_API_URL,
});
const result = await capturePnlForTrade({ trade, capital, accountCurrency: 'EUR', windowMode: 'terminal' });
console.log('trade:', trade.id, trade.instrument, 'closed_at:', trade.closed_at);
console.log('capture result:', JSON.stringify(result, null, 2));
await capital.logout();
\""
```

Expected: `capture result` shows `matched >= 1` and a `pnlTotal` close to what Capital's UI reports for that trade. If `matched === 0`, investigate whether Capital is returning the transaction within the window (may need to widen `to` beyond +5min, or check pagination).

- [ ] **Step 6: Commit**

```bash
git add src/scheduler/pnl-capture.ts tests/pnl-capture.test.ts
git commit -m "feat(pnl): capturePnlForTrade orchestrator with terminal+partial windows"
```

---

## Task 4: DB writer — setTradePnl

**Files:**
- Modify: `src/database/index.ts`
- Test: `tests/db-set-trade-pnl.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```typescript
// tests/db-set-trade-pnl.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, insertTrade, getTradeById, setTradePnl } from '../src/database/index.js';

describe('setTradePnl', () => {
  beforeEach(async () => { await initDb(':memory:'); });

  it('writes pnl_a, pnl_b, and derives pnl_total when both legs provided', () => {
    insertTrade({
      id: 'trade-A', strategy_tag: 'ICT_INTRADAY', instrument: 'GOLD',
      instrument_category: 'COMMODITY', direction: 'long', setup_type: 'OB_RETEST',
      entry: 4735, sl: 4723, tp1: 4748, tp2: 4760,
      position_a_id: 'D-A', position_b_id: 'D-B', size_a: 0.5, size_b: 0.3,
      status: 'complete', composite_score: 65, kill_zone: 'NY_OPEN',
      news_category: null, analyst_decision: 'APPROVE', reasoning: '',
      closure_reason: null, opened_at: '2026-05-07T13:16:50.502Z',
    } as never);
    setTradePnl('trade-A', { pnlA: 10.5, pnlB: 8.72 });
    const t = getTradeById('trade-A');
    expect(t?.pnl_a).toBeCloseTo(10.5);
    expect(t?.pnl_b).toBeCloseTo(8.72);
    expect(t?.pnl_total).toBeCloseTo(19.22);
  });

  it('writes pnl_total override when leg pnls unknown', () => {
    insertTrade({
      id: 'trade-B', strategy_tag: 'ICT_INTRADAY', instrument: 'GOLD',
      instrument_category: 'COMMODITY', direction: 'long', setup_type: 'OB_RETEST',
      entry: 4735, sl: 4723, tp1: 4748, tp2: 4760,
      position_a_id: 'D-A', position_b_id: 'D-B', size_a: 0.5, size_b: 0.5,
      status: 'complete', composite_score: 65, kill_zone: 'NY_OPEN',
      news_category: null, analyst_decision: 'APPROVE', reasoning: '',
      closure_reason: null, opened_at: '2026-05-07T13:16:50.502Z',
    } as never);
    setTradePnl('trade-B', { pnlTotalOverride: 12.01 });
    const t = getTradeById('trade-B');
    expect(t?.pnl_a).toBeNull();
    expect(t?.pnl_b).toBeNull();
    expect(t?.pnl_total).toBeCloseTo(12.01);
  });

  it('is idempotent: re-applying the same values is a no-op', () => {
    insertTrade({
      id: 'trade-C', strategy_tag: 'ICT_INTRADAY', instrument: 'GOLD',
      instrument_category: 'COMMODITY', direction: 'long', setup_type: 'OB_RETEST',
      entry: 4735, sl: 4723, tp1: 4748, tp2: 4760,
      position_a_id: 'D-A', position_b_id: 'D-B', size_a: 0.5, size_b: 0.3,
      status: 'complete', composite_score: 65, kill_zone: 'NY_OPEN',
      news_category: null, analyst_decision: 'APPROVE', reasoning: '',
      closure_reason: null, opened_at: '2026-05-07T13:16:50.502Z',
    } as never);
    setTradePnl('trade-C', { pnlA: 10.5, pnlB: 8.72 });
    setTradePnl('trade-C', { pnlA: 10.5, pnlB: 8.72 });
    const t = getTradeById('trade-C');
    expect(t?.pnl_total).toBeCloseTo(19.22);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db-set-trade-pnl.test.ts`
Expected: FAIL with "setTradePnl is not exported from database/index"

- [ ] **Step 3: Add the implementation**

Append after `updateTradeStatus` (around line 680) in `src/database/index.ts`:

```typescript
/**
 * Persist realised P&L for a trade. Separate from updateTradeStatus
 * so the status update remains atomic and not dependent on broker
 * round-trips. Two modes:
 *   - pnlA / pnlB provided: leg-level attribution. pnl_total is
 *     computed deterministically from the legs.
 *   - pnlTotalOverride provided: aggregate-only attribution (used
 *     when transaction → leg matching is ambiguous). pnl_a / pnl_b
 *     stay NULL — we don't fabricate a split.
 *
 * Caller must choose ONE mode per call. Mixing yields an error.
 */
export function setTradePnl(
  tradeId: string,
  pnl: { pnlA?: number; pnlB?: number; pnlTotalOverride?: number },
): void {
  const hasLeg = pnl.pnlA !== undefined || pnl.pnlB !== undefined;
  const hasTotal = pnl.pnlTotalOverride !== undefined;
  if (hasLeg && hasTotal) {
    throw new Error('setTradePnl: pass leg pnls OR pnlTotalOverride, not both');
  }
  if (!hasLeg && !hasTotal) return; // nothing to write

  if (hasLeg) {
    const pnlTotal = (pnl.pnlA ?? 0) + (pnl.pnlB ?? 0);
    db.run(
      `UPDATE trades
         SET pnl_a = COALESCE(?, pnl_a),
             pnl_b = COALESCE(?, pnl_b),
             pnl_total = ?
       WHERE id = ?`,
      [pnl.pnlA ?? null, pnl.pnlB ?? null, pnlTotal, tradeId],
    );
  } else {
    db.run(
      `UPDATE trades
         SET pnl_total = ?
       WHERE id = ?`,
      [pnl.pnlTotalOverride, tradeId],
    );
  }
  saveToFile();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/db-set-trade-pnl.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/database/index.ts tests/db-set-trade-pnl.test.ts
git commit -m "feat(db): setTradePnl writer with leg / aggregate-override modes"
```

---

## Task 5: Wire handleTp1Hit + handleTp2Hit + handleSlOnLeg to capture P&L

**Files:**
- Modify: `src/scheduler/index.ts` — `handleTp1Hit` (~line 494, partial capture for leg A), `handleTp2Hit` (~line 556, terminal), `handleSlOnLeg` (~line 579, terminal branch only — interim leg-B SL still skipped from capture).
- Test: `tests/scheduler-pnl-wire.test.ts` (new)

**Why TP1 leg-A capture:** `handleTp1Hit` deactivates leg A and moves leg B's SL to break-even. Leg A is permanently closed at this point with realised P&L — but the trade row stays at `tp1_hit` (still has live exposure on leg B). If we wait until terminal close to capture, leg A's P&L is at risk of being lost (broker-side transaction history may have rolled off / pagination boundary / unrelated audit). Capturing now is correct and matches the closure semantics.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/scheduler-pnl-wire.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { initDb, insertTrade, getTradeById, getActiveSlTpOrders } from '../src/database/index.js';
import { handleTp2Hit, handleSlOnLeg } from '../src/scheduler/index.js';

const seed = (id: string) => insertTrade({
  id, strategy_tag: 'ICT_INTRADAY', instrument: 'GOLD',
  instrument_category: 'COMMODITY', direction: 'long', setup_type: 'OB_RETEST',
  entry: 4735, sl: 4723, tp1: 4748, tp2: 4760,
  position_a_id: 'D-A', position_b_id: 'D-B', size_a: 0.5, size_b: 0.3,
  status: 'tp1_hit', composite_score: 65, kill_zone: 'NY_OPEN',
  news_category: null, analyst_decision: 'APPROVE', reasoning: '',
  closure_reason: null, opened_at: '2026-05-07T13:16:50.502Z',
} as never);

const mockTxResponse = [
  { date: 't', reference: 'X', transactionType: 'TRADE',
    size: 0.5, currency: 'EUR', profitAndLoss: '10.50' },
  { date: 't', reference: 'Y', transactionType: 'TRADE',
    size: 0.3, currency: 'EUR', profitAndLoss: '8.72' },
];

describe('handleTp2Hit + P&L capture', () => {
  beforeEach(async () => { await initDb(':memory:'); });

  it('writes pnl_total after TP2 close', async () => {
    seed('trade-tp2');
    const trade = getTradeById('trade-tp2')!;
    const capturePnl = vi.fn().mockResolvedValue({
      pnlA: 10.5, pnlB: 8.72, pnlTotal: 19.22, matched: 2, unmatched: 0,
      note: '', found: true,
    });
    await handleTp2Hit(trade, 'trade-tp2', {
      capital: { getOpenPositions: async () => [], getActivityHistory: async () => [],
                 updatePosition: async () => ({} as never),
                 safelyAmendPosition: async () => ({} as never),
                 getMarketDetails: async () => ({} as never) } as never,
      getActiveSlTpOrders, getTradeById,
      deactivateSlTpOrder: () => {}, updateTradeStatus: () => {},
      alertTp1Hit: async () => {}, alertTp2Hit: async () => {},
      alertSlHit: async () => {}, capturePnl,
    } as never);
    expect(capturePnl).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/scheduler-pnl-wire.test.ts`
Expected: FAIL — `capturePnl` is not a recognised dep field.

- [ ] **Step 3: Wire capturePnl into MonitorDeps and the handlers**

Modify `src/scheduler/index.ts` MonitorDeps interface (around line 65) to add:

```typescript
  capturePnl?: (trade: TradeRecord) => Promise<{
    pnlA: number | null; pnlB: number | null;
    pnlTotal: number; matched: number; note: string; found: boolean;
  }>;
```

Modify `defaultMonitorDeps()` (line ~264):

```typescript
  return {
    capital,
    getActiveSlTpOrders: realGetActiveSlTpOrders,
    getTradeById: realGetTradeById,
    deactivateSlTpOrder: realDeactivateSlTpOrder,
    updateTradeStatus: realUpdateTradeStatus,
    alertTp1Hit: realAlertTp1Hit,
    alertTp2Hit: realAlertTp2Hit,
    alertSlHit: realAlertSlHit,
    capturePnl: (trade: TradeRecord) =>
      capturePnlForTrade({
        trade,
        capital,
        accountCurrency: process.env.CAPITAL_ACCOUNT_CURRENCY ?? 'EUR',
      }),
  };
```

Add import at top:

```typescript
import { capturePnlForTrade } from './pnl-capture.js';
import { setTradePnl as realSetTradePnl } from '../database/index.js';
```

Modify `handleTp2Hit` (line 556):

```typescript
export async function handleTp2Hit(
  trade: TradeRecord,
  tradeId: string,
  deps?: MonitorDeps,
): Promise<void> {
  const d = deps ?? defaultMonitorDeps();
  d.deactivateSlTpOrder(tradeId, 'B');
  d.updateTradeStatus(tradeId, 'complete');

  // Capture realised broker P&L. Best-effort: if it fails the status
  // update has already landed; we'll re-attempt via backfill if needed.
  if (d.capturePnl) {
    try {
      const result = await d.capturePnl(trade);
      if (result.found) {
        if (result.pnlA !== null || result.pnlB !== null) {
          realSetTradePnl(tradeId, {
            pnlA: result.pnlA ?? undefined,
            pnlB: result.pnlB ?? undefined,
          });
        } else {
          realSetTradePnl(tradeId, { pnlTotalOverride: result.pnlTotal });
        }
        console.log(`[Monitor] P&L captured for ${tradeId}: total=${result.pnlTotal} (matched=${result.matched})`);
      } else {
        console.warn(`[Monitor] No broker P&L found for ${tradeId} after TP2 close: ${result.note}`);
      }
    } catch (err) {
      console.error(`[Monitor] P&L capture failed for ${tradeId}: ${summarizeError(err)}`);
    }
  }

  try {
    if (d.alertTp2Hit) await d.alertTp2Hit(trade);
  } catch (e) {
    console.error(`[Monitor] Telegram TP2 alert failed: ${summarizeError(e)}`);
  }
}
```

Same pattern in `handleSlOnLeg` AFTER the terminal `d.updateTradeStatus(tradeId, finalStatus)` at line 602 — wrap the capture in the same try block. **Important:** only fire capture inside the terminal branch — the interim "still legs active" branch at line 591-596 should NOT capture (the trade isn't closed).

**For `handleTp1Hit`** (line ~494): after `d.updateTradeStatus(tradeId, 'tp1_hit')` and the `moveLegSlToBe('B', ...)` call, add a partial capture targeting leg A only:

```typescript
if (d.capturePnl) {
  try {
    const result = await d.capturePnl(trade, 'partial');
    // Partial windowMode → expect at most 1 transaction matching size_a.
    // Leg B stays open; don't overwrite its (null) pnl_b.
    if (result.found && result.pnlA !== null) {
      realSetTradePnl(tradeId, { pnlA: result.pnlA });
      console.log(`[TP1] P&L captured for ${tradeId} leg A: ${result.pnlA}`);
    } else if (result.found && result.pnlA === null && result.pnlTotal !== 0) {
      // Size-ambiguous fallback (size_a === size_b) — write total-only,
      // pnl_b remains null until leg B closes.
      realSetTradePnl(tradeId, { pnlTotalOverride: result.pnlTotal });
      console.log(`[TP1] P&L captured for ${tradeId} (total-only): ${result.pnlTotal}`);
    } else {
      console.warn(`[TP1] No broker P&L found for ${tradeId} leg A: ${result.note}`);
    }
  } catch (err) {
    console.error(`[TP1] P&L capture failed for ${tradeId}: ${summarizeError(err)}`);
  }
}
```

Update MonitorDeps `capturePnl` signature to accept the windowMode arg:

```typescript
  capturePnl?: (trade: TradeRecord, windowMode?: 'terminal' | 'partial') => Promise<{
    pnlA: number | null; pnlB: number | null;
    pnlTotal: number; matched: number; note: string; found: boolean;
  }>;
```

Update `defaultMonitorDeps()` to forward the arg:

```typescript
  capturePnl: (trade: TradeRecord, windowMode: 'terminal' | 'partial' = 'terminal') =>
    capturePnlForTrade({
      trade,
      capital,
      accountCurrency: process.env.CAPITAL_ACCOUNT_CURRENCY ?? 'EUR',
      windowMode,
    }),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/scheduler-pnl-wire.test.ts`
Expected: PASS (1 test). Then run full suite:

```bash
npx vitest run
```
Expected: 820+ tests still passing (no regression).

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/index.ts tests/scheduler-pnl-wire.test.ts
git commit -m "feat(pnl): capture realised P&L on TP2 + terminal SL closes"
```

---

## Task 6: Wire close_position MCP tool to capture P&L (terminal + partial)

**Files:**
- Modify: `src/agents/trading-agent.ts:1712-1723` (both the partial-leg deactivate branch and the terminal markTradeClosedEarly branch)
- Test: `tests/scheduler-pnl-wire.test.ts` (extend)

**Why both branches:** if the agent closes leg A while leg B is still active (`remainingActive.length > 0` at line 1720), the trade stays in its prior status and `markTradeClosedEarly` is skipped — but leg A is permanently closed with realised P&L. Without capture at this branch, leg-A P&L vanishes when leg B later closes (the broker's transaction will be for B at that time, and leg A's earlier transaction may be outside any future window). Capture both: partial leg close → write `pnlA` or `pnlB` based on the matched leg; terminal → standard pattern.

- [ ] **Step 1: Add failing test**

```typescript
// Append to tests/scheduler-pnl-wire.test.ts
import { executeTool } from '../src/agents/trading-agent.js';

describe('close_position MCP tool + P&L capture', () => {
  beforeEach(async () => { await initDb(':memory:'); });

  it('captures P&L after markTradeClosedEarly', async () => {
    // Test will fail until the implementation is wired. See Task 6.
    seed('trade-early');
    // Stub the agent's capital singleton with a transaction-yielding mock.
    // ... full mock setup omitted here for brevity — see implementation.
    expect(true).toBe(false); // placeholder failing assertion
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/scheduler-pnl-wire.test.ts -t close_position`
Expected: FAIL (placeholder).

- [ ] **Step 3: Wire close_position**

Modify `src/agents/trading-agent.ts` close_position handler around line 1712-1723:

```typescript
const remainingActive = getActiveSlTpOrdersByTradeId(trade.id);
const accountCurrency = process.env.CAPITAL_ACCOUNT_CURRENCY ?? 'EUR';

if (remainingActive.length === 0) {
  // Terminal close.
  markTradeClosedEarly(trade.id, `${reasonText} (deal=${dealId}, leg=${matchedLeg?.leg ?? '?'})`);
  try {
    const result = await capturePnlForTrade({
      trade, capital, accountCurrency, windowMode: 'terminal',
    });
    if (result.found) {
      if (result.pnlA !== null || result.pnlB !== null) {
        setTradePnl(trade.id, { pnlA: result.pnlA ?? undefined, pnlB: result.pnlB ?? undefined });
      } else {
        setTradePnl(trade.id, { pnlTotalOverride: result.pnlTotal });
      }
    } else {
      console.warn(`[close_position] No broker P&L found for ${trade.id} (terminal): ${result.note}`);
    }
  } catch (err) {
    console.error(`[close_position] Terminal P&L capture failed for ${trade.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
} else if (matchedLeg) {
  // Partial leg close — other legs still live. Capture this leg's
  // realised P&L now; trade status unchanged.
  try {
    const result = await capturePnlForTrade({
      trade, capital, accountCurrency, windowMode: 'partial',
    });
    if (result.found) {
      // Map matchedLeg.leg → pnlA / pnlB. matchTransactionsToLegs may
      // have already attributed via size; if it did, use that. Else
      // attribute the total to the matched leg directly.
      const pnlForLeg =
        matchedLeg.leg === 'A'
          ? (result.pnlA ?? result.pnlTotal)
          : (result.pnlB ?? result.pnlTotal);
      if (matchedLeg.leg === 'A') {
        setTradePnl(trade.id, { pnlA: pnlForLeg });
      } else {
        setTradePnl(trade.id, { pnlB: pnlForLeg });
      }
      console.log(`[close_position] Partial P&L captured for ${trade.id} leg ${matchedLeg.leg}: ${pnlForLeg}`);
    } else {
      console.warn(`[close_position] No broker P&L found for ${trade.id} leg ${matchedLeg.leg}: ${result.note}`);
    }
  } catch (err) {
    console.error(`[close_position] Partial P&L capture failed for ${trade.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
```

Add imports at top of `trading-agent.ts`:

```typescript
import { capturePnlForTrade } from '../scheduler/pnl-capture.js';
import { setTradePnl } from '../database/index.js';
```

- [ ] **Step 4: Rewrite the test with a real mock and run**

Replace the placeholder test with a proper one that mocks the agent's capital + DB seam. Run:

```bash
npx vitest run tests/scheduler-pnl-wire.test.ts
npx vitest run
```
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/agents/trading-agent.ts tests/scheduler-pnl-wire.test.ts
git commit -m "feat(pnl): capture realised P&L on agent-initiated close_position"
```

---

## Task 7: Daily P&L aggregator

**Files:**
- Modify: `src/database/index.ts` (add `aggregateAndUpsertDailyPnl`)
- Test: `tests/daily-pnl-aggregator.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```typescript
// tests/daily-pnl-aggregator.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, insertTrade, setTradePnl, updateTradeStatus,
         aggregateAndUpsertDailyPnl, getDailyPnl } from '../src/database/index.js';

const seedClosedTrade = (id: string, pnlTotal: number, closedAt: string) => {
  insertTrade({
    id, strategy_tag: 'ICT_INTRADAY', instrument: 'GOLD',
    instrument_category: 'COMMODITY', direction: 'long', setup_type: 'OB_RETEST',
    entry: 4735, sl: 4723, tp1: 4748, tp2: 4760,
    position_a_id: 'D-A', position_b_id: 'D-B', size_a: 0.5, size_b: 0.3,
    status: 'tp1_hit', composite_score: 65, kill_zone: 'NY_OPEN',
    news_category: null, analyst_decision: 'APPROVE', reasoning: '',
    closure_reason: null, opened_at: '2026-05-07T07:00:00.000Z',
  } as never);
  updateTradeStatus(id, 'complete');
  setTradePnl(id, { pnlTotalOverride: pnlTotal });
  // Force closed_at to the test date.
  // (test helper — direct exec via db handle exposed for tests).
};

describe('aggregateAndUpsertDailyPnl', () => {
  beforeEach(async () => { await initDb(':memory:'); });

  it('sums pnl_total grouped by closed_at date', () => {
    seedClosedTrade('t1', 12.5, '2026-05-07');
    seedClosedTrade('t2', 6.72, '2026-05-07');
    seedClosedTrade('t3', -3.21, '2026-05-08'); // different day — excluded

    aggregateAndUpsertDailyPnl('2026-05-07', 5000);
    const row = getDailyPnl('2026-05-07');
    expect(row?.realised_pnl).toBeCloseTo(19.22);
    expect(row?.equity).toBe(5000);
  });

  it('writes 0 when no trades closed on the date', () => {
    aggregateAndUpsertDailyPnl('2026-05-11', 5000);
    const row = getDailyPnl('2026-05-11');
    expect(row?.realised_pnl).toBe(0);
  });

  it('aggregates trades whose closed_at uses ISO-Z format', () => {
    // Real production format from updateTradeStatus: toISOString() →
    // '2026-05-07T13:35:01.106Z'
    seedClosedTradeRaw('iso-1', 4.50, '2026-05-07T13:35:01.106Z');
    seedClosedTradeRaw('iso-2', 6.00, '2026-05-07T07:20:00.000Z');
    aggregateAndUpsertDailyPnl('2026-05-07', 5000);
    expect(getDailyPnl('2026-05-07')?.realised_pnl).toBeCloseTo(10.5);
  });

  it('aggregates trades whose closed_at uses space-separator format', () => {
    // Real production format from markTradeClosedEarly: datetime('now')
    // → '2026-05-06 15:16:43'
    seedClosedTradeRaw('space-1', 3.21, '2026-05-06 15:16:43');
    seedClosedTradeRaw('space-2', 1.79, '2026-05-06 09:02:34');
    aggregateAndUpsertDailyPnl('2026-05-06', 5000);
    expect(getDailyPnl('2026-05-06')?.realised_pnl).toBeCloseTo(5.0);
  });

  it('aggregates mixed ISO + space-separator format trades on the same date', () => {
    seedClosedTradeRaw('mix-iso', 2.50, '2026-05-05T08:15:00.000Z');
    seedClosedTradeRaw('mix-space', 4.00, '2026-05-05 14:30:22');
    aggregateAndUpsertDailyPnl('2026-05-05', 5000);
    expect(getDailyPnl('2026-05-05')?.realised_pnl).toBeCloseTo(6.5);
  });
});

// Helper that inserts a closed trade with an EXPLICIT closed_at value.
// Required because the standard updateTradeStatus auto-stamps closed_at
// from new Date().toISOString() — we need to control the date format
// for these tests.
function seedClosedTradeRaw(id: string, pnlTotal: number, closedAt: string): void {
  insertTrade({
    id, strategy_tag: 'ICT_INTRADAY', instrument: 'GOLD',
    instrument_category: 'COMMODITY', direction: 'long', setup_type: 'OB_RETEST',
    entry: 4735, sl: 4723, tp1: 4748, tp2: 4760,
    position_a_id: 'D-A', position_b_id: 'D-B', size_a: 0.5, size_b: 0.3,
    status: 'tp1_hit', composite_score: 65, kill_zone: 'NY_OPEN',
    news_category: null, analyst_decision: 'APPROVE', reasoning: '',
    closure_reason: null, opened_at: '2026-05-05T07:00:00.000Z',
  } as never);
  // Direct SQL to bypass auto-stamping in updateTradeStatus.
  // Exposed via initDb returning a `db` handle for tests, or via a
  // test-only helper exported from src/database/index.ts.
  setTradeStatusAndClosedAt(id, 'complete', closedAt);
  setTradePnl(id, { pnlTotalOverride: pnlTotal });
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/daily-pnl-aggregator.test.ts`
Expected: FAIL — `aggregateAndUpsertDailyPnl` not exported.

- [ ] **Step 3: Add the implementation**

Append after `upsertDailyPnl` (line ~1068) in `src/database/index.ts`:

```typescript
/**
 * Sums realised P&L from closed trades on a given date and upserts the
 * daily_pnl_log row. Unrealised is set to 0 — callers that want
 * unrealised must use the MCP get_daily_pnl tool that hits Capital's
 * live balance.
 *
 * `date` is a UTC YYYY-MM-DD string. Trades are filtered by
 * `date(closed_at) = ?` (sqlite's date() parses ISO-8601 directly).
 */
export function aggregateAndUpsertDailyPnl(date: string, equity: number): void {
  const result = db.exec(
    `SELECT COALESCE(SUM(pnl_total), 0) as realised
       FROM trades
      WHERE date(closed_at) = ?
        AND status IN ('complete', 'sl_hit', 'closed_early')`,
    [date],
  );
  const realised = (result[0]?.values[0]?.[0] as number) ?? 0;
  upsertDailyPnl(date, realised, 0, equity);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/daily-pnl-aggregator.test.ts`
Expected: PASS (2 tests). The first test will require the helper to also stamp `closed_at` properly — extend `seedClosedTrade` to issue a direct `UPDATE trades SET closed_at = ? WHERE id = ?` via a test-only escape hatch (or use a date-injecting test fixture).

- [ ] **Step 5: Commit**

```bash
git add src/database/index.ts tests/daily-pnl-aggregator.test.ts
git commit -m "feat(pnl): aggregateAndUpsertDailyPnl — daily realised P&L roll-up"
```

---

## Task 8: Daily aggregator cron + self-healing P&L retry

**Files:**
- Modify: `src/database/index.ts` — add `getTradesWithMissingPnl(sinceDays)` helper.
- Modify: `src/scheduler/index.ts` — add new cron entry near line 829-950 that retries missing P&L on the past 7 days BEFORE aggregating.
- Test: extend `tests/daily-pnl-aggregator.test.ts` with `getTradesWithMissingPnl` cases.

**Why retry in the aggregator:** Codex flagged that best-effort try/catch alone is insufficient for accounting data — the original production bug was exactly silent capture gaps. Rather than spawn a new cron, fold the dead-letter retry into the daily aggregator: scan the last 7 days for trades with status terminal + `pnl_total IS NULL OR pnl_total = 0`, retry capture, THEN sum. The trade row itself is the dead-letter queue — no new table.

- [ ] **Step 1: Add `getTradesWithMissingPnl` helper**

In `src/database/index.ts` after `getTradeHistory`:

```typescript
/**
 * Returns terminal-status trades whose pnl_total is NULL or 0 and that
 * closed within the last `sinceDays` days. Used by the daily aggregator
 * to retry P&L capture for any trades whose synchronous close-path
 * capture failed (broker outage, no transactions in window, etc.).
 *
 * Why 7 days: Capital's transaction history is reliably available for
 * at least 30 days, but we don't want unbounded backfill on every cron.
 * 7 days is enough to cover weekend / multi-day outages.
 */
export function getTradesWithMissingPnl(sinceDays: number): TradeRecord[] {
  const result = db.exec(
    `SELECT * FROM trades
       WHERE status IN ('complete', 'sl_hit', 'closed_early')
         AND (pnl_total IS NULL OR pnl_total = 0)
         AND date(closed_at) >= date('now', ?)
       ORDER BY closed_at DESC`,
    [`-${sinceDays} days`],
  );
  return resultToObjects<TradeRecord>(result);
}
```

Add a passing test for it before continuing.

- [ ] **Step 2: Add cron entry with retry + aggregate**

In `src/scheduler/index.ts` near the other daily cron jobs (around the EOD journal entry at line ~928), add:

```typescript
// 2026-05-11: Daily realised-P&L roll-up + self-healing retry. Runs at
// 00:05 UTC. First retries P&L capture for any terminal trades from
// the past 7 days whose pnl_total is still NULL/0 — this is the
// dead-letter recovery loop. Then aggregates yesterday's realised P&L
// into daily_pnl_log.
cron.schedule('5 0 * * *', async () => {
  // ---- Step A: self-healing retry on missing P&L ----
  const stragglers = getTradesWithMissingPnl(7);
  if (stragglers.length > 0) {
    console.log(`[DailyPnl] Retrying P&L capture for ${stragglers.length} trade(s) with missing pnl_total`);
  }
  for (const trade of stragglers) {
    try {
      const result = await capturePnlForTrade({
        trade,
        capital,
        accountCurrency: process.env.CAPITAL_ACCOUNT_CURRENCY ?? 'EUR',
        windowMode: 'terminal',
      });
      if (result.found) {
        if (result.pnlA !== null || result.pnlB !== null) {
          setTradePnl(trade.id, { pnlA: result.pnlA ?? undefined, pnlB: result.pnlB ?? undefined });
        } else {
          setTradePnl(trade.id, { pnlTotalOverride: result.pnlTotal });
        }
        console.log(`[DailyPnl] Retry succeeded for ${trade.id}: total=${result.pnlTotal}`);
      } else {
        console.warn(`[DailyPnl] Retry still no data for ${trade.id}: ${result.note}`);
      }
    } catch (err) {
      console.error(`[DailyPnl] Retry failed for ${trade.id}: ${summarizeError(err)}`);
    }
  }

  // ---- Step B: aggregate yesterday ----
  const yesterday = new Date(Date.now() - 24 * 60 * 60_000)
    .toISOString()
    .substring(0, 10); // YYYY-MM-DD
  let equity = 0;
  try {
    const accounts = await capital.getAccounts();
    equity = accounts[0]?.balance?.balance ?? 0;
  } catch (err) {
    console.warn(`[DailyPnl] Could not fetch live equity for ${yesterday}: ${summarizeError(err)}`);
    const last = getDailyPnl(yesterday);
    equity = last?.equity ?? 0;
  }
  try {
    aggregateAndUpsertDailyPnl(yesterday, equity);
    console.log(`[DailyPnl] Aggregated realised P&L for ${yesterday} (equity=${equity})`);
  } catch (err) {
    console.error(`[DailyPnl] Aggregation failed for ${yesterday}: ${summarizeError(err)}`);
  }
}, { timezone: 'UTC' });
```

Add imports at top of `src/scheduler/index.ts`:

```typescript
import {
  aggregateAndUpsertDailyPnl,
  getDailyPnl,
  getTradesWithMissingPnl,
  setTradePnl,
} from '../database/index.js';
```

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: all tests pass — cron registration is unit-tested via integration (no specific test for the new cron, but no regression elsewhere).

- [ ] **Step 3: Commit**

```bash
git add src/scheduler/index.ts
git commit -m "feat(pnl): schedule daily P&L aggregator at 00:05 UTC"
```

---

## Task 9: Historical backfill script

**Files:**
- Create: `scripts/backfill-trade-pnl.ts`
- Test: Manual — dry-run output review before --apply.

- [ ] **Step 1: Write the script**

```typescript
// scripts/backfill-trade-pnl.ts
//
// One-shot backfill: for every trade in [FROM, TO] whose pnl_total is
// 0 or NULL, fetch broker P&L via Capital /history/transactions and
// write it via setTradePnl. Dry-run by default — pass --apply to commit.
//
// Usage:
//   npx tsx scripts/backfill-trade-pnl.ts            # dry-run
//   npx tsx scripts/backfill-trade-pnl.ts --apply    # commit changes
//
// Date range: 2026-04-21 → 2026-05-08 covers the audit gap
// (see project_farad_logging_gap_rca.md memory). Adjust constants
// below if rerunning for a different window.

import 'dotenv/config';
import { initDb, getTradeHistory, setTradePnl } from '../src/database/index.js';
import { CapitalClient } from '../src/mcp-server/capital-client.js';
import { capturePnlForTrade } from '../src/scheduler/pnl-capture.js';

const FROM = '2026-04-21';
const TO = '2026-05-08';
const apply = process.argv.includes('--apply');
const accountCurrency = process.env.CAPITAL_ACCOUNT_CURRENCY ?? 'EUR';

async function main() {
  await initDb('./data/trading-bot.db');

  const capital = new CapitalClient({
    apiKey: process.env.CAPITAL_API_KEY ?? '',
    identifier: process.env.CAPITAL_IDENTIFIER ?? '',
    password: process.env.CAPITAL_API_KEY_PASSWORD ?? '',
    baseURL: process.env.CAPITAL_API_URL ?? 'https://demo-api-capital.backend-capital.com',
  });

  // Pull a wide history slice — getTradeHistory takes a limit.
  const all = getTradeHistory(500);
  const candidates = all.filter(t =>
    t.opened_at >= FROM && t.opened_at < TO &&
    (t.pnl_total === null || t.pnl_total === 0) &&
    (t.status === 'complete' || t.status === 'sl_hit' || t.status === 'closed_early'),
  );

  console.log(`Found ${candidates.length} candidates in [${FROM}, ${TO}). Apply=${apply}.`);

  let updated = 0;
  let skipped = 0;
  for (const t of candidates) {
    const result = await capturePnlForTrade({ trade: t, capital, accountCurrency });
    if (!result.found) {
      console.log(`  SKIP ${t.id} ${t.instrument} — no broker P&L (${result.note})`);
      skipped += 1;
      continue;
    }
    const split = result.pnlA !== null || result.pnlB !== null;
    console.log(`  ${apply ? 'APPLY' : 'DRY '} ${t.id} ${t.instrument} → total=${result.pnlTotal} ${split ? `[A=${result.pnlA}, B=${result.pnlB}]` : '[total-only]'}`);
    if (apply) {
      if (split) {
        setTradePnl(t.id, {
          pnlA: result.pnlA ?? undefined,
          pnlB: result.pnlB ?? undefined,
        });
      } else {
        setTradePnl(t.id, { pnlTotalOverride: result.pnlTotal });
      }
      updated += 1;
    }
  }

  console.log(`\nDone. updated=${updated} skipped=${skipped} dryrun=${!apply}`);
  await capital.logout();
}

main().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Run dry-run against a local DB copy**

```bash
# Pull a local copy of production DB for testing the backfill against
# real Capital data:
scp bot@162.55.212.198:/home/bot/trading-bot/data/trading-bot.db /tmp/trading-bot-backup.db
cp /tmp/trading-bot-backup.db ./data/trading-bot.db
npx tsx scripts/backfill-trade-pnl.ts
```

Expected: prints per-trade match info. No DB writes.

- [ ] **Step 3: Review dry-run output, then apply**

```bash
npx tsx scripts/backfill-trade-pnl.ts --apply
```

Expected: DB rows updated. Re-running prints `APPLY` with same numbers idempotently.

- [ ] **Step 4: Commit script (after dry-run review)**

```bash
git add scripts/backfill-trade-pnl.ts
git commit -m "feat(pnl): one-shot backfill script for Apr 21 → May 8 audit gap"
```

- [ ] **Step 5: Deploy + rerun aggregator on VPS for backfilled dates**

```bash
# On the VPS after deploying:
ssh bot@162.55.212.198 "cd /home/bot/trading-bot && \
  npx tsx scripts/backfill-trade-pnl.ts --apply && \
  for d in 2026-04-21 2026-04-22 ... 2026-05-08; do \
    npx tsx -e \"import('./src/database/index.js').then(m => m.initDb('./data/trading-bot.db').then(() => m.aggregateAndUpsertDailyPnl('$d', 5000)))\"; \
  done"
```

(Note: the daily aggregator only runs going forward; backfilled trades need a one-shot per-day re-aggregation.)

---

## Codex Plan-Review Amendments (2026-05-11)

This plan was reviewed by `codex:rescue` after the initial draft. All 5 findings were folded in:

1. **TP1 leg-A capture** → Task 5 now wires `handleTp1Hit` with `windowMode: 'partial'` and writes `pnl_a` only (no `closed_at` mutation).
2. **Partial `close_position` capture** → Task 6 now handles both terminal and partial branches; partial writes `pnl_a` or `pnl_b` to whichever leg's dealId just closed.
3. **Mixed `closed_at` format aggregation tests** → Task 7 now has explicit tests for ISO-Z, space-separator, and mixed-day formats from the production DB.
4. **Self-healing retry instead of best-effort-only** → Task 8 now retries missing P&L for the past 7 days *before* daily aggregation. The trade row itself is the dead-letter queue (`pnl_total IS NULL OR 0`), avoiding a new table.
5. **Capital pagination/range unverifiable locally** → Task 3 step 5 added: live dry-run against demo API gates the commit.

## Self-Review

**Spec coverage:**
- ✅ Fetch broker P&L on every close (terminal + partial) → Task 5 (TP1 partial + TP2 terminal + SL terminal), Task 6 (close_position terminal + partial)
- ✅ Write to pnl_total → Task 4 (setTradePnl), invoked by Tasks 5+6+8
- ✅ Daily aggregator + self-healing retry → Tasks 7+8
- ✅ Mixed format handling → Task 7 covers both `'2026-05-07T13:35:01.106Z'` (toISOString) and `'2026-05-06 15:16:43'` (sqlite datetime('now'))
- ✅ Backfill (historical) → Task 9
- ✅ Live dry-run gate before merging → Task 3 step 5

**Placeholder scan:** None. Task 6 step 1 uses a placeholder `expect(true).toBe(false)` to start TDD, replaced with real mock in step 4. Task 7's `setTradeStatusAndClosedAt` helper needs an export from `src/database/index.ts` — implementer adds it as the first sub-step.

**Type consistency:**
- `PnlCaptureResult`, `MatchResult` types defined in Task 2-3, used unchanged in Tasks 5-6-8.
- `setTradePnl` signature `{ pnlA?, pnlB?, pnlTotalOverride? }` used consistently in Tasks 4, 5, 6, 8, 9.
- `capturePnlForTrade()` deps shape `{ trade, capital, accountCurrency, windowMode?, now? }` consistent across Tasks 3, 5, 6, 8, 9.

**Known risks:**
1. **Transaction matching may underperform on real Capital data.** Mitigation: total-only fallback + self-healing retry (Task 8) re-attempts for 7 days post-close.
2. **Capital `/history/transactions` pagination/range limit** — unverifiable locally. Mitigation: Task 3 step 5 dry-run gate must pass on demo API before merge.
3. **Adjacent same-currency same-size trades** — Capital `Transaction` lacks dealId, so two simultaneous trades with same size on different instruments could swap-attribute. Mitigation: narrow `partial` window (1 min) reduces overlap probability to near-zero. Document as known limitation; if it bites, add dealId-via-note parsing.
4. **2-leg trades with equal sizes** fall back to total-only. Acceptable.
5. **Backfill writes to live VPS DB.** Script defaults to dry-run; manual `--apply` review required.

---

## Execution Handoff

Plan saved. Two execution options:

**1. Subagent-Driven (recommended for this scope — 9 tasks, data-correctness critical)** — dispatch a fresh subagent per task with codex:rescue twin per task (per `feedback_codex_alongside_agent.md`), review between tasks.

**2. Inline Execution** — execute all 9 tasks in this session via executing-plans skill, batch checkpoints.

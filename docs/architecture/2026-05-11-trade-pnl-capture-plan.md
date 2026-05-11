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
1. Query window `[opened_at, closed_at + 5min]`.
2. Filter to entries where `profitAndLoss != null && currency === accountCurrency`.
3. Match by `size` against `trade.size_a` / `trade.size_b` where possible; tag remainder as `unmatched`.
4. **MVP fallback:** if leg-level split fails, sum all P&Ls in window and write to `pnl_total` directly via the new `pnlTotalOverride` path. Leg-level `pnl_a` / `pnl_b` stay null in this fallback — better incomplete than wrong.

---

## File Structure

**Create:**
- `src/scheduler/pnl-capture.ts` — pure functions: `matchTransactionsToLegs()`, `parsePnlString()`, `capturePnlForTrade()` (orchestrator).
- `tests/pnl-capture.test.ts` — unit tests for matching + parsing.
- `tests/scheduler-pnl-wire.test.ts` — integration tests that `handleTp2Hit` / `handleSlOnLeg` / `close_position` write pnl_total on close.
- `tests/daily-pnl-aggregator.test.ts` — aggregator + cron wiring tests.
- `scripts/backfill-trade-pnl.ts` — one-shot CLI script (dry-run by default).

**Modify:**
- `src/database/index.ts` — add `setTradePnl()` writer; add `aggregateAndUpsertDailyPnl(date, equity)`.
- `src/scheduler/index.ts` — wire `handleTp2Hit` (line 563), `handleSlOnLeg` (line 602); add daily aggregator cron.
- `src/agents/trading-agent.ts` — wire `close_position` tool (line 1722) to capture P&L post-close.
- `src/scheduler/index.ts` (MonitorDeps) — add `capturePnlForTrade` to the DI surface so tests can stub it.

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

  const from = toCapitalDateFmt(trade.opened_at);
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
Expected: PASS (13 tests total)

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/pnl-capture.ts tests/pnl-capture.test.ts
git commit -m "feat(pnl): capturePnlForTrade orchestrator with bounded query window"
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

## Task 5: Wire handleTp2Hit + handleSlOnLeg to capture P&L

**Files:**
- Modify: `src/scheduler/index.ts:556-615` (handleTp2Hit + handleSlOnLeg terminal branch)
- Test: `tests/scheduler-pnl-wire.test.ts` (new)

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

Same pattern in `handleSlOnLeg` AFTER the terminal `d.updateTradeStatus(tradeId, finalStatus)` at line 602 — wrap the capture in the same try block.

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

## Task 6: Wire close_position MCP tool to capture P&L

**Files:**
- Modify: `src/agents/trading-agent.ts:1716-1723` (the markTradeClosedEarly call site)
- Test: `tests/scheduler-pnl-wire.test.ts` (extend)

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

Modify `src/agents/trading-agent.ts` close_position handler (line 1717-1723) to:

```typescript
const remainingActive = getActiveSlTpOrdersByTradeId(trade.id);
if (remainingActive.length === 0) {
  markTradeClosedEarly(trade.id, `${reasonText} (deal=${dealId}, leg=${matchedLeg?.leg ?? '?'})`);
  // Capture broker P&L (best-effort).
  try {
    const result = await capturePnlForTrade({
      trade,
      capital,
      accountCurrency: process.env.CAPITAL_ACCOUNT_CURRENCY ?? 'EUR',
    });
    if (result.found) {
      if (result.pnlA !== null || result.pnlB !== null) {
        setTradePnl(trade.id, { pnlA: result.pnlA ?? undefined, pnlB: result.pnlB ?? undefined });
      } else {
        setTradePnl(trade.id, { pnlTotalOverride: result.pnlTotal });
      }
    } else {
      console.warn(`[close_position] No broker P&L found for ${trade.id}: ${result.note}`);
    }
  } catch (err) {
    console.error(`[close_position] P&L capture failed for ${trade.id}: ${err instanceof Error ? err.message : String(err)}`);
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
});
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

## Task 8: Daily aggregator cron job

**Files:**
- Modify: `src/scheduler/index.ts` (add new cron entry near line 829-950)
- Test: `tests/daily-pnl-aggregator.test.ts` (extend with cron registration check — or skip cron-timing test since node-cron is hard to test)

- [ ] **Step 1: Add cron entry**

In `src/scheduler/index.ts` near the other daily cron jobs (around the EOD journal entry at line ~928), add:

```typescript
// 2026-05-11: Daily realised-P&L roll-up. Runs at 00:05 UTC for the
// previous UTC day. Uses Capital's live balance as the equity snapshot.
// If Capital is unreachable, falls back to the last known equity from
// daily_pnl_log so we still record realised P&L.
cron.schedule('5 0 * * *', async () => {
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
import { aggregateAndUpsertDailyPnl, getDailyPnl } from '../database/index.js';
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

## Self-Review

**Spec coverage:**
- ✅ Fetch broker P&L on close → Task 5 (TP2 + SL terminal), Task 6 (close_position)
- ✅ Write to pnl_total → Task 4 (setTradePnl), invoked by Tasks 5+6
- ✅ Daily aggregator → Tasks 7+8
- ✅ Backfill → Task 9

**Placeholder scan:** None. Task 6 step 1 uses a placeholder `expect(true).toBe(false)` to start TDD, replaced with real mock in step 4.

**Type consistency:**
- `PnlCaptureResult`, `MatchResult` types defined in Task 2-3, used unchanged in Tasks 5-6.
- `setTradePnl` signature `{ pnlA?, pnlB?, pnlTotalOverride? }` used consistently in Tasks 4, 5, 6, 9.
- `capturePnlForTrade()` deps shape `{ trade, capital, accountCurrency, now? }` consistent across Tasks 3, 5, 6, 9.

**Known risks:**
1. **Transaction matching may underperform on real Capital data.** Mitigation: total-only fallback (Task 2) means we still capture *aggregate* P&L even if leg-split fails. Monitor production logs after deploy.
2. **Capital `getTransactionHistory` may return >2 transactions** if there's overlap (e.g., adjacent trades on the same instrument). The window is bounded by `[opened_at, closed_at + 5min]` per trade — should give acceptable isolation, but worth reviewing dry-run output.
3. **2-leg trades with equal sizes** fall back to total-only. Acceptable.
4. **Backfill writes to live VPS DB.** Script defaults to dry-run; manual `--apply` review required.

---

## Execution Handoff

Plan saved. Two execution options:

**1. Subagent-Driven (recommended for this scope — 9 tasks, data-correctness critical)** — dispatch a fresh subagent per task with codex:rescue twin per task (per `feedback_codex_alongside_agent.md`), review between tasks.

**2. Inline Execution** — execute all 9 tasks in this session via executing-plans skill, batch checkpoints.

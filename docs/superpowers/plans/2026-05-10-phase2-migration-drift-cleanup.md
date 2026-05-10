# Phase 2 Migration Drift Cleanup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 2 P1 latent bugs + 1 P2 race-prone semantic + 1 P3 orphan-position observability gap + 1 P3 stale-comment sweep, all stemming from the 2026-05-09 Phase 2 3-leg-removal migration.

**Architecture:** Five surgical edits across four files. No new dependencies. TDD per task. Codex parallel review per task per the standing rule. VPS deploy at end.

**Tech Stack:** TypeScript, vitest 4.1.4, sql.js, better-sqlite3 patterns, Anthropic SDK, Telegraf.

**Spec:** `docs/superpowers/specs/2026-05-10-phase2-migration-drift-cleanup-design.md`

---

## Task 1: P1.1 — `getTradeByDealId` drop `position_c_id`

**Files:**
- Modify: `src/database/index.ts:998-1011`
- Test: `tests/database-getTradeByDealId.test.ts` (NEW)

- [ ] **Step 1: Write the failing test**

```typescript
// tests/database-getTradeByDealId.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, insertTrade, getTradeByDealId } from '../src/database/index.js';

describe('getTradeByDealId — Phase 2 schema (no position_c_id column)', () => {
  beforeEach(async () => {
    await initDatabase(':memory:');
  });

  it('finds trade by leg A dealId', () => {
    const tradeId = 'TRADE-A-1';
    insertTrade({
      id: tradeId, strategy_tag: 'ICT_INTRADAY', instrument: 'SILVER',
      instrument_category: 'commodity', direction: 'BUY', setup_type: 'IFC_LongTrigger',
      entry: 30, sl: 29.22, tp1: 30.78, tp2: 31.02,
      position_a_id: 'DEAL-A-XYZ', position_b_id: 'DEAL-B-XYZ',
      size_a: 7, size_b: 3, status: 'open', composite_score: 78,
      kill_zone: 'NY_OPEN', news_category: null,
      analyst_decision: 'APPROVE', reasoning: 'test',
    });
    expect(getTradeByDealId('DEAL-A-XYZ')?.id).toBe(tradeId);
  });

  it('finds trade by leg B dealId', () => {
    const tradeId = 'TRADE-B-1';
    insertTrade({
      id: tradeId, strategy_tag: 'ICT_INTRADAY', instrument: 'SILVER',
      instrument_category: 'commodity', direction: 'BUY', setup_type: 'IFC_LongTrigger',
      entry: 30, sl: 29.22, tp1: 30.78, tp2: 31.02,
      position_a_id: 'DEAL-A-1', position_b_id: 'DEAL-B-1',
      size_a: 7, size_b: 3, status: 'open', composite_score: 78,
      kill_zone: 'NY_OPEN', news_category: null,
      analyst_decision: 'APPROVE', reasoning: 'test',
    });
    expect(getTradeByDealId('DEAL-B-1')?.id).toBe(tradeId);
  });

  it('does not throw "no such column: position_c_id" on Phase 2 schema', () => {
    expect(() => getTradeByDealId('DEAL-MISSING')).not.toThrow();
    expect(getTradeByDealId('DEAL-MISSING')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/database-getTradeByDealId.test.ts`
Expected: All three tests FAIL with `SQLite3 error: no such column: position_c_id`. (The schema has been migrated by `setupSchema`; the SQL string still references the dropped column.)

- [ ] **Step 3: Apply the fix**

Replace `src/database/index.ts:998-1011` with:

```typescript
/**
 * Find which trade record (if any) owns this Capital deal_id by checking
 * the position_a_id / position_b_id columns. Used by the `close_position`
 * MCP tool so the LLM can pass the dealId and we can find the corresponding
 * trade row to mark closed_early.
 *
 * (Pre-2026-05-09 this also checked position_c_id, dropped by the Phase 2
 * 3-leg-removal migration at database/index.ts:191-261.)
 */
export function getTradeByDealId(dealId: string): TradeRecord | null {
  const result = db.exec(
    'SELECT * FROM trades WHERE position_a_id = ? OR position_b_id = ?',
    [dealId, dealId],
  );
  const rows = resultToObjects<TradeRecord>(result);
  return rows[0] || null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/database-getTradeByDealId.test.ts`
Expected: 3/3 PASS.

- [ ] **Step 5: Run full suite + tsc**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 814+3 = 817 tests pass; tsc clean.

- [ ] **Step 6: Codex parallel review**

Dispatch codex:codex-rescue with diff scope: verify SQL is syntactically correct, bind-param count matches placeholder count, no other call sites of `getTradeByDealId` rely on the dropped behaviour, JSDoc accurate.

- [ ] **Step 7: Commit**

```bash
git add tests/database-getTradeByDealId.test.ts src/database/index.ts
git commit -m "fix(db): drop position_c_id from getTradeByDealId SQL (Phase 2 drift)"
```

---

## Task 2: P1.2 — Tighten `createSlTpOrder` leg type

**Files:**
- Modify: `src/database/index.ts:945-955`

- [ ] **Step 1: Run tsc to confirm starting state is clean**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 2: Apply the type tightening**

Replace `src/database/index.ts:945-955` with:

```typescript
export function createSlTpOrder(params: {
  trade_id: string;
  leg: 'A' | 'B';
  instrument: string;
  direction: Direction;
  quantity: number;
  sl_price?: number;
  tp_price?: number;
  trailing_stop_distance?: number;
  deal_id?: string;
}): void {
```

(Removed `'C'` from union, removed the stale "NEW 2026-04-21: 'C' added for 3-leg split-position" comment.)

- [ ] **Step 3: Run tsc to verify all callers still type-check**

Run: `npx tsc --noEmit`
Expected: clean. If any caller breaks, fix the caller (it would be passing `'C'`, which is exactly the runtime CHECK violation we're preventing).

- [ ] **Step 4: Run full suite**

Run: `npx vitest run`
Expected: 817/817 pass.

- [ ] **Step 5: Codex parallel review**

Dispatch codex:codex-rescue: confirm no caller passes `'C'`, type narrows correctly, no test mocks the old shape.

- [ ] **Step 6: Commit**

```bash
git add src/database/index.ts
git commit -m "fix(db): tighten createSlTpOrder leg type to 'A'|'B' (Phase 2 drift)"
```

---

## Task 3: P2.1 — Move `get_daily_pnl` to stateful tools

**Files:**
- Modify: `src/agents/trading-agent.ts:589-597`
- Test: `tests/trading-agent-readonly-set.test.ts` (NEW)

- [ ] **Step 1: Write the failing test**

```typescript
// tests/trading-agent-readonly-set.test.ts
import { describe, it, expect } from 'vitest';
import { READ_ONLY_TOOLS } from '../src/agents/trading-agent.js';

describe('READ_ONLY_TOOLS membership (Spec 1 L1 split)', () => {
  it('does NOT include get_daily_pnl (it is a write — upserts daily_pnl_log)', () => {
    expect(READ_ONLY_TOOLS.has('get_daily_pnl')).toBe(false);
  });

  it('includes the actual read-only tools', () => {
    expect(READ_ONLY_TOOLS.has('get_portfolio')).toBe(true);
    expect(READ_ONLY_TOOLS.has('get_ranked_instruments')).toBe(true);
    expect(READ_ONLY_TOOLS.has('get_prices')).toBe(true);
    expect(READ_ONLY_TOOLS.has('get_news_context')).toBe(true);
    expect(READ_ONLY_TOOLS.has('get_economic_calendar')).toBe(true);
    expect(READ_ONLY_TOOLS.has('get_lessons')).toBe(true);
  });
});
```

If `READ_ONLY_TOOLS` is not currently exported, also export it (smallest possible change to make it testable; tests are first-class consumers).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/trading-agent-readonly-set.test.ts`
Expected: First test FAILS (`get_daily_pnl` is currently in the set).

- [ ] **Step 3: Apply the fix**

In `src/agents/trading-agent.ts:589-597`, remove `'get_daily_pnl'` from the `READ_ONLY_TOOLS` set. Add a comment line above the set explaining why `get_daily_pnl` is excluded:

```typescript
// READ_ONLY_TOOLS — tools safe to run concurrently in Promise.all.
// 'get_daily_pnl' deliberately excluded: although it returns data the
// agent reads, the MCP tool implementation upserts daily_pnl_log
// (mcp-server/tools/db-tools.ts:69-83). Classifying it stateful keeps
// write semantics consistent and prevents future race conditions if the
// process model changes.
const READ_ONLY_TOOLS = new Set<string>([
  'get_portfolio',
  'get_ranked_instruments',
  'get_prices',
  'get_news_context',
  'get_economic_calendar',
  'get_lessons',
]);
```

If `READ_ONLY_TOOLS` was not previously exported, export it now (matches what the test imports).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/trading-agent-readonly-set.test.ts`
Expected: 2/2 PASS.

- [ ] **Step 5: Run full suite + tsc**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 819/819 pass (816 prior + 3 new from Task 1 + 2 new now); tsc clean.

- [ ] **Step 6: Codex parallel review**

Dispatch codex:codex-rescue: verify no other caller relies on `get_daily_pnl` being read-only, confirm STEP 1 batched-read behaviour in the agent loop still works (read-only batch + sequential stateful — `get_daily_pnl` will now run sequentially after the read-only batch in the same iteration). Confirm prompts/ict-agent.md STEP 1 directive still works (the LLM emits all three in parallel; the server reorders for execution but reconstructs in tool_use order for the response).

- [ ] **Step 7: Commit**

```bash
git add tests/trading-agent-readonly-set.test.ts src/agents/trading-agent.ts
git commit -m "fix(agent): move get_daily_pnl out of READ_ONLY_TOOLS (it upserts daily_pnl_log)"
```

---

## Task 4: P3.1 — Telegram CRITICAL alert on DB_LOG_FAILED_AFTER_PLACEMENT

**Files:**
- Modify: `src/agents/trading-agent.ts:1543-1563`
- Modify: `src/notifications/telegram.ts` (add `alertOrphanPositions`)
- Test: extend `tests/place-split-trade.test.ts` (or new `tests/orphan-alert.test.ts` if simpler)

- [ ] **Step 1: Add the alert function to telegram.ts**

Append to `src/notifications/telegram.ts` (near `alertSystemWarning`):

```typescript
export async function alertOrphanPositions(opts: {
  instrument: string;
  direction: 'BUY' | 'SELL';
  legA: { dealId: string; size: number };
  legB: { dealId: string; size: number };
  errorMessage: string;
}): Promise<void> {
  const text = [
    '🚨 *CRITICAL — ORPHAN POSITIONS*',
    '',
    'Trade row write failed AFTER both legs were placed on Capital.com.',
    'Manual reconciliation required.',
    '',
    `Instrument: ${mdEsc(opts.instrument)}`,
    `Direction: ${opts.direction}`,
    `Leg A dealId: \`${mdEsc(opts.legA.dealId)}\` (size ${opts.legA.size})`,
    `Leg B dealId: \`${mdEsc(opts.legB.dealId)}\` (size ${opts.legB.size})`,
    `Error: ${mdEsc(opts.errorMessage)}`,
    '',
    'These positions are LIVE on Capital but NOT tracked by the bot.',
    'Decide: close manually via Capital app, or insert trade row by hand.',
  ].join('\n');
  await sendTelegram(text);
}
```

- [ ] **Step 2: Write the failing test**

```typescript
// tests/orphan-alert.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendTelegramMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../src/notifications/telegram.js', async (orig) => ({
  ...(await orig() as object),
  sendTelegram: sendTelegramMock,
}));

import { alertOrphanPositions } from '../src/notifications/telegram.js';

describe('alertOrphanPositions', () => {
  beforeEach(() => sendTelegramMock.mockClear());

  it('emits CRITICAL header with both deal IDs and error message', async () => {
    await alertOrphanPositions({
      instrument: 'SILVER',
      direction: 'BUY',
      legA: { dealId: 'DEAL-A-XYZ', size: 7 },
      legB: { dealId: 'DEAL-B-XYZ', size: 3 },
      errorMessage: 'sql.js write failed: disk full',
    });
    expect(sendTelegramMock).toHaveBeenCalledTimes(1);
    const msg = sendTelegramMock.mock.calls[0][0] as string;
    expect(msg).toContain('CRITICAL');
    expect(msg).toContain('ORPHAN POSITIONS');
    expect(msg).toContain('DEAL-A-XYZ');
    expect(msg).toContain('DEAL-B-XYZ');
    expect(msg).toContain('sql.js write failed: disk full');
    expect(msg).toContain('SILVER');
    expect(msg).toContain('Manual reconciliation required');
  });
});
```

- [ ] **Step 3: Run test to verify it passes already** (alertOrphanPositions was added in Step 1)

Run: `npx vitest run tests/orphan-alert.test.ts`
Expected: 1/1 PASS.

- [ ] **Step 4: Wire the alert into the DB_LOG_FAILED_AFTER_PLACEMENT branch**

In `src/agents/trading-agent.ts:1543-1563`, the DB write block currently catches an error and returns the error JSON. Add an `await alertOrphanPositions({...})` call inside the catch BEFORE the return, populated with `placedLegA.dealReference`, `placedLegB.dealReference`, `serverSizing.sizeA`, `serverSizing.sizeB`, `validatedProposal.instrument`, `validatedProposal.direction`, and the caught error message.

Also import `alertOrphanPositions` at the top of `trading-agent.ts` (alongside the existing telegram imports).

- [ ] **Step 5: Run full suite + tsc**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 820/820 pass; tsc clean.

- [ ] **Step 6: Codex parallel review**

Dispatch codex:codex-rescue: verify the alert is awaited (so a Telegram failure doesn't silently swallow the original DB error path), the deal IDs are captured BEFORE the DB-write try block (so they're available in the catch), Markdown escaping is applied to user-supplied strings (instrument is fine, error message must be `mdEsc`'d), and the alert path falls through to the existing error return cleanly.

- [ ] **Step 7: Commit**

```bash
git add src/notifications/telegram.ts src/agents/trading-agent.ts tests/orphan-alert.test.ts
git commit -m "feat(safety): Telegram CRITICAL alert on DB_LOG_FAILED_AFTER_PLACEMENT"
```

---

## Task 5: P3.2 — Stale-comment sweep

**Files:**
- Modify: `src/scanner/index.ts:15` ("20 instruments" → "7 instruments")
- Modify: `src/scheduler/index.ts:5,12-13` (3-leg references → 2-leg)
- Modify: `src/agents/trading-agent.ts:1514` (3-leg comment) — keep historical context but tighten
- Modify: `src/database/index.ts:945-947` already done in Task 2 — verify no stale leftover

- [ ] **Step 1: Read each comment and decide minimal rewrite**

For each line above, read context (5 lines before/after) and apply the minimum change that makes the comment accurate. Do not rephrase prose unnecessarily.

- [ ] **Step 2: Run tsc + full suite to confirm comments compile and didn't accidentally edit code**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 820/820 pass; tsc clean.

- [ ] **Step 3: Codex parallel review**

Dispatch codex:codex-rescue with diff scope: confirm only comments changed (no executable lines), comments accurately describe current behaviour, no new typos.

- [ ] **Step 4: Commit**

```bash
git add src/scanner/index.ts src/scheduler/index.ts src/agents/trading-agent.ts
git commit -m "docs: sweep stale 3-leg / 20-instrument comments (Phase 2 drift)"
```

---

## Task 6: Final verification + push + VPS deploy

- [ ] **Step 1: Re-run full suite + tsc + check git log**

```bash
npx vitest run
npx tsc --noEmit
git log --oneline origin/master..HEAD
```

Expected: 820/820 pass; tsc clean; 5 commits ahead.

- [ ] **Step 2: Push to master**

```bash
git push origin master
```

- [ ] **Step 3: VPS pull + restart**

```bash
ssh bot@162.55.212.198 'cd /home/bot/trading-bot && git pull origin master && npx tsc --noEmit && pm2 restart trading-bot'
```

- [ ] **Step 4: Verify boot clean**

```bash
ssh bot@162.55.212.198 'sleep 10 && pm2 logs trading-bot --lines 50 --nostream --raw | tail -40'
```

Expected: preflight OK, Capital.com OK, scheduler running, no import errors.

---

## Self-review

- **Spec coverage:** P1.1 (Task 1), P1.2 (Task 2), P2.1 (Task 3), P3.1 (Task 4), P3.2 (Task 5), deploy (Task 6). All 5 IN-scope items have tasks.
- **Placeholders:** none — every step has actual code or actual command.
- **Type consistency:** `READ_ONLY_TOOLS` is referenced in both Task 3 implementation and test (same name); `alertOrphanPositions` parameter shape consistent between Task 4 Step 1, Step 2, and Step 4.

## Execution

Subagent-driven (per standing pattern): one fresh implementer per task, codex parallel review per task, mark complete and move on. Tasks 1–5 each commit; Task 6 pushes and deploys.

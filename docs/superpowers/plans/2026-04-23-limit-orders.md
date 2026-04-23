# Limit Orders (P1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert `place_order` MCP tool from market orders to limit orders at the OB midpoint, with a required `entry_price` parameter and 15-minute auto-expiry via Capital.com's `goodTillDate`. Closes the gap between the documented agent intent at `ict-agent.md:212` and the tool's actual behavior.

**Architecture:** The Capital.com client already exposes `createWorkingOrder` hitting `POST /api/v1/workingorders` — spec §3's "new placeLimitOrder method" is semantically this exact call. Use the existing method; extend `CreateWorkingOrderParams` with optional `timeInForce`, `goodTillDate`, `guaranteedStop`, `label`. Update `place_order` tool schema + handler to require `entry_price`, dispatch to `createWorkingOrder` (not `openPosition`), compute `goodTillDate = now + 15 min`. Update the ICT agent prompt. No database changes, no scheduler changes.

**Tech Stack:** TypeScript (strict), Vitest, axios (existing), Zod (existing), Capital.com REST API v1 (existing client). No new runtime dependencies.

---

## Spec reconciliation note

Spec §3 proposed a new `placeLimitOrder` method. In practice, `src/mcp-server/capital-client.ts:435-444` already has `createWorkingOrder(params: CreateWorkingOrderParams): Promise<DealConfirmation>` — same HTTP call, same `pollDealConfirmation` flow. This plan uses the existing method to avoid dead code. The spec's success criteria, behavior, and testing remain identical — only the method name changes.

## File Structure

**Created by this plan:**
- None (no new source files; one uncommitted smoke-test script in Task 4).

**Modified by this plan:**
- `src/types.ts` — extend `CreateWorkingOrderParams` with 4 new optional fields (~8-line diff).
- `src/mcp-server/tools/trading-tools.ts` — `place_order` tool schema + handler change (~20-line diff).
- `prompts/ict-agent.md` — tool description + new LIMIT-ORDER EXECUTION section (~15-line diff).
- `tests/capital-client.test.ts` — 2 new cases for the extended param type.
- `tests/trading-tools.test.ts` — 3 new cases for the new `place_order` contract.

**NOT touched:**
- Scanner, bias detection, scoring, news filter, Analyst, Reflection, Review — none of the decision-path code.
- Database schema, migrations.
- Scheduler cron jobs or monitor loop.
- Backtest engine (already simulates entry as next-candle open, approximating a limit fill).
- `openPosition`, `closePosition`, `partialClosePosition`, `updatePosition`, `updateWorkingOrder`, `deleteWorkingOrder` — all untouched.

**Testing framework:** Vitest. Run `npm test -- --run`. Current passing count: **240** (after today's P4).

---

### Task 1: Extend `CreateWorkingOrderParams` with expiry + label

**Files:**
- Modify: `C:\Users\user\Desktop\Trade Bot\Trade Bot\src\types.ts`
- Test: `C:\Users\user\Desktop\Trade Bot\Trade Bot\tests\capital-client.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/capital-client.test.ts`:

```ts
describe('createWorkingOrder — LIMIT with goodTillDate expiry (P1)', () => {
  it('forwards timeInForce, goodTillDate, guaranteedStop, label fields in request body', async () => {
    const mockAxios = {
      request: vi.fn().mockResolvedValue({ status: 200, data: { dealReference: 'REF-123' } }),
    };
    const client = new CapitalClient({
      apiKey: 'k', identifier: 'i', password: 'p', baseURL: 'https://demo.test',
    });
    // Inject mock for test isolation. Access the private http instance.
    // (Pattern: existing tests in this file do this.)
    (client as unknown as { http: unknown }).http = mockAxios;
    // Bypass session auth for this unit test — spy out the session path.
    vi.spyOn(client as unknown as { ensureSession: () => Promise<void> }, 'ensureSession')
      .mockResolvedValue();
    // Stub pollDealConfirmation to avoid long poll loops in tests.
    vi.spyOn(
      client as unknown as { pollDealConfirmation: (ref: string) => Promise<unknown> },
      'pollDealConfirmation'
    ).mockResolvedValue({
      dealReference: 'REF-123', dealId: 'WORK-ORDER-1', dealStatus: 'ACCEPTED',
      status: 'ACCEPTED', direction: 'BUY', epic: 'EURUSD', size: 1,
    });

    await client.createWorkingOrder({
      direction: 'BUY',
      epic: 'EURUSD',
      size: 1000,
      level: 1.08523,
      type: 'LIMIT',
      stopLevel: 1.08400,
      profitLevel: 1.08800,
      timeInForce: 'GOOD_TILL_DATE',
      goodTillDate: '2026-04-24T18:45:00',
      guaranteedStop: false,
      label: 'ICT-EURUSD-A-1776962007',
    });

    expect(mockAxios.request).toHaveBeenCalledTimes(1);
    const callArg = mockAxios.request.mock.calls[0][0];
    expect(callArg.method).toBe('POST');
    expect(callArg.url).toBe('/api/v1/workingorders');
    expect(callArg.data).toEqual({
      direction: 'BUY',
      epic: 'EURUSD',
      size: 1000,
      level: 1.08523,
      type: 'LIMIT',
      stopLevel: 1.08400,
      profitLevel: 1.08800,
      timeInForce: 'GOOD_TILL_DATE',
      goodTillDate: '2026-04-24T18:45:00',
      guaranteedStop: false,
      label: 'ICT-EURUSD-A-1776962007',
    });
  });

  it('still accepts the legacy minimal param set (backward compatible)', async () => {
    const mockAxios = {
      request: vi.fn().mockResolvedValue({ status: 200, data: { dealReference: 'REF-legacy' } }),
    };
    const client = new CapitalClient({
      apiKey: 'k', identifier: 'i', password: 'p', baseURL: 'https://demo.test',
    });
    (client as unknown as { http: unknown }).http = mockAxios;
    vi.spyOn(client as unknown as { ensureSession: () => Promise<void> }, 'ensureSession')
      .mockResolvedValue();
    vi.spyOn(
      client as unknown as { pollDealConfirmation: (ref: string) => Promise<unknown> },
      'pollDealConfirmation'
    ).mockResolvedValue({ dealReference: 'REF-legacy', dealId: 'WO-2', dealStatus: 'ACCEPTED', status: 'ACCEPTED', direction: 'BUY', epic: 'GBPUSD', size: 1 });

    // No timeInForce / goodTillDate / guaranteedStop / label — all optional.
    await client.createWorkingOrder({
      direction: 'BUY',
      epic: 'GBPUSD',
      size: 500,
      level: 1.27000,
      type: 'LIMIT',
    });
    expect(mockAxios.request).toHaveBeenCalledTimes(1);
    const callArg = mockAxios.request.mock.calls[0][0];
    expect(callArg.data.timeInForce).toBeUndefined();
    expect(callArg.data.goodTillDate).toBeUndefined();
  });
});
```

> **Note on test-harness private-access:** the exact pattern depends on existing patterns in `tests/capital-client.test.ts`. If those tests use a different injection strategy, adapt — but the assertions on request body keys remain verbatim.

- [ ] **Step 2: Run tests to verify failure**

Run: `cd "/c/Users/user/Desktop/Trade Bot/Trade Bot" && npm test -- --run tests/capital-client.test.ts 2>&1 | tail -12`
Expected: FAIL on the new describe block — the extended params fail the TypeScript compile OR fail at runtime because current `CreateWorkingOrderParams` doesn't include the new fields.

- [ ] **Step 3: Extend the type**

Find the `CreateWorkingOrderParams` interface in `src/types.ts` (currently at lines 154-162 based on 2026-04-23 HEAD). Replace with:

```ts
export interface CreateWorkingOrderParams {
  direction: 'BUY' | 'SELL';
  epic: string;
  size: number;
  level: number;
  type: 'LIMIT' | 'STOP';
  stopLevel?: number;
  profitLevel?: number;
  // Added 2026-04-23 (P1 limit orders) — optional fields that let
  // callers express auto-expiry and audit labels. Capital's
  // /api/v1/workingorders endpoint accepts these fields per their
  // published spec; the client forwards them verbatim.
  timeInForce?: 'GOOD_TILL_CANCELLED' | 'GOOD_TILL_DATE';
  goodTillDate?: string;         // ISO-8601 seconds, UTC (e.g. "2026-04-24T18:45:00")
  guaranteedStop?: boolean;
  label?: string;
}
```

No change required in `capital-client.ts` — `createWorkingOrder` already forwards `params` verbatim as the POST body.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd "/c/Users/user/Desktop/Trade Bot/Trade Bot" && npm test -- --run tests/capital-client.test.ts 2>&1 | tail -8`
Expected: the 2 new cases pass. All prior capital-client tests still pass.

- [ ] **Step 5: Run full suite**

Run: `cd "/c/Users/user/Desktop/Trade Bot/Trade Bot" && npm test -- --run 2>&1 | tail -6`
Expected: 242/242 passing (240 + 2 new).

- [ ] **Step 6: Commit**

```bash
cd "/c/Users/user/Desktop/Trade Bot/Trade Bot" && git add src/types.ts tests/capital-client.test.ts && git commit -m "$(cat <<'EOF'
feat(capital): extend CreateWorkingOrderParams with expiry + label (P1 Task 1)

Capital.com's /api/v1/workingorders endpoint accepts timeInForce,
goodTillDate, guaranteedStop, and label in addition to the minimal
set currently typed. Extending the interface lets callers express
15-minute auto-expiry on LIMIT orders (via GOOD_TILL_DATE) — the
mechanism P1's place_order tool needs for the slippage-elimination
strategy.

No change in createWorkingOrder implementation — it forwards params
verbatim as the POST body. All prior params remain optional/identical.

2 new tests in tests/capital-client.test.ts verify the extended fields
land in the request body and that the legacy minimal param set still
works (backward compat).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Expected: 1 commit, 2 files changed.

---

### Task 2: `place_order` becomes limit-only via `createWorkingOrder`

**Files:**
- Modify: `C:\Users\user\Desktop\Trade Bot\Trade Bot\src\mcp-server\tools\trading-tools.ts`
- Test: `C:\Users\user\Desktop\Trade Bot\Trade Bot\tests\trading-tools.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `tests/trading-tools.test.ts`:

```ts
// ==================== P1 — place_order as LIMIT ====================

describe('place_order tool (P1 — limit-only)', () => {
  it('requires entry_price at the Zod schema level', () => {
    // Import the tool's inputSchema exported for testing. If not already
    // exported, add it in this task's Step 3.
    // The assertion is that a payload without entry_price fails Zod parsing.
    // Using ZodError from the schema directly keeps this test a pure
    // unit test with no MCP-server bootstrapping.
    const { _placeOrderInputSchema } = require('../src/mcp-server/tools/trading-tools.js');
    const withoutEntryPrice = {
      epic: 'EURUSD',
      direction: 'long',
      size: 1000,
      sl: 1.08400,
      tp: 1.08800,
      label: 'ICT-EURUSD-A-123',
    };
    const result = _placeOrderInputSchema.safeParse(withoutEntryPrice);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i: { path: string[] }) => i.path.includes('entry_price'))).toBe(true);
    }
  });

  it('accepts the full schema with a valid entry_price', () => {
    const { _placeOrderInputSchema } = require('../src/mcp-server/tools/trading-tools.js');
    const full = {
      epic: 'EURUSD',
      direction: 'long' as const,
      size: 1000,
      entry_price: 1.08523,
      sl: 1.08400,
      tp: 1.08800,
      label: 'ICT-EURUSD-A-123',
    };
    const result = _placeOrderInputSchema.safeParse(full);
    expect(result.success).toBe(true);
  });

  it('handler dispatches to createWorkingOrder with the right shape', async () => {
    // Mock a CapitalClient via _placeOrderHandler exported for testing.
    const mockClient = {
      createWorkingOrder: vi.fn().mockResolvedValue({
        dealReference: 'REF-P1',
        dealId: 'WO-P1',
        dealStatus: 'ACCEPTED',
        status: 'ACCEPTED',
        direction: 'BUY',
        epic: 'EURUSD',
        size: 1000,
      }),
    };
    const { _placeOrderHandler } = require('../src/mcp-server/tools/trading-tools.js');
    const t0 = Date.now();
    const response = await _placeOrderHandler(mockClient, {
      epic: 'EURUSD',
      direction: 'long',
      size: 1000,
      entry_price: 1.08523,
      sl: 1.08400,
      tp: 1.08800,
      label: 'ICT-EURUSD-A-123',
    });

    // Assert the client was called with a proper CreateWorkingOrderParams.
    expect(mockClient.createWorkingOrder).toHaveBeenCalledTimes(1);
    const callParams = mockClient.createWorkingOrder.mock.calls[0][0];
    expect(callParams.direction).toBe('BUY');
    expect(callParams.epic).toBe('EURUSD');
    expect(callParams.size).toBe(1000);
    expect(callParams.level).toBe(1.08523);
    expect(callParams.type).toBe('LIMIT');
    expect(callParams.timeInForce).toBe('GOOD_TILL_DATE');
    expect(callParams.stopLevel).toBe(1.08400);
    expect(callParams.profitLevel).toBe(1.08800);
    expect(callParams.guaranteedStop).toBe(false);
    expect(callParams.label).toBe('ICT-EURUSD-A-123');

    // Assert goodTillDate is ~15 min from now (±10 sec tolerance).
    const gtdMs = new Date(callParams.goodTillDate + 'Z').getTime();
    const expectedMs = t0 + 15 * 60 * 1000;
    expect(Math.abs(gtdMs - expectedMs)).toBeLessThan(10_000);

    // Assert response JSON shape.
    const body = JSON.parse(response.content[0].text);
    expect(body.orderType).toBe('LIMIT');
    expect(body.entry_price).toBe(1.08523);
    expect(body.expires_at).toBe(callParams.goodTillDate);
    expect(body.workingOrderId).toBe('WO-P1');
    expect(body.dealReference).toBe('REF-P1');
    expect(body.note).toContain('auto-cancel');
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `cd "/c/Users/user/Desktop/Trade Bot/Trade Bot" && npm test -- --run tests/trading-tools.test.ts 2>&1 | tail -12`
Expected: FAIL on the three new cases (`_placeOrderInputSchema` + `_placeOrderHandler` not yet exported).

- [ ] **Step 3: Update `trading-tools.ts`**

Find the `place_order` tool registration in `src/mcp-server/tools/trading-tools.ts` (currently at lines 24-72 based on today's HEAD). Replace the input schema block:

```ts
// BEFORE (approximate — real file has z.string().describe(...) chains)
inputSchema: {
  epic: z.string().describe('Capital.com epic (e.g. GOLD, US100, EURUSD)'),
  direction: z.enum(['long', 'short']).describe('Trade direction'),
  size: z.number().positive().describe('Position size in units'),
  sl: z.number().describe('Stop loss price (sent to Capital.com as stopLevel)'),
  tp: z.number().describe('Take profit price (sent to Capital.com as profitLevel)'),
  label: z.string().describe('Position label e.g. XAUUSD-A-1713300000 (local audit only)'),
},
```

```ts
// AFTER — entry_price REQUIRED; description updated
inputSchema: {
  epic: z.string().describe('Capital.com epic (e.g. GOLD, EURUSD)'),
  direction: z.enum(['long', 'short']).describe('Trade direction'),
  size: z.number().positive().describe('Position size in units'),
  entry_price: z.number().positive().describe(
    'Limit price — typically the OB/FVG zone midpoint. REQUIRED. ' +
    'The order auto-cancels via goodTillDate if not filled within 15 min.'
  ),
  sl: z.number().describe('Stop loss price (stopLevel on the working order)'),
  tp: z.number().describe('Take profit price (profitLevel on the working order)'),
  label: z.string().describe('Position label (local audit only)'),
},
```

Replace the handler body (the `wrapTool('place_order', async ({ epic, direction, size, sl, tp, label }) => { ... })`) with:

```ts
wrapTool('place_order', async ({ epic, direction, size, entry_price, sl, tp, label }) => {
  const capitalDirection = direction === 'long' ? 'BUY' : 'SELL';
  // 15-minute auto-expiry. ISO-8601 seconds (no ms) matches Capital's
  // expected goodTillDate format. The timestamp is in UTC but the field
  // does NOT carry a Z suffix (Capital docs specify local-datetime shape).
  const goodTillDate = new Date(Date.now() + 15 * 60 * 1000)
    .toISOString()
    .slice(0, 19);

  const confirmation = await capital.createWorkingOrder({
    direction: capitalDirection,
    epic,
    size,
    level: entry_price,
    type: 'LIMIT',
    stopLevel: sl,
    profitLevel: tp,
    timeInForce: 'GOOD_TILL_DATE',
    goodTillDate,
    guaranteedStop: false,
    label,
  });

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        workingOrderId: confirmation.dealId ?? null,
        dealReference: confirmation.dealReference,
        dealStatus: confirmation.dealStatus,
        status: confirmation.status,
        orderType: 'LIMIT',
        entry_price,
        expires_at: goodTillDate,
        note: 'Limit order placed. Will auto-cancel if not filled by expires_at.',
      }),
    }],
  };
})
```

Export the schema object + a pure handler (to make the unit tests possible) at the bottom of the `registerTradingTools` function or at module scope:

```ts
// ==================== TEST-ONLY EXPORTS ====================
// Exported for tests/trading-tools.test.ts. Not used at runtime.

export const _placeOrderInputSchema = z.object({
  epic: z.string(),
  direction: z.enum(['long', 'short']),
  size: z.number().positive(),
  entry_price: z.number().positive(),
  sl: z.number(),
  tp: z.number(),
  label: z.string(),
});

export async function _placeOrderHandler(
  capital: { createWorkingOrder: (p: Parameters<CapitalClient['createWorkingOrder']>[0]) => Promise<{ dealReference: string; dealId?: string; dealStatus: string; status: string }> },
  input: { epic: string; direction: 'long' | 'short'; size: number; entry_price: number; sl: number; tp: number; label: string },
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const capitalDirection = input.direction === 'long' ? 'BUY' : 'SELL';
  const goodTillDate = new Date(Date.now() + 15 * 60 * 1000)
    .toISOString()
    .slice(0, 19);
  const confirmation = await capital.createWorkingOrder({
    direction: capitalDirection,
    epic: input.epic,
    size: input.size,
    level: input.entry_price,
    type: 'LIMIT',
    stopLevel: input.sl,
    profitLevel: input.tp,
    timeInForce: 'GOOD_TILL_DATE',
    goodTillDate,
    guaranteedStop: false,
    label: input.label,
  });
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        workingOrderId: confirmation.dealId ?? null,
        dealReference: confirmation.dealReference,
        dealStatus: confirmation.dealStatus,
        status: confirmation.status,
        orderType: 'LIMIT',
        entry_price: input.entry_price,
        expires_at: goodTillDate,
        note: 'Limit order placed. Will auto-cancel if not filled by expires_at.',
      }),
    }],
  };
}
```

The in-tool handler should call `_placeOrderHandler(capital, args)` so the real code path and the tested code path are identical.

- [ ] **Step 4: Run tests to verify pass**

Run: `cd "/c/Users/user/Desktop/Trade Bot/Trade Bot" && npm test -- --run tests/trading-tools.test.ts 2>&1 | tail -10`
Expected: the 3 new `place_order` cases pass. The existing `normaliseTradePayload` cases still pass.

- [ ] **Step 5: Build check**

Run: `cd "/c/Users/user/Desktop/Trade Bot/Trade Bot" && npm run build 2>&1 | tail -5`
Expected: no TypeScript errors.

- [ ] **Step 6: Full suite**

Run: `cd "/c/Users/user/Desktop/Trade Bot/Trade Bot" && npm test -- --run 2>&1 | tail -6`
Expected: 245/245 passing (240 + 2 from Task 1 + 3 from Task 2).

- [ ] **Step 7: Commit**

```bash
cd "/c/Users/user/Desktop/Trade Bot/Trade Bot" && git add src/mcp-server/tools/trading-tools.ts tests/trading-tools.test.ts && git commit -m "$(cat <<'EOF'
feat(place_order): limit-only with required entry_price + 15-min expiry (P1 Task 2)

Breaking change: the place_order MCP tool now requires entry_price and
dispatches to capital.createWorkingOrder (type=LIMIT, timeInForce=
GOOD_TILL_DATE, goodTillDate=now+15min). Market orders via place_order
are no longer possible — any call without entry_price fails Zod
validation and the trade is silently missed (matching Option A's
semantics: the limit fills at the planned price or the trade is
skipped).

This closes the gap between ict-agent.md:212 ("Entry: ... or limit at
OB/FVG midpoint") and the tool's historical market-order behavior.
Slippage-elimination is now code-enforced, not prompt-dependent.

openPosition in the Capital client is retained (unused by place_order
now, still available for internal callers). close_position,
partial_close, update_sl, set_trailing_stop are unchanged — those
are correctly market/modify operations.

3 new unit tests: Zod required-ness, full schema acceptance, handler
dispatches to createWorkingOrder with correct shape including the
computed goodTillDate. Full suite 245/245.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Update the ICT agent prompt

**Files:**
- Modify: `C:\Users\user\Desktop\Trade Bot\Trade Bot\prompts\ict-agent.md`

- [ ] **Step 1: Update the place_order tool description**

Find line 12 in `prompts/ict-agent.md`:

```
- place_order(instrument, direction, size, sl, tp, label) — execute a single order leg (see MULTI-TP EXECUTION section below)
```

Replace with:

```
- place_order(instrument, direction, size, entry_price, sl, tp, label) — place a LIMIT order leg at entry_price (typically the OB/FVG midpoint). Auto-cancels after 15 minutes if not filled. REQUIRES entry_price. See LIMIT-ORDER EXECUTION section below.
```

- [ ] **Step 2: Add the LIMIT-ORDER EXECUTION section**

Find the `## CRITICAL: HOW TO EXECUTE MULTIPLE TAKE PROFITS ON TRADING 212` header (around line 25 as of HEAD). INSERT this new section AFTER that section's body (before the next major header):

```markdown

## LIMIT-ORDER EXECUTION (added 2026-04-23)

Every `place_order` call is a **LIMIT order** with a **15-minute `goodTillDate` expiry**. You MUST pass `entry_price` — the zone midpoint at which you want to be filled. Typical candidates:

- **OB (order block) midpoint** — the 50% level inside the order block
- **FVG (fair value gap) midpoint** — the 50% fill level
- **Liquidity-sweep retest level** — the swept high/low you expect price to tap before reversing

If price does not reach `entry_price` within 15 minutes, Capital auto-cancels both split legs (Position A and Position B). You do NOT need to call `cancel_working_order` — this is handled by the broker via `goodTillDate`.

On the next 15M candle close, reconsider whether the setup is still valid. If so, propose a new `place_order` with the updated `entry_price`. If price has moved significantly past your planned entry, the setup is likely stale — skip it.

**Why this matters:** on 2026-04-22 a USDJPY market-order entry slipped 14.6 pips, gutting R:R from 1.7:1 to 0.5:1 and forcing an immediate close. The full 2019-2025 backtest audit (see `docs/superpowers/reviews/2026-04-23-backtest-vs-live-diagnostic.md` Appendix D) found market-order slippage was the single biggest frictional drag on the strategy — ~2175 R across 14,918 trades. Limit orders at a planned entry eliminate this drag; fewer fills but every fill respects the planned R:R.

**NEVER propose `place_order` without `entry_price`.** The tool will reject the call with a Zod validation error and the trade will be missed.
```

- [ ] **Step 3: Verify prompt still loads**

Prompts are loaded at runtime via `loadPrompt('ict-agent.md')`. No compile-time validation — but a quick sanity check that the file is still valid markdown:

Run: `cd "/c/Users/user/Desktop/Trade Bot/Trade Bot" && wc -l prompts/ict-agent.md`
Expected: line count ~20 lines higher than previous.

- [ ] **Step 4: Commit**

```bash
cd "/c/Users/user/Desktop/Trade Bot/Trade Bot" && git add prompts/ict-agent.md && git commit -m "$(cat <<'EOF'
feat(prompt): ict-agent — require entry_price + document LIMIT execution (P1 Task 3)

Updates the place_order tool description to reflect the Task 2 schema
change (entry_price required) and adds a new LIMIT-ORDER EXECUTION
section explaining the 15-minute goodTillDate auto-cancel behavior,
why it matters (the 2026-04-22 14.6-pip USDJPY slippage + backtest's
2175 R cumulative drag), and what to do when the limit doesn't fill
(nothing — Capital handles expiry).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Smoke test + deploy

**Files:**
- Create (uncommitted): `scripts/smoke-limit-order.ts`
- No repo changes after smoke test — script is deleted before `git push`.

- [ ] **Step 1: Push Tasks 1-3 to origin**

Run: `cd "/c/Users/user/Desktop/Trade Bot/Trade Bot" && git push origin master 2>&1 | tail -5`
Expected: `master -> master` with the bypass warning.

- [ ] **Step 2: Pull on VPS + build**

Run:
```bash
ssh -o ConnectTimeout=15 bot@162.55.212.198 "cd /home/bot/trading-bot && git pull --ff-only 2>&1 | tail -8 && npm run build 2>&1 | tail -3"
```
Expected: fast-forward pull; TypeScript build clean.

**DO NOT pm2 restart yet. Smoke test gates the restart.**

- [ ] **Step 3: Create the smoke-test script on the VPS (not committed)**

Run:
```bash
ssh -o ConnectTimeout=15 bot@162.55.212.198 "cat > /home/bot/trading-bot/scripts/smoke-limit-order.ts <<'TS_EOF'
// P1 smoke test — places a 1-unit EURUSD limit well below market and
// verifies it appears as a working order + auto-cancels via goodTillDate.
// NOT committed to the repo.
import { config } from 'dotenv';
import { CapitalClient } from '../src/mcp-server/capital-client.js';

config();

async function main() {
  const client = new CapitalClient({
    apiKey:     process.env.CAPITAL_API_KEY            ?? '',
    identifier: process.env.CAPITAL_IDENTIFIER         ?? '',
    password:   process.env.CAPITAL_API_KEY_PASSWORD   ?? '',
    baseURL:    process.env.CAPITAL_API_URL            ?? 'https://demo-api-capital.backend-capital.com',
  });

  // 5-minute expiry so we can verify auto-cancel without waiting 15 min.
  const goodTillDate = new Date(Date.now() + 5 * 60 * 1000).toISOString().slice(0, 19);
  // Price well below current EURUSD market — will not fill.
  const unfillable = 0.90000;

  console.log('[smoke] Placing EURUSD BUY limit @', unfillable, 'expires', goodTillDate);
  const result = await client.createWorkingOrder({
    direction: 'BUY',
    epic: 'EURUSD',
    size: 1,
    level: unfillable,
    type: 'LIMIT',
    stopLevel: 0.89500,
    profitLevel: 0.90500,
    timeInForce: 'GOOD_TILL_DATE',
    goodTillDate,
    guaranteedStop: false,
    label: 'P1-SMOKE-' + Date.now(),
  });

  console.log('[smoke] Working order created:');
  console.log('  dealReference:', result.dealReference);
  console.log('  dealId (workingOrderId):', result.dealId);
  console.log('  dealStatus:', result.dealStatus);
  console.log('  status:', result.status);

  const orders = await client.getWorkingOrders();
  const ours = orders.find((o) => o.workingOrderData.dealId === result.dealId);
  if (ours) {
    console.log('[smoke] PASS — order visible in working orders list');
    console.log('  orderType:', ours.workingOrderData.orderType);
    console.log('  orderLevel:', ours.workingOrderData.orderLevel);
    console.log('  timeInForce:', ours.workingOrderData.timeInForce);
  } else {
    console.error('[smoke] FAIL — order not found in working orders list');
    process.exit(1);
  }

  console.log('[smoke] Wait 5+ minutes, then query again to verify auto-cancel.');
  console.log('[smoke] Or call client.deleteWorkingOrder(\"' + result.dealId + '\") manually.');
}

main().catch((err) => {
  console.error('[smoke] ERROR:', err.message);
  process.exit(1);
});
TS_EOF
echo 'Script written.'"
```

- [ ] **Step 4: Run the smoke test**

Run:
```bash
ssh -o ConnectTimeout=30 bot@162.55.212.198 "cd /home/bot/trading-bot && npx tsx scripts/smoke-limit-order.ts 2>&1 | tail -20"
```

Expected: something like:
```
[smoke] Placing EURUSD BUY limit @ 0.9 expires 2026-04-23T19:XX:00
[smoke] Working order created:
  dealReference: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
  dealId (workingOrderId): 000XXXXX-YYYY-ZZZZ-0000-000000000001
  dealStatus: ACCEPTED
  status: ACCEPTED
[smoke] PASS — order visible in working orders list
  orderType: LIMIT
  orderLevel: 0.9
  timeInForce: GOOD_TILL_DATE
```

If the output shows `PASS`, the Capital client + createWorkingOrder flow + new params all work end-to-end against the real demo broker.

If `FAIL` or any error: STOP. Do not pm2 restart. Go to rollback (Task 4 Step 8).

- [ ] **Step 5: Wait 5+ minutes, verify auto-cancel**

Run after ≥5 minutes:
```bash
ssh -o ConnectTimeout=15 bot@162.55.212.198 "cd /home/bot/trading-bot && npx tsx -e 'import { CapitalClient } from \"./src/mcp-server/capital-client.js\"; import { config } from \"dotenv\"; config(); const c = new CapitalClient({apiKey:process.env.CAPITAL_API_KEY||\"\",identifier:process.env.CAPITAL_IDENTIFIER||\"\",password:process.env.CAPITAL_API_KEY_PASSWORD||\"\",baseURL:process.env.CAPITAL_API_URL||\"https://demo-api-capital.backend-capital.com\"}); c.getWorkingOrders().then(os => { const p1 = os.filter(o => o.workingOrderData.dealId.startsWith(\"000\")); console.log(\"P1-SMOKE orders still live:\", p1.length); p1.forEach(o => console.log(\"  \", o.workingOrderData.dealId, o.workingOrderData.orderLevel)); });'"
```

Expected: `P1-SMOKE orders still live: 0` — Capital has auto-cancelled.

If the order is still present past its goodTillDate: Capital's expiry mechanism may behave differently on demo. Manually delete it:
```bash
ssh bot@162.55.212.198 "cd /home/bot/trading-bot && npx tsx -e 'import { CapitalClient } from \"./src/mcp-server/capital-client.js\"; import { config } from \"dotenv\"; config(); const c = new CapitalClient({apiKey:process.env.CAPITAL_API_KEY||\"\",identifier:process.env.CAPITAL_IDENTIFIER||\"\",password:process.env.CAPITAL_API_KEY_PASSWORD||\"\",baseURL:process.env.CAPITAL_API_URL||\"https://demo-api-capital.backend-capital.com\"}); c.deleteWorkingOrder(\"<DEAL_ID>\").then(() => console.log(\"deleted\"));'"
```
...and proceed with caution — note the expiry-behavior caveat in the final verdict.

- [ ] **Step 6: Delete the smoke script from the VPS**

Run: `ssh -o ConnectTimeout=10 bot@162.55.212.198 "rm /home/bot/trading-bot/scripts/smoke-limit-order.ts && ls /home/bot/trading-bot/scripts/"`
Expected: `dump-reject-metrics.ts  run-backtest.ts` (only these two — no smoke script).

- [ ] **Step 7: pm2 restart**

Run: `ssh -o ConnectTimeout=15 bot@162.55.212.198 "pm2 restart trading-bot 2>&1 | tail -3"`
Expected: pm2 restart count increments, bot online.

Verify scheduler + preflight clean:
```bash
ssh -o ConnectTimeout=10 bot@162.55.212.198 "pm2 logs trading-bot --lines 30 --nostream 2>&1 | grep -E 'Scheduler started|Preflight|OK' | tail -10"
```

- [ ] **Step 8: Rollback plan (only if smoke test failed)**

If Step 4 or Step 7 failed:
```bash
cd "/c/Users/user/Desktop/Trade Bot/Trade Bot" && git revert <task-3-sha> <task-2-sha> <task-1-sha> --no-edit && git push origin master
ssh bot@162.55.212.198 "cd /home/bot/trading-bot && git pull --ff-only && npm run build && pm2 restart trading-bot"
```

No DB changes to reverse. Any outstanding P1-SMOKE working orders expire within 5 minutes or can be deleted manually via the Step 5 command.

---

### Task 5: Monitor first real ICT cycle

**Files:**
- No files. Observation only.

- [ ] **Step 1: Identify next kill zone**

Current UTC time vs:
- London Open: 07:00–10:00 UTC
- NY Open:     13:00–16:00 UTC
- London Close: 15:00–17:00 UTC

If next kill zone is >1 hour away, defer Task 5 verification — the first real cycle won't trigger until then. Document the deploy time and pick this up in the next kill zone.

- [ ] **Step 2: Tail the log during the next kill zone**

Run: `ssh -o ConnectTimeout=10 bot@162.55.212.198 "tail -F /home/bot/trading-bot/data/pm2-out.log"`
Leave this running.

Look for the pattern:
```
[ICT Agent] Calling tool: place_order
```
followed by a response like:
```
"orderType":"LIMIT","entry_price":<number>,"expires_at":"<ISO-seconds>","workingOrderId":"<uuid-ish>"
```

- [ ] **Step 3: Verify fill or expiry behavior**

If the limit fills (price reaches `entry_price` within 15 min):
- Watch for the subsequent `Calling tool: log_trade` with the actual fill price
- Verify the DB row is inserted (previous `closed_early` + `closure_reason` migration makes this robust)

If the limit doesn't fill:
- 15 min later the order should disappear from Capital's working orders
- No `log_trade` call — correct behavior (Option A: miss the trade)
- Next /5 cron tick proceeds normally

- [ ] **Step 4: Report verdict**

Summarize to Giuseppe:
- Did a cycle execute a place_order with `orderType: LIMIT`?
- Did the limit fill or expire?
- If filled: actual fill price vs requested `entry_price` (should be near-identical vs market-order's multi-pip slippage)
- If expired: how many min past goodTillDate did it take for the order to disappear?

No commit for Task 5 — verification only.

---

## Self-Review

Spec coverage check against `docs/superpowers/specs/2026-04-23-limit-orders-design.md`:

- Spec §1 Problem statement — **Task 2 Step 7** commit message restates context; **Task 3 Step 2** prompt section cites the 14.6-pip observation + the 2175 R backtest cost. ✓
- Spec §2 Architecture — **Tasks 1-3** touch exactly the files §2 lists; the spec's "new placeLimitOrder method" is reconciled to the existing `createWorkingOrder`. ✓
- Spec §3 Module API — **Task 1 Step 3** extends `CreateWorkingOrderParams`; **Task 2 Step 3** updates `place_order` schema + handler with the exact shape §3 shows. ✓
- Spec §3 Capital.com request shape — **Task 1 Step 1** asserts the exact POST body keys + values. ✓
- Spec §3 Prompt updates — **Task 3** implements the exact text §3 shows. ✓
- Spec §4 Unit tests — **Task 1 Step 1** + **Task 2 Step 1** implement both test suites (2 + 3 cases). ✓
- Spec §4 Regression (240 tests pass) — **Task 1 Step 5** + **Task 2 Step 6** assert full-suite counts. ✓
- Spec §4 Manual smoke test — **Task 4 Steps 3-5**, gated before pm2 restart. ✓
- Spec §5 Success criteria — each of the 8 criteria maps to a specific Task step (1→Task 2 Step 5, 2→Task 2 Step 6, 3→Task 2 Step 6, 4→Task 4 Steps 4-5, 5→Task 4 Step 7, 6→Task 5 Step 2, 7+8→Task 5 Step 3). ✓
- Spec §6 Rollback plan — **Task 4 Step 8** implements the exact revert flow. ✓
- Spec §7 Out of scope — plan does not touch any file §7 excludes (scanner, scoring, news, Analyst, scheduler, DB, backtest). ✓
- Spec §8 Demo-safety — smoke-test-gates-restart pattern preserves this. ✓
- Spec §9 Timeline — plan fits the ~2.5 hour estimate (Task 1 ~30 min, Task 2 ~45 min, Task 3 ~15 min, Task 4 ~30 min, Task 5 observe-only). ✓

Placeholder scan: no "TBD", "TODO", or vague-error phrases. Every code step shows actual code. Every command shows expected output.

Type consistency: `CreateWorkingOrderParams` fields (timeInForce / goodTillDate / guaranteedStop / label) used consistently across Tasks 1, 2. `_placeOrderInputSchema` / `_placeOrderHandler` / `entry_price` / `goodTillDate` naming consistent across Task 2 tests + implementation.

---

## Execution notes

- **No worktree:** continuing on master, consistent with today's pattern. This IS a live-behavioral change so the smoke test gate is the critical safety mechanism, not worktree isolation.
- **Atomic commits:** Tasks 1, 2, 3 each produce one commit (3 total). Task 4 deploy + smoke test produces no commit (script not committed). Task 5 is verification only.
- **Stop conditions:** if Task 4 Step 4 smoke test fails, execute Task 4 Step 8 rollback immediately. Do not attempt to debug in-place against live demo state.
- **Single pm2 restart at Task 4 Step 7** — the only live-service event in P1.
- **Observation window (Task 5):** may require hours. Next scheduled kill zone from deploy time dictates when a real ICT cycle is possible.

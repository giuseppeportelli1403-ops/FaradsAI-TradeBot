# Limit Orders at OB Midpoint (P1) — Design Spec

**Date:** 2026-04-23
**Author:** Giuseppe Portelli + Claude Code (Opus 4.7)
**Status:** approved by Giuseppe through brainstorming §1+§2+§3 (pending spec review)
**Context:** follow-up to the 2026-04-23 backtest-vs-live diagnostic
([docs/superpowers/reviews/2026-04-23-backtest-vs-live-diagnostic.md](../reviews/2026-04-23-backtest-vs-live-diagnostic.md))
and Agent γ's realism math ([docs/superpowers/specs/2026-04-23-backtest-realism-design.md](2026-04-23-backtest-realism-design.md))
**Priority:** P1 — biggest leverage of the 4 recommendations AND biggest
live-behavioral-change risk. Handled with extra care.

---

## 1. Problem statement

The 2026-04-22 USDJPY trade showed **14.6 pips of market-order entry
slippage**, gutting R:R from 1.7:1 to 0.5:1. Agent γ's subsequent realism
audit of the 2019-2025 backtest quantified: market-order slippage costs
**~2175 R** over 14,918 trades — the single biggest frictional drag on
strategy PnL. Agent β's post-patch verification on 37,336 fresh candles
confirmed: gross +0.10 R/trade edge → net −0.27 R/trade once market-order
slippage is priced in. Three instruments (USDJPY, SILVER, OIL_CRUDE)
have per-trade R-costs of 0.4–0.9 R — bigger than the gross edge itself.

The `ict-agent.md` prompt at line 212 already **documents the intent**:
*"Entry: current 15M candle close (or limit at OB/FVG midpoint if price
has moved)"*. But the `place_order` MCP tool has no `entry_price`
parameter and has always sent market orders. The agent's limit-order
intent has been silently ignored.

**Goal:** make `place_order` a limit-only tool, require `entry_price`
from the agent, auto-expire unfilled orders after 15 minutes via
Capital.com's `goodTillDate` mechanism. This closes the gap between
documented intent and actual execution.

**Non-goal (out of scope):** fallback to market if the limit doesn't
fill (defeats the whole premise — see Agent γ's math). If a limit
doesn't fill, the trade is missed and the agent reconsiders on the
next 15M candle close.

## 2. Architecture

```
src/mcp-server/tools/trading-tools.ts   (MODIFIED)
  │  place_order signature BREAKING-CHANGES:
  │    adds REQUIRED entry_price: number (the OB midpoint)
  │  Dispatches to capital.placeLimitOrder() (new) instead of
  │  capital.openPosition() (legacy, retained)
  │
src/mcp-server/capital-client.ts        (MODIFIED)
  │  New method placeLimitOrder hits POST /api/v1/workingOrders
  │  with type=LIMIT, timeInForce=GOOD_TILL_DATE, goodTillDate=now+15m
  │  Returns workingOrderId (via affectedDeals), not a dealId
  │  openPosition() retained (unused by place_order now, but kept for
  │  potential emergency/manual flows)
  │
prompts/ict-agent.md                    (MODIFIED, ~5 line diff)
  │  place_order description updated to require entry_price
  │  Added: "If the limit does not fill within 15 min, Capital
  │  auto-cancels via goodTillDate. No cleanup action required.
  │  The trade is missed — reconsider on the next 15M candle close."
  │
tests/capital-client.test.ts            (MODIFIED)
  │  Add ~4 cases for placeLimitOrder
  │
tests/trading-tools.test.ts             (MODIFIED)
  │  Add ~3 cases for the new place_order contract (Zod validation
  │  + dispatch to placeLimitOrder + response shape)
```

**Not touched:**
- ICT scanner / Analyst / news filter / scoring logic
- `close_position`, `partial_close`, `update_sl`, `set_trailing_stop` (remain market-style)
- Database schema
- Scheduler monitor loop (watches `sl_tp_orders` for TP/SL events — unchanged)
- `src/backtest/engine.ts` (already simulates "entry at next candle open", which approximates a limit fill)

## 3. Module API

### New Capital-client method

```ts
interface PlaceLimitOrderParams {
  epic: string;
  direction: 'BUY' | 'SELL';
  size: number;
  level: number;               // limit price (the OB midpoint)
  stopLevel?: number;
  profitLevel?: number;
  goodTillDate?: string;       // ISO-8601 seconds, UTC. Default: now + 15 min.
  label?: string;
}

interface PlaceLimitOrderResult {
  dealReference: string;
  dealStatus: string;
  status: string;              // 'ACCEPTED' | 'REJECTED'
  workingOrderId?: string;     // from affectedDeals[0] when present
}

async placeLimitOrder(params: PlaceLimitOrderParams): Promise<PlaceLimitOrderResult>
```

### Capital.com request shape

```
POST /api/v1/workingOrders
Content-Type: application/json
CST: <session>
X-SECURITY-TOKEN: <token>

{
  "direction":      "BUY",
  "epic":           "EURUSD",
  "size":           1700,
  "level":          1.08523,
  "type":           "LIMIT",
  "timeInForce":    "GOOD_TILL_DATE",
  "goodTillDate":   "2026-04-24T18:45:00",
  "stopLevel":      1.08400,
  "profitLevel":    1.08800,
  "guaranteedStop": false,
  "label":          "ICT-EURUSD-A-1776962007"
}
```

The Capital API returns a `dealReference`; we call the existing
`pollDealConfirmation` helper which, on success, returns the
`workingOrderId` from `affectedDeals[0].dealId`.

### MCP tool signature change

```ts
// trading-tools.ts place_order schema — BEFORE
{
  epic: z.string(),
  direction: z.enum(['long', 'short']),
  size: z.number().positive(),
  sl: z.number(),
  tp: z.number(),
  label: z.string(),
}

// AFTER — entry_price REQUIRED (breaking change)
{
  epic: z.string(),
  direction: z.enum(['long', 'short']),
  size: z.number().positive(),
  entry_price: z.number().positive()
    .describe('Limit price — typically the OB/FVG zone midpoint. Required.'),
  sl: z.number(),
  tp: z.number(),
  label: z.string(),
}
```

Handler body:

```ts
wrapTool('place_order', async ({ epic, direction, size, entry_price, sl, tp, label }) => {
  const capitalDirection = direction === 'long' ? 'BUY' : 'SELL';
  // 15-min expiry from invocation time. ISO seconds (no ms) matches
  // Capital's expected goodTillDate format.
  const goodTillDate = new Date(Date.now() + 15 * 60 * 1000).toISOString().slice(0, 19);

  const confirmation = await capital.placeLimitOrder({
    direction: capitalDirection,
    epic,
    size,
    level: entry_price,
    stopLevel: sl,
    profitLevel: tp,
    goodTillDate,
    label,
  });

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        workingOrderId: confirmation.workingOrderId ?? null,
        dealReference: confirmation.dealReference,
        dealStatus: confirmation.dealStatus,
        orderType: 'LIMIT',
        entry_price,
        expires_at: goodTillDate,
        note: 'Limit order placed. Will auto-cancel if not filled by expires_at.',
      }),
    }],
  };
})
```

### Prompt updates (ict-agent.md)

Current tool line (line 12):

```
- place_order(instrument, direction, size, sl, tp, label) — execute a single order leg
```

→

```
- place_order(instrument, direction, size, entry_price, sl, tp, label) — place a LIMIT order leg at entry_price (typically the OB/FVG midpoint). Auto-cancels after 15 minutes if not filled. See LIMIT-ORDER EXECUTION section.
```

New section added near the MULTI-TP EXECUTION section:

```
## LIMIT-ORDER EXECUTION (added 2026-04-23)

Every place_order is a LIMIT order with a 15-minute goodTillDate expiry.
You MUST pass entry_price — the zone midpoint at which you want to be
filled. Typical candidates:

- OB (order block) midpoint
- FVG (fair value gap) midpoint
- Liquidity-sweep retest level

If price does not reach entry_price within 15 minutes, Capital
auto-cancels both legs (Position A and Position B). You do NOT need to
call cancel_working_order — this is handled by the broker via
goodTillDate.

On the next 15M candle close, reconsider whether the setup is still
valid. If so, propose a new place_order with the updated entry_price.
If price has moved significantly, the setup is likely stale — skip it.

NEVER propose place_order without entry_price. The tool will reject
the call and the trade will be missed.
```

## 4. Testing

### Unit tests

**`tests/capital-client.test.ts` — new cases:**

1. `placeLimitOrder` hits POST /api/v1/workingOrders with the correct body keys + values
2. Default `goodTillDate` ≈ now + 15 min (±5 sec tolerance)
3. Caller-supplied `goodTillDate` overrides the default
4. HTTP 400 / Capital rejection surfaces a clear error with the Capital message

**`tests/trading-tools.test.ts` — new cases:**

1. Calling `place_order` with a valid `entry_price` dispatches to `placeLimitOrder` (mock client)
2. Omitting `entry_price` throws a Zod validation error (proves the required contract)
3. Response JSON includes `orderType: 'LIMIT'`, a non-null `expires_at`, and either `workingOrderId` or null

### Regression

All 240 existing tests must still pass after the signature change.

### Manual smoke test (pre-restart gate)

Before restarting pm2 on the VPS, run a one-off script that exercises
the full round-trip against the Capital demo:

```bash
ssh bot@162.55.212.198 "cd /home/bot/trading-bot && npx tsx scripts/smoke-limit-order.ts"
```

The smoke script (not committed — ≤40 lines, deleted after run):

1. Loads `.env`, constructs `CapitalClient`
2. Creates a session
3. Calls `placeLimitOrder({ epic: 'EURUSD', direction: 'BUY', size: 1, level: <way_below_market>, stopLevel: <below_level>, profitLevel: <above_level>, goodTillDate: now+5min })`
4. Logs the returned workingOrderId
5. Calls `getWorkingOrders()` to verify the order appears
6. Prints "Smoke test PASS. Order will auto-cancel at <goodTillDate>."
7. Exits

Operator waits ≥5 min, then SSH-queries `getWorkingOrders` again to
verify the order has auto-cancelled. If it's still present, escalate.

## 5. Success criteria (definition of "done")

1. `npm run build` clean.
2. All 240 existing tests still pass.
3. ~7 new tests pass (capital-client + trading-tools).
4. Smoke test shows a working order created → visible → auto-cancelled.
5. pm2 restart on VPS has no startup errors; scheduler lists all 6 cron jobs.
6. Next real ICT cycle that decides to trade emits a limit order
   (observable in pm2 log: `Calling tool: place_order` + response
   JSON with `orderType: 'LIMIT'`).
7. If the first real limit fills → `log_trade` records actual fill price.
8. If the first real limit does NOT fill → order expires silently at
   goodTillDate; no crashes; next /5 cron tick proceeds normally.

## 6. Rollback plan

If the smoke test fails: **do NOT pm2 restart**. Revert the 3 feature
commits with `git revert`, push, re-pull on VPS, re-build. Live bot
continues running old market-order code, zero impact. ~10-minute
rollback.

If a post-deploy real limit order behaves unexpectedly: same revert
process. Any outstanding working orders placed by the new code
auto-cancel via goodTillDate within 15 minutes — no cleanup required
on our side.

## 7. Out of scope

- Market-order fallback when a limit doesn't fill (defeats P1's premise)
- Partial-fill handling (not a concern at Farad's 1-2k-unit size)
- Smart limit re-pricing as price drifts (the agent re-evaluates next cycle)
- Cancellation of limits before expiry (auto-expiry is sufficient)
- Changes to `close_position`, `partial_close`, `update_sl`,
  `set_trailing_stop` (these remain market/modify operations — correct)
- Removal of `openPosition` from the Capital client (dead-code cleanup
  is scope creep; retain for potential emergency flows)
- Any change to the ICT agent's bias-detection, scoring, news filter,
  Analyst, or scanner logic

## 8. Demo-safety

- No live decision-path changes (scoring, bias, news, Analyst all
  unchanged).
- Single pm2 restart, measured in seconds.
- Smoke test gates the restart — we prove the endpoint works before
  exposing a real ICT cycle to new code.
- Rollback is clean: 3 commits, `git revert`, re-deploy. No DB changes
  to reverse.
- Capital auto-expires any misbehaving working orders within 15 min.

## 9. Timeline

- Code: capital-client method (~30 min), tool signature (~15 min), prompt
  (~10 min), tests (~45 min)
- Build + test: ~10 min
- Smoke test write + run: ~20 min
- Commit, push, deploy: ~10 min
- **Total: ~2.5 hours** from plan start to deployed, smoke-tested P1

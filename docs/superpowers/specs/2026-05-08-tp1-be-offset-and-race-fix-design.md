# TP1 → SL→BE+0.1R + Race-Window Reduction

**Date:** 2026-05-08
**Author:** Claude (with Giuseppe / BetterOps AI)
**Status:** Approved 2026-05-08 — Codex audit (DESIGN APPROVED WITH CAVEATS) folded in; user signed off; transitioning to `superpowers:writing-plans`.

## TL;DR

Two-part fix to the TP1 → SL-to-breakeven mechanism:

1. **Move runner SL to entry ± 0.1R** (signed by direction) instead of exactly entry, so a stop-out on the runner locks in a tiny profit instead of zero.
2. **Tighten the split-position monitor cron** from `*/5` to `*/1` to cut the worst-case race window 5×, plus return `{ applied, reason }` from `safelyAmendPosition` so the post-amend log accurately reflects whether the broker actually applied the change.

Applies uniformly to all instruments and all trade types (FX, commodities; 2-leg Phase 2 and legacy 3-leg). Solves the GOLD case observed 2026-05-07 13:35:00 UTC where TP1 and TP2 fired between two 5-minute monitor ticks and the runner SL→BE amend was silently no-op'd.

## Locked decisions

- **Q1 BE target semantics:** `entry + offset` for longs, `entry − offset` for shorts. **`offset = max(0.1R, 2 × typicalSpread(instrument))`**, where R = `|entry − sl|` and `typicalSpread` is read from the existing `src/backtest/realism.ts:32-35` instrument table (EURUSD/AUDUSD/GBPUSD ≈ 0.8-1.2 pips, USDJPY ≈ 1 pip, commodities medium-spread). The 2× spread floor guarantees the new SL never lands inside the bid-ask, even on unusually small-R FX trades. Single base percentage (0.1R), per-instrument floor.
- **Q2 Race-window mitigation:** reduce monitor cron to 1-minute cadence. Capital streaming WebSocket (Approach B) deferred.
- **Q3 Log accuracy:** Augment `safelyAmendPosition`'s existing `DealConfirmation` return with an `applied: boolean` field. The current implementation already returns a synthetic `DealConfirmation` on the race-skip path (with `dealReference: 'synthetic-amend-skipped-<dealId>'` and `reason: 'POSITION_ALREADY_CLOSED_BY_BROKER'`). We add `applied: false` to that synthetic and `applied: true` to **all** real-PUT return paths — critically including the `pollDealConfirmation` return at `src/mcp-server/capital-client.ts:465`. If line 465's wrap is missed, the scheduler will log `skipped` on every successful real amend (this is the main implementation trap flagged by Codex audit 2026-05-08). Caller logs distinct strings based on `confirmation.applied`. **Non-breaking:** existing callers (`mcp-server/tools/trading-tools.ts:232,271`) only read `confirmation.dealStatus` / `confirmation.status`, which keep their current values.

## Why now

Triggered by Giuseppe's observation on 2026-05-07's GOLD trade (`trade-5a3eceb198544ead-4decda2c`):

```
13:35:00  [TP1] GOLD — Position B SL→BE (4735.54)            ← misleading success log
13:35:00  [Capital] safelyAmendPosition <Leg B dealId> skipped — position already closed before GET (race against SL/TP fill).
```

GOLD's TP1 (4748.08) and TP2 (4751.84) sit only 3.76 points apart under Phase 2's 1.3R floor. Both filled between the 13:30 and 13:35 monitor ticks. When `handleTp1Hit` ran at 13:35, Leg B was already closed broker-side, so `safelyAmendPosition`'s pre-GET found nothing to amend and skipped silently — but the success log line fired anyway. The trade closed at full +1.09R because TP2 was the next target, but the same race in a TP1-then-reverse scenario would have stopped Leg B at the **original SL** instead of BE+0.1R. Cost per such event: Leg B at -1R sized 30% = -0.3R blended; with the fix, Leg B at +0.1R sized 30% = +0.03R blended. **Delta = 0.33R saved per "TP1-then-reverse-past-entry" outcome.**

Phase 2's tighter 1.3R TP2 floor materially increases the chance of TP1 and TP2 filling in the same monitor pass on fast moves — exactly what GOLD exhibited. The fix needs to apply to every instrument and trade type, not just GOLD.

## Live in-flight constraint

No active trades at draft time. Deploy-window restart is safe; no in-flight runner amend depends on the current return shape of `safelyAmendPosition`.

## Code surface

### Files modified

1. `src/scheduler/index.ts`
   - `handleTp1Hit` — replace `stopLevel: trade.entry` (Leg B and Leg C amends) with a computed `beStop` using the helper described below.
     ```ts
     const r = Math.abs(trade.entry - trade.sl);
     if (r === 0) {
       console.warn(`[TP1] ${trade.instrument} ${tradeId} has zero R — using exact entry as fallback`);
     }
     const minSpreadOffset = 2 * typicalSpread(trade.instrument); // imported from src/backtest/realism.ts
     const offset = Math.max(0.1 * r, minSpreadOffset);
     const sign = trade.direction === 'long' ? +1 : -1;
     const beStop = trade.entry + sign * offset;
     ```
     Adjust the `[TP1]` log lines to print `BE+offset` and the chosen value (e.g. `[TP1] GOLD — Position B SL→BE+1.254 (4736.794) applied`). Branch on `confirmation.applied` from the helper and log `skipped (race against fast TP fill)` when false.
   - `handleTp2Hit` — same `applied`-aware logging on the 3-leg trail-to-TP1 amend. SL **value** unchanged (still `trade.tp1`). No semantics change.
   - Cron string for split-position monitor — `'*/5 * * * *'` → `'*/1 * * * *'`. Verified by Codex audit (2026-05-08): no hard 5-minute dependency in `monitorSplitPositions` (`scheduler/index.ts:282-320`); candle-close detection (`scheduler/index.ts:863-920`) is already gated by candle keys + `<5min` windows (`scheduler/index.ts:132-148`), so ICT Agent will not over-fire.

2. `src/mcp-server/capital-client.ts` — `safelyAmendPosition` and `updatePosition`
   - Augment the `DealConfirmation` interface with an optional `applied?: boolean` field (or define a thin extension type local to this module).
   - **Three return paths must each set `applied`:**
     - `safelyAmendPosition` race-skip synthetic (~line 412) → `applied: false`.
     - `updatePosition` race-skip synthetic (~line 473) → `applied: false`.
     - `updatePosition` real-PUT path (~line 465, returns raw `pollDealConfirmation` today) → wrap with `applied: true`. **Missing this is the audit trap** — the scheduler would log `skipped` on every real amend.
   - **Backwards compatibility:** the four existing call sites continue to work unchanged:
     - `mcp-server/tools/trading-tools.ts:232` — reads `confirmation.dealStatus`, `confirmation.status`. Both fields still present (synthetic supplies them with `'ACCEPTED'` / `'FULLY_CLOSED'`).
     - `mcp-server/tools/trading-tools.ts:271` — same.
     - `agents/trading-agent.ts:1589` — `await`s without assigning, ignores return. Untouched.
     - `scheduler/index.ts:535` (legacy 3-leg `handleTp2Hit` trail-to-TP1) — currently no return-value inspection; this fix adds an `applied` check and the same skip-log treatment as `handleTp1Hit` for symmetry.
   - Verify with `npx tsc --noEmit` after the change.

### Files added (tests)

3. `tests/scheduler-tp1-be-offset.test.ts` (new)
   - `handleTp1Hit — long: Leg B SL = entry + offset, applied=true logged`
   - `handleTp1Hit — short: Leg B SL = entry − offset, applied=true logged`
   - `handleTp1Hit — 3-leg long: BOTH Leg B and Leg C SL = entry + offset`
   - `handleTp1Hit — race: amend returns {applied:false}; status still flips to tp1_hit; "skipped (race against fast TP fill)" log fires`
   - `handleTp1Hit — applied undefined defaults to applied=true (defensive — covers any future caller that forgot to set the field)`
   - `handleTp1Hit — zero-R trade: warning logged, falls back to entry exactly, no crash`
   - `handleTp1Hit — small-R FX: offset = 2× spread floor (asserts beStop is outside bid-ask for EURUSD with 5-pip R)`
   - Math invariant sweep: 5 instruments × 2 directions, asserts beStop = entry + sign × max(0.1R, 2×spread)

4. `tests/scheduler.test.ts` (existing) — update existing 2-leg TP1-hit case to assert new `beStop` value, not `trade.entry`.

5. `tests/safelyAmendPosition.test.ts` (existing) — add cases:
   - Success path (real PUT) returns `applied: true`
   - Race-skip in `safelyAmendPosition` returns `applied: false`
   - Race-skip in `updatePosition` returns `applied: false`
   - All three paths still expose `dealStatus` and `status` for legacy callers

## Out of scope (deferred)

- **Approach B — Capital streaming WebSocket** for fill events. Eliminates the race entirely but ~200 lines of WS client + reconnect + dedupe + fallback. Separate project if 1-min cadence still misses races.
- **TP2 trail offset** — `handleTp2Hit` legacy 3-leg amend still trails to `trade.tp1` exactly. Adding an offset there is a strategy change, not a bug fix; not requested.
- **Telegram Markdown escape bug** observed on 2026-05-07 alertTp3Hit (SILVER) and alertTp2Hit (GOLD) — independent issue, not bundled.
- **Per-instrument tunable offset** — single 0.1R applies to all. Can add a per-instrument override map later if needed.
- **`pnl_total = 0` DB logging bug** — being fixed in a parallel session.

## Tests / verification gates

- `npm test` — all current 765 tests + 5 new = 770 must pass.
- `npx tsc --noEmit` — zero errors. Specifically verify the 4 untouched amend-site callers still typecheck.
- Backtest cache-only sanity:
  ```
  npx tsx scripts/run-backtest.ts --start 2024 --end 2025 \
    --tickers EURUSD,GBPUSD,GOLD,AUDUSD,OIL_CRUDE
  ```
  Gate: PF ≥ 0.61 (Phase 2 baseline). Expected lift is small (+0.03R per "TP1-then-reverse" trade × frequency of that pattern). Not a blocker if PF stays flat; blocker if it regresses meaningfully.
- Live smoke test post-deploy:
  ```
  ssh bot@162.55.212.198 "pm2 status && pm2 logs trading-bot --lines 20 --nostream"
  ```
  Verify the next monitor tick lands at `:01` past the minute (was `:05`), no errors at startup.

## Rollout

Single commit, single push to master. CI auto-deploys per the existing `.pause-deploy`-absent state. pm2 restarts. No DB migration. No in-flight position state to preserve.

## Edge cases considered

- **Spread vs offset:** Plain 0.1R is unsafe on small-R FX. Yesterday's R range was ~5-100 pips on FX; for the rare ~5-pip FX stop, 0.1R = 0.5 pips, which lands inside the 0.8-1.2 pip EURUSD/GBPUSD/AUDUSD spread (per `src/backtest/realism.ts:32-35`). Mitigation: `offset = max(0.1R, 2 × typicalSpread(instrument))`. On normal trades (yesterday's GOLD R=12.54) the 0.1R term wins; on tight-stop FX the spread floor wins.
- **Tick alignment of beStop:** Capital rounds price-level amends server-side; the existing 5 amend sites already pass un-rounded computed values without issue. No pre-round needed.
- **Direction field:** `trade.direction` is `'long' | 'short'` per the DB schema and is set at trade-open time in `place_split_trade`. Always defined for any trade reaching `handleTp1Hit`.
- **Zero-R defensive:** `handleTp1Hit` will `console.warn` and fall back to exact `trade.entry` if `r === 0`. Validates upstream sizing logic (`src/agents/trading-agent.ts:425-430`) is the real guard, but the scheduler doesn't trust upstream blindly.
- **3-leg trades opened pre-Phase-2 still in-flight:** none at deploy time; future irrelevant since 3-leg path is no longer entered for new trades.
- **Capital quota at 1-min cadence:** worst case ~67 calls/hour during market hours (60 monitor + 7 keep-alive). Well under typical Capital limits.
- **Monitor tick overlap under slow API:** `monitorRunning` flag in `scheduler/index.ts:859-872` skips overlapping ticks silently rather than queuing. At 1-min cadence under a slow Capital API, ticks could pile up and be silently dropped. Same risk pattern as today, just shifted; not worse than the `*/5` baseline which had the same drop semantics. Acceptable for this fix; revisit if pm2 logs show frequent skips.
- **Monitor-task internal candle gating:** Codex audit verified that candle-close detection at `scheduler/index.ts:863-920` is already gated by candle keys + `<5min` windows (`scheduler/index.ts:132-148`). Switching the cron to `*/1` does NOT cause the ICT Agent to over-fire — the gate still ensures it only runs at 15m/1h boundaries. No additional code change needed for this concern.

## Acceptance criteria

1. New trade hits TP1 → broker shows runner SL at `entry ± 0.1R` (verifiable via `pm2 logs` and the `[TP1] ... applied` line).
2. New trade hits TP1 then reverses past entry → runner stops at BE+0.1R, P&L row reflects `+0.1R` on the runner instead of `0`.
3. Fast trade where TP1 and TP2 fire in the same monitor pass → log shows `[TP1] ... skipped (race against fast TP fill)` instead of misleading `applied`. Trade still resolves to `complete` correctly.
4. Position monitor visible at every minute mark in `pm2 logs`, not every 5.

# Project Status — Auto-Updated
Last updated: 2026-04-23 ~18:15 UTC end-of-day (day 4 of demo)
Project: BetterOpsAI Trading Bot ("Farad")
Branch: **master**
Last commit on master: `ef9f4d5` — "feat(prompt): ict-agent — require entry_price + document LIMIT execution (P1 Task 3)"
VPS head: `ef9f4d5` (synced — smoke-test gate PASSED, pm2 restart #45 clean)
pm2 state: restart #45, PID 85342, online, preflight clean, **scheduler running with 6 crons**

## 🌅 First thing to read next session — P1 verification

**The P1 limit-order change is DEPLOYED and awaiting live verification.**
- Smoke-tested against Capital demo end-to-end: a working-order was created, appeared in the working-orders list, and auto-cancelled via `goodTillDate` exactly as designed.
- The in-process code path is identical to what the smoke test exercised.
- **Next action:** during tomorrow's first kill zone (London Open 07:00 UTC, ~13 hours from deploy), tail `pm2 logs trading-bot` and watch for the first `[ICT Agent] Calling tool: place_order` followed by a response JSON containing `"orderType":"LIMIT"` and a non-null `workingOrderId`. That's the live "done" signal.
- **If it fills:** `log_trade` captures the actual fill price; compare to the `entry_price` the agent requested. Near-identical (within spread) = success.
- **If it doesn't fill in 15 min:** Capital auto-cancels; no crash; next /5 cron tick proceeds. Also success — that's option A working as designed.

## 📋 What shipped today — 27 commits across 7 themes

| Commit | Theme | Purpose |
|---|---|---|
| `6c347ef` | **AV burst-limit fix** | Detect Alpha Vantage 1 req/sec burst limit, throttle via TokenBucket(1, 1100ms), detect distinct burst-limit `Information` message, retry once, always-log mapping outcomes. |
| `5ea2214` | **log_trade schema fix** | Extend TradeStatus with `closed_early`, add `closure_reason TEXT` column + migrations. `normaliseTradePayload` auto-generates missing `id`, maps `strategy`→`strategy_tag`, derives `entry` from `actual_entry`/`intended_entry`, normalises non-canonical `closed_*` statuses. |
| `20370a7` | (chore) | project-status update for AV-burst + log_trade fixes |
| `9e312f5` | **news-resilience (5 layers)** | (1) 30-min per-ticker cache; (2) stale-cache up to 4 h when quota exhausts; (3) 22/25 daily soft-cap reserving headroom for Researcher; (4) stale-bearish dampening halves magnitude on news > 60 min old when aggregate is bearish; (5) one-shot Telegram degradation alert per UTC day. |
| `239ca9f` | (chore) | project-status update for news-resilience deploy |
| `8914b00` | **Swing subsystem removal** | Deleted `src/agents/swing-agent.ts` + `prompts/swing-agent.md`, removed 3 Swing cron jobs, dropped `swing_shortlist` from Researcher. Kept `'SWING'` in StrategyTag enum + DB CHECK for historical queryability. Triggered by AAPL long found on Capital.com. |
| `2f2b4b0` | (chore) | project-status update for Swing removal |
| `5a434b1` | **diagnostic spec** | Backtest vs live diagnostic — design |
| `66ba77d` | **diagnostic plan** | 5-task execution plan |
| `8d29691` | **diagnostic report** | 4-angle review: rule-drift audit (α), live-trade forensic + skipped-cycle audit (β, 15 case files), backtest realism check (γ), expectations forecast (D). Verdict: MIXED — frequency on-track for actual gate stack (5 ± 2), but backtest's +1671R headline overstated 2-4× once realism modeled. |
| `42a6a65` | **P3 spec** | Backtest realism design |
| `ef42196` | **P3 plan** | 3-task implementation plan |
| `1145beb` | **P3 Task 1** | New `src/backtest/realism.ts` with EXECUTION_COSTS + computeExecutionCost |
| `110cdb1` | **P3 Task 2** | Integrate into engine.ts — subtract per-trade cost in resolveOutcome |
| `49a7fce` | **P3 close-out** | Post-run calibration of test internals + Appendix D to diagnostic report. Reveals γ's optimistic typical-stop assumption — USDJPY/SILVER/OIL_CRUDE have 3× tighter stops than γ assumed, inflating per-trade R-cost. FX majors cheaper than γ predicted. |
| `7ce7c6e` | **P4 spec** | Reject metrics design |
| `034a254` | **P4 plan** | 6-task implementation plan |
| `131c4a0` | **P4 Task 1** | classifyLine (7 skip categories + 4 execute categories, priority-ordered) |
| `a00f27e` | **P4 Task 2** | extractInstrument + extractKillZone (10-line sliding window) |
| `ccda42b` | **P4 Task 3** | aggregateLog + renderMarkdown |
| `7ab65fc` | **P4 Task 4** | CLI entry point (Windows-safe isMain via `fileURLToPath` + `path.resolve`) |
| `c30bdc0` | **P4 Task 5** | Scheduler cron at 00:05 UTC (detached spawn, stdio:'ignore', error-swallowed) |
| `9c071d2` | **P4 post-deploy fix** | Rewrote extractKillZone — real log format is `Kill Zone: LONDON OPEN ACTIVE ✅` with emoji + variable spacing, not the tight `kill zone: London Open` my tests assumed. State-machine matcher: ACTIVE / INACTIVE / "Next kill zone" / outside. |
| `10e772c` | (chore) | end-of-day project-status update before P1 was started |
| `a98191c` | **P1 spec** | Limit orders at OB midpoint — design spec |
| `1fceaca` | **P1 plan** | 5-task implementation plan (reconciled "new placeLimitOrder method" to use existing createWorkingOrder) |
| `51b5313` | **P1 Task 1** | CreateWorkingOrderParams extended with timeInForce + goodTillDate + guaranteedStop + label. +2 tests. |
| `df3cfbb` | **P1 Task 2** | place_order MCP tool — BREAKING: entry_price now required, dispatches to createWorkingOrder (LIMIT + GOOD_TILL_DATE + now+15min). +3 tests. |
| `ef9f4d5` | **P1 Task 3** | ict-agent.md — place_order tool desc updated, new LIMIT-ORDER EXECUTION section explaining OB/FVG midpoint + 15-min auto-expiry + "NEVER propose without entry_price" rule. |

**Tests shipped today: 182 → 245 (+63 new across 5 test files + 1 brand-new file).**

## P1 — smoke-test verification (COMPLETED)

Pre-`pm2 restart` gate. Ran on VPS at 2026-04-23 ~18:05 UTC:
- Placed EURUSD BUY limit @ 0.90000 (well below market, will never fill), size 500, goodTillDate 18:10:22
- Capital returned `dealReference: o_e0a95ebe-...` + `workingOrderId: 00005552-0055-311e-0000-000081e6249e`, `dealStatus: ACCEPTED`, `status: OPEN`
- `getWorkingOrders()` confirmed visible: `orderType: LIMIT, orderLevel: 0.9, timeInForce: GOOD_TILL_DATE`
- Polled until ~18:10 UTC: order EXPIRED (auto-cancel via Capital goodTillDate confirmed ✅)

The live Capital demo endpoint + our new code-path works end-to-end. Smoke-test script deleted from VPS (uncommitted, never in repo). pm2 restarted #45.

## AAPL position on Capital.com — still open, manual watch

The Swing Agent's AAPL long from 2026-04-22 (entry ~$273.07, SL $264.22, TP1 $278, TP2 $287) is still open on Capital.com. You chose option **1b** (leave open, manage manually to TP/SL). The bot will NOT touch it — Swing Agent is gone, and the trade was never in the local DB anyway (Swing Agent had skipped `log_trade` after `place_order`, separate bug).

## 🎯 Current production config — single source of truth

**Universe (7 — ICT only):** GOLD, SILVER, OIL_CRUDE, EURUSD, GBPUSD, USDJPY, AUDUSD

**Active cron schedule (6 entries):**
```
*/5 * * * *    Split-position monitor + candle detection → ICT Agent
*/8 * * * *    Capital.com session keep-alive ping
30 5 * * *     Market Researcher (daily pre-London)
0 22 * * 0     Market Researcher (weekly)
0 0 * * 0      Weekly Review Agent
5 0 * * *      Reject metrics dump (previous UTC day) — NEW 2026-04-23
```

**Kill switches:** 6% daily (code-enforced), 10% weekly (prompt-advisory)
**Demo gate:** DEMO_RELAXED_GATES=true — Tier 3 ≥45, R:R ≥1.5:1 for tight-spread, kill-zone bonus +15/+10

## 🔍 Key diagnostic findings (from the 2026-04-23 investigation)

1. **Base strategy edge = +0.10 R/trade gross** on 2019-2025 1H candles. γ's +0.11 estimate validated on fresh 37,336-trade dataset.
2. **Realism cost wipes the edge on 3 instruments.** USDJPY (-0.94 R/trade), SILVER (-0.57), OIL_CRUDE (-0.42) are slippage-catastrophic with market orders. FX majors survive friction better.
3. **Backtest 1671R headline → -1569R under worst-plausible realism** (confirmed via commits `1145beb` + `110cdb1` on actual 37,336-trade run: gross +3,881R → net -9,999R).
4. **With limit orders (γ's best-case):** realistic ceiling is +400-600R over 6.5 years. This is the deferred P1 priority.

## 🚧 Deferred items — next session candidates

1. **P1 live verification (HIGHEST PRIORITY tomorrow morning).** Code deployed + smoke-tested, but no real ICT cycle has exercised the new path yet (18:11 UTC deploy was past London Close kill zone). First real cycle: London Open 07:00 UTC tomorrow. See "First thing to read next session" above for exact verification steps.

2. **P2 — news-opposing softening (hard SKIP → 50% risk).** SCHEDULED for tomorrow (2026-04-24) at **11:00-13:00 UTC (13:00-15:00 Malta)** — after London Open exercises P1, before NY Open needs stability.

   **Pre-P2 checklist** (run at ~11:00 UTC tomorrow):
   - `ssh bot@162.55.212.198 "pm2 status"` — confirm bot uptime, no crash loops
   - `ssh bot@162.55.212.198 "grep -E 'orderType.*LIMIT|Calling tool: place_order|working order|workingOrderId' /home/bot/trading-bot/data/pm2-out.log | tail -30"` — did P1 fire? Did a limit fill or expire?
   - Log into Capital demo UI — any dangling working orders from today? Any new fills?
   - If P1 looks broken → rollback P1 BEFORE starting P2: `git revert ef9f4d5 df3cfbb 51b5313 --no-edit && git push origin master` and re-deploy

   **If P1 looks healthy → start P2 brainstorm → spec → plan → execute.** Target: ship before NY Open (13:00 UTC / 15:00 Malta) so both P1 + P2 get exercised in the same kill zone.

   **P2 scope reminder (from diagnostic recs):** soften news-opposing from hard SKIP to 50% risk. Touches `src/news/index.ts` `isNewsOpposing` function (return a factor 0.0 / 0.5 / 1.0 instead of boolean) + `prompts/ict-agent.md` Step 3E ("opposing news → skip entirely" → "opposing Cat A news → take at 50% risk"). ~1 hour of work. Caveat: 50% is the baseline rec, not a data-calibrated number (real calibration needs weeks of post-P1 data).
3. **Swing Agent `log_trade` bug post-mortem:** the 2026-04-22 AAPL trade was never persisted. Root cause was the Swing Agent skipping the log_trade step after place_order. Now moot (Swing removed) but worth documenting in case Swing ever returns.
4. **Backtest news-filter proxy (γ's Delta 3, credibility C):** not implemented in P3; deferred per spec §1 non-goal.
5. **Reject-metrics polish:** (a) percentages can exceed 100% when multiple skip events per cycle (cosmetic); (b) split-leg place_orders sometimes attribute to `_unknown` when the 10-line window doesn't reach the instrument-naming line.
6. **Weekly Review still reports SWING data** (historical-only) — fine, but eventually it becomes dead output. Post-demo cleanup.
7. **The 3-leg split now applies limit orders at the same entry_price per leg** (per the plan's Task 2 architecture). If Leg A fills but Leg B/C don't within the 15-min window, the partial setup runs without the remaining legs. Acceptable for now but worth watching: if this pattern occurs, we may want to either (a) bundle legs into a single order, or (b) detect partial-limit-fills and cancel the filled leg if others expire. Post-demo tuning.

## 🛡️ Infrastructure state

- 23 commits on master, all pushed to origin, all deployed to VPS
- pm2 restart count today: 34 → 40 (+6 restarts for 5 separate deploys, some multi-reboot from pm2 auto-restart on transient errors)
- Total downtime estimated at ~10 seconds across all deploys
- No DB migrations pending (the `closed_early` + `closure_reason` migration from `5ea2214` ran cleanly at 08:58 UTC restart)
- `data/metrics/` directory created on VPS with 2 daily reports: `reject-2026-04-22.md` (3 executed trades) + `reject-2026-04-23.md` (0 executed trades, partial day)

## 🚦 Next session priorities (in order)

1. **Morning status check** — `pm2 status`, grep for `[Scheduler] Reject-metrics dump` in logs (tomorrow's 00:05 UTC auto-generated report), check `data/metrics/reject-2026-04-23.md` for the complete UTC-day dump
2. **P1 (limit orders)** — brainstorm → spec → plan → execute, same chain as today. Bring full focus.
3. **P2 (news-opposing softening)** — after P1 has 24h of metrics data to inform the right dampening factor

## 🧘 Session close state

23 commits, 3 subsystems shipped, 1 removed, 1 diagnostic done, +58 tests (182 → 240). Repo clean at `9c071d2`, VPS synced. AAPL trade still open on Capital.com — monitor manually. **P1 and P2 explicitly deferred for a fresh session** per Option B framing and end-of-session fatigue guardrail.

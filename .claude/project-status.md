# Project Status — Auto-Updated

> ## 🔔 STILL PENDING (Giuseppe asked 2026-04-24, surface every session) 🔔
>
> 1. **Node 22 upgrade on VPS** — still pending. `yahoo-finance2@3.14.0` warns about requiring Node ≥22 while VPS runs 20.20.2. Works with warning today. Tracked in `~/.claude/projects/C--Program-Files-Git/memory/project_farad_demo_end_todo.md` item #3.
> 2. **ICT Agent `log_trade` bug** — `[ICT Agent] Tool log_trade failed: insertTrade: required field(s) missing: id`. Pre-existing. Check `src/mcp-server/tools/trading-tools.ts` `log_trade` definition vs `src/database/index.ts` `insertTrade`. Tracked in memory item #9.
> 3. **Anthropic API credits** — was $15.98 on 2026-05-04, auto-reload OFF. Phase 2's looser TP2 floor (1.3R universal vs prior 2.0R) means more proposals reach the analyst → faster burn. **Check Console balance** before next session start.

Last updated: 2026-05-07 ~10:40 UTC — Phase 1 + Phase 2 shipped same day
Project: BetterOpsAI Trading Bot ("Farad")
Branch: **master**
Last commit on master: `a742669` — "fix(sizing): tick-align BOTH legs (Codex Round 2 BLOCKER fix)"
VPS head: `a742669` (synced — pm2 restart #73 clean, preflight 0 errors)

## 🚢 What shipped today — two phases, 7 commits, single session

Both deployed to VPS; bot online, preflight clean, **765 tests pass** (was 707 at session start), tsc clean, **3 Codex review passes** (each caught real bugs pre-deploy).

### Phase 0 — Live recovery (manual, before any code shipped)

The SILVER 3-leg trade `trade-a8a0eb21` had its TP2/TP3 stripped at 07:55 UTC when the SL→BE handler fired (Capital.com PUT-amend strips omitted fields). Manually restored:
- Leg B `...103`: SL 78.88, TP **80.58** (TP2)
- Leg C `...105`: SL 78.88, TP **81.43** (TP3)

Recovery script lives on VPS at `/home/bot/trading-bot/scripts/_phase0_recover_silver.mjs` (not committed, regenerable from this session's transcript).

### Phase 1 — TP-preservation helper

| Commit | Purpose |
|---|---|
| `d3a8563` | Initial scheduler-only fix (preserve TP on SL→BE amend by re-supplying profitLevel) |
| `82244f3` | Comprehensive refactor: added `safelyAmendPosition` to `CapitalClient`. Helper does GET→merge→PUT, making partial-amend strips structurally impossible. Routed all 5 amend call sites through it (handleTp1Hit, handleTp2Hit, set_trailing_stop, MCP update_sl, ICT update_sl) |
| `a989249` | Stale comment cleanup |

### Phase 2 — 2-TP strategy restructure

| Commit | Purpose |
|---|---|
| `840fa8d` | **3 legs → 2 legs.** TP3 + Leg C removed for new trades. TP1 70% / TP2 30%. Universal R:R floors (TP1 ≥ 1.0R, TP2 ≥ 1.3R) replace per-mode/per-tier floors. validateRRFloor + validateOrderSide refactored. Tool schemas + DB writes drop tp3/size_c. Backtest engine 2-leg P&L (`tp2_hit=+1.09R`, `tp1_be=+0.7R`, `sl=-1R`). ICT prompt fully restructured. |
| `00e5b4e` | **Server-side tick-aware 70/30 sizing.** New `computeServerSizing` helper. LLM-supplied size_a/size_b are ignored — server computes from total_risk_pct + broker minDealSize. proposalHash drops sizes from canonical projection (sizes are server-computed, not LLM-controlled). Fail-CLOSED on getMarketDetails failure. |
| `11041a6` | **27 new tests.** Backtest 2-leg outcome (gross + net of executionCost), proposalHash backward-compat (tp3/size_c/size_a/size_b ignored), computeServerSizing edge cases. |
| `a742669` | **Tick-align BOTH legs** (Codex BLOCKER fix). Original sizing only tick-aligned Leg B; Leg A inherited remainder and could be non-aligned. Now: integer-tick split with 1e-9 IEEE 754 epsilon. 10 sweep cases across FX/GOLD/SILVER/OIL_CRUDE tick rules. |

### Backtest gate result (cache-only, 5 instruments, 2024-2025)

| Metric | Baseline (2026-05-04) | Phase 2 (2026-05-07) | Verdict |
|---|---|---|---|
| Trades | 9,979 | 7,380 | -26% (concentrated on higher-conviction setups) |
| **PF** | **0.56** | **0.61** | **1.09× — improvement ✅** (gate was ≥0.95×) |
| Max DD | 852.81R | 509.43R | -40% — much tighter ✅ |

Result file: `backtest-results/phase2_2-tp-restructure_2026-05-07.json` (local scratch, not committed, regenerable).

## 🎯 Current production config

**Universe (7 — ICT only):** GOLD, SILVER, OIL_CRUDE, EURUSD, GBPUSD, USDJPY, AUDUSD

**Active cron schedule (8 entries):**
```
*/5 * * * *    Split-position monitor + candle detection → ICT Agent
*/8 * * * *    Capital.com session keep-alive ping
30 5 * * *     Market Researcher (daily pre-London)
0 22 * * 0     Market Researcher (weekly)
0 0 * * 0      Weekly Review Agent
30 21 * * 1-5  EOD Journal Agent (Mon-Fri after US close)
*/10 * * * *   RSS news poll (18 feeds, Tier 1/2/3)
5 0 * * *      Reject metrics dump (previous UTC day)
```

**Kill switches:** 6% daily (code-enforced), 10% weekly (code-enforced post-2026-05-04).
**Demo gate:** DEMO_RELAXED_GATES=true.
**Strategy:** 2-leg ladder (TP1 70% / TP2 30%) with universal R:R floors (1.0R / 1.3R).
**Sizing:** server-side tick-aware (LLM sets risk%, server computes leg sizes).

## 📍 First sanity checks for next session

```bash
# Bot still alive?
ssh bot@162.55.212.198 "pm2 jlist | python3 -c 'import sys,json; d=json.load(sys.stdin); [print(p[\"name\"], p[\"pm2_env\"][\"status\"], \"restarts:\", p[\"pm2_env\"].get(\"restart_time\",0)) for p in d]'"

# What did the bot do overnight?
ssh bot@162.55.212.198 "tail -50 /home/bot/trading-bot/data/pm2-out.log | grep -E 'place_split_trade|TP1|TP2|computeServerSizing|SILVER'"

# SILVER 3-leg trade still riding to TP2/TP3?
ssh bot@162.55.212.198 "cd /home/bot/trading-bot && node scripts/_phase0_inspect.mjs"

# Codex audit log (new this session — captures every codex invocation):
cat ~/.claude/codex-audit.log
```

## 🟢 Live in-flight position

**SILVER `trade-a8a0eb21`** (opened 2026-05-07 07:02:31 UTC, status `tp1_hit`):
- Leg A `...101` — closed at TP1 79.73 (07:55 UTC)
- Leg B `...103` — open: SL 78.88, TP **80.58** (TP2), UPL +$5.27 at session close
- Leg C `...105` — open: SL 78.88, TP **81.43** (TP3), UPL +$5.27 at session close

Phase 2's 2-leg strategy applies only to NEW trades — this 3-leg SILVER rides legacy `handleTp1Hit` / `handleTp2Hit` / `handleTp3Hit` branches end-to-end. Phase 1's `safelyAmendPosition` protects against TP-stripping if scheduler fires another amend (e.g., trail C's SL to TP1 on TP2 hit).

## 📊 Test surface

- 765 tests pass (was 707 at session start, +58 net)
- 37 test files
- tsc clean
- New tests: 3× safelyAmendPosition, 10× computeServerSizing tick-alignment sweep, 14× backtest 2-leg outcomes, hash-ignored-fields, 2-leg TP1-hit scheduler

## 🛠 Codex audit infrastructure (NEW this session)

User-level config at `~/.claude/settings.json`:
- PreToolUse + PostToolUse hooks on Bash → `~/.claude/hooks/codex-audit-{pre,post}.sh`
- Hooks filter for `codex-companion.mjs` substring; silent on all other bash calls
- Every codex invocation logged to `~/.claude/codex-audit.log` with timestamp, command, response
- Plus best-effort always-on debug env vars (`CLAUDE_CODE_DEBUG=1`, `DEBUG=1`) — verify after next session start

## 📋 Deferred items (Codex flagged, defer-acceptable)

- **Balance-drift guard** between analyst-time (T1) and placement-time (T2) sizing. Both recompute fresh from current balance — T2 wins. Edge case bounded by 10-min approval TTL. Add 1-2% drift check if drift becomes observable.
- **getMarketDetails retry/cache.** Currently fail-CLOSED with `MIN_DEAL_SIZE_UNAVAILABLE` if API errors. Could add 2-attempt retry / 5-min cache if a real Capital outage blocks trades.
- **Cosmetic:** startup banner [Config] still says "R:R 1.5:1 for tight-spread symbols" — stale post-Phase 2 (universal 1.3R now). Source likely in `src/preflight.ts` or `src/index.ts`.

## 🚀 Next session opener

When you open next, surface (in order):
1. The 3 PENDING items at the top (Node 22, log_trade bug, Anthropic credits)
2. Sanity-check the bot is still online and SILVER state is clean
3. Whether the deferred Phase 2 items have become observable issues live

# Project Status — Auto-Updated
Last updated: 2026-04-21 (end of Day 2 — 9 PRs shipped, cost optimised, auto-deploy live)
Project: BetterOpsAI Trading Bot ("Farad")
Branch: **master** (now the default; `main` deleted today. Repo: https://github.com/giuseppeportelli1403-ops/FaradsAI-TradeBot)
Last commit on master: `d7ed32a` — "perf: tighten iteration + output-token caps; swap AAPL/US30 for OIL/SILVER"
VPS head: `d7ed32a` (same as master — auto-deploy working)
pm2 state: restart #16, PID 50271, online

## 🌅 FIRST THING TO READ NEXT SESSION

**Bot is fully configured and running on its leanest production setup.** 9 PRs merged today across infrastructure, architecture, and cost. Nothing pending. Key items to be aware of:

1. **Auto-deploy is live.** Push to master (via PR + admin merge) triggers CI + SSH + pm2 restart in ~90 seconds. No more manual `pm2 restart` trips.
2. **Branch protection + ruleset active on master.** Direct pushes blocked (except admin override). Justin opens PRs, Giuseppe reviews/approves/merges.
3. **All agents on Claude Sonnet 4.6.** Zero Opus usage in production code. Expected daily burn €8-18.
4. **3-leg split-position is live** — schema, monitor, alerts, and prompts all aligned. Orphan-trade bug from Day 1 is eliminated.
5. **10-instrument universe** — tight-spread core only (4 FX majors, 3 indices, 3 commodities).

## 📋 What shipped today (9 PRs)

| PR | Commit | Purpose |
|---|---|---|
| 1 | `2bfc0e1` | CI npm install fix + revert "No position cap" agent hint |
| 2 | `b726086` | CODEOWNERS (auto-route PRs to Giuseppe) |
| 3 | `d26d217` | pull_request trigger for CI (fixes required-status-check chicken-egg) |
| 4 | `475f2d7` | **3-leg architecture** (schema + monitor + alerts + agent log_trade; 5 phases, 660+ LOC) |
| 5 | `7ff76cd` | Remove Asian Open kill zone + 02:30 UTC researcher |
| 6 | `cb52f40` | ICT Opus→Sonnet, ICT effort→medium, drop 4H cron, skip out-of-killzone |
| 7 | `d416a7c` | All Opus → Sonnet (Swing + Review) |
| 8 | `4d51387` | Universe 25→10 + Swing mgmt 7×→3× + Swing effort→medium |
| 9 | `d7ed32a` | maxIter 15→8, max_tokens 16k→12k, swap AAPL/US30 for OIL/SILVER |

Every PR: CI-tested, admin-merged, auto-deployed. Zero direct pushes to master.

## 🎯 Final production config

**Agents — all Claude Sonnet 4.6:**
| Agent | Effort | maxIter | max_tokens |
|---|---|---|---|
| ICT | medium | 8 | 12,000 |
| Swing | medium | 8 | 12,000 |
| Review | max | — | 12,000 |
| Analyst | medium | — | 2,000 |
| Reflection | high | — | 4,000 |
| Researcher | medium | — | 1,000 |

**Universe (10):**
- Indices: US100, US500, DE40
- Commodities: GOLD, SILVER, OIL_CRUDE
- FX Majors: EURUSD, GBPUSD, USDJPY, AUDUSD

**Cron schedule (live):**
```
*/5 * * * *       ICT monitor + candle close (KILL-ZONE GATED)
*/8 * * * *       Capital keep-alive
30 5 * * *        Researcher daily pre-London
0 22 * * 0        Researcher weekly
30 21 * * 1-5     Swing daily
0 6 * * 1         Swing weekly outlook
0 8,13,17 * * 1-5 Swing mgmt (session boundaries: London Open / NY Open / London Close)
0 0 * * 0         Weekly Review (Sunday)
```

**Flags:**
- `DEMO_RELAXED_GATES=true` — Tier 3 active, kill-zone bonus +10 outside, R:R 1.5:1 for tight-spread symbols
- TD Grow paid plan active (5,000 credits/day)

## 💰 Cost projection

| Stage | €/day |
|---|---|
| Morning baseline (all Opus, 25 instruments, no gates) | 100-130 |
| End of day config (all cuts) | **8-18** |

For the remaining 12 demo days: **~€100-220 total**. Under the €200 target Giuseppe originally budgeted for 2 weeks.

Twelve Data paid tier: $79/mo ongoing.

## 🚧 Known open item — 3-leg trading behaviour unproven in live

The 3-leg architecture (schema + monitor + Telegram) is fully implemented and tested (143 vitest cases pass including specific TP1/TP2/TP3 handler regressions). But the bot hasn't fired a real 3-leg trade yet — Day 2 passed without a qualifying setup after all the infrastructure work. First live 3-leg trade will validate the whole end-to-end chain (agent opens 3 Capital positions → log_trade records A+B+C → monitor tracks → TP1 moves B+C to BE → etc.).

**Watch tomorrow's Telegram for** 🟢 *NEW TRADE* showing Leg A/B/C with TP1/TP2/TP3 R:R.

## 🛡️ Infrastructure state

- **Branch protection on master:** PR required, 1 approval required, required `Build + Test` status check, no force-push, no delete
- **Ruleset blocking `main` recreation:** active
- **GitHub Pro:** active (€4/mo for private-repo branch protection)
- **Auto-deploy:** GitHub Actions `.github/workflows/deploy.yml` — CI test gate + restricted-command SSH deploy key
- **Deploy key on VPS:** `~/.ssh/github_deploy` (never leaves VPS). `authorized_keys` has `command="/home/bot/deploy.sh"` restriction
- **3 secrets in GitHub:** VPS_HOST, VPS_USER, VPS_SSH_KEY
- **CODEOWNERS:** `* @giuseppeportelli1403-ops`

## 🤝 Justin's merge — what survived vs what got reverted

From Justin's commit `9e095b0` (merged PR #67e67d9 earlier today):

**Kept in production:** 3-leg architecture (now code-complete), backtest engine, Tier 2 at 60, Tier 3 permanent at 50, outside kill-zone bonus +5, scanner cache TTL 15 min, per-instrument coordination lock, ICT + Swing prompt updates.

**Reverted during cost work:** Asian Open kill zone + 02:30 researcher (PR #5), 4H ICT cron (PR #6), Swing mgmt 7×/day (PR #8 back to 3×), "No position cap" agent hint (PR #1), 25-instrument universe (PR #8 trimmed to 10).

**Replaced:** Justin's deploy workflow (no CI gate, no restricted key) replaced with our CI-gated workflow.

Justin's real contributions (3-leg + backtest engine) survived. His risky behavioural changes (Asian sprawl, no-cap hint, 7×/day mgmt) were walked back.

## 📚 Reference docs (all in `audit/`)

- `audit/BENCHMARK_REPORT.md` / `.docx` — full benchmark vs Jesse/Freqtrade/Backtrader/Hummingbot (498 lines)
- `audit/ARCHITECTURE_offline_replay.md` / `.docx` — architecture spec for offline backtest harness (~700 lines, option (C) from the 3-leg decision — Justin ended up building this separately and we merged it)
- `audit/build_docx.py` / `build_architecture_docx.py` — pypandoc scripts to regenerate .docx from .md

## 🚦 Next session priorities

1. **Check tomorrow morning:** `"what did the bot do overnight?"` — pull pm2 logs, confirm kill-zone gate is skipping dead hours
2. **First 3-leg live trade** will be the infrastructure validation moment
3. **Anthropic dashboard** — confirm daily burn lands at €8-18 (steady state after today's dev restarts settle)
4. **Twelve Data dashboard** — confirm paid tier is working normally, no cap-exhaust errors
5. **Review agent Sunday 00:00 UTC** — first post-3-leg-upgrade weekly review

## 🧘 Session close state

Everything merged, deployed, healthy. Bot armed for tomorrow's London Open. Zero pending work items. Repo clean at `d7ed32a`, VPS synced.

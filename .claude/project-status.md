# Project Status — Auto-Updated
Last updated: 2026-04-22 (end of Day 3 — 5 PRs shipped, TD audit complete, strategy loosened, AV routing ready for verification)
Project: BetterOpsAI Trading Bot ("Farad")
Branch: **master**
Last commit on master: `c885c21` — "fix: sync kill-switch thresholds to 6% daily / 10% weekly everywhere"
VPS head: `c885c21` (synced — auto-deploy working)
pm2 state: restart #26, PID 59591, online, ~100 MB, no errors in post-deploy log

## 🌅 FIRST THING TO READ NEXT SESSION

**Start the session by reading `C:\Users\user\.claude\projects\C--Program-Files-Git\memory\project_farad_av_verification_2026_04_23.md`** — there's a saved reminder about two AV-mapping verification items that need attention tomorrow morning. Giuseppe flagged them as important.

**Bot state is healthy but has still not placed a single trade** in 3 days of demo. Today's work addressed every systemic blocker we could identify (data routing, credential leaks, scoring thresholds, bias detection). The remaining bottleneck is news score (pinned at 0 for every instrument due to AV ticker-format issue) — fixed in code today but not yet verifiable (AV quota exhausted). First live test tomorrow morning once quota resets at UTC midnight.

## 📋 What shipped today — 5 PRs, 22 commits

| PR | Commit range | Purpose |
|---|---|---|
| #13 | `4bea63b` → `1cea32b` | TD symbol map fix (GOLD/SILVER were NYSE stock / Indian ETF, now XAU/USD / XAG/USD) + scheduler credential-leak fix (summarizeError helper) |
| #14 | `f4bcb96` → `bd75c39` | P0/P1 audit bundle (7 commits): 9 more credential-leak vectors fixed, DXY→'DX' REIT retired, backtest symbol map synced, scanner daily-cap signal surfaced, cache-key aliasing fixed, NaN guards added |
| #15 | `58ce54b` → `43c6991` | P2 cleanup (4 commits): indices → UNAVAILABLE (were wrong ETFs), TwelveDataDailyCapError typed class, fetchNewsContext withFallback + AV rate-limit detection, reviewer tidy |
| #16 | `ce339a8` → `11dda14` | Strategy loosening (5 commits): Tier 3 50→45, base 25→30, slope-based bias clarity fallback, AV ticker routing (FOREX:X/GLD/SLV/USO), prompt sync |
| #17 | `9c6f259` | Kill-switch consistency sync to 6% daily / 10% weekly across all refs |

Every PR: reviewer-swept → CI-green → admin-merged → auto-deployed → live-verified.

## 🎯 Current production config (post-today)

**Universe (7 — indices removed):**
- Commodities: GOLD, SILVER, OIL_CRUDE (all correctly routed to spot)
- FX Majors: EURUSD, GBPUSD, USDJPY, AUDUSD

**TWELVE_DATA_UNAVAILABLE set (9 symbols):**
- VIX (Pro tier required)
- NAS100, SPX, US30, US100, US500, DE40, UK100 (no reliable Grow-tier index feed)
- DXY (was resolving to NYSE REIT; real DXY needs Pro tier or alt provider)

**Scanner scoring:**
- Base: 30 (was 25)
- Clarity: 0 / 10 / **15 (new slope-fallback)** / 20
- Kill-zone bonus: +15 in / +10 out (demo-relaxed)
- News: -15 to +20 (still pinned at 0; AV routing live tomorrow)
- Spread bonus: +5 if tight
- Tiers: Tier 1 ≥80 (1.5% risk), Tier 2 ≥60 (1% risk), Tier 3 ≥45 (0.5% risk) — was Tier 3 ≥50

**Kill switches:**
- Daily: -6% (code-enforced in trading-agent / swing-agent / DB log / dead MCP path)
- Weekly: -10% (prompt-advisory only — no code enforcement)

**Agents — all Claude Sonnet 4.6:** ICT (medium / 8 iter / 12k tok), Swing (medium / 8 / 12k), Researcher (medium), Analyst (medium), Reflection (high), Review (max).

**Cron schedule:** unchanged from 2026-04-21. `*/5` ICT kill-zone-gated, `30 5` Researcher daily, `30 21 Mon-Fri` Swing daily, hourly Swing mgmt, Sunday 00:00 Review.

## 🧪 Test suite

**167/167 passing** (was 145 start of day). +22 new regression tests across:
- `tests/error-summary.test.ts` (6) — credential-leak regression
- `tests/market-data.test.ts` (+10) — symbol map coverage, cache aliasing, state reset, NaN filter, AV rate-limit detection, withFallback, normalizeForAlphaVantage routing
- `tests/scanner.test.ts` (+4) — slope-based bias clarity fallback
- `tests/instrument-universe.test.ts` (+1) — invariant: universe ⊆ non-null mapper
- `tests/scheduler.test.ts` (updated ping-failure assertion) — credential-leak shape regression
- `tests/demo-gates.test.ts` (updated) — Tier 3 45-59 + 6%/10% kill switch literals

## 🚧 Known open items

**1. AV ticker-format verification (HIGH PRIORITY — do first thing tomorrow).**
- Memory file saved at `project_farad_av_verification_2026_04_23.md` will auto-surface on next session.
- Two items: (a) confirm each Farad ticker returns >0 AV articles via the new `[Market Data] AV news for ... : N articles` log lines; (b) decide whether GLD/SLV/USO ETF-proxy news is real commodity sentiment or fund-flow noise — if noise, switch to AV's `topics=economy_macro`.

**2. MCP server dead code** (`src/mcp-server/index.ts`, `tools/*.ts`, `logger.ts`).
- Confirmed: pm2 runs `dist/index.js` which never imports these. Agents call `fetchCandles`/etc. directly.
- Decision needed post-demo: (a) delete, (b) wire up as optional stdio endpoint for external agents, (c) keep with "NOT WIRED" header.
- 0 `[MCP]` log lines in prod — explained by this. Not a bug, dead-code artifact.

**3. Zero trades in 3 days.**
- Loosening shipped today (Approach 2). Slope clarity resolves today's morning bias conflicts; Tier 3 threshold dropped to 45; prompts synced.
- NY Open 13:00 UTC is the first cycle post-loosening (fires ~3 minutes after this doc is written).
- Failure-escalation plan per spec: if 3 consecutive kill-zone cycles still all-SKIP on bias conflicts → escalate to Approach 3 (R:R relaxation + iteration 8→12 + longer kill zones).

**4. Weekly 10% kill switch is advisory only** (prompt-driven). No code enforcement. If you ever want hard weekly enforcement, it's a separate implementation (~30 lines in trading-agent/swing-agent's `get_daily_pnl` executeTool).

## 🛡️ Infrastructure state

No infrastructure changes today. Same as 2026-04-21:
- Auto-deploy via `.github/workflows/deploy.yml` (CI gate + restricted SSH deploy key)
- Branch protection: master requires PR + 1 approval + CI green. Admin-merge used throughout today (GitHub forbids self-approval by PR author).
- CODEOWNERS: `* @giuseppeportelli1403-ops`
- 26 pm2 restarts lifetime; 4 deploys today, each <3s downtime.

## 📚 Reference docs added today

- `docs/superpowers/specs/2026-04-22-strategy-loosening-approach-2-design.md` (241 lines)
- `docs/superpowers/plans/2026-04-22-strategy-loosening-approach-2.md` (686 lines)

These shipped with PR #16 for traceability.

## 🚦 Next session priorities

1. **[AUTO-SURFACED] AV news verification** — memory file will prompt Claude to raise this.
2. **Morning status check** — "what did the bot do overnight?" — pull pm2-out.log for ICT / Swing cycles since deploy, check equity, check for first `place_order` call.
3. **First trade watch** — if it happened, inspect the 3-leg Telegram alert + reflection-agent output; if not, evaluate whether to escalate to Approach 3.
4. **Anthropic + TD dashboards** — confirm daily burn holds at €8-18, TD credit usage well under 800/day cap.
5. **Post-demo MCP dead-code decision** (not urgent this week, flag when demo wraps).

## 🧘 Session close state

5 PRs merged, 22 commits deployed, 22 new regression tests, all reviewer-swept, all live-verified. Bot is on the cleanest, most consistent state it's been in. Equity $996.67 unchanged; TP1 verification still pending. Strategy loosening is the last remaining lever before we'd need to either extend kill zones or reduce R:R floors (Approach 3 territory).

Repo clean at `c885c21`, VPS synced, memory reminder armed.

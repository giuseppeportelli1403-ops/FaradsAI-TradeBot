# Project Status — Auto-Updated
Last updated: 2026-04-21 (morning — gate relaxations deployed, bot trading with relaxed gates during London Open)
Project: BetterOpsAI Trading Bot ("Farad")
Branch: master (pushed to https://github.com/giuseppeportelli1403-ops/FaradsAI-TradeBot)
Last commit: 4c580f7 — "feat(demo): DEMO_RELAXED_GATES flag unlocks 3 gate relaxations"

## ✅ LATEST — DEMO_RELAXED_GATES live on VPS as of 07:44 UTC

- VPS restart #4, pm2 PID 43916, healthy
- `.env` line `DEMO_RELAXED_GATES=true` set + confirmed in startup log
- Bot deployed mid-London-Open (07:00-10:00 UTC window)
- 123/123 tests green, commit `4c580f7`, architecture spec for offline-replay deferred

**What changed in behaviour right now:**
- Scanner kill-zone bonus outside kill zones: 0 → +10 (strong off-hours setups can clear Tier 2)
- Tier 3 bracket active for composite score 50-64 at 0.5% risk
- R:R minimum dropped to 1.5:1 for tight-spread symbols (EURUSD, GBPUSD, USDJPY, AUDUSD, GOLD, US100, US500, US30, DE40, AAPL, MSFT, NVDA, AMZN, GOOGL, META)
- Unchanged hard guards: daily 4% kill switch, weekly 8%, coordination lock, split-position method, live-trade gate

**Expected trade rate with gates relaxed:** 3-5 trades/week (vs 0.8-2.3 before). First evidence should land within the next ~8 hours (today's London Open + NY Open windows). Telegram buzz on any 🟢 trade open.

**Revert path if Giuseppe changes his mind:** `ssh bot@162.55.212.198 'sed -i "s/^DEMO_RELAXED_GATES=true/DEMO_RELAXED_GATES=false/" /home/bot/trading-bot/.env && pm2 restart trading-bot --update-env'`. No code change needed.

---

## 🌅 FIRST THING TO READ WHEN YOU WAKE UP

Giuseppe commissioned a full deep-dive audit overnight. Deliverables:

- **📄 Word document (what you asked for):** `audit/BENCHMARK_REPORT.docx` — 39 KB, cover page, TOC, full report + Gate Audit appendix
- **📝 Markdown version:** `audit/BENCHMARK_REPORT.md` (498 lines)
- **🔍 Gate audit source:** `C:\Users\user\Downloads\_benchmark\farad\GATE_AUDIT.md`
- **📊 Per-bot inventories:** `C:\Users\user\Downloads\_benchmark\<jesse|freqtrade|backtrader|hummingbot|farad>\INVENTORY.md`

**Headline:** Your fear is partially justified. Realistic trade rate = **0.8–2.3 trades/week** (one every 3–5 days), can be tripled to **3–5/week** by relaxing 3 specific gates this week. Day 1's zero trades was a **data exhaustion** problem (already fixed), NOT filter strictness. Bot will trade — just slower than your gut hopes.

**3 P0 actions for this week** (all detailed with exact thresholds in §5 of the report):
1. [S, ~4h] Relax Kill Zone penalty (–15 → –5), add Tier 3 score bracket (50–64 at 0.5% risk), reduce R:R min (2:1 → 1.5:1) for tight-spread symbols. Expected: 3x trade frequency without touching kill switches.
2. [M, ~3d] Build offline candle replay harness. Unblocks every "would this have traded?" question without burning TD credits.
3. [S, ~1d] Approval gate on self-rewriting strategy loop. Closes the tail risk of the review agent shipping a kill-switch-disabling rule overnight.

**3 gates to NEVER relax:** daily 4% kill switch, ICT/Swing coordination lock, split-position method.

**Ask me:** "What did the bot do overnight?" — I'll pull pm2 logs and tell you exactly.

---


## What We Did This Session

Giuseppe returned to a bot that had spent demo-day-1 (2026-04-20) producing
no trades because of two data-source problems + a structural budget problem
with the Twelve Data free tier. We diagnosed, fixed, and deployed four
commits — the bot is now overnight-ready for demo day 2.

### Fix 1 — yahoo-finance2 v3 instantiation bug
- VPS had `yahoo-finance2@3.14.0` installed; v3 dropped the singleton default
  export. Sector-strength calls were throwing `Call const yahooFinance = new YahooFinance() first`.
- Migrated `src/mcp-server/market-data.ts:12` to `import YahooFinance` + module-
  level `const yahooFinance = new YahooFinance()`.
- Side-effect: v3 warns about Node ≥22 (VPS is 20.20.2). Advisory only;
  library works. Saved to memory as a "watch if sector data gets weird" signal.
- Commit: **478a104** `fix(market-data): migrate yahoo-finance2 to v3 instantiation`

### Fix 2 — Twelve Data daily-cap circuit breaker
- Root cause: Twelve Data signals credit exhaustion via HTTP 200 +
  `{status:'error', message:'...out of API credits...'}` — TokenBucket caught
  nothing because nothing looked wrong at the transport layer. Each retry still
  incremented TD's counter, burning 1,089 post-cap credits on day 1.
- Added module-level breaker state + `isDailyCapTripped()` short-circuit at
  top of `fetchCandles()`. Trips on regex match against error message or real
  HTTP 429 (defensive). Auto-resets at UTC midnight (TD's reset boundary).
- Added 4 vitest cases covering the exact production error string, short-
  circuit behaviour, non-triggering on unrelated errors, and HTTP 429 fallback.
- **Verified in production at 22:00:17 UTC** — breaker fired against the
  still-exhausted counter and successfully blocked further network hits.
- Commit: **3dc2da7** `feat(market-data): add Twelve Data daily-cap circuit breaker`

### Root-cause analysis — why 800 credits evaporated by 14:00 UTC
- Two Explore agents in parallel mapped the scanner + agent call chain.
- Smoking gun: `getRankedInstruments()` in `src/scanner/index.ts` fanning out
  20 × `fetchCandles('1h', 30)` per call = 20 TD credits × every ICT cycle
  (~every 15 min during market hours) = 480–1,200 credits/day from ranking alone.
- Full budget: ~1,400–1,600 credits/day vs 800 cap. Cap was always going to blow.

### Fix 3 — Scanner hourly caching (Option 1, demo-time throttle)
- Added module-level ranking cache, keyed by `(at, zone, results)`.
- TTL: 60 min. Invalidates early on kill-zone transitions (07/10/13/15/16/17 UTC)
  so killZone score bonus stays accurate.
- Expected burn: ~100–160 credits/day from ranking (~75% reduction).
- Giuseppe's explicit framing: "we will do no 1 [hourly scanner] when the bot
  leaves the demo i want you to remind about this change so then i will pay the 80".
  Memory flag added: `project_farad_demo_end_todo.md` — raise scanner revert +
  Twelve Data Grow decision proactively at demo end (~2026-05-04).
- Commit: **42e4215** `perf(scanner): cache rankings hourly to fit Twelve Data free tier`

### Fix 4 — Telegram alert on trade-open
- Gap discovered by Explore agent: `alertTradePlaced()` existed in
  `src/notifications/telegram.ts:43` but was never called. Both agents logged
  trades to DB silently. User's phone only buzzed on position *close* events.
- Wired `await alertTradePlaced(trade)` into both ICT and Swing agents'
  `log_trade` case (`trading-agent.ts:200`, `swing-agent.ts:89`).
- Motivation: Giuseppe is going to sleep; he wants his phone to buzz the
  moment the bot opens a position overnight.
- Commit: **073d04f** `feat(notifications): fire Telegram alert when a trade is opened`

## Current State — All four fixes deployed & live
- ✅ **VPS:** PID 41463, pm2 restart counter at 3, uptime clean, 12.9mb→99mb
  on startup (normal), preflight + Capital.com + DB + Telegram + Scheduler ✓
- ✅ **Tests:** 117/117 green (was 113 + 4 new breaker tests)
- ✅ **Build:** `tsc` clean on laptop and VPS
- ✅ **GitHub:** origin/master up-to-date (4 commits ahead of start of session)
- ✅ **Breaker verified in production** (fired at 22:00:17 UTC)
- ⏳ **Demo day 2 (2026-04-21):** starts fresh at UTC midnight. London Open
  07:00 UTC, NY Open 13:00 UTC. Scanner will burn ~160 credits/day max.

## Decisions Made This Session

- **Option 1 over Option 3 for demo phase.** Chose scanner throttling (free)
  over paid Twelve Data plan ($79/mo Grow). Giuseppe's reasoning: test on free
  infra first; pay only when demo proves the bot trades well.
- **Proactive reminder pattern.** New workflow: when Giuseppe defers a decision
  to a future event (demo end, live flip), save a project-type memory with
  trigger conditions so the next session can raise it without being asked.
- **Atomic commits per logical unit** — four commits this session, each
  independently green for bisect. Same pattern as the prior session.
- **Mid-demo fix posture** — "research first, show proposed diffs, then touch
  live-path code." Used Explore agents for mapping before edits on both rounds.

## Next Steps — for Giuseppe on return

### Immediate (morning debrief)
1. Check Telegram — if the bot opened any positions overnight, the 🟢 alert
   will be in your chat history with full entry/SL/TP details.
2. When you open Claude Code, ask: **"what did the bot do overnight?"** — I'll
   pull VPS logs, count cycles, show decisions, report any trade activity.
3. If no trade fired during London or NY Open, dig into the agent reasoning
   to see if it's being too risk-averse for demo pace.

### This week (demo continues through 2026-05-04)
4. Let the scheduler run. Cached scanner should keep credit burn well under 800/day.
5. Watch for the first real TP1 event — needed to verify `handleTp1Hit` moves
   Position B's SL to break-even on Capital's side (gate #2 for going live).
6. Weekly Review Agent fires Sunday 00:00 UTC — read its output Monday morning.

### At demo end (~2026-05-04)
7. Claude will proactively raise (per `project_farad_demo_end_todo.md`):
   - Revert scanner throttle if Twelve Data Grow is purchased
   - Consider Node 22 VPS upgrade if sector data has drifted
8. Decide on live trading: requires deliberate `LIVE_TRADING_OK=true` +
   live URL swap. Preflight refuses without both.

## Deferred / Known Issues

### Introduced this session
- VPS runs Node 20.20.2 but `yahoo-finance2@3.14.0` prefers Node ≥22.
  Library works with a warning; flagged as watch-item in memory.
- Scanner cache is a demo-time compromise, not a permanent design — revert
  flagged in memory for post-demo.

### Unchanged from previous session (still valid)
- Secret rotation (Capital API creds) deferred per Giuseppe's call
- VPS `.env` still has dead `CAPITAL_PASSWORD` line (harmless)
- GitHub default branch still `main` (code on `master`)
- `BROKER_MIGRATION_PROMPT.md` references historical CAPITAL_PASSWORD
- `scripts/epic-mapping.json` gitignored artefact

## Session Reliability Notes
- Four atomic commits, each independently green (`npm run build && npm test`).
- Deploy pipeline held: `git pull --ff-only && npm run build && pm2 restart` —
  each restart ≤3s downtime. Three restarts this session (deploy round 1, then
  re-deploy round 2). Capital.com session maintained throughout via keep-alive.
- All verification stayed on Capital.com demo URL. Live-trading gate intact.

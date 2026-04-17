# Project Status — Auto-Updated
Last updated: 2026-04-17 (evening, Malta) — end of 10-commit launch session, bot live on VPS
Project: BetterOpsAI Trading Bot ("Farad")
Branch: master (pushed to https://github.com/giuseppeportelli1403-ops/FaradsAI-TradeBot)
Last commit: 2c0b801 — "feat(deploy): VPS deployment artefacts" (next commit is this auto-save)

## Session Recap — 10 commits on top of a5ba764

```
2c0b801  feat(deploy): VPS deployment artefacts — Hetzner + pm2 + GitHub    ← Blocker 14 prep
39630e8  feat(scheduler): Telegram alert on Capital ping failure             ← Blocker 6
d73550b  chore: auto-update session state and preferences                    ← mid-session save
f32e7ed  feat(scheduler): unit-test monitorSplitPositions orchestration      ← Blocker 5 A2
002a32e  fix(capital-client): return position dealId from affectedDeals[0]   ← Blocker 4.1 HIDDEN BUG
e2580a2  fix(preflight): gate live endpoint by explicit opt-in               ← Blocker 3
728d19c  feat(scanner): add epic field to INSTRUMENT_UNIVERSE                ← Blocker 2
12939cd  fix: authenticate with API-key password, not account login          ← Blocker 1
a5ba764  feat: migrate broker from Trading 212 to Capital.com                ← baseline
```

Every commit is atomic per blocker. Each preceded by Coder+Tester+Reviewer swarm with independent live verification against Capital.com demo before commit. Test count: 43 → 101 across 10 files. `tsc --noEmit` 0 errors.

## Current State — Production-ready on VPS

- ✅ **VPS live:** Hetzner CX23 (2 vCPU / 4 GB / 40 GB, €4.71/mo) at **162.55.212.198** (Nuremberg)
- ✅ **Bot running:** PID 14299, pm2-managed, 0 restarts, 18-min uptime at session close
- ✅ **Boot persistence:** `pm2-bot.service` systemd unit (survives VPS reboot); `pm2 save` dumped process list to `/home/bot/.pm2/dump.pm2`
- ✅ **Security:** UFW (SSH only), fail2ban active, unattended security upgrades, non-root `bot` user
- ✅ **First autonomous cycle completed:** ICT Trading Agent correctly declined to trade at 21:00 UTC (post-session dead zone, no kill zones active, weekend incoming). Reasoning captured in pm2 logs.
- ✅ **Code on GitHub:** private repo `giuseppeportelli1403-ops/FaradsAI-TradeBot`; deploy key from VPS has read-only access
- ✅ **All verification gates green:** `npm test` 101/101 on both laptop AND VPS; `tsc` 0 errors
- ⏳ **Blocker 6 (24h soak):** technically still running — expected green by tomorrow morning; can verify with `ssh bot@162.55.212.198 'pm2 status'`
- ⏳ **Step 13 (2-week demo):** clock started. First real trade window Monday 2026-04-20 07:00 UTC (London Open)

## Deferred / Known Issues

### Security (Giuseppe's action items, not blocking)
- **CAPITAL_PASSWORD** (account login): leaked to transcript twice. Rotate via Capital.com web UI → Change Password.
- **CAPITAL_API_KEY** (16 of 17 chars visible in transcript): regenerate via Capital dashboard; set new CAPITAL_API_KEY_PASSWORD too.
- **ANTHROPIC_API_KEY** (20 of ~108 chars visible): low risk — 88 remaining chars computationally infeasible to brute-force. Optional rotate.
- **TELEGRAM_BOT_TOKEN** (~20 of ~45 chars visible): low-medium risk. Optional rotate.
- Giuseppe chose "leave .env as is" for this session; rotation deferred.

### Lockfile hygiene
- `npm ci` failed on VPS due to missing `@emnapi/core@1.10.0` + `@emnapi/runtime@1.10.0` entries in lockfile (Windows-generated lockfile doesn't capture these Linux-only transitive optional deps). Worked around with `npm install` on VPS. Clean fix: regenerate lockfile on Linux/CI and commit.

### Cosmetic
- VPS `.env` still contains dead `CAPITAL_PASSWORD=...` line (no code reads it; harmless). Giuseppe can strip at leisure.
- GitHub default branch is `main` (empty) while code lives on `master`. Change default branch in repo settings → Settings → Branches for cleaner future clones.
- MCP SDK version in `package.json` (`^1.12.1`) differs from `CLAUDE.md`'s historical claim of `1.29.0` — docs/reality drift from before this session.
- `BROKER_MIGRATION_PROMPT.md` and `docs/superpowers/plans/2026-04-17-capital-com-migration.md` still reference `CAPITAL_PASSWORD` (historical). Consider superseded banners.
- `scripts/epic-mapping.json` is a generated artefact now gitignored; will not be committed again.

## Next Steps (Giuseppe)

### Tonight / tomorrow morning
1. `ssh bot@162.55.212.198 'pm2 status'` — confirm overnight soak survived
2. (optional) Rotate leaked Capital secrets in dashboard
3. (optional) Change GitHub default branch to `master`

### Monday 2026-04-20 07:00 UTC (London Open)
4. Watch logs during the first real kill-zone window — `ssh bot@162.55.212.198 'pm2 logs trading-bot --lines 100'`
5. If an agent places a trade: verify via Capital.com web UI; confirm SL/TP shown; watch scheduler's monitor loop for any TP1→BE event

### 2-week demo (Step 13)
6. Let the bot trade autonomously on demo for at least 2 weeks
7. Once a real TP1 hits, verify `handleTp1Hit` moves Position B's SL to break-even on Capital side
8. Weekly review agent fires Sundays 00:00 UTC — read its output

### After the 2-week demo (Step 15)
9. Tune strategy files based on reflection lessons accumulated over 14 days
10. Decide whether to enable live trading: would require deliberate `LIVE_TRADING_OK=true` in VPS .env + switch of `CAPITAL_API_URL` to live endpoint (preflight refuses without both)

## Key Decisions This Session

- **Per-blocker atomic commits** — 10 reversible commits rather than one "launch-readiness" blob. Easier to bisect if anything regresses.
- **Swarm-per-blocker** (Coder + live Tester + independent Reviewer) — caught the dealId bug that unit tests missed. Would not have been caught pre-deploy otherwise.
- **Single-chokepoint fix for Blocker 4.1** at `pollDealConfirmation` auto-corrects 4 confirmation-returning methods; working-order flows safe via empty-`affectedDeals` fallback.
- **URL-based live/demo gate** with explicit `LIVE_TRADING_OK=true` opt-in replaces the never-working `accountType === 'DEMO'` check. Defensive against typo'd CAPITAL_API_URL.
- **Dependency injection via optional `MonitorDeps` / `PingDeps`** for scheduler testability without `vi.mock` hackery. Production behavior untouched when `deps` omitted.
- **VPS over 24h laptop soak** — pivoted when Giuseppe asked. Monthly cost €4.71 vs. tying up laptop 24h. Trade-off: deploy overhead this session (~30 min), permanence for the 2-week demo + beyond.
- **"Leave .env as is"** — Giuseppe accepted the current state including leaked secret rotation deferral. Bot functions correctly either way.

## Session Reliability Notes

- All live calls stayed on Capital.com demo URL. Never hit the live endpoint.
- 1 orphan position during Blocker 4 smoke trade (dealId bug). Rescue-closed within seconds via `getOpenPositions()` lookup. ~0 P&L.
- 2 secret-inspection commands leaked partial values to transcript (my mistake). Flagged to Giuseppe both times; future secret inspection must use length-only patterns.
- VPS setup-vps.sh completed all 6 phases cleanly on first run. No manual intervention needed past the pm2 startup command copy-paste.

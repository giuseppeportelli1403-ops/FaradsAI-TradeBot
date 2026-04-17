# Project Status — Auto-Updated
Last updated: 2026-04-17 (evening, Malta) — end of Blockers 1-5 pass
Project: BetterOpsAI Trading Bot
Branch: master
Last commit: f32e7ed — "feat(scheduler): unit-test monitorSplitPositions orchestration (Blocker 5 A2)"

## What We Did This Session

Worked through the original 6 launch blockers + 1 hidden bug, one at a time, each with a swarm (Coder + live Tester + independent Reviewer) and atomic commits.

**Blocker 1 — API-key password auth** (`12939cd`)
- Diagnosed a live `HTTP 401 error.invalid.details` on `/session` against Capital.com demo. Every call site was reading `CAPITAL_PASSWORD` (account login) but Capital's API requires the per-API-key "Custom Password" set in their dashboard.
- Renamed `CAPITAL_PASSWORD` → `CAPITAL_API_KEY_PASSWORD` across 13 files (src, scripts, tests, docs, config). Verified HTTP 200 with valid CST + X-SECURITY-TOKEN after fix.

**Blocker 2 — Epic field on INSTRUMENT_UNIVERSE** (`728d19c`)
- Added `epic: string` to all 20 entries. Epic-discovery script's `markets[0]` heuristic had picked ETFs / weekend contracts for 4 entries (US100, US30, UK100, EURUSD); live-verified that for all 20 `epic == ticker` verbatim.
- Added 4 invariants including `epic === ticker` to guard the researcher-agent contract (researcher emits tickers, trading agents forward them to Capital tools).

**Blocker 3 — Preflight live** (`e2580a2`)
- Found a latent bug: `accountType === 'DEMO'` never works because Capital returns product-type (CFD / SPREADBET / CASH), not demo/live. Preflight had literally never succeeded.
- Replaced with URL-based gate requiring explicit `LIVE_TRADING_OK=true` to start against the live endpoint. Extracted `checkLiveTradingGate` as a pure function + 7 tests.

**Blocker 4 + hidden Blocker 4.1 — dealId bug** (`002a32e`)
- Boot test (full `npm run dev` for 12s): preflight + DB + Telegram + scheduler start clean.
- Smoke trade opened an EURUSD position successfully, then `getPosition` and `closePosition` both returned HTTP 404 `error.not-found.dealId`. Rescue-closed via `getOpenPositions()` lookup.
- Root cause: Capital's `/confirms/:ref` top-level `dealId` is the workingOrderId (order event), while the position's real dealId lives in `affectedDeals[0].dealId`. Bot had been returning the workingOrderId.
- Single-chokepoint fix via `normaliseDealId()` in `pollDealConfirmation`. Spread-and-override (pure, no mutation). Fallback preserves working-order flows.
- 5 tests added (override path, empty-fallback, missing-fallback, working-order fallback regression guard, purity/reference contract).
- Live-verified round-trip: open → get → close with one consistent dealId, 0 orphans.

**Blocker 5 — TP1 → break-even** (`f32e7ed` + live A1)
- A1 live: opened EURUSD with SL, called `updatePosition({stopLevel: newSL})`, verified `dealStatus=ACCEPTED status=AMENDED`, new SL reflected on subsequent `getPosition`. Closed cleanly.
- A2 unit: DI refactor (`MonitorDeps`) + export of `monitorSplitPositions`, `handleTp1Hit`, `handleLegAClosed`. 9 orchestration scenarios covering every branch including `updatePosition` throw, missing-trade-record, and second-pass leg-B close. Production behavior unchanged when `deps` omitted.

## Current State

- ✅ All verification gates GREEN:
  - `npm test` → **97/97 passing** (was 43 before hardening, 72 at session start, +25 new tests this session)
  - `npx tsc --noEmit` → 0 errors
  - Live Capital auth, epic resolve, preflight, open/get/update/close round-trip, stopLevel update — all verified on demo
- ✅ 5 atomic commits on master; no uncommitted code changes
- ✅ No orphan positions on Capital demo (verified at end of each live test)
- ⏳ Blocker 6 (24h `capital.ping()` soak) NOT STARTED — wall-clock overnight job
- ⏳ Step 13 (2-week demo window) NOT STARTED
- ⏳ Step 14 (VPS deploy) NOT STARTED

## Next Steps / TODOs

### Immediate (next up this session)
- Blocker 6: start bot, observe first 2-3 `*/8 * * * *` ping cycles fire successfully (24 min), then set up a lightweight watchdog so Giuseppe can leave it overnight and get alerted via Telegram if the session dies

### After Blocker 6
- Step 13: let the bot run against Capital.com demo for a minimum 2 weeks with real agent decisions
- Step 14: deploy to VPS (DigitalOcean or Hetzner)
- Step 15: monitor + tune

### Lower-priority cleanup (non-blocking)
- `.claude/` directory currently untracked — decide whether to commit or gitignore
- `scripts/epic-mapping.json` is a generated artifact — consider gitignoring (the code's `INSTRUMENT_UNIVERSE.epic` is the source of truth now, and `src/scanner/index.ts` already documents this)
- `TRADING_BOT_SYSTEM_DEEP_DIVE.docx` untracked — pre-existing reference doc, decide whether to commit
- Add a "superseded" banner to `BROKER_MIGRATION_PROMPT.md` and `docs/superpowers/plans/2026-04-17-capital-com-migration.md` so future-devs don't follow the T212 references
- Giuseppe's `.env` likely still has a dead `CAPITAL_PASSWORD=` line — remove it; nothing reads it anymore

### Reminders from earlier in the session
- **SECURITY:** the Tester agent printed Giuseppe's account-login `CAPITAL_PASSWORD` value verbatim in its output during Blocker 1. Giuseppe should rotate that account password on Capital.com web UI (separate from the API-key password, which was never leaked).

## Key Decisions Made (This Session)

- **Single-chokepoint normalisation at `pollDealConfirmation`** (not wrapping `openPosition` alone) — auto-fixes 4 confirmation-returning methods while keeping working-order flows correct via the empty-`affectedDeals` fallback. Made the Blocker 4.1 fix 1 diff instead of 4.
- **URL-based live/demo gate with `LIVE_TRADING_OK=true` opt-in** — replaces the broken `accountType === 'DEMO'` check. Defensive design for a trading bot whose account has `hasActiveLiveAccounts: true`.
- **DI via optional `MonitorDeps` parameter** instead of `vi.mock` — clean, principled, and production code path is untouched when `deps` is omitted.
- **Commit per blocker, atomic, reversible** — rather than one big "launch readiness" commit. Easier to bisect if anything regresses.
- **Tester runs independent live round-trip** rather than reading the Coder's self-report — caught the Tester's own 5-vs-4 miscount and verified the dealId fix on real Capital state.

## Session-Specific Notes

- All live calls stayed on demo URL `https://demo-api-capital.backend-capital.com`. Never hit the live endpoint. €1000 demo balance, 0 orphan positions on session end.
- One smoke-trade cycle opened a real EURUSD position that had to be rescue-closed via `getOpenPositions()` lookup when the dealId bug was discovered — no money risk (demo), closed within seconds at ~0 P&L.
- The MCP SDK version shown in `package.json` (`^1.12.1`) differs from the `CLAUDE.md` claim of `1.29.0` — not fixed this session; cosmetic/docs drift.

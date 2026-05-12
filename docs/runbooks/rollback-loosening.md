# Rollback Runbook — Trade-Frequency Loosening (PR 1 + future PR 2)

**Last updated:** 2026-05-12 (PR 1 shipped as commit `fa7a6f5`, pre-reload SHA `25e57c3`).
**Design ref:** `docs/superpowers/specs/2026-05-12-trade-frequency-loosening-design.md`
**Plan ref:** `docs/superpowers/plans/2026-05-12-trade-frequency-loosening-pr1.md`

## When to trigger

Any of these from `scripts/measure-loosening-impact.ts` (runs nightly via cron — see `crontab -l | grep measure-loosening`):

- **Trades/day < 1 for 3 consecutive days** — bot under-firing despite the loosening
- **Trades/day > 8 for 2 consecutive days** — bot over-firing; thresholds too loose
- **Rolling-3-day win rate < 35% absolute** (closed-trade sample ≥ 5)
- **Rolling expected R/trade < 0.2R** over min 10 closed trades — the failure mode where bot fires 3-5/day at decent win rate but average R collapses
- **Daily kill switch fired 2 consecutive days**
- **Audit script FP count > 0** (hallucinations appearing post-ship) — verify via `npx tsx scripts/audit-trigger-decisions.ts --days 7` and look for non-zero FP in the per-trigger confusion matrix

If any fires: the daily cron's exit code is 1 — easy to spot in `data/metrics/loosening-daily.log` (each day's run appends JSON + a "🚨 ROLLBACK TRIGGERS FIRED" stderr line).

## Steps (< 60 seconds end-to-end)

### 1. Identify the pre-PR SHA

```bash
ssh bot@162.55.212.198 "tail -5 ~/trading-bot/data/metrics/pr1-rollout.log"
```

Expected output: `Pre-reload SHA (rollback target): 25e57c369b1df13850edc133ac970a43299069b3`

(If `pr1-rollout.log` is missing or corrupted, the SHA is also in the commit message of `fa7a6f5` — search for "Pre-PR SHA for rollback".)

### 2. Stop the bot gracefully

```bash
ssh bot@162.55.212.198 "pm2 stop trading-bot"
```

This drains in-flight critical sections before shutting down.

### 3. Reset to pre-PR SHA

```bash
ssh bot@162.55.212.198 "cd ~/trading-bot && git reset --hard 25e57c3"
```

(Substitute the actual SHA if you're rolling back a later PR.)

### 4. Rebuild

```bash
ssh bot@162.55.212.198 "cd ~/trading-bot && npm run build"
```

### 5. Restart

```bash
ssh bot@162.55.212.198 "pm2 start trading-bot"
```

### 6. Verify clean startup

```bash
ssh bot@162.55.212.198 "pm2 logs trading-bot --lines 30 --nostream"
```

Look for:
- `[OK] Preflight checks passed.`
- `[OK] Telegram initialised.`
- `[Config] DEMO_RELAXED_GATES: ACTIVE (Tier 3 floor: 40 tight-spread / 45 medium-spread...)` — confirms OLD thresholds restored
- `[OK] Scheduler running. Bot is live.`

### 7. Notify (manual)

Send to BetterOps Telegram channel:

> 🚨 PR 1 trade-frequency loosening **rolled back** at $(date -u).
> Trigger fired: `<paste fired_trigger>`
> Pre-PR SHA: `25e57c3`
> New HEAD: `<output of git rev-parse HEAD>`
> Bot is back on prior strict thresholds (Tier 3 40/45, body 0.4, wick 1.0, Force-Propose 55).

### 8. Update memory entry

Edit `~/.claude/projects/C--Program-Files-Git/memory/MEMORY.md` to note the rollback. Add a new memory file `project_farad_loosening_rolled_back.md` with:
- Date + trigger
- Diagnostic data (last 3 days' `loosening-daily.log` content)
- Next steps (see below)

## No DB rollback needed

PR 1 only touches source code + prompts:
- `src/agents/spread.ts` (tier3FloorFor)
- `prompts/ict-agent.md` (4 threshold values)
- `tests/backtest-engine.test.ts` (5 test expectations)
- `scripts/measure-loosening-impact.ts` (the measurement script itself — keep this on rollback; it harmlessly reports 0/0/0 under old code)

DB schema, CHECK constraints, analyst_log table, trades table — all unchanged. Reverting code is sufficient.

The `scripts/shadow-llm-replay.ts` tool + detector parameterization + analyst-load-cap + per-instrument matrix (Phase 1 prereq commits `1135156`, `093748d`, `accbf8a`) are ALSO safe to keep on rollback — they're infrastructure / observability, no behavior change at current strictness.

## After rollback — diagnostic checklist

1. **Pull last 7 days of `data/metrics/loosening-daily.log`** — confirm which trigger fired, when, what the metrics looked like leading up.

2. **Run audit script over the rollback window:**
   ```bash
   ssh bot@162.55.212.198 "cd ~/trading-bot && npx tsx scripts/audit-trigger-decisions.ts --days 7"
   ```
   Compare FP count to the pre-PR-1 baseline (was 0 — see the MODIFY-removal session's audit notes).

3. **Pull a representative losing trade's pm2-out.log block** to determine whether failure was:
   - LLM over-eager (PR 2 prompt restructure issue — relevant for a future PR 2 rollback)
   - Math too loose (PR 1 threshold issue)
   - External factor (market regime, news event, broker issue)

4. **Pull the analyst_log for the rollback window** to see per-cycle APPROVE/REJECT distribution. If approval rate dropped, the analyst's CHECK 1 sanity gate may have been overwhelmed by the loosened candidate flood.

5. **Open a follow-up spec brainstorm** — feed the rollback's failure data into the design phase before the next attempt. Don't just re-ship with slightly different numbers.

## Optional automation (deferred)

A cron job that automatically runs steps 2-6 when the measurement script's exit code is non-zero would shave manual response time from minutes to seconds. NOT in initial scope — the manual procedure is fast enough (< 60s for someone with VPS access) and the human-in-the-loop step at #7 (Telegram notify) is a good circuit breaker against false-positive rollbacks. Build this if rollback frequency proves high enough to warrant the automation.

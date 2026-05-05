# Phase 2 Deep Audit — Findings

**Date:** 2026-05-05
**Method:** 3 parallel `Explore` agents (read-only) + DB query + log analysis. Same methodology that found the Phase 1 analyst bug. Coverage: every LLM-calling agent, scheduler, news pipeline, calendar veto, market-data layer, broker integration, capital-client, risk gates.

## TL;DR

The **trading and risk-gate side is well-hardened** — the 2026-04-29 audit-3 fixes resolved most placement/race/orphan issues. Remaining residual risks there are P2 (operator-handled).

The **information and learning side is a swiss-cheese of silent failures**. Every non-analyst LLM-calling agent has the same broken pattern that just bit the analyst (free-form-prose-then-JSON), plus the news/scheduler layer has half a dozen silent-failure or stale-state bugs. This is the actual reason Giuseppe sees "0 progress in 3 weeks" — the bot has no working memory, no real research context, no learning loop.

## Severity legend

| Tier | Meaning |
|---|---|
| **P0** | Live data loss, silent failure that hides itself, missing alert. Fix this batch. |
| **P1** | Functional bug or race that produces wrong-but-valid output. Fix soon. |
| **P2** | Imprecision, edge-case, ergonomic. Defer unless empty queue. |

## Findings — LLM-calling agents (same pattern as the analyst bug)

| # | Agent | File | Lines | Pattern | Symptom | Severity |
|---|---|---|---|---|---|---|
| L1 | Reflection | `src/agents/reflection-agent.ts` | 29-68 | Free-form prose → `parseLastJsonObject`. Haiku 4.5, max_tokens 4000. Trade record alone is 1-2k tokens. Verbose lesson output requested. **Silent skip on parse fail (lesson NOT saved).** | DB has 5 lessons total; should be ~30 if learning loop ever worked. **Bot has no memory of what worked.** | **P0** |
| L2 | Researcher | `src/agents/researcher-agent.ts` | 83-143 | Free-form text + regex `/\[[\s\S]*?\]/` array extract. Haiku 4.5, max_tokens **1000** (extremely tight). On parse fail returns FAKE THEME with warning. Has a known-prior-bug comment (lines 119-123) admitting "researcher's brief has been a one-fake-theme document for an unknown number of cycles". | Bot reads market context that's literally fabricated; ICT decisions made on fake regime. | **P0** |
| L3 | Review (weekly) | `src/agents/review-agent.ts` | 55-91 | Free-form markdown + JSON extract. Haiku 4.5, max_tokens 12000 with ~10k input → only ~2k output budget. Multi-section JSON (report + ict_updates + banned_patterns + alerts) **does not fit**. Telegram-alerts on parse failure (better than others). | Weekly review fails silently; calibration metrics, banned-pattern detection, strategy updates all lost. | **P0** |
| L4 | EOD journal | `src/agents/eod-journal-agent.ts` | 122-172 | Markdown-only output. Haiku 4.5, max_tokens **2000**. Multi-section markdown plus ~2k input tokens. **Silent skip on empty/truncated output.** No Telegram alert. | DB has minimal journal entries; no daily narrative for next-day context. | **P0** |
| L5 | ICT main agent | `src/agents/trading-agent.ts` | ~1370 | Already uses tool calling (forced via `tools: MCP_TOOLS`). Haiku 4.5 max_tokens 12000. Loop-exhaustion is the only failure mode (logged + tolerable). | None (this surface is not vulnerable). | **N/A** |
| L6 | Analyst | `src/agents/analyst-agent.ts` | post-Phase 1 | Now uses forced `submit_decision` tool calling (Phase 1 fix shipped today). | Pre-deploy: 3 weeks of 0/6 parseable analyst calls. Post-deploy: awaiting first live test. | ✅ Fixed |

**Pattern:** All 4 vulnerable agents share — (1) Haiku 4.5 with tight max_tokens, (2) prompts that request verbose output, (3) free-form-prose-then-JSON parsing, (4) silent fail-closed (data lost), (5) zero integration test coverage. The Phase 1 analyst fix (forced tool calling) is the **proven blueprint** — same fix replicates to all four.

## Findings — Scheduler / News / Market-Data

| # | File | Lines | Issue | Severity |
|---|---|---|---|---|
| S1 | `src/mcp-server/market-data.ts` | 254 | Missing `TWELVE_DATA_API_KEY` returns `[]` silently from `fetchCandles` — no Telegram alert. Scanner downstream treats empty candles as neutral bias and filters the instrument; ops blames the strategy. | **P0** |
| S2 | `src/mcp-server/market-data.ts` | 502, 630, 1025 | Same pattern for `FINNHUB_API_KEY`, `FRED_API_KEY`, `MARKETAUX_API_KEY`. Calendar/macro/news degrades to empty or stale silently. | **P0** |
| S3 | `src/scheduler/index.ts` | 637-684 | If ICT cycle is still running on the next 15M candle close, the new candle close is **dropped silently** — entire 15-minute setup window skipped. | **P0** |
| S4 | `src/agents/reflection-agent.ts` integration via `src/scheduler/index.ts:297-330` | 297-330 | `queueReflectionIfFinalised` calls `d.getTradeById(tradeId)` to check status, but if that returns a stale cached object (status='open' when DB now says 'closed'), reflection is silently skipped on Leg-A/B-only SL closes. | **P0** |
| S5 | `src/news/calendar-veto.ts` | 242-243 | Inclusive boundary inequalities — events exactly at the post-window edge still trigger veto. ~1ms imprecision; minor but non-zero. | P2 |
| S6 | `src/scheduler/index.ts` | 293-419 | `monitorSplitPositions` makes 3+ calls to `d.getActiveSlTpOrders()` per tick. Race with Capital webhook (if implemented elsewhere) could leave a fully-closed trade stuck in `tp1_hit` / `tp2_hit` state. | P1 |
| S7 | `src/news/index.ts` | 84-99 | RSS articles merged with MarketAux but **tier weighting NOT implemented** — Tier-1 (regulatory) and Tier-3 (blog) weighted equally. Sentiment averaging diluted by `sentiment_score=0` defaults from RSS. | P1 |
| S8 | `src/scheduler/index.ts` | 733-736 | Initial RSS poll on startup wraps `pollAllFeeds().catch(...)` — silently swallows total-failure case. First 3-4 trading cycles after a VPS reboot operate with zero RSS context. | P1 |
| S9 | `src/mcp-server/market-data.ts` | 1025-1029 | `MARKETAUX_API_KEY` missing → `serveStaleOrEmpty` serves 4-hour-old news without setting `news_unavailable=true`. Bot trades on stale bearish news that's already priced in. | P1 |

## Findings — Broker / Risk Gates (mostly hardened)

The 2026-04-29 audit-3 fix batch resolved most issues. Residual:

| # | File | Issue | Severity |
|---|---|---|---|
| B1 | `src/mcp-server/capital-client.ts:730-782` | `/confirms` reconcile-on-timeout MITIGATED, but if the reconcile query itself fails, position can be orphaned (live on Capital, not in DB). | P0-residual |
| B2 | `src/mcp-server/capital-client.ts:793-814` | `affectedDeals[0]` selected without status validation — a multi-affect response with `[DELETED, OPEN]` would pick DELETED (warning logged but not enforced). Capital hasn't been observed returning multi-affect; severity is conditional. | P1 |
| B3 | `src/index.ts:9-39` | Shutdown race during in-flight `insertTrade()` — 500ms grace period helps but doesn't guarantee. Trade can be live on Capital but not persisted to DB. | P2 |
| B4 | `src/agents/trading-agent.ts:1084-1113` | Sequential leg placement — if rollback's `closePosition` itself times out, position stays open with manual reconcile required. Logged loudly; operator-handled. | P2 |

Everything else (proposal hash, coordination lock, daily kill switch, atomic token consumption, leg-C reflection columns, boolean coercion, TP2_HIT visibility, brief staleness) is **already fixed** as of 2026-04-29.

## Live evidence (DB + log)

- `analyst_log` since 2026-04-29: 10 rows. **1 APPROVE** (2026-05-05 08:02:21, the SILVER trade now open at +$3.09 UPL). 9 REJECT — 6× JSON parse fail, 3× 60s timeout (all pre-Phase-1-deploy).
- `trades`: 2 rows total. AUDUSD long 2026-04-23 (sl_hit, $0). SILVER long 2026-05-05 08:02 (open, score 60). Trade #2 confirms the analyst path can work end-to-end when the response fits.
- `lessons`: 5 rows total. Should be ~30+. Reflection agent silently skipping.
- `research_briefs`: not directly counted — but per code comment, "researcher's brief has been a one-fake-theme document for an unknown number of cycles."
- `daily_pnl_log`: schema mismatch (`daily_pnl_pct` column doesn't exist; dump showed `column not found` on the query I ran).

## Proposed Phase 2 fix batch

Ordered by leverage (highest impact first). Each is the same surgical pattern as Phase 1.

### Round 1 — replicate the Phase 1 analyst blueprint to the 4 broken agents

Each agent gets a forced tool call (define `submit_X` tool, set `tool_choice: { type: 'tool', name: 'submit_X' }`, drop `thinking: adaptive` if present). Tests cover the extractor; the wrapper is small.

| Order | Agent | Tool name | Estimated time |
|---|---|---|---|
| 1 | Reflection | `submit_lesson` | 30 min |
| 2 | Researcher | `submit_themes` | 30 min |
| 3 | EOD journal | `submit_journal` | 45 min (markdown is tougher to schema-fy — may keep as text but add explicit "no preamble" enforcement) |
| 4 | Review (weekly) | `submit_review` | 60 min (the largest schema — multi-section) |

**This Round alone would unblock the bot's memory, regime awareness, calibration loop, and journaling — the entire learning side.**

### Round 2 — Telegram alerts for missing/degraded data

Add a startup audit that screams when any required env var is unset. Add a `news_unavailable=true` propagation when MarketAux is stale-served. ~30 min total.

| Item | File | Estimated time |
|---|---|---|
| Startup env-var audit + alert | `src/preflight.ts` | 15 min |
| `news_unavailable` flag on stale-serve | `src/mcp-server/market-data.ts` | 15 min |

### Round 3 — scheduler robustness

| Item | File | Estimated time |
|---|---|---|
| Queue missed candle closes during cycle overlap (S3) | `src/scheduler/index.ts` | 45 min |
| Force-fresh `getTradeById` in reflection queue (S4) | `src/scheduler/index.ts` + DB | 20 min |
| Initial RSS retry-with-backoff (S8) | `src/scheduler/index.ts` | 20 min |

### Round 4 — RSS tier weighting (S7)

Real change to news scoring. Probably 1-2 hours including tests. Defer until Round 1-3 are done — meaningless if reflection/research aren't writing anyway.

### Round 5 (optional, low priority)

- Calendar-veto boundary precision (S5) — 5 min, cosmetic
- Capital affectedDeals[0] hardening (B2) — 20 min, conditional
- Daily PnL schema fix (the `daily_pnl_pct` column the audit query couldn't find) — 15 min, mostly diagnostic plumbing

## Verification still pending

- Phase 1 analyst tool-calling needs a live cycle that produces a candidate. The 09:15 cycle didn't reach the analyst (ICT decided no candidate). Next chance: any kill-zone cycle that finds a tradeable setup. Watch `pm2-out.log` for `[Analyst] stop_reason=...` lines.

## Recommendation

**Round 1 (replicate Phase 1 blueprint to 4 LLM agents)** is the single highest-leverage move available. It's the bug class that just produced 3 weeks of zero progress, and the fix is mechanical (we have the working pattern from analyst). Round 2 is cheap and prevents future silent regressions on env. Rounds 3-5 are valuable but lower urgency.

I propose doing Rounds 1+2 as a single batch (~3 hours of work, 5-7 commits, one merged deploy), then handing back to Giuseppe for monitoring before Round 3.

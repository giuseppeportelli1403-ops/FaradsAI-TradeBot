# Feature Specification: News Inputs Pruning — Reduce to 3 Authoritative Sources

**Feature Branch**: `spec/news-pruning`
**Created**: 2026-05-13
**Status**: Draft
**Input**: User description: "I want there to be 3 main news inputs, the 3 best ones from all listed in [the 2026-05-13 news audit]. Decisions: Finnhub calendar OUT. ActionForex / ForexLive / Investing Forex IN (promote to Tier 1). All other recommended drops apply (BBC, CNBC, Yahoo, MarketWatch, OilPrice, Wolf Street, ZeroHedge, dead Calculated Risk)."

---

## Context Summary *(non-template — added for grounding)*

The 2026-05-13 news audit (verified by Codex twin) established that the Farad bot currently ingests news from **4 real sources + 1 helper**:

| # | Source | Role | Decision |
|---|---|---|---|
| 1 | **MarketAux** (paid REST, capped 90/100 calls/day) | Real-time headlines with per-entity sentiment for `EURUSD` | **KEEP** |
| 2 | **Forex Factory calendar** (free XML scrape) | Scheduled macro events (FOMC, NFP, CPI, ECB) — powers calendar veto | **KEEP** |
| 3 | **Finnhub economic calendar** (free tier, unioned with FF) | Redundant calendar source — called from `trading-agent.ts:850, :1488`, `market-data-tools.ts:125`, and `researcher-agent.ts:231` | **DROP** (all 4 call sites + the function definition at `market-data.ts:500-524`) |
| 4 | **15 RSS feeds** (tiered 1/2/3, polled every 10 min — see `rss-feeds.ts:39-161`) | Tier 1 (5): Fed, ECB, BoE, BBC, CNBC. Tier 2 (6): ActionForex, ForexLive, Investing Forex, OilPrice, Investing general, Yahoo. Tier 3 (4): MarketWatch, Calculated Risk, Wolf Street, ZeroHedge. | **PRUNE to 6 feeds, all Tier 1** |
| 5 | Jina Reader (helper for article bodies) | Used by impact classifier when snippets are thin | **KEEP** |

The audit's load-bearing finding: **news scoring is NOT the trade-frequency bottleneck.** News score is a soft additive in the scanner composite (`scanner/index.ts:371, :406`, range −15..+10), the analyst LLM never reads a news score, and the only hard pre-LLM news-adjacent gate is the calendar veto (`trading-agent.ts:1487-1499`). This spec is therefore **a noise-reduction and authority-improvement effort**, not a trade-frequency fix.

### Target RSS feed set (6 feeds, all Tier 1)

| Feed | Currently | Action |
|---|---|---|
| Federal Reserve | Tier 1 | Keep |
| European Central Bank | Tier 1 | Keep |
| Bank of England | Tier 1 | Keep |
| ActionForex | Tier 2 | **Promote to Tier 1** |
| ForexLive | Tier 2 | **Promote to Tier 1** |
| Investing.com Forex Opinion | Tier 2 | **Promote to Tier 1** |
| BBC Business | Tier 1/2 | Drop |
| CNBC Top News | Tier 1/2 | Drop |
| Yahoo Finance Top Stories | Tier 2/3 | Drop |
| MarketWatch | Tier 2/3 | Drop |
| OilPrice.com | Tier 2 (OIL only) | Drop |
| Calculated Risk | Tier 3 (stale ~106 days per `rss-feeds.ts:146`) | Drop |
| Wolf Street | Tier 3 | Drop |
| ZeroHedge | Tier 3 (alarmist, never solo Cat A) | Drop |
| Remaining ~4 feeds | varies | Drop unless they fit Fed/ECB/BoE/forex-specialist criteria — to be confirmed when reading the full list |

**End state:** 6 RSS feeds, all Tier 1, all directly relevant to EUR/USD macro thesis.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Eliminate noise from the RSS cache (Priority: P1)

The bot owner wants the RSS cache to contain only macro-relevant content for EUR/USD. Today the cache mixes Tier-1 central-bank releases with Tier-3 alarmist blogs (ZeroHedge, Wolf Street) and dead/stale feeds (Calculated Risk last updated ~106 days ago). When the analyst prompt assembles news context, low-quality items dilute the signal even though they are downgraded to Cat C by the impact classifier.

**Why this priority**: Improves the quality of the news context passed to the LLM analyst without changing any scoring or gating logic. Lowest-risk change in the spec — pure deletion of feed entries.

**Independent Test**: After the change, the RSS aggregator polls only 6 feeds; `getAllCachedArticles()` returns 0 items from any dropped feed within one full poll cycle (10 minutes); existing impact-classifier and scanner tests pass without modification.

**Acceptance Scenarios**:

1. **Given** the `RSS_FEEDS` array in `src/news/rss-feeds.ts`, **When** the file is loaded, **Then** it contains exactly 6 feed entries: Federal Reserve, European Central Bank, Bank of England, ActionForex, ForexLive, Investing.com Forex Opinion.
2. **Given** the RSS aggregator polls on its 10-minute cron, **When** one poll cycle completes, **Then** every cached article's `feedName` field is one of the 6 retained feeds — no article from a dropped feed appears.
3. **Given** a Tier-2 keyword-only article that previously qualified via BBC/CNBC, **When** the same headline arrives via MarketAux, **Then** the impact classifier still classifies it correctly (regression test against existing fixtures).

---

### User Story 2 — Single calendar source (Priority: P2)

The bot owner wants one calendar source, not two. Today Forex Factory and Finnhub calendars are unioned at `trading-agent.ts:1487-1490` for the calendar veto. Finnhub is a backup but adds an API dependency, rate-limit risk, and divergence risk (the two sources can disagree on an event's impact level).

**Why this priority**: Lower priority than RSS pruning because it touches the calendar veto path (which IS a hard pre-LLM gate). Must be done carefully to ensure FF alone provides full coverage of FOMC/NFP/CPI/ECB events.

**Independent Test**: A regression suite of the last 30 days of calendar events shows FF-only coverage matches FF+Finnhub union coverage for all events tagged `impact: high` and country `US`/`EU`/`DE`/`FR`/`IT`/`ES`. Any event present in the union but missing from FF-only is flagged for manual review before the change ships.

**Acceptance Scenarios**:

1. **Given** the calendar veto is queried for a date with a known FOMC announcement, **When** FF-only mode is active, **Then** the FOMC event is in the returned event list with `impact: high`.
2. **Given** the calendar veto is queried for the same date, **When** the result is compared to the prior FF+Finnhub union output, **Then** the high-impact event sets are identical for US + eurozone countries.
3. **Given** the Finnhub calendar code path is removed, **When** the bot runs a full ICT cycle, **Then** no log line references "finnhub" or "fetchEconomicCalendar" outside of historical context.

---

### User Story 3 — Promote forex-specialist feeds to Tier 1 (Priority: P1)

The bot owner trades EUR/USD and wants forex-specialist commentary (ActionForex, ForexLive, Investing Forex) treated with the same authority as Fed/ECB/BoE press releases. Today they are Tier 2, which means their articles need keyword-match boost to reach Cat A in the impact classifier. After this change they reach Cat A on tier alone.

**Why this priority**: The Tier-2 noisy peers (BBC, CNBC, Yahoo, MarketWatch) are being dropped in the same change, so the remaining "Tier 2" group would be these three forex specialists. Promoting them to Tier 1 collapses the tier hierarchy from 1/2/3 to just Tier 1 — simpler, fewer code paths.

**Independent Test**: Run the impact classifier on a corpus of 50 historical ActionForex/ForexLive/Investing Forex articles. Under the new tier assignment, articles that were previously Cat B now reach Cat A when keywords match an event window; articles that did not match keywords remain Cat C (no false Cat A promotions).

**Acceptance Scenarios**:

1. **Given** an ActionForex article tagged `EUR/USD` published 30 minutes before an ECB event, **When** the impact classifier runs, **Then** the category is Cat A.
2. **Given** a generic ActionForex weekly recap with no event-keyword match, **When** the impact classifier runs, **Then** the category is Cat C — not auto-promoted to A by tier alone.
3. **Given** the `RSS_FEEDS` array after this change, **When** the tier values are inspected, **Then** all 6 feeds have `tier: 1`.

---

### User Story 4 — No regression in scanner composite or analyst behaviour (Priority: P1)

The bot owner needs confidence that pruning news inputs does not silently change trade frequency or quality. The scanner composite includes a news score; if that score shifts because of fewer feeds, trade frequency could change in an uncontrolled way.

**Why this priority**: Safety. The change is supposed to be neutral on trade execution. Any unexpected delta must be caught before merge.

**Independent Test**: If a scanner replay harness exists in `tests/` or `scripts/`, run it against 7 days of fixtures. **If no replay harness exists, the test is satisfied by**: (a) full 901-test vitest suite passing without fixture modification, AND (b) `scripts/audit-trigger-decisions.ts` agreement rate within ±0.2% of the pre-change 95.2% baseline. The composite-score replay metric is the *ideal* test; the audit-script + suite combination is the *minimum required* if replay is infeasible.

**Acceptance Scenarios**:

1. **Given** the 901-test vitest suite at HEAD `3bc90ca`, **When** all tests run after the change, **Then** all pass without modification of test fixtures (any fixture change must be reviewed in the PR).
2. **Given** a snapshot of yesterday's scanner cycles, **When** re-run with pruned feeds, **Then** APPROVE/REJECT decisions match for ≥95% of setups.
3. **Given** the `audit-trigger-decisions.ts` deterministic vs LLM script, **When** run before and after the change, **Then** the agreement rate does not drop below the pre-change baseline (currently 95.2% on 5 triggers).

---

## Functional Requirements

- **FR-1**: `src/news/rss-feeds.ts` MUST export exactly 6 feed entries: Federal Reserve, European Central Bank, Bank of England, ActionForex, ForexLive, Investing.com Forex Opinion. All MUST have `tier: 1`.
- **FR-2**: `src/news/rss-aggregator.ts` MUST NOT special-case any dropped feed; the file should be agnostic to which feeds are configured.
- **FR-3**: The Finnhub calendar function `fetchEconomicCalendar` MUST be deleted from `src/mcp-server/market-data.ts:500-524`. **All four call sites MUST be updated to `fetchForexFactoryCalendar` (or removed if dead):**
  - `src/agents/trading-agent.ts:797` — import
  - `src/agents/trading-agent.ts:850` — `get_economic_calendar` MCP tool body
  - `src/agents/trading-agent.ts:1488` — calendar veto union (replaced by FF-only call at :1487-1491)
  - `src/mcp-server/tools/market-data-tools.ts:15, :125` — second `get_economic_calendar` MCP tool body + description text mentioning Finnhub at `:120`
  - `src/agents/researcher-agent.ts:13, :231` — researcher brief generation
- **FR-4**: `src/news/forex-factory-calendar.ts` becomes the sole calendar source. No new behaviour is introduced — just removal of the union with Finnhub.
- **FR-5**: The impact classifier's keyword-match logic MUST continue to function for the retained feeds; no keyword list changes are in scope.
- **FR-6**: The MarketAux code path (`market-data.ts:681-1136`) MUST NOT be modified.
- **FR-7**: `src/news/rss-aggregator.ts:228` contains tier-branch logic (`article.tier === 1 ? 1.0 : article.tier === 2 ? 0.6 : 0.3`) that becomes effectively `1.0` for every article after this change. The branch logic is intentionally PRESERVED (not simplified to `1.0`) because the `FeedTier` type still admits values 2 and 3 for future re-introduction. A code comment MUST be added next to the line explaining this.
- **FR-8** *(resolved 2026-05-13)*: Rollback mechanism is `git revert <merge_sha>` + push + `pm2 restart trading-bot` on VPS. No env flag. Decision rationale: the change is a neutral data-source swap on a code path FF already participates in (the Promise.all union at `trading-agent.ts:1487` already calls FF), so no new failure mode is introduced; the established Farad convention from PR #1 ([[project_farad_pr1_loosening_shipped]]) and PR #23 ([[project_farad_dc_phase1_shipped]]) uses git-revert + the 5-day false-positive measurement window.

## Non-Functional Requirements

- **NFR-1**: All 901 vitest tests at HEAD `3bc90ca` must pass without test modification (or modifications must be reviewed).
- **NFR-2**: No new external dependencies. Pure deletion + tier reassignment.
- **NFR-3**: Plain-English commit messages. PR description follows the same audit-trail style as PR #1 / PR #23.

## Out of Scope (Non-Goals)

- Adding new news sources (Finnhub forex-news, FinBERT, etc.) — these are tracked in [[project_farad_news_pipeline]] as future work, not this iteration.
- Changing the news scoring algorithm or its weights in the scanner composite.
- Adding DB persistence for headlines (instrumentation gap noted in the audit — separate spec).
- Changing the analyst prompt's Cat-A REJECT rule.
- Changing the calendar veto windows or thresholds.
- Removing the `isNewsOpposing` / `getNewsRiskFactor` helpers — even though they are dead, removing them is a separate cleanup.

## Rollback Plan

- **Mechanism (decided 2026-05-13):** `git revert <merge_sha>` on master, push, `ssh bot@162.55.212.198 'cd /home/bot/trading-bot && git pull && pm2 restart trading-bot'`. Rollback latency ~5 minutes end-to-end.
- **5-day false-positive window** matches the convention from [[project_farad_dc_phase1_shipped]] — measure noise-reduction metric (article count per cache cycle) and watchdog the scanner composite drift daily through 2026-05-19.
- **Rollback triggers (any one):** trade frequency drops >15% vs prior 5-day baseline; `[analyst-coercion]` log line count changes; scanner composite drift >2 points on >5% of replayed setups; any unexpected calendar-veto miss on a known FOMC/NFP event.

## Success Criteria

- 6 RSS feeds active, all Tier 1.
- One calendar source (Forex Factory only).
- 901/901 tests pass.
- Trade frequency over 5 trading days within ±15% of the pre-change baseline.
- Scanner composite score drift on replayed setups ≤2 points on ≥95% of items.
- No regression in the [analyst-coercion] log monitored daily per [[project_farad_modify_removed]].

---

## Verification Status

- Initial audit: 2026-05-13 (Claude general-purpose agent + Codex twin, both agreed on sources, file:line cites, and the news-not-the-bottleneck verdict).
- Spec author: Claude Code, this session.
- Spec to be reviewed by: Codex twin (pending — Task #5 in this session's task list).
- Final approval: User (Giuseppe), pending review of this document.

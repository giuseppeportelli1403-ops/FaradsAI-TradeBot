# Phase 2 — Rounds 1+2+3 Implementation Spec

**Date:** 2026-05-05
**Author:** Claude
**Status:** Approved (Giuseppe pre-authorized — "do everything, one by one")

References: [`2026-05-05-phase-2-audit-findings.md`](./2026-05-05-phase-2-audit-findings.md) for the bug catalogue. This spec is the implementation design only.

## Goal

Replicate the proven Phase 1 analyst tool-calling blueprint to the 4 broken LLM-calling agents (Round 1), add startup alerts so silent env failures stop being silent (Round 2), and harden the scheduler against cycle-overlap drops + stale state (Round 3). Each item is independently testable and deployable.

## Approach decision

**Approach chosen: per-agent dedicated tool (Approach 1).** Each LLM agent gets its own tool with its own schema (`submit_lesson`, `submit_themes`, `submit_review`, `submit_journal`). Considered but rejected:

- **Approach 2 — shared `submit_output` tool with a discriminated-union schema.** DRY but couples 4 agents that genuinely differ in output shape (lesson record vs string array vs multi-section JSON vs markdown narrative). The DRY win is < 50 LoC; the coupling cost is real if a future schema change breaks one agent's contract while another rides along.
- **Approach 3 — extract `runToolCallAgent(tool, params, extractor)` wrapper in `llm-output.ts`.** Save boilerplate at the cost of an abstraction that has only one current consumer pattern (the analyst). YAGNI — easy to extract later if a third agent benefits.

**Decision rationale:** Approach 1 follows the analyst fix pattern verbatim (proven), keeps each agent's contract local to its file (easier to debug and test), and matches the codebase's existing per-agent autonomy. Cost: ~150 LoC of new code across 4 files (a tool definition + an extractor per agent), all near-identical to the analyst's `submit_decision` shape.

## Round 1 — 4 LLM agents → forced tool calling

Each agent's existing free-form-prose-then-JSON pattern gets replaced with:

1. Define a `submit_X` tool with a strict `input_schema`.
2. Add `tools: [submit_X_tool]` and `tool_choice: { type: 'tool', name: 'submit_X' }` to the `messages.create` call.
3. Drop `thinking: { type: 'adaptive' }` and `output_config` if present (Codex confirmed these are mutually exclusive with forced `tool_choice`). Haiku 4.5 doesn't use thinking anyway.
4. Replace text-extract-then-parse with a per-agent extractor that reads from the `tool_use` block. Mirror the analyst's `extractAnalystDecisionFromTool` shape — defensive validation, fail-closed on shape errors.
5. Test the extractor with hand-crafted `tool_use` content arrays, including failure modes (no tool block, wrong tool name, invalid enum, non-finite numbers, missing required fields).

### 1.1 Reflection — `submit_lesson`

- File: `src/agents/reflection-agent.ts`
- Tool name: `submit_lesson`
- Schema fields (matching the existing `Lesson` type / `lessons` table columns): `instrument`, `direction`, `setup_type`, `kill_zone`, `composite_score`, `position_a_outcome`, `position_b_outcome`, `position_c_outcome`, `pnl_a_r`, `pnl_b_r`, `pnl_c_r`, `pnl_total_r`, `was_bias_correct`, `was_structure_clean`, `was_news_safe`, `lesson_text`, `tags`.
- Extractor: `extractLessonFromTool(content) → Lesson | null`. Returns null on missing/invalid tool call (caller treats as "skip lesson, log warning"). NOTE: this is the **only** extractor in Phase 2 that returns null instead of fail-closing to a synthetic record — a missing lesson is acceptable; a fake lesson would poison the learning loop.
- Tests: extend `tests/reflection.test.ts` (create if missing) with 7-10 tool-use cases.

### 1.2 Researcher — `submit_themes`

- File: `src/agents/researcher-agent.ts`
- Tool name: `submit_themes`
- Schema: `themes` (string[], min 3, max 5, all non-empty), `regime` (one of `risk_on` / `risk_off` / `neutral` / `mixed`), `warnings` (string[]).
- Extractor: `extractResearcherBriefFromTool(content) → ResearcherBrief | null`. Replaces the FAKE-THEME fallback — null means "no brief this cycle, log loud warning, downstream consumers handle null brief (already supported per `getLatestBrief()` returning null)".
- The 1000-token max is **dropped to 4000** to give the brief room — themes + regime classification is more thinking than 1000 supports.
- Tests: extend `tests/researcher.test.ts` (create if missing) with 6-8 cases.

### 1.3 EOD Journal — `submit_journal`

- File: `src/agents/eod-journal-agent.ts`
- Tool name: `submit_journal`
- Schema: `summary` (string, full markdown body — the entire journal goes here, no length cap from us; Anthropic's max_tokens governs), `tags` (string[]), `total_trades` (integer), `total_r` (number).
- Extractor: `extractJournalFromTool(content) → JournalEntry | null`. Keeps existing silent-skip semantics on null but the `total_trades`/`total_r` fields give the schema something to enforce so we know the model engaged with the data.
- Tests: extend `tests/eod-journal.test.ts` with 5 cases.

### 1.4 Review (weekly) — `submit_review`

- File: `src/agents/review-agent.ts`
- Tool name: `submit_review`
- Schema: most complex of the four — `report_text` (markdown), `ict_updates` (object with optional fields for prompt updates), `banned_patterns` (string[]), `alerts` (string[]), `calibration_metrics` (object with `total_calls`, `approved`, `rejected`, `apf_correlation` numeric fields).
- Extractor: `extractReviewFromTool(content) → ReviewOutput | null`. Existing Telegram-on-fail behaviour preserved.
- Tests: extend `tests/review.test.ts` (create if missing) with 5-7 cases.

## Round 2 — Telegram alerts for silent env-var failures

### 2.1 Startup env-var audit

- File: `src/preflight.ts` — extend `runPreflight()` to track which optional env vars are missing.
- New behaviour: if any of `TWELVE_DATA_API_KEY` (already required — keep), `FINNHUB_API_KEY`, `FRED_API_KEY`, `MARKETAUX_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` is missing, **emit one Telegram alert at startup** listing them ("Bot started with degraded data: missing X, Y, Z. Affected features: …"). Bot still boots — these are graceful-degradation features — but ops gets a loud one-time signal.
- Edge case: if `TELEGRAM_BOT_TOKEN` itself is missing, fall back to a startup banner via `console.error` with `[CRITICAL]` prefix.
- Tests: extend `tests/preflight.test.ts`.

### 2.2 Stale-news flag

- File: `src/mcp-server/market-data.ts:1025-1029` (the `serveStaleOrEmpty` path).
- Change: when `MARKETAUX_API_KEY` is missing **and** the cache is older than the existing 4-hour window, set `news_unavailable: true` on the returned object so downstream agents (analyst, ICT) can see news is degraded.
- Tests: extend `tests/news.test.ts` if it exists, otherwise add a focused test.

## Round 3 — Scheduler robustness

### 3.1 Queue missed candle closes during ICT cycle overlap

- File: `src/scheduler/index.ts:637-684` (the `ictRunning` flag block).
- Current bug: if a 15M candle close fires while `ictRunning` is true, the new close is **dropped silently**. Trader misses an entire setup window.
- Change: introduce a single-slot queue (`pendingCandleClose: { candleKey, ts } | null`). On overlap, store the most recent missed close. When the in-flight cycle finishes, check the queue and immediately fire a follow-up cycle on the queued close.
- Single slot (not unbounded queue) is intentional — if 3+ closes back up, only the most recent is meaningful (older are stale).
- Tests: extend `tests/scheduler.test.ts` with overlap simulation.

### 3.2 Force-fresh `getTradeById` in reflection queue

- File: `src/scheduler/index.ts:297-330` (`queueReflectionIfFinalised`).
- Current bug: relies on `d.getTradeById(tradeId)` which may return a stale cached object if SQL.js's in-memory state is read before the prior write hits the in-memory page (race vs handler completion).
- Change: pass the post-handler trade status explicitly into `queueReflectionIfFinalised(tradeId, knownStatus)`. If `knownStatus` is a finalised state (`sl_hit`, `tp1_hit`, `tp2_hit`, `tp3_hit`, `closed`, `cancelled`), queue immediately without re-querying the DB.
- Tests: existing reflection-queue tests + 2 new for the explicit-status path.

### 3.3 Initial RSS poll retry-with-backoff

- File: `src/scheduler/index.ts:733-736` (the `pollAllFeeds().catch(...)` swallow).
- Current bug: on full network failure at boot, the bot operates with empty RSS for 10 minutes (next cron tick).
- Change: replace the silent catch with a 3-attempt retry chain (1s, 5s, 15s backoff). After 3 failures, emit a Telegram `[BOOT]` alert and continue (do not block boot — ICT can still run with empty news, just with degraded context).
- Tests: extend `tests/scheduler.test.ts` or `tests/rss-aggregator.test.ts`.

## Sequencing — one item at a time

Execute in numbered order (1.1 → 1.2 → 1.3 → 1.4 → 2.1 → 2.2 → 3.1 → 3.2 → 3.3). Each item:

1. Failing test
2. Implementation
3. Passing test
4. Full suite (`npm test`) clean
5. Commit on master with descriptive message

After **each Round** (1, 2, 3): Codex review of the round's commits, then deploy to VPS in one batch (pull + build + restart + save), then a brief stability check (preflight clean, scheduler running, last 20 log lines free of errors). Only then move to the next round.

## Risks

- **Haiku 4.5 + forced `tool_choice`** — Codex confirmed Sonnet supports this without thinking. Haiku has the same constraint surface (no adaptive thinking — already not used). Confidence: HIGH. Mitigation: first agent fix (Reflection 1.1) acts as the smoke test; if Haiku rejects forced tool calls we'll know immediately and can pivot to `tool_choice: 'auto'` + the existing fail-closed-on-no-tool-block extractor pattern.
- **Test scaffolding gaps** — `tests/researcher.test.ts`, `tests/reflection.test.ts`, `tests/review.test.ts` may not exist. The plan creates them as needed.
- **Three deploys in one session** — pm2 restart is fast (~10s) and the bot is on demo. Each restart breaks any in-flight ICT cycle but the cron will re-fire within 5 min. Acceptable.
- **EOD journal markdown-in-tool-string** — putting a 1000-token markdown body in a `string` schema field works fine but eyes-on-prize: the schema enforces field shape, not content quality. If the model produces empty or one-line journals, the extractor passes them through. Mitigation: assert minimum length in the extractor (e.g., `summary.length >= 100`), fail-closed if shorter.

## Out of scope

- Round 4 (RSS tier weighting) — distinct architecture work, deserves its own spec.
- Round 5 (cosmetic) — calendar-veto boundary precision (S5), Capital affectedDeals[0] hardening (B2), DEMO_RELAXED_GATES banner staleness. Defer.
- Strategy-edge questions — once the learning loop is unblocked we'll have actual data to evaluate the strategy. Until then, more strategy churn is premature.

## Verification gates

After each Round's deploy, watch `data/pm2-out.log` on the VPS for the first cycle that exercises the changed agent. Round 1 verification is the strongest — we should see actual lessons / themes / journal entries / reviews start landing in the DB instead of silent skips. Round 2 verification is "no startup alert if all keys present, alert fires correctly if a key is removed in test". Round 3 verification is harder to force live but tests cover the logic.

## Plan terminus

Spec → `superpowers:writing-plans` → executing-plans (sequential, one item at a time, Codex-review per round, deploy per round).

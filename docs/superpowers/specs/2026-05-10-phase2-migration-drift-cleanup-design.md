# Phase 2 Migration Drift Cleanup — Design Spec

**Date:** 2026-05-10
**Origin:** `docs/architecture/SYSTEM-FLOWCHART.md` §10 — surfaced by Codex independent code-trace cross-check on 2026-05-09 during the post-L3b-2 architecture-doc build.
**Master at spec time:** `265beff`

## Goal

Clean up five drift artefacts left behind by the 2026-05-09 Phase 2 3-leg-removal migration (`database/index.ts:191-369`) and the 2026-05-09 Spec 1 read-only-tools split. Two are latent runtime bugs that will manifest on the next trade close; the other three are correctness/safety improvements identified during the architecture audit.

## Why now

The Phase 2 migration dropped DB columns (`position_c_id`, `tp3`, `size_c`, `pnl_c`) and tightened the `sl_tp_orders.leg` CHECK from `('A','B','C')` to `('A','B')`. The migration is correct, but two callers of the migrated tables still reference the old shape:

1. `database/index.ts:1006` `getTradeByDealId` SQL still selects `position_c_id`. Will throw `no such column: position_c_id` the next time the position monitor needs it (every trade close path).
2. `database/index.ts:947` `createSlTpOrder` TypeScript parameter type still allows `leg: 'A' | 'B' | 'C'`. TypeScript compiles; runtime hits the CHECK constraint and throws `CHECK constraint failed` if any caller passes `'C'` (none currently do, but the type is a runtime trap waiting for a typo).

Three more issues surfaced in the same audit and benefit from being bundled with this cleanup:

3. `get_daily_pnl` is classified as read-only in `trading-agent.ts:589` `READ_ONLY_TOOLS` set, but the MCP tool definition at `mcp-server/tools/db-tools.ts:69-83` upserts the `daily_pnl_log` table. Today this is safe because sql.js is in-process single-threaded; the inconsistency becomes a real race if any future refactor moves to a multi-process or multi-connection DB.
4. `DB_LOG_FAILED_AFTER_PLACEMENT` (`trading-agent.ts:1543-1563`) currently returns an error JSON to the LLM and silently leaves orphan positions live on Capital with no DB row. The position monitor cannot see them. No alert is sent.
5. Stale comments in three files reference removed 3-leg state.

## Scope

### IN

| ID | File:line | Change | Type |
|---|---|---|---|
| P1.1 | `database/index.ts:1006` | Drop `OR position_c_id = ?` from SQL; drop third bind param; update preceding JSDoc | Bug fix |
| P1.2 | `database/index.ts:947` | Tighten `createSlTpOrder` `leg` parameter type to `'A' \| 'B'`; remove stale "NEW 2026-04-21: 'C' added" comment | Type tightening |
| P2.1 | `trading-agent.ts:589-597` | Remove `'get_daily_pnl'` from `READ_ONLY_TOOLS` set | Semantic correctness |
| P3.1 | `trading-agent.ts:1543-1563` | Add Telegram CRITICAL alert with both deal IDs on DB_LOG_FAILED_AFTER_PLACEMENT branch | Safety / observability |
| P3.2 | `scanner/index.ts:15`, `scheduler/index.ts:5,12-13`, `trading-agent.ts:1514` | Update stale comments | Documentation |

### OUT (intentionally excluded)

- **Scanner ranking cache TTL=0** — already well-documented at `scanner/index.ts:240-243` as an intentional scaffold. Calls per ICT cycle are 7 Capital fetches × ~16 cycles/day = ~112/day. Capital rate budget is far above that. The cache write is kept in place for cheap future re-enable. **No action.**
- **`prompts/ict-agent.md` 1.31R vs `validateRRFloor` 1.30R desync** — load-bearing (`+0.01` is a defensive margin against broker tick rounding). **No action.** Already documented in `docs/architecture/SYSTEM-FLOWCHART.md` §10.
- **Outbox-pattern refactor for orphan prevention** — bigger refactor (insert trade row pre-placement with status='pending', update on success). Out of scope for this cleanup; could be a separate spec if `DB_LOG_FAILED_AFTER_PLACEMENT` ever fires in practice. The CRITICAL Telegram alert covers the observability gap until then.

## Decisions captured during brainstorm (2026-05-10)

| Question | Decision | Rationale |
|---|---|---|
| `get_daily_pnl` race fix | Move to stateful list | Cleanest semantic; ~50-100ms perf hit per cycle is trivial; future-proof if process model changes |
| Scanner cache TTL=0 | Document, no code change | Existing comment at `scanner/index.ts:240-243` is already adequate; no real budget concern |
| `DB_LOG_FAILED_AFTER_PLACEMENT` | Telegram CRITICAL alert, no auto-close | Auto-close risks closing a real trade if the failure was just a write timeout; manual reconcile is safer |

## Architecture

No new modules, no new dependencies. Five surgical edits across four files:

```
src/database/index.ts        ← P1.1, P1.2
src/agents/trading-agent.ts  ← P2.1, P3.1, P3.2 (1 line)
src/scanner/index.ts         ← P3.2 (1 line)
src/scheduler/index.ts       ← P3.2 (2 lines)
```

Tests touch:

```
tests/database-getTradeByDealId.test.ts  ← NEW (P1.1)
tests/trading-agent-readonly-set.test.ts ← NEW (P2.1)
tests/place-split-trade.test.ts           ← extend (P3.1)
```

P1.2 is a TypeScript-only change; the existing `tests/database-sl-tp-orders.test.ts` already enforces A/B values at insert time, so no new test is needed beyond verifying the type narrows correctly via tsc.

P3.2 comment changes need no tests.

## Worked example: P3.1 alert payload

When `insertTrade` or `createSlTpOrder` throws after both Capital legs are live:

```
🚨 CRITICAL — ORPHAN POSITIONS

Trade row write failed AFTER both legs were placed on Capital.com.
Manual reconciliation required.

Instrument: SILVER
Direction: BUY
Leg A dealId: <dealRefA>  (size: <sizeA>)
Leg B dealId: <dealRefB>  (size: <sizeB>)
Error: <db error message>

These positions are LIVE on Capital but NOT tracked by the bot.
Decide: close manually via Capital app, or insert trade row by hand.
```

The alert uses the existing `alertSystemWarning` channel (or a new `alertOrphanPositions` if Telegram routing benefits from a dedicated function — implementation choice during plan execution).

## Self-review (placeholders, contradictions, scope)

- Placeholders: none.
- Contradictions: none.
- Scope check: appropriately narrow — single migration follow-up, no surprises hiding.
- Ambiguity: P3.2 stale comments are listed by file:line; rewrites done in implementation.

## What this spec is NOT

- Not a refactor of the position monitor.
- Not a redesign of how `place_split_trade` handles partial failures (Phase 6 in `trading-agent.ts:1473-1496` already compensates by closing placed legs on placement failure — that path is correct).
- Not introducing the outbox pattern.
- Not changing scanner cache behavior.

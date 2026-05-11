# Phase 1 — Data Model

**Feature:** Scoring Pipeline Audit & Silent-Rejection Fix
**Spec:** [spec.md](./spec.md) | **Plan:** [plan.md](./plan.md) | **Research:** [research.md](./research.md)
**Date:** 2026-05-12

This document defines the four logical entities the spec introduces, their database mapping (SQLite, `data/trading-bot.db`), the migration steps, and the validation rules each entity enforces. The Farad bot already has a tested migration pattern (`PRAGMA table_info` + guarded `ALTER TABLE` per Codex's note at `src/database/index.ts:544-570`); this spec follows it.

---

## Entities

### E-1 — `ScoreBreakdown`

**Purpose:** Audit trail for every composite_score computation. Lets the owner reconstruct *why* a score was 78 vs 82 weeks after the fact.

**Fields:**
| Field | Type | Notes |
|---|---|---|
| `trade_id` | TEXT (FK → trades.id) | 1:1 with the trade attempt; primary key |
| `instrument` | TEXT | Denormalised for digest queries |
| `composite_score` | INTEGER | The final 0-100 value used for tier assignment |
| `tier` | INTEGER NULL | 1 / 2 / 3 / NULL (NULL = below floor, no trade) |
| `breakdown_json` | TEXT (JSON) | `{ base, bias_clarity, ict_array, news, history, spread, range_cap_applied? }` |
| `scored_at` | TEXT (ISO 8601) | Timestamp |
| `scorer_version` | TEXT | e.g., `"v2-deterministic-2026-05-12"` — bumped on every scoring rule change |

**Validation rules (FR-001, FR-002, FR-003):**
- `composite_score` MUST equal the sum of `breakdown_json` numeric values, clamped to [0, 100]. Asserted in code and in tests.
- `breakdown_json` MUST contain all 6 components (`base`, `bias_clarity`, `ict_array`, `news`, `history`, `spread`). Missing keys = test failure.
- For range-mode setups, `range_cap_applied` is `true` iff the cap reduced the score (today: when raw score would be ≥60 but is forced to 59).
- `scorer_version` MUST change every time `src/scoring/components.ts` or `compose.ts` is edited — enforced by a CI check that diffs the version constant against the file content hash.

**State transitions:** None. Insert-only audit record.

---

### E-2 — `RejectionRecord`

**Purpose:** Single source of truth for every rejection across all four layers (scanner, analyst, executor, post-approval). Enables FR-004 through FR-007 and SC-002, SC-003, SC-009.

**Storage:** Two physical tables — `trade_rejections` (new) for scanner/executor/post-approval, plus three new columns on `analyst_log` (existing) so analyst rejections live where they already are. The `RejectionRecord` is the LOGICAL entity; the digest builder UNIONs both.

**`trade_rejections` table (new):**
| Field | Type | Notes |
|---|---|---|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | |
| `ts` | TEXT (ISO 8601) | When the rejection happened |
| `instrument` | TEXT | Always present |
| `layer` | TEXT | One of: `'scanner' \| 'executor' \| 'post_approval'` |
| `category` | TEXT | Machine-parseable code from `REJECTION_CATEGORIES` enum |
| `subcategory` | TEXT NULL | Optional refinement (e.g., for executor: which validation step) |
| `reason_text` | TEXT | Free-form human reason (still useful for forensics) |
| `proposed_score` | INTEGER NULL | Score at time of rejection, if known |
| `proposed_tier` | INTEGER NULL | Tier at time of rejection, if known |
| `request_id` | TEXT NULL | Links to the analyst request (for cross-layer joins) |

**`analyst_log` table additions (existing table — ALTER):**
| New Field | Type | Notes |
|---|---|---|
| `category` | TEXT NULL | One of: `ANALYST_REJECT_BANNED_PATTERN`, `ANALYST_REJECT_CORRELATION`, `ANALYST_REJECT_NEWS_WINDOW`, `ANALYST_REJECT_COOLDOWN`, `ANALYST_FAIL_CLOSED_API_ERROR`, `ANALYST_FAIL_CLOSED_PARSE`, `ANALYST_FAIL_CLOSED_NO_TOOL_CALL`, `ANALYST_APPROVE`, `ANALYST_MODIFY` |
| `is_fail_closed` | INTEGER (0/1) | 1 if rejection was due to API/parse/schema failure, NOT a deliberate cause-REJECT. Distinguishes FR-005's two classes. |
| `subcategory` | TEXT NULL | Free-form refinement |

**`REJECTION_CATEGORIES` enum (TypeScript, single source of truth in `src/rejection-log/categories.ts`):**

```typescript
export const REJECTION_CATEGORIES = [
  // Scanner-side
  'KILL_ZONE_OUT',
  'SCANNER_FETCH_ERROR',
  'SCORE_BELOW_TIER_FLOOR',
  // Analyst-side (also persisted in analyst_log.category)
  'ANALYST_REJECT_BANNED_PATTERN',
  'ANALYST_REJECT_CORRELATION',
  'ANALYST_REJECT_NEWS_WINDOW',
  'ANALYST_REJECT_COOLDOWN',           // soft-rejected by analyst even though code-level fires first
  'ANALYST_FAIL_CLOSED_API_ERROR',
  'ANALYST_FAIL_CLOSED_PARSE',
  'ANALYST_FAIL_CLOSED_NO_TOOL_CALL',
  // Executor-side
  'EXECUTOR_REJECT_SCORE_BELOW_TIER_MIN',
  'EXECUTOR_REJECT_TIER_SCORE_MISMATCH',
  'EXECUTOR_REJECT_RANGE_MODE_TIER_MISMATCH',
  'EXECUTOR_REJECT_RISK_PCT_TIER_MISMATCH',
  'EXECUTOR_REJECT_INVALID_ORDER_SIDE',
  'EXECUTOR_REJECT_RR_FLOOR',
  'EXECUTOR_REJECT_EMERGENCY_STOP',
  'EXECUTOR_REJECT_BELOW_MIN_SIZE',
  'EXECUTOR_REJECT_TRADE_OPEN',          // legacy single-trade gate, when max_total_risk_pct=0
  'EXECUTOR_REJECT_RISK_BUDGET_EXCEEDED', // new gate when max_total_risk_pct>0
  'EXECUTOR_REJECT_TIER_1_NEWS_BLOCK',
  // Cooldown (US-3 — executor layer)
  'COOLDOWN_3_LOSSES_ACTIVE',
  // Post-approval (US-6)
  'POST_APPROVAL_TTL_EXPIRED',
  'POST_APPROVAL_HASH_MISMATCH',
  'POST_APPROVAL_DUPLICATE_LOCK',
  // Sentinel — must NEVER appear in production. Test asserts count=0.
  'OTHER',
] as const;
export type RejectionCategory = typeof REJECTION_CATEGORIES[number];
```

**Validation rules:**
- Every `recordRejection({...})` call MUST pass a category from the enum (TypeScript compiler enforces).
- Daily digest builder MUST cover 100% of rejections (no `OTHER` or null categories) — SC-002.
- `is_fail_closed = 1` for the three `ANALYST_FAIL_CLOSED_*` categories; `0` for everything else — SC-003.

**State transitions:** None. Append-only.

**Indexes:**
- `trade_rejections (ts, layer)` — for daily digest range scan
- `trade_rejections (instrument, ts)` — for "why was setup X rejected on day Y" forensics (SC-009)
- `analyst_log (ts, category)` — same shape for analyst layer

---

### E-3 — `CooldownState`

**Purpose:** Bot-wide gate state for the loss-streak cooldown (US-3). Read on every trade attempt.

**Storage:** Derived from existing `trades` table — NO new table needed (per R-3 + Codex's "none if deriving from trades").

**Computed fields (no schema):**
| Field | Type | Source |
|---|---|---|
| `consecutive_losses` | number | Count of `outcome='loss'` trades from the END of `trades ORDER BY closed_at DESC`, stopping at first non-loss |
| `last_loss_closed_at` | string \| null | Latest `closed_at` of the streak |
| `clears_at` | string \| null | `last_loss_closed_at + clearAfterHours` |
| `active` | boolean | `consecutive_losses >= maxConsecutiveLosses AND now < clears_at` |

**Configuration storage:** `pm_state` table (existing). Two new rows:
| key | value | default |
|---|---|---|
| `cooldown_max_consecutive_losses` | INTEGER | 3 |
| `cooldown_clear_after_hours` | INTEGER | 24 |

**Validation rules (FR-008, FR-009, FR-010):**
- `getCooldownState()` MUST be deterministic given fixed input (testable with frozen clock).
- When `active = true`, executor MUST emit `recordRejection({ category: 'COOLDOWN_3_LOSSES_ACTIVE', ... })` and short-circuit before analyst dispatch.
- `pm_state` keys MUST be modifiable at runtime without redeploy (test that updating the row changes behaviour on next attempt).

**Migration:** No new table. INSERT default `pm_state` rows in the same migration that creates `trade_rejections`.

---

### E-4 — `RiskBudgetState`

**Purpose:** Per-attempt computation for the opt-in concurrent-trades gate (US-7).

**Storage:** Computed at attempt time from `trades` table + `pm_state` config. NO new table.

**Computed fields:**
| Field | Type | Source |
|---|---|---|
| `open_risk_pct` | number | SUM of `risk_pct` over all trades where `closed_at IS NULL` |
| `proposed_risk_pct` | number | From the incoming trade proposal |
| `max_total_risk_pct` | number | From `pm_state` row, default 0 |
| `would_exceed` | boolean | `(open_risk_pct + proposed_risk_pct) > max_total_risk_pct AND max_total_risk_pct > 0` |

**Configuration storage:** `pm_state` table (existing). One new row:
| key | value | default |
|---|---|---|
| `max_total_risk_pct` | REAL | 0.0 |

**Backward-compat rule (FR-017, SC-007):**
- Default `max_total_risk_pct = 0.0` MUST preserve current behaviour: any second trade attempt while one is open returns `EXECUTOR_REJECT_TRADE_OPEN`.
- Setting `max_total_risk_pct > 0` activates the new gate: returns `EXECUTOR_REJECT_RISK_BUDGET_EXCEEDED` only when budget would be exceeded.

**Composition with analyst CHECK 4 (FR-019):**
- The risk-budget gate is independent of the analyst's correlated-risk check. Both run; first to reject wins. Two rejections may be logged for the same proposal (one in `trade_rejections`, one in `analyst_log`) — that's intentional and lets the digest show "trade X was rejected by both gate A and gate B".

---

## Migration Steps

Single migration script, run by the existing schema-migration code at `src/database/index.ts:544-570` (Codex citation). Pattern: `PRAGMA table_info` to detect if migration already ran, then guarded `ALTER TABLE` / `CREATE TABLE`.

```sql
-- Migration 007: scoring-pipeline-audit (2026-05-12)
-- Adds:
--   - score_breakdowns table (US-1)
--   - trade_rejections table (US-2)
--   - 3 new columns on analyst_log (US-2)
--   - 3 new pm_state default rows (US-3, US-7)

-- E-1: ScoreBreakdown
CREATE TABLE IF NOT EXISTS score_breakdowns (
  trade_id TEXT PRIMARY KEY,
  instrument TEXT NOT NULL,
  composite_score INTEGER NOT NULL,
  tier INTEGER,
  breakdown_json TEXT NOT NULL,
  scored_at TEXT NOT NULL,
  scorer_version TEXT NOT NULL,
  FOREIGN KEY (trade_id) REFERENCES trades(id)
);

-- E-2: trade_rejections
CREATE TABLE IF NOT EXISTS trade_rejections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  instrument TEXT NOT NULL,
  layer TEXT NOT NULL CHECK (layer IN ('scanner', 'executor', 'post_approval')),
  category TEXT NOT NULL,
  subcategory TEXT,
  reason_text TEXT NOT NULL,
  proposed_score INTEGER,
  proposed_tier INTEGER,
  request_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_rejections_ts_layer ON trade_rejections (ts, layer);
CREATE INDEX IF NOT EXISTS idx_rejections_instrument_ts ON trade_rejections (instrument, ts);

-- E-2: analyst_log additions (guarded — only ALTER if columns don't exist)
-- (Pseudo-SQL — actual code uses PRAGMA table_info per existing pattern)
ALTER TABLE analyst_log ADD COLUMN category TEXT;
ALTER TABLE analyst_log ADD COLUMN is_fail_closed INTEGER DEFAULT 0;
ALTER TABLE analyst_log ADD COLUMN subcategory TEXT;
CREATE INDEX IF NOT EXISTS idx_analyst_log_ts_category ON analyst_log (ts, category);

-- E-3: pm_state defaults for cooldown
INSERT OR IGNORE INTO pm_state (key, value) VALUES
  ('cooldown_max_consecutive_losses', '3'),
  ('cooldown_clear_after_hours', '24');

-- E-4: pm_state default for risk budget (default 0 = current single-trade behaviour)
INSERT OR IGNORE INTO pm_state (key, value) VALUES
  ('max_total_risk_pct', '0.0');
```

**Migration safety:**
- All DDL is `IF NOT EXISTS` or guarded `ALTER`. Idempotent.
- `INSERT OR IGNORE` for `pm_state` rows — does not overwrite if the owner already set a custom value.
- Foreign key on `score_breakdowns.trade_id` — if a trade row is deleted (shouldn't happen in production, but tests do it), the breakdown row stays orphaned with the FK reference. Acceptable.
- No data migration needed — these are all new tables/columns.

**Migration window:**
- Deploy at scheduler quiet window: 22:00 UTC on a Sunday (after weekly review). Avoids in-flight approvals where `proposalHash` mismatch could trigger.
- Pre-deploy: confirm no open approvals via `SELECT COUNT(*) FROM approvals WHERE consumed_at IS NULL`.

---

## Cross-cutting concerns

### Foreign-key consistency
- `score_breakdowns.trade_id` references `trades.id`.
- `trade_rejections.request_id` is a soft reference to `analyst_log.request_id` — no FK because rejections can happen at the scanner layer before any analyst request exists.

### JSON shape stability for `breakdown_json`
The JSON keys are a public contract for the digest, dashboards, and the `scripts/dump-reject-metrics.ts` tool. Renaming a key is a breaking change → bump `scorer_version` AND coordinate with consumers in the same PR.

### Telegram digest payload size
Worst-case daily volume: 12 instruments × 12 cycles/hour × 18 hours × 1 rejection/cycle = ~2,500 rejections/day. The digest summarises by category (15-25 rows), not per-rejection — payload stays under 4KB and well within Telegram's 4096-character message limit.

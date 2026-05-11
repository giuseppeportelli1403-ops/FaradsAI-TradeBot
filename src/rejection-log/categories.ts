// REJECTION_CATEGORIES — single taxonomy for every silent or visible
// rejection across the four pipeline layers. Adding a new category here
// (and only here) is how you extend the digest. The 'OTHER' sentinel is
// intentionally unreachable in production — tests assert count=0.

export const REJECTION_CATEGORIES = [
  // === Scanner-side ===
  'KILL_ZONE_OUT',
  'SCANNER_FETCH_ERROR',
  'SCORE_BELOW_TIER_FLOOR',

  // === Analyst-side (also persisted in analyst_log.category) ===
  'ANALYST_REJECT_BANNED_PATTERN',
  'ANALYST_REJECT_CORRELATION',
  'ANALYST_REJECT_NEWS_WINDOW',
  'ANALYST_REJECT_COOLDOWN',
  'ANALYST_FAIL_CLOSED_API_ERROR',
  'ANALYST_FAIL_CLOSED_PARSE',
  'ANALYST_FAIL_CLOSED_NO_TOOL_CALL',

  // === Cooldown (US-3, executor layer — fires before analyst dispatch) ===
  'COOLDOWN_3_LOSSES_ACTIVE',

  // === Executor-side ===
  'EXECUTOR_REJECT_SCORE_BELOW_TIER_MIN',
  'EXECUTOR_REJECT_TIER_SCORE_MISMATCH',
  'EXECUTOR_REJECT_RANGE_MODE_TIER_MISMATCH',
  'EXECUTOR_REJECT_RISK_PCT_TIER_MISMATCH',
  'EXECUTOR_REJECT_INVALID_ORDER_SIDE',
  'EXECUTOR_REJECT_RR_FLOOR',
  'EXECUTOR_REJECT_EMERGENCY_STOP',
  'EXECUTOR_REJECT_BELOW_MIN_SIZE',
  'EXECUTOR_REJECT_TRADE_OPEN',
  'EXECUTOR_REJECT_RISK_BUDGET_EXCEEDED',
  'EXECUTOR_REJECT_TIER_1_NEWS_BLOCK',

  // === Post-approval (US-6) ===
  'POST_APPROVAL_TTL_EXPIRED',
  'POST_APPROVAL_HASH_MISMATCH',
  'POST_APPROVAL_DUPLICATE_LOCK',

  // === Sentinel — must NEVER appear in production. SC-002 enforces count=0. ===
  'OTHER',
] as const;

export type RejectionCategory = typeof REJECTION_CATEGORIES[number];

export type RejectionLayer = 'scanner' | 'analyst' | 'executor' | 'post_approval';

const FAIL_CLOSED_CATEGORIES: ReadonlySet<RejectionCategory> = new Set([
  'ANALYST_FAIL_CLOSED_API_ERROR',
  'ANALYST_FAIL_CLOSED_PARSE',
  'ANALYST_FAIL_CLOSED_NO_TOOL_CALL',
]);

export function isFailClosed(category: RejectionCategory): boolean {
  return FAIL_CLOSED_CATEGORIES.has(category);
}

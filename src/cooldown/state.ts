// Cooldown state — code-level enforcement of the loss-streak rule
// (US-3 / Spec 001). Replaces the prompt-only rule that lived in
// prompts/analyst-agent.md (Sonnet may or may not have honoured it).
//
// Source of truth: the `trades` table, ordered by closed_at DESC.
// A trade is a "loss" when status='sl_hit' OR pnl_total < 0.
// The streak count walks from the most-recent closed trade backwards
// and stops at the first non-loss (so 'L L W L L' = 2 losses, not 4).
// When `consecutive_losses >= maxConsecutiveLosses` AND we are still
// within `clearAfterHours` of the last loss closing, the cooldown is
// active and the executor short-circuits before analyst dispatch.

import { getDb } from '../database/index.js';
import { getMaxConsecutiveLosses, getClearAfterHours } from './policy.js';

export interface CooldownState {
  active: boolean;
  consecutive_losses: number;
  last_loss_closed_at: string | null;
  clears_at: string | null;
}

interface ClosedTradeRow {
  id: string;
  status: string;
  pnl_total: number | null;
  closed_at: string;
}

/**
 * Read the most recent N closed trades and walk back to count the
 * consecutive losses at the END of the sequence. N = max + 1 so we
 * can detect "exactly max losses followed by a win" without pulling
 * the entire trades history.
 */
function readRecentClosedTrades(maxToCheck: number): ClosedTradeRow[] {
  const db = getDb();
  const result = db.exec(
    `SELECT id, status, pnl_total, closed_at
       FROM trades
      WHERE closed_at IS NOT NULL
   ORDER BY closed_at DESC
      LIMIT ?`,
    [maxToCheck],
  );
  if (!result[0]) return [];
  return result[0].values.map((row) => ({
    id: String(row[0]),
    status: String(row[1]),
    pnl_total: row[2] === null ? null : Number(row[2]),
    closed_at: String(row[3]),
  }));
}

/**
 * A trade is a "loss" when:
 *   - status='sl_hit' (stopped out), OR
 *   - pnl_total is recorded and is strictly negative.
 *
 * A 'closed_early' trade that exited at break-even is NOT a loss.
 */
function isLoss(t: ClosedTradeRow): boolean {
  if (t.status === 'sl_hit') return true;
  if (t.pnl_total !== null && t.pnl_total < 0) return true;
  return false;
}

/**
 * Compute current cooldown state. Pure function w.r.t. the trades
 * table + pm_state config — same DB state always returns the same
 * result, except for the time-based `active` flag which depends on `now`.
 *
 * Pass {now} from tests to freeze the clock; production uses Date.now().
 */
export function getCooldownState(opts?: { now?: Date }): CooldownState {
  const max = getMaxConsecutiveLosses();
  const clearHours = getClearAfterHours();
  const now = opts?.now ?? new Date();

  // Pull max + 1 so we know whether the streak is exactly max (active)
  // or has been broken by a more recent win (inactive).
  const recent = readRecentClosedTrades(max + 1);

  let consecutive = 0;
  let lastLossClosedAt: string | null = null;
  for (const t of recent) {
    if (isLoss(t)) {
      consecutive++;
      if (lastLossClosedAt === null) {
        // The most recent loss in the streak (we're walking newest-first).
        lastLossClosedAt = t.closed_at;
      }
    } else {
      // Streak broken by a win or break-even.
      break;
    }
  }

  let clearsAt: string | null = null;
  if (lastLossClosedAt !== null) {
    const lastLossMs = Date.parse(lastLossClosedAt);
    if (Number.isFinite(lastLossMs)) {
      clearsAt = new Date(lastLossMs + clearHours * 3600 * 1000).toISOString();
    }
  }

  let active = false;
  if (consecutive >= max && clearsAt !== null) {
    const clearsAtMs = Date.parse(clearsAt);
    if (Number.isFinite(clearsAtMs) && now.getTime() < clearsAtMs) {
      active = true;
    }
  }

  return {
    active,
    consecutive_losses: consecutive,
    last_loss_closed_at: lastLossClosedAt,
    clears_at: clearsAt,
  };
}

export function isCooldownActive(opts?: { now?: Date }): boolean {
  return getCooldownState(opts).active;
}

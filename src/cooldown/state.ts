// Cooldown state — STUB. Full implementation in T055 (PR 2 / US-3).
// Exists now so the public surface in index.ts compiles for PR 1.

import { getDb } from '../database/index.js';
import { getMaxConsecutiveLosses, getClearAfterHours } from './policy.js';

export interface CooldownState {
  active: boolean;
  consecutive_losses: number;
  last_loss_closed_at: string | null;
  clears_at: string | null;
}

/**
 * STUB until T055. Returns inactive state — code-level cooldown does NOT
 * fire in PR 1. PR 1 ships the categorisation infrastructure; PR 2 wires
 * it to actual rejection.
 */
export function getCooldownState(_opts?: { now?: Date }): CooldownState {
  // Reference imports to avoid unused-import lint warnings until T055
  // gives them work to do.
  void getDb;
  void getMaxConsecutiveLosses;
  void getClearAfterHours;
  return {
    active: false,
    consecutive_losses: 0,
    last_loss_closed_at: null,
    clears_at: null,
  };
}

export function isCooldownActive(opts?: { now?: Date }): boolean {
  return getCooldownState(opts).active;
}

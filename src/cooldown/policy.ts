// Cooldown policy config — reads pm_state with safe defaults.

import { getPmState } from '../database/index.js';

const DEFAULT_MAX_CONSECUTIVE_LOSSES = 3;
const DEFAULT_CLEAR_AFTER_HOURS = 24;

export function getMaxConsecutiveLosses(): number {
  const raw = getPmState('cooldown_max_consecutive_losses');
  if (raw === null) return DEFAULT_MAX_CONSECUTIVE_LOSSES;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_CONSECUTIVE_LOSSES;
}

export function getClearAfterHours(): number {
  const raw = getPmState('cooldown_clear_after_hours');
  if (raw === null) return DEFAULT_CLEAR_AFTER_HOURS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CLEAR_AFTER_HOURS;
}

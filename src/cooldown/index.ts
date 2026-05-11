// src/cooldown/ — code-level loss-streak cooldown gate (US-3).
// Replaces the prompt-only rule in prompts/analyst-agent.md.
// Enforced in trading-agent.ts BEFORE analyst dispatch.

export {
  getCooldownState,
  isCooldownActive,
  type CooldownState,
} from './state.js';
export {
  getMaxConsecutiveLosses,
  getClearAfterHours,
} from './policy.js';

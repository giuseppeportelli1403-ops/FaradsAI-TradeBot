// src/scoring/ — single source of truth for the bot's scoring math.
// Replaces the prompt-side scoring rubric in prompts/ict-agent.md §H.
// Live scanner AND backtest engine consume from this module.

export { composeScore, type ScoreInputs, type ScoreOutput } from './compose.js';
export {
  baseComponent,
  biasClarityComponent,
  newsComponent,
  spreadComponent,
  historyComponent,
  ictArrayComponent,
} from './components.js';
export { TIER_1_THRESHOLD, TIER_2_THRESHOLD, tier3FloorFor } from './tiers.js';

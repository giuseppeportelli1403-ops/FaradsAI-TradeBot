// Compose a deterministic composite_score from the per-component pure
// functions. Single source of truth used by both the live scanner and the
// backtest engine. Returns the score, the per-component breakdown (audit
// trail), and the resolved tier.

import {
  baseComponent,
  biasClarityComponent,
  newsComponent,
  spreadComponent,
  historyComponent,
  ictArrayComponent,
} from './components.js';
import { TIER_1_THRESHOLD, TIER_2_THRESHOLD, tier3FloorFor } from './tiers.js';

/**
 * Bumped on every change to scoring math. Stored alongside every
 * score_breakdowns row so historical scores can be reconstructed and
 * compared across versions.
 */
export const SCORER_VERSION = 'v2-deterministic-2026-05-12';

/**
 * Range-mode score cap. Documented in prompts/ict-agent.md:211 and the
 * 2026-04-29 rebalance comments at scanner/index.ts:413-431. Range setups
 * are higher variance than trend setups; capping at 59 keeps them at
 * Tier 3 (0.5% risk). Lifting this cap is gated on US-4 backtest evidence.
 */
const RANGE_MODE_CAP = 59;

export interface ScoreInputs {
  ticker: string;
  rawBiasClarity: number;
  rawNewsScore: number;
  spreadQuality: 'tight' | 'medium' | 'wide' | string;
  /** Win-rate of past trades for this setup x kill_zone x instrument bucket. */
  historyWinRate?: number;
  /** Number of past trades in that bucket. Activates history adjustment at >= 2. */
  historySampleSize?: number;
  /** Set true if the setup is range-mode (trigger 5). Adds +20 baseline AND caps final score at 59. */
  isRangeMode: boolean;
  /**
   * Inputs for the structure-quality scorer (US-5). Until T066 lands the
   * full implementation, ictArrayComponent returns 0 regardless of value.
   * Pass undefined or a placeholder for now.
   */
  ictArrayInputs?: unknown;
}

export interface ScoreBreakdown {
  base: number;
  bias_clarity: number;
  ict_array: number;
  news: number;
  history: number;
  spread: number;
  range_mode_baseline?: number;
  range_cap_applied?: boolean;
}

export interface ScoreOutput {
  composite_score: number;
  tier: 1 | 2 | 3 | null;
  score_breakdown: ScoreBreakdown;
  scorer_version: string;
}

export function composeScore(inputs: ScoreInputs): ScoreOutput {
  const base = baseComponent();
  const bias_clarity = biasClarityComponent(inputs.rawBiasClarity);
  const ict_array = ictArrayComponent(inputs.ictArrayInputs);
  const news = newsComponent(inputs.rawNewsScore);
  const history = historyComponent(
    inputs.historyWinRate ?? 0,
    inputs.historySampleSize ?? 0
  );
  const spread = spreadComponent(inputs.spreadQuality);

  let raw = base + bias_clarity + ict_array + news + history + spread;
  let range_mode_baseline: number | undefined;
  let range_cap_applied: boolean | undefined;

  if (inputs.isRangeMode) {
    range_mode_baseline = 20;
    raw += range_mode_baseline;
    if (raw > RANGE_MODE_CAP) {
      range_cap_applied = true;
      raw = RANGE_MODE_CAP;
    } else {
      range_cap_applied = false;
    }
  }

  // Final clamp to the absolute [0, 100] envelope. Belt-and-suspenders —
  // none of the components above can produce out-of-range values, but a
  // future contributor might.
  const composite_score = Math.max(0, Math.min(100, raw));

  let tier: 1 | 2 | 3 | null;
  if (composite_score >= TIER_1_THRESHOLD) {
    tier = 1;
  } else if (composite_score >= TIER_2_THRESHOLD) {
    tier = 2;
  } else if (composite_score >= tier3FloorFor(inputs.ticker)) {
    tier = 3;
  } else {
    tier = null;
  }

  const score_breakdown: ScoreBreakdown = {
    base,
    bias_clarity,
    ict_array,
    news,
    history,
    spread,
    ...(range_mode_baseline !== undefined && { range_mode_baseline }),
    ...(range_cap_applied !== undefined && { range_cap_applied }),
  };

  return {
    composite_score,
    tier,
    score_breakdown,
    scorer_version: SCORER_VERSION,
  };
}

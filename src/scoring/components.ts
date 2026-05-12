// Pure scoring components. Each function takes typed inputs and returns
// a numeric contribution. NO LLM calls, NO DB calls, NO I/O — fully
// deterministic. Replaces the prompt-side scoring rubric in
// prompts/ict-agent.md §H.
//
// Component contributions per data-model.md E-1 and prompts/ict-agent.md:161-167:
//   base:         +25  (always)
//   bias_clarity: 0 / 15 / 20 / 25  (remapped from detectBias 0/10/15/20)
//   ict_array:    0 / 15 / 25 / 35  (US-5 — stub returns 0 until T066)
//   news:         -15 to +10 (Cat A) / -5 to +5 (Cat B), source-clamped
//   history:      0 / +10 / -10 (activates at sample_size >= 2)
//   spread:       0 / +5 (tight)
//   range_mode:   adds +20 baseline; final score capped at 59 — handled in compose.ts

export function baseComponent(): number {
  return 25;
}

/**
 * Remaps the legacy bias-clarity scale (0/10/15/20) to the post-2026-04-29
 * rebalanced scale (0/15/20/25). Input is the raw `detectBias().clarity` value.
 */
export function biasClarityComponent(rawClarity: number): 0 | 15 | 20 | 25 {
  if (!Number.isFinite(rawClarity)) return 0;
  if (rawClarity >= 20) return 25;
  if (rawClarity >= 15) return 20;
  if (rawClarity >= 10) return 15;
  return 0;
}

/**
 * News contribution. Source (src/news/index.ts:135-141) already clamps to
 * Cat A range -15..+10 and Cat B range -5..+5; this function defensively
 * re-clamps to [-15, +10] to guard against drift.
 */
export function newsComponent(rawNewsScore: number): number {
  if (!Number.isFinite(rawNewsScore)) return 0;
  return Math.max(-15, Math.min(10, rawNewsScore));
}

export function spreadComponent(quality: 'tight' | 'medium' | 'wide' | string): 0 | 5 {
  return quality === 'tight' ? 5 : 0;
}

/**
 * Historical win-rate adjustment. Activates at sample_size >= 2 (lowered
 * from 5 to 2 on 2026-04-29 to make the feedback loop bite inside the demo
 * window). Below threshold returns 0 (insufficient data).
 *
 *   win_rate < 0.50 → -10  (under-perform)
 *   0.50..0.70      →   0  (neutral band)
 *   win_rate > 0.70 → +10  (over-perform)
 */
export function historyComponent(winRate: number, sampleSize: number): -10 | 0 | 10 {
  if (sampleSize < 2 || !Number.isFinite(winRate)) return 0;
  if (winRate < 0.5) return -10;
  if (winRate > 0.7) return 10;
  return 0;
}

/**
 * ICT structure-quality contribution.
 *
 * 2026-05-12 — US-5 / T066 implementation now LIVE. Replaces the prior
 * stub with a deterministic OB/FVG/sweep/BOS scorer that operates on
 * the candle arrays already fetched by the scanner. Returns 0/15/25/35
 * per the threshold rubric in research.md R-2.
 *
 * Backward-compatible signature: when called with `undefined` (as the
 * backtest engine does — it has no ICT array model), returns 0. This
 * preserves the historical backtest's "structure scoring is 0 here"
 * caveat documented at backtest/engine.ts header.
 *
 * Full implementation lives in src/scoring/ict-array-detector.ts.
 */
import { detectIctArrayContribution, type IctArrayInputs } from './ict-array-detector.js';

export function ictArrayComponent(inputs: IctArrayInputs | undefined): 0 | 15 | 25 | 35 {
  if (inputs === undefined) return 0;
  return detectIctArrayContribution(inputs);
}

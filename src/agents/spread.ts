// Spread-class helpers shared by the scanner and the trading-agent.
//
// Lives here (instead of trading-agent.ts) to avoid a circular import:
// trading-agent.ts imports from scanner/index.ts, so the scanner cannot
// import from trading-agent.ts in turn.
//
// Tight-spread tickers (strategy.md §4): EURUSD, GBPUSD, USDJPY, AUDUSD, GOLD.
// Medium-spread (no carve-out): SILVER, OIL_CRUDE.

const TIGHT_SPREAD_TICKERS = new Set(['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'GOLD']);

/** True if the ticker has tight-spread carve-out (R:R floor and Tier 3 score floor). */
export function isTightSpreadTicker(ticker: string): boolean {
  return TIGHT_SPREAD_TICKERS.has(ticker.toUpperCase());
}

// Tier 3 score floor by spread class. History:
//   - Phase E (2026-05-04): lowered 45 → 40 to widen Tier 3 funnel. Backtest
//     exposed OIL_CRUDE failure mode (medium-spread weak-bias 1H trades at
//     score 40-44 dragged PF 0.51 / DD +30%). Carve-out kept 40 for tight-
//     spread, reverted to 45 for medium-spread.
//   - PR 1 (2026-05-12, trade-frequency loosening): further lowered to 30
//     (tight) / 35 (medium). Empirical evidence (audit script 95.2% LLM-
//     deterministic agreement, zero hallucinations, 1 confirmed miss over
//     30 days) supports the LLM being overcautious at current strictness.
//     Target: lift trade frequency from 0-1/day to 3-5/day. See
//     docs/superpowers/specs/2026-05-12-trade-frequency-loosening-design.md
//     for full rationale + the 2 pre-merge sub-gates (deterministic backtest
//     + shadow-LLM replay) that validated this change before ship.
export function tier3FloorFor(ticker: string): number {
  return isTightSpreadTicker(ticker) ? 30 : 35;
}

/**
 * 2026-05-05 (Audit defensive guard): assert that every entry in
 * INSTRUMENT_UNIVERSE has an explicit spread classification consistent
 * with this module's TIGHT_SPREAD_TICKERS set. Catches the case where a
 * future PR adds a new ticker to the universe without updating the
 * tight-spread list — the new ticker would silently default to the
 * medium-spread floor (45), which may or may not be correct.
 *
 * Called from src/preflight.ts at startup. Throws on mismatch so the
 * mistake is loud — bot refuses to boot until the classification is
 * synced.
 *
 * Each universe entry has a `spread_quality` field ('tight'|'medium'|'wide').
 * Rule: spread_quality === 'tight' iff isTightSpreadTicker(ticker).
 */
export function assertUniverseSpreadConsistency(
  universe: ReadonlyArray<{ ticker: string; spread_quality: string }>,
): void {
  const mismatches: string[] = [];
  for (const inst of universe) {
    const isTightInUniverse = inst.spread_quality === 'tight';
    const isTightInCarveOut = isTightSpreadTicker(inst.ticker);
    if (isTightInUniverse !== isTightInCarveOut) {
      mismatches.push(
        `${inst.ticker}: universe says spread_quality='${inst.spread_quality}' (tight=${isTightInUniverse}) ` +
          `but tier3FloorFor classifies tight=${isTightInCarveOut}`,
      );
    }
  }
  if (mismatches.length > 0) {
    throw new Error(
      `[spread] Universe / carve-out classification mismatch:\n  - ${mismatches.join('\n  - ')}\n` +
        `Fix: add tight-spread tickers to TIGHT_SPREAD_TICKERS in src/agents/spread.ts, ` +
        `or change spread_quality in INSTRUMENT_UNIVERSE.`,
    );
  }
}

/**
 * Map setup_type + tier → total_risk_pct fraction (not percent).
 *
 * Special cases (flat regardless of tier):
 *   Range_Sweep_Reversal   → 0.0025  (0.25% — range-mode half-size; existing)
 *   Displacement_Continuation → 0.0025  (0.25% — Phase 1 half-size posture;
 *                              promote to tier-aware in Phase 2 once live
 *                              data confirms the setup is safe)
 *
 * Standard tier-aware cases (all other setup types):
 *   Tier 1 → 0.015 (1.5%)
 *   Tier 2 → 0.010 (1.0%)
 *   Tier 3 → 0.005 (0.5%)
 *
 * The match for range-mode is intentionally lenient (matches any setup_type
 * whose first underscore-delimited word is range) so that minor casing
 * variants (Range Sweep Reversal, range_sweep_reversal) are handled
 * consistently with the inline logic in trading-agent.ts.
 */
export function tierRiskPct(setupType: string, tier: 1 | 2 | 3 | number): number {
  const norm = setupType.trim().toLowerCase().replace(/[\s_]+/g, '_');

  // Displacement_Continuation — Phase 1 half-size posture
  if (norm === 'displacement_continuation') return 0.0025; // Phase 1 half-size; promote in Phase 2

  // Range_Sweep_Reversal (and any range_* variant) — existing half-size rule
  if (/^range_/.test(norm)) return 0.0025;

  // Standard tier-aware risk
  if (tier === 1) return 0.015;
  if (tier === 2) return 0.010;
  return 0.005; // Tier 3 (and any unexpected tier value)
}

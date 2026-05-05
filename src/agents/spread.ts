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

// Tier 3 score floor by spread class. Phase E (2026-05-04) lowered the
// floor 45 → 40 to widen the Tier 3 funnel, but the backtest exposed
// OIL_CRUDE as the failure mode: medium-spread weak-bias 1H trades at
// score 40-44 dragged PF 0.51 / DD +30%. Carve-out keeps 40 only for
// tight-spread instruments (which already had a +5 spread bonus baking
// them at the old floor anyway) and reverts to 45 for everything else.
export function tier3FloorFor(ticker: string): number {
  return isTightSpreadTicker(ticker) ? 40 : 45;
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

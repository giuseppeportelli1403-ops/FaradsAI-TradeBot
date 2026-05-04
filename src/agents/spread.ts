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

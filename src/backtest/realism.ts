// Backtest Realism — per-instrument spread + slippage cost model
//
// The backtest engine at src/backtest/engine.ts assumes zero spread and
// zero slippage on every trade. Agent γ's 2026-04-23 diagnostic
// (docs/superpowers/reviews/2026-04-23-backtest-vs-live-diagnostic.md)
// quantified this overstates strategy PnL by approximately −3072 R across
// the 14,918-trade 2019-2025 backtest (spread −897 R + slippage −2175 R).
// The 2026-04-22 USDJPY fill (expected 159.333, filled 159.187, 14.6 pips
// of entry slippage that gutted R:R from 1.7:1 to 0.5:1) is the
// live-grounded anchor for the USDJPY slippage_entry constant below.
// Other instruments scaled proportionally using typical Capital.com demo
// spreads and market-order fill behavior.
//
// News-filter proxy (γ's Delta 3, credibility C) is NOT implemented here —
// it's deferred to post-demo per the spec §1 non-goal.

export interface ExecutionCostConstants {
  /** Spread in instrument's native price units. Pips × pip_size for FX,
   *  dollars for commodities. */
  spread: number;
  /** Entry slippage in native price units. Anchored to the 2026-04-22
   *  USDJPY 14.6-pip live observation for USDJPY; other instruments
   *  scaled proportionally. */
  slippage_entry: number;
  /** Exit slippage in native price units. Typically ~30-40% of entry
   *  slippage — stop hunts and TP fill noise both tend net-adverse. */
  slippage_exit: number;
}

/** Per-instrument execution costs. Native price units. */
export const EXECUTION_COSTS: Record<string, ExecutionCostConstants> = {
  EURUSD:    { spread: 0.00008, slippage_entry: 0.00007, slippage_exit: 0.00004 },
  GBPUSD:    { spread: 0.00012, slippage_entry: 0.00010, slippage_exit: 0.00005 },
  USDJPY:    { spread: 0.010,   slippage_entry: 0.146,   slippage_exit: 0.050   },
  AUDUSD:    { spread: 0.00010, slippage_entry: 0.00009, slippage_exit: 0.00005 },
  GOLD:      { spread: 0.40,    slippage_entry: 0.60,    slippage_exit: 0.45    },
  SILVER:    { spread: 0.025,   slippage_entry: 0.040,   slippage_exit: 0.020   },
  OIL_CRUDE: { spread: 0.04,    slippage_entry: 0.07,    slippage_exit: 0.04    },
};

// Track unknown-ticker warnings so we log at most once per ticker per
// process. Noise control: a typo in the engine (e.g., 'SILVER_FUT') should
// flag loudly the first time it's seen, then stay silent so downstream log
// readers aren't drowned.
const warnedTickers = new Set<string>();

/**
 * Compute the R-unit execution cost for a trade on the given ticker
 * with the given stop distance (in the instrument's native price units).
 *
 * Formula:
 *   total_cost = spread + slippage_entry + slippage_exit
 *   r_cost     = total_cost / stopDistance
 *
 * Returns 0 for:
 *   - unknown ticker (warns once per ticker per process)
 *   - non-positive stopDistance (avoids divide-by-zero and nonsense input)
 *   - NaN stopDistance (same rationale)
 */
export function computeExecutionCost(ticker: string, stopDistance: number): number {
  if (!Number.isFinite(stopDistance) || stopDistance <= 0) {
    return 0;
  }

  const upper = ticker.toUpperCase();
  const costs = EXECUTION_COSTS[upper];

  if (!costs) {
    if (!warnedTickers.has(upper)) {
      warnedTickers.add(upper);
      console.warn(
        `[Realism] Unknown ticker '${upper}' — returning 0 execution cost. ` +
        `Add to EXECUTION_COSTS in src/backtest/realism.ts to avoid silently ` +
        `overstating backtest R. This warning fires once per ticker per process.`,
      );
    }
    return 0;
  }

  const totalCost = costs.spread + costs.slippage_entry + costs.slippage_exit;
  return totalCost / stopDistance;
}

/**
 * Test-only exposure. Lives at the bottom of the module so it's visually
 * obvious these are not part of the public runtime surface.
 *
 *   - `warnedTickers`:         the live Set, for inspecting/asserting warn state
 *   - `expectedRCostAtTypicalStop`: γ's per-instrument typical-stop assumption
 *                              paired with the R-cost γ expects at that stop.
 *                              Used by tests to sanity-check that the constants
 *                              above produce γ's headline numbers.
 *   - `resetWarnings`:         clears warnedTickers for test isolation.
 */
export const _internalsForTest = {
  warnedTickers,
  expectedRCostAtTypicalStop: {
    EURUSD:    { typicalStop: 0.00130, expectedRCost: 0.15 },
    GBPUSD:    { typicalStop: 0.00125, expectedRCost: 0.22 },
    USDJPY:    { typicalStop: 0.71,    expectedRCost: 0.29 },
    AUDUSD:    { typicalStop: 0.00120, expectedRCost: 0.20 },
    GOLD:      { typicalStop: 7.25,    expectedRCost: 0.20 },
    SILVER:    { typicalStop: 0.47,    expectedRCost: 0.18 },
    OIL_CRUDE: { typicalStop: 0.83,    expectedRCost: 0.18 },
  } as Record<string, { typicalStop: number; expectedRCost: number }>,
  resetWarnings: (): void => {
    warnedTickers.clear();
  },
};

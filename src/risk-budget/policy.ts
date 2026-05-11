// Risk-budget policy — STUB. Full implementation in T088 (PR 3 / US-7).
// Default max_total_risk_pct=0 preserves the legacy single-trade behaviour.

import { getPmState, getOpenTradesRiskPctSum } from '../database/index.js';

export interface RiskBudgetState {
  open_risk_pct: number;
  max_total_risk_pct: number;
}

export function getRiskBudgetState(): RiskBudgetState {
  const raw = getPmState('max_total_risk_pct');
  const max_total_risk_pct = raw === null ? 0 : Number(raw);
  return {
    open_risk_pct: getOpenTradesRiskPctSum(),
    max_total_risk_pct: Number.isFinite(max_total_risk_pct) ? max_total_risk_pct : 0,
  };
}

/**
 * Returns true iff (sum of open-trade risk + proposed risk) > budget AND
 * budget is configured (>0). When budget is 0 (default), this function
 * returns false so the legacy `EXECUTOR_REJECT_TRADE_OPEN` gate handles
 * single-trade enforcement instead.
 */
export function wouldExceed(proposedRiskPct: number, state?: RiskBudgetState): boolean {
  const s = state ?? getRiskBudgetState();
  if (s.max_total_risk_pct <= 0) return false;
  return s.open_risk_pct + proposedRiskPct > s.max_total_risk_pct;
}

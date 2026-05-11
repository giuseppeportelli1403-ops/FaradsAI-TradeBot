// src/risk-budget/ — opt-in concurrent-trades risk budget (US-7).
// Default max_total_risk_pct=0 preserves the legacy single-trade behaviour.

export {
  getRiskBudgetState,
  wouldExceed,
  type RiskBudgetState,
} from './policy.js';

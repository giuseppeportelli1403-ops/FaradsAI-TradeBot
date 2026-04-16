// Weekly Review Agent — Strategy Improver
// Fires every Sunday at 00:00 UTC
//
// Reads: full week of trade records (BOTH ICT and Swing), research briefs,
//        analyst decisions log, current strategy.md and swing_strategy.md
//
// Produces:
//   1. Weekly summary (total trades, win rate, avg R, total P&L) — broken down by strategy
//   2. Win rate by setup type (ICT and Swing separately)
//   3. Win rate by kill zone (ICT only)
//   4. Win rate by weekly/daily setup type (Swing only)
//   5. Win rate by news category alignment
//   6. Win rate by instrument category
//   7. Analyst agent statistics (% approved, % rejected, % modified, rejection accuracy)
//   8. Best performing setup per strategy
//   9. Worst performing setup per strategy
//   10. New banned patterns (if statistically justified)
//   11. Scoring weight adjustments (if statistically justified)
//   12. Researcher brief accuracy vs realised P&L correlation
//
// Rules:
//   - Minimum 10 trades per rule change (small samples lie)
//   - Must cite exact stats when changing scoring weights
//   - Cannot remove core risk management rules (Section 7)
//   - Cannot remove kill switches (Section 7.2)
//   - If both strategies underperform 2 consecutive weeks → Telegram "system review" alert
//   - Updates BOTH strategy.md and swing_strategy.md
//
// Implementation: Step 9

export async function runWeeklyReviewAgent(): Promise<void> {
  // TODO: Implement weekly performance report + dual strategy updates
}

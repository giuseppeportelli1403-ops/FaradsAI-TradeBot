// Reflection Agent — Post-Trade Structured Lesson Writer
// Fires automatically after every trade fully closes (both legs)
// Handles BOTH ICT Intraday and Swing trades
//
// Receives: complete trade record with entry, exit, setup type, news context,
//           composite score, final P&L in R, AND strategy_tag ("ICT_INTRADAY" or "SWING")
//
// Outputs: structured JSON lesson (25+ fields) saved to lessons table in DB
//
// Key fields: strategy_tag, lesson, rule_suggestion, was_bias_correct, was_trigger_valid,
//             score_accuracy_notes, pnl_total_r, setup_type, kill_zone, news_category,
//             analyst_decision, hold_duration, swing_layers (for swing trades)
//
// IMPORTANT: Keep separate lesson pools for ICT and Swing.
//            Never mix rules across strategies.
//            An ICT lesson about kill zones does not apply to a Swing trade held for 6 days.
//
// Implementation: Step 8

export async function runReflectionAgent(tradeId: string): Promise<void> {
  // TODO: Implement structured lesson generation for both strategies
}

// ICT Intraday Trading Agent — 5-Step Decision Cycle
// Called every time a new 15M or 1H candle closes
//
// Step 1: Check daily risk status (kill switch at 4% daily loss)
//         + Check portfolio count (max 3 positions)
//         + Check coordination lock (no trade if Swing agent has position on same instrument)
// Step 2: Get ranked instruments from universe scanner
// Step 3: Full ICT analysis per candidate instrument
//         (1H bias → ICT arrays → kill zone → news → lessons → composite score → 15M trigger → trade params)
// Step 4: Manage existing positions (TP1 hit → move SL to BE, trailing stops, early exits)
// Step 5: Output structured reasoning log for audit trail
//
// Uses split-position execution: every trade = 2 legs (Position A at TP1, Position B at TP2)
// strategy_tag: "ICT_INTRADAY"
// Labels: "{instrument}-A-{timestamp}" / "{instrument}-B-{timestamp}"
//
// Pre-execution: trade proposal sent to Analyst Agent for APPROVE/REJECT/MODIFY
// Combined max with Swing: 5 total trades open (10 T212 positions)
//
// Implementation: Step 7

export async function runTradingAgent(): Promise<void> {
  // TODO: Implement 5-step decision cycle
}

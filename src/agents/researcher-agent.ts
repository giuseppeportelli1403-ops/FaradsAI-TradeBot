// Market Researcher Agent — Battlefield Preparation
// Does NOT place trades. Prepares research briefs for both trading agents.
//
// Schedule:
//   - Daily at 05:30 UTC (before London open)
//   - Sunday at 22:00 UTC (before the week starts)
//
// Answers three questions each cycle:
//   1. What is the regime? (risk-on, risk-off, mixed)
//   2. What are today's/this week's themes?
//   3. Which instruments are in play? (top 10 per strategy)
//
// Decision Sequence:
//   Step 1: Regime check (VIX levels, DXY direction, yield curve)
//     - VIX < 15 → low vol, trend strategies favoured
//     - VIX 15-20 → normal, both strategies work
//     - VIX 20-30 → elevated, reduce position size 25%
//     - VIX > 30 → crisis, Swing stands down, ICT Tier 1 only
//   Step 2: Thematic scan (economic calendar, Tier 1 events)
//   Step 3: Sector/asset class ranking
//   Step 4: Instrument shortlists (ICT top 10 + Swing top 10)
//   Step 5: Write the brief (structured JSON → write_research_brief)
//
// Tools:
//   get_prices, get_economic_calendar, get_news_context,
//   get_sector_strength, get_correlation_matrix,
//   get_vix, get_dxy, get_yield_curve, write_research_brief
//
// Implementation: Step 6b

export async function runResearcherAgent(): Promise<void> {
  // TODO: Implement daily research sequence
}

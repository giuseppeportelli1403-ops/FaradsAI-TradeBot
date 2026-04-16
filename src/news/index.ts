// News Context System — Fetcher and Scorer
// Provides scored news items for the Main Trading Agent
//
// Categories:
//   Cat A (score 4-5): Major catalyst — strong directional impact
//   Cat B (score 2-3): Moderate supporting context
//   Cat C (score 0-1): Noise — ignore
//
// Rule: News opposing technical direction → skip instrument entirely
//
// Implementation: Step 6

export async function getNewsContext(instrument: string): Promise<unknown[]> {
  // TODO: Implement news fetching and scoring
  return [];
}

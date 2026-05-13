// Tier-1 RSS feed configuration — pruned 2026-05-13 per specs/001-news-pruning/.
//
// Hand-curated set of 6 free, reliable RSS feeds for EUR/USD macro trading.
// All entries are currently Tier 1 (wires, regulators, and FX specialists);
// the FeedTier type below still admits values 2 and 3 to allow future
// re-introduction of lower-tier feeds without a type migration (see FR-7
// in the spec). Originally a tiered 1/2/3 configuration (B3 pattern,
// 2026-04-28); collapsed to Tier 1 only when the news audit established
// that lower-tier blog/aggregator feeds added noise without lift.
//
// Feeds with `instruments: ['*']` apply to every Farad universe instrument;
// feeds with specific tags (`['GOLD', 'SILVER']` etc) only fan out to
// matching instruments. Currency tags (`USD`, `EUR`, etc) are matched by the
// per-instrument fan-out logic via instrumentToCurrencies.
//
// If a feed disappears or changes format, the poll loop logs the failure
// and the remaining feeds keep flowing. Curate this list in the same spirit
// as FinceptTerminal: add only sources you'd cite to a desk, retire feeds
// that drift to clickbait.

export type FeedTier = 1 | 2 | 3;

export interface FeedConfig {
  /** Display name for logs and source-tier scoring. */
  name: string;
  /** Tier 1 highest-weight (wires + regulators) → Tier 3 lowest. */
  tier: FeedTier;
  /** RSS URL. */
  url: string;
  /** Currencies / categories this feed primarily covers. Empty = global. */
  tags?: ReadonlyArray<string>;
  /** Notes for future maintainers — e.g. known reliability quirks. */
  notes?: string;
}

// 2026-05-13 news-pruning pass via specs/001-news-pruning/spec.md collapsed
// the previous 3-tier 15-feed configuration down to 6 Tier-1 feeds.
// 9 generic-news + alarmist + dead feeds dropped (full list in spec.md
// Context Summary); 3 forex-specialist feeds promoted from Tier 2 to Tier 1.
// The audit (specs/001-news-pruning/spec.md §Context Summary) established
// that news is NOT the trade-frequency bottleneck — this change is pure
// noise reduction, not a scoring change.
//
// Earlier 2026-04-28 validation-pass history removed 6 stale feeds (details
// in git log on this file). FeedTier type still admits 2 and 3 to allow
// future re-introduction of lower-tier feeds without a migration.
export const RSS_FEEDS: ReadonlyArray<FeedConfig> = [
  // ====== TIER 1 — wires, regulators, FX specialists ======
  {
    name: 'Federal Reserve press releases',
    tier: 1,
    url: 'https://www.federalreserve.gov/feeds/press_all.xml',
    tags: ['USD', 'FOMC'],
    notes: 'Official source for Fed announcements / FOMC decisions / minutes.',
  },
  {
    name: 'ECB press releases',
    tier: 1,
    url: 'https://www.ecb.europa.eu/rss/press.html',
    tags: ['EUR', 'ECB'],
    notes: 'Official ECB monetary-policy + supervisory press releases.',
  },
  {
    name: 'Bank of England news',
    tier: 1,
    url: 'https://www.bankofengland.co.uk/rss/news',
    tags: ['GBP', 'BoE', 'MPC'],
  },
  {
    name: 'ActionForex',
    tier: 1,
    url: 'https://www.actionforex.com/feed/',
    tags: ['EUR', 'GBP', 'USD', 'JPY', 'AUD'],
    notes: 'FX commentary + analysis. Promoted to Tier 1 in 2026-05-13 pruning pass — was Tier 2.',
  },
  {
    name: 'ForexLive',
    tier: 1,
    url: 'https://www.forexlive.com/feed',
    tags: ['EUR', 'GBP', 'USD', 'JPY', 'AUD'],
    notes: 'Live-blogging style; great for breaking FX moves. Promoted to Tier 1 in 2026-05-13 pruning pass — was Tier 2.',
  },
  {
    name: 'Investing.com Forex Opinion',
    tier: 1,
    url: 'https://www.investing.com/rss/forex.rss',
    tags: ['EUR', 'GBP', 'USD', 'JPY', 'AUD'],
    notes: 'FX-focused subset of Investing.com. Promoted to Tier 1 in 2026-05-13 pruning pass — was Tier 2.',
  },
];

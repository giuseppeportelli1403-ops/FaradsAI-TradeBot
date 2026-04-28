// Tiered RSS feed configuration — B3 (2026-04-28).
//
// Hand-curated set of free, reliable RSS feeds for FX + commodity trading,
// organised in three tiers per the FinceptTerminal pattern (NewsService.cpp:942
// in their codebase). Tier 1 = wires/regulators (highest weight), Tier 2 =
// FX/commodity specialists (high weight), Tier 3 = analysis/blogs (medium
// weight, used only as supporting context, never as Cat A on its own).
//
// Feeds with `instruments: ['*']` apply to every Farad universe instrument;
// feeds with specific tags (`['GOLD', 'SILVER']` etc) only fan out to
// matching instruments. Currency tags (`USD`, `EUR`, etc) are matched by the
// per-instrument fan-out logic via instrumentToCurrencies.
//
// If a feed disappears or changes format, the poll loop logs the failure
// and the other 17 keep flowing. Curate this list in the same spirit as
// FinceptTerminal: add only sources you'd cite to a desk, retire feeds that
// drift to clickbait.

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

export const RSS_FEEDS: ReadonlyArray<FeedConfig> = [
  // ====== TIER 1 — wires & regulators (PRIMARY SOURCES) ======
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
    name: 'US Treasury press releases',
    tier: 1,
    url: 'https://home.treasury.gov/rss-feeds/press-releases',
    tags: ['USD'],
    notes: 'Yields, sanctions, debt-issuance announcements.',
  },
  {
    name: 'BBC Business',
    tier: 1,
    url: 'https://feeds.bbci.co.uk/news/business/rss.xml',
    tags: ['*'],
    notes: 'Reliable global wire alternative since Reuters retired free RSS in 2020.',
  },
  {
    name: 'AP Business',
    tier: 1,
    url: 'https://apnews.com/index.rss',
    tags: ['*'],
    notes: 'AP throttles aggressive polling; respect 10-min interval.',
  },
  {
    name: 'IMF press releases',
    tier: 1,
    url: 'https://www.imf.org/en/News/RSS?Language=ENG&series=Press%20Releases',
    tags: ['*'],
  },
  {
    name: 'Bank for International Settlements (BIS)',
    tier: 1,
    url: 'https://www.bis.org/list/press_releases/index.rss',
    tags: ['*'],
    notes: 'Central-bank-of-central-banks; useful for systemic stress signals.',
  },

  // ====== TIER 2 — FX & commodity specialists (HIGH WEIGHT) ======
  {
    name: 'FXStreet news',
    tier: 2,
    url: 'https://www.fxstreet.com/rss/news',
    tags: ['EUR', 'GBP', 'USD', 'JPY', 'AUD'],
  },
  {
    name: 'ForexLive',
    tier: 2,
    url: 'https://www.forexlive.com/feed',
    tags: ['EUR', 'GBP', 'USD', 'JPY', 'AUD'],
    notes: 'Live-blogging style; great for breaking FX moves.',
  },
  {
    name: 'DailyFX articles',
    tier: 2,
    url: 'https://www.dailyfx.com/feeds/all',
    tags: ['EUR', 'GBP', 'USD', 'JPY', 'AUD'],
  },
  {
    name: 'Kitco News',
    tier: 2,
    url: 'https://www.kitco.com/rss/KitcoNews.xml',
    tags: ['GOLD', 'SILVER', 'USD'],
    notes: 'Gold/silver specialist; always relevant for XAU/XAG trades.',
  },
  {
    name: 'OilPrice.com',
    tier: 2,
    url: 'https://oilprice.com/rss/main',
    tags: ['OIL_CRUDE', 'USD'],
    notes: 'Crude / energy specialist; OPEC + EIA inventory + supply news.',
  },
  {
    name: 'Investing.com news',
    tier: 2,
    url: 'https://www.investing.com/rss/news.rss',
    tags: ['*'],
    notes: 'Broad markets feed with FX + commodity coverage.',
  },

  // ====== TIER 3 — analysis & blogs (SUPPORTING CONTEXT ONLY) ======
  {
    name: 'MarketWatch Top Stories',
    tier: 3,
    url: 'https://feeds.marketwatch.com/marketwatch/topstories/',
    tags: ['*'],
  },
  {
    name: 'Calculated Risk',
    tier: 3,
    url: 'https://www.calculatedriskblog.com/feeds/posts/default',
    tags: ['USD'],
    notes: 'Bill McBride; macro-trend + housing-cycle commentary.',
  },
  {
    name: 'Wolf Street',
    tier: 3,
    url: 'https://wolfstreet.com/feed/',
    tags: ['USD', 'EUR'],
  },
  {
    name: 'ZeroHedge',
    tier: 3,
    url: 'https://feeds.feedburner.com/zerohedge/feed',
    tags: ['*'],
    notes: 'Alarmist tone — single-source ZH never qualifies as Cat A; use only as supporting Tier-3 context.',
  },
];

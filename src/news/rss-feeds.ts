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

// 2026-04-28 validation pass via scripts/validate-rss-feeds.ts removed 6
// dead feeds (US Treasury/AP/IMF — 401/403/404; BIS — XML parse fail;
// DailyFX/Kitco — 403/404). Replaced with CNBC Top News + Yahoo Finance Top
// Stories. Re-validate before adding more — every addition incurs a 10-min
// poll cycle on the production scheduler.
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
    name: 'BBC Business',
    tier: 1,
    url: 'https://feeds.bbci.co.uk/news/business/rss.xml',
    tags: ['*'],
    notes: 'Reliable global wire alternative since Reuters retired free RSS in 2020.',
  },
  {
    name: 'CNBC Top News',
    tier: 1,
    url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114',
    tags: ['*'],
    notes: 'Replacement for AP Business (401) — major US business wire, validated 2026-04-28.',
  },
  // REMOVED 2026-04-28 (validation):
  //   - US Treasury press releases — https://home.treasury.gov/rss-feeds/press-releases (404, RSS deprecated)
  //   - AP Business — https://apnews.com/index.rss (401, requires API auth now)
  //   - IMF press releases — https://www.imf.org/en/News/RSS?... (403)
  //   - BIS — https://www.bis.org/list/press_releases/index.rss (XML parse failure)

  // ====== TIER 2 — FX & commodity specialists (HIGH WEIGHT) ======
  // FXStreet (https://www.fxstreet.com/rss/news) REMOVED 2026-04-28: works
  // from local laptop but Hetzner IP is blocked at the network layer (403
  // in <80ms regardless of User-Agent — datacenter/geo block, not UA gating).
  // No header spoof works. Replaced with ActionForex + Investing.com Forex
  // Opinion both confirmed 200 OK from VPS in ~200-800ms.
  {
    name: 'ActionForex',
    tier: 2,
    url: 'https://www.actionforex.com/feed/',
    tags: ['EUR', 'GBP', 'USD', 'JPY', 'AUD'],
    notes: 'Replacement for FXStreet (Hetzner-blocked). FX commentary + analysis. Validated 200 OK from VPS 2026-04-28.',
  },
  {
    name: 'Investing.com Forex Opinion',
    tier: 2,
    url: 'https://www.investing.com/rss/forex.rss',
    tags: ['EUR', 'GBP', 'USD', 'JPY', 'AUD'],
    notes: 'FX-focused subset of Investing.com (separate URL from the broader Investing.com news feed below). Validated 200 OK from VPS 2026-04-28.',
  },
  {
    name: 'ForexLive',
    tier: 2,
    url: 'https://www.forexlive.com/feed',
    tags: ['EUR', 'GBP', 'USD', 'JPY', 'AUD'],
    notes: 'Live-blogging style; great for breaking FX moves.',
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
  {
    name: 'Yahoo Finance Top Stories',
    tier: 2,
    url: 'https://finance.yahoo.com/rss/topstories',
    tags: ['*'],
    notes: 'Replacement for Kitco/DailyFX — broad markets, validated 2026-04-28.',
  },
  // REMOVED 2026-04-28 (validation):
  //   - DailyFX articles — https://www.dailyfx.com/feeds/all (403)
  //   - Kitco News — https://www.kitco.com/rss/KitcoNews.xml (404, URL changed)

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
    notes:
      'Bill McBride; macro-trend + housing-cycle commentary. NOTE 2026-04-28: validator showed latest article ~106 days old — feed parses OK but author may be on hiatus. Monitor; remove if stays stale.',
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

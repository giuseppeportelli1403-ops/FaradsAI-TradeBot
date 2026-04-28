// One-shot validator for the 18-feed RSS configuration in src/news/rss-feeds.ts.
// Hits every feed once, times each fetch, reports HTTP status + parse success
// + article count + most-recent article title. Use to catch feeds that 404,
// redirect, or have changed format BEFORE the bot relies on them.
//
// Usage:
//   npx tsx scripts/validate-rss-feeds.ts             # default 10s timeout
//   npx tsx scripts/validate-rss-feeds.ts --timeout 30  # 30s timeout
//
// Exit code: 0 if all feeds OK, 1 if any failed (so this can be wired
// into pre-deploy checks).
import Parser from 'rss-parser';
import { RSS_FEEDS, type FeedConfig } from '../src/news/rss-feeds.js';

interface Result {
  config: FeedConfig;
  status: 'OK' | 'FAIL' | 'EMPTY';
  durationMs: number;
  articleCount?: number;
  latestTitle?: string;
  latestAgeHours?: number;
  error?: string;
}

function parseTimeoutArg(argv: string[]): number {
  const flag = argv.indexOf('--timeout');
  if (flag !== -1 && argv[flag + 1]) {
    const sec = parseInt(argv[flag + 1], 10);
    if (Number.isFinite(sec) && sec > 0) return sec * 1000;
  }
  return 10_000;
}

async function validateOne(config: FeedConfig, timeoutMs: number): Promise<Result> {
  const parser = new Parser({
    timeout: timeoutMs,
    headers: { 'User-Agent': 'BetterOpsAI-Farad/1.0 (RSS validator)' },
  });
  const start = Date.now();
  try {
    const parsed = await parser.parseURL(config.url);
    const durationMs = Date.now() - start;
    const items = parsed.items ?? [];
    if (items.length === 0) {
      return { config, status: 'EMPTY', durationMs, articleCount: 0 };
    }
    const latest = items[0];
    const pubMs = Date.parse(latest.isoDate ?? latest.pubDate ?? '');
    const ageHours = Number.isFinite(pubMs) ? (Date.now() - pubMs) / (1000 * 60 * 60) : undefined;
    return {
      config,
      status: 'OK',
      durationMs,
      articleCount: items.length,
      latestTitle: (latest.title ?? '').slice(0, 80),
      latestAgeHours: ageHours !== undefined ? Math.round(ageHours * 10) / 10 : undefined,
    };
  } catch (err) {
    return {
      config,
      status: 'FAIL',
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function statusIcon(status: Result['status']): string {
  if (status === 'OK') return '[OK]   ';
  if (status === 'EMPTY') return '[EMPTY]';
  return '[FAIL] ';
}

async function main(): Promise<void> {
  const timeoutMs = parseTimeoutArg(process.argv.slice(2));
  console.log(`[validate-rss] Polling ${RSS_FEEDS.length} feeds with ${timeoutMs / 1000}s timeout each...\n`);

  // Concurrency cap matches the live aggregator (6) so this exercises the
  // same load profile the production poll loop hits.
  const concurrency = 6;
  const results: Result[] = new Array(RSS_FEEDS.length);
  for (let cursor = 0; cursor < RSS_FEEDS.length; cursor += concurrency) {
    const batch = RSS_FEEDS.slice(cursor, cursor + concurrency);
    const batchResults = await Promise.all(batch.map((feed) => validateOne(feed, timeoutMs)));
    for (let j = 0; j < batch.length; j++) {
      results[cursor + j] = batchResults[j];
    }
  }

  // Group by tier, then status.
  const byTier: Record<number, Result[]> = { 1: [], 2: [], 3: [] };
  for (const r of results) byTier[r.config.tier].push(r);

  const ok = results.filter((r) => r.status === 'OK').length;
  const empty = results.filter((r) => r.status === 'EMPTY').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;

  console.log(`Summary: ${ok} OK, ${empty} EMPTY, ${fail} FAIL out of ${results.length}\n`);

  for (const tier of [1, 2, 3] as const) {
    const tierResults = byTier[tier];
    console.log(`---- Tier ${tier} (${tierResults.length} feeds) ----`);
    for (const r of tierResults) {
      const icon = statusIcon(r.status);
      const dur = `${String(r.durationMs).padStart(5)}ms`;
      const name = r.config.name.padEnd(36);
      if (r.status === 'OK') {
        const ageStr = r.latestAgeHours !== undefined ? `${r.latestAgeHours}h ago` : '?';
        console.log(`  ${icon} ${name} ${dur} | ${r.articleCount} articles | latest ${ageStr}`);
        console.log(`           "${r.latestTitle}"`);
      } else if (r.status === 'EMPTY') {
        console.log(`  ${icon} ${name} ${dur} | feed parsed but 0 articles`);
      } else {
        console.log(`  ${icon} ${name} ${dur} | ERROR: ${r.error}`);
        console.log(`           ${r.config.url}`);
      }
    }
    console.log('');
  }

  if (fail > 0) {
    console.log(`[validate-rss] ${fail} feed(s) failed — replacement URLs needed.`);
    process.exit(1);
  }
  if (empty > 0) {
    console.log(`[validate-rss] ${empty} feed(s) parsed but returned no articles — investigate.`);
    process.exit(1);
  }
  console.log('[validate-rss] All feeds OK.');
}

main().catch((err) => {
  console.error('[validate-rss] FAILED:', err);
  process.exit(1);
});

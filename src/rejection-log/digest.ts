// Daily rejection digest builder. Reads from trade_rejections and
// analyst_log, summarises by category, and returns a payload ready for
// Telegram delivery (or stdout for --dry-run).
//
// Real implementation lands in T031. This file ships in T006 as the
// import surface so the scheduler cron and digest CLI script can already
// reference it without circular-build issues.

import { getDailyRejections } from '../database/index.js';
import { REJECTION_CATEGORIES, type RejectionCategory } from './categories.js';

export interface DigestPayload {
  date: string;                                          // YYYY-MM-DD UTC
  total_rejections: number;
  fail_closed_total: number;
  by_category: Partial<Record<RejectionCategory, number>>;
  has_other: boolean;                                    // SC-002 guard — must be false in production
}

export function buildDailyDigest(dateUtc: string): DigestPayload {
  const rows = getDailyRejections(dateUtc);
  const by_category: Partial<Record<RejectionCategory, number>> = {};
  let total_rejections = 0;
  let fail_closed_total = 0;
  let has_other = false;

  for (const row of rows) {
    // Defensive cast — recordRejection enforces the enum at the type
    // boundary, but a row written outside that path could be anything.
    const cat = row.category as RejectionCategory;
    by_category[cat] = (by_category[cat] ?? 0) + row.count;
    total_rejections += row.count;
    if (row.is_fail_closed === 1) {
      fail_closed_total += row.count;
    }
    if (cat === 'OTHER' || !REJECTION_CATEGORIES.includes(cat)) {
      has_other = true;
    }
  }

  return {
    date: dateUtc,
    total_rejections,
    fail_closed_total,
    by_category,
    has_other,
  };
}

/**
 * Format a digest payload as a single Telegram message body.
 * One line per category sorted by count desc, total at bottom.
 */
export function formatDigestForTelegram(payload: DigestPayload): string {
  const sortedEntries = Object.entries(payload.by_category)
    .sort((a, b) => (b[1] as number) - (a[1] as number));
  const lines: string[] = [
    `📊 *Rejection Digest — ${payload.date} UTC*`,
    '',
    ...sortedEntries.map(([cat, count]) => `\`${count.toString().padStart(4)}\` ${cat}`),
    '',
    `Total: ${payload.total_rejections} (fail-closed: ${payload.fail_closed_total})`,
  ];
  if (payload.has_other) {
    lines.push('');
    lines.push('⚠️ `OTHER` or unknown category present — investigate (SC-002 violation).');
  }
  return lines.join('\n');
}

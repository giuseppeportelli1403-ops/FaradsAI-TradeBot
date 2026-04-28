// EOD Journal Agent — W3 (2026-04-28).
//
// MindStudio-inspired pattern. Runs once per UK trading day at 21:30 UTC
// (after US close, before Asia open). Reads the day's trades + lessons +
// brief, writes a short Markdown reflection to journal/YYYY-MM-DD.md.
// The next morning's ICT cycle gets the journal as preamble context — a
// "yesterday I learned X" thread that complements the per-trade Reflection
// Agent at a different time horizon.
//
// Model: Haiku 4.5 — summarisation task, low stakes (informational, not
// decisive). Mixed model assignment 2026-04-28.

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadPromptWithSystemTime } from './load-prompt.js';
import { loadStrategy } from './load-prompt.js';
import { extractText, withTimeout } from './llm-output.js';
import { getTradesForWeek, getLessons, getDailyPnl, getLatestBrief } from '../database/index.js';

const anthropic = new Anthropic();
const __dirname = dirname(fileURLToPath(import.meta.url));

const JOURNAL_DIR = join(__dirname, '..', '..', 'journal');

/**
 * Compute the UTC day-bucket strings for "today" relative to `now`.
 * Returns YYYY-MM-DD as the date label, plus ISO timestamps for the
 * day's [start, end) used by getTradesForWeek-style date filters.
 */
export function dayBucket(now: Date): {
  date: string;
  startIso: string;
  endIso: string;
} {
  const date = now.toISOString().slice(0, 10);
  const start = new Date(`${date}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 24 * 60 * 60_000);
  return {
    date,
    startIso: start.toISOString(),
    endIso: end.toISOString(),
  };
}

export function journalPathFor(date: string): string {
  return join(JOURNAL_DIR, `${date}.md`);
}

/**
 * Read the most recent journal entry on or before `now − 1 day`. Walks back
 * up to `maxLookbackDays` (default 3) to handle weekend gaps — Monday morning's
 * ICT cycle reaches for Friday's journal. Returns null when no entry exists
 * in the lookback window (e.g. first day after deploy).
 *
 * CR-9 (2026-04-28): default lookback narrowed 5 → 3 days so extended
 * downtime can't inject a stale week-old journal as preamble. Mon morning
 * with the bot offline since Tue still finds Fri's journal (1-day weekend
 * + Mon weekday-in-the-future reach). Anything older than that is stale
 * enough that "no preamble" is preferable.
 *
 * Used by the ICT Trading Agent to prepend yesterday's reflection to its
 * decision-cycle context message — closes the W3 loop so the EOD journal
 * actually informs the next day's trades.
 */
export function loadRecentJournal(
  now: Date = new Date(),
  maxLookbackDays: number = 3,
): { date: string; markdown: string } | null {
  for (let i = 1; i <= maxLookbackDays; i++) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    const date = d.toISOString().slice(0, 10);
    const path = journalPathFor(date);
    if (existsSync(path)) {
      try {
        return { date, markdown: readFileSync(path, 'utf-8') };
      } catch {
        // Read errored — skip this date and try the next one
      }
    }
  }
  return null;
}

/**
 * Persist a markdown journal entry for `date`. Creates the journal/
 * directory if missing. Overwrites any existing entry for the same date
 * (re-running the agent on a date is intentionally idempotent — the second
 * run uses the latest data).
 */
export function saveJournalEntry(date: string, markdown: string): string {
  if (!existsSync(JOURNAL_DIR)) {
    mkdirSync(JOURNAL_DIR, { recursive: true });
  }
  const path = journalPathFor(date);
  writeFileSync(path, markdown, 'utf-8');
  return path;
}

export async function runEodJournalAgent(now: Date = new Date()): Promise<string> {
  const bucket = dayBucket(now);
  console.log(`EOD Journal Agent starting for ${bucket.date}...`);

  const trades = getTradesForWeek(bucket.startIso, bucket.endIso);
  const lessons = getLessons({ strategy_tag: 'ICT_INTRADAY', limit: 50 }).filter((l) => {
    const ts = (l.timestamp ?? '').slice(0, 10);
    return ts === bucket.date;
  });
  const dailyPnl = getDailyPnl(bucket.date);
  const brief = getLatestBrief();
  const strategy = loadStrategy('strategy.md');

  const systemPrompt = loadPromptWithSystemTime('eod-journal.md', now);

  // 2026-04-29 audit: 30s timeout (Codex AN6 — Anthropic SDK default is
  // 600s, way too long for a daily summary).
  const timeoutMs = 30_000;
  let response: Awaited<ReturnType<typeof anthropic.messages.create>>;
  try {
    response = await withTimeout(
      anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium' },
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages: [{
          role: 'user',
          content: `EOD CONTEXT — ${bucket.date}

DAILY P&L: ${dailyPnl ? JSON.stringify(dailyPnl) : 'No P&L record for today.'}

TRADES TODAY (${trades.length}):
${JSON.stringify(trades, null, 2)}

LESSONS RECORDED TODAY (${lessons.length}):
${JSON.stringify(lessons, null, 2)}

LATEST RESEARCH BRIEF:
${brief ? JSON.stringify(brief, null, 2) : 'No brief available.'}

CURRENT STRATEGY (excerpt):
${strategy.slice(0, 2000)}

Write the journal entry in the exact Markdown format from your system prompt. Output ONLY the Markdown document — no JSON, no preamble.`,
        }],
      }),
      timeoutMs,
      'EOD Journal',
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[EOD Journal] API call failed for ${bucket.date}: ${msg}.`);
    return '';
  }

  // 2026-04-29 audit fix (P0-A1): use extractText to read all blocks.
  // Pre-fix `response.content[0]?.type === 'text'` returned '' whenever
  // adaptive thinking placed a ThinkingBlock at index 0 — every EOD
  // journal entry was silently empty.
  const text = extractText(response.content);
  if (!text) {
    console.warn(`[EOD Journal] Empty response for ${bucket.date}; skipping save.`);
    return '';
  }

  const path = saveJournalEntry(bucket.date, text);
  console.log(`EOD Journal saved: ${path}`);
  return text;
}

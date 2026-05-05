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
import { withTimeout } from './llm-output.js';
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

// 2026-05-05 audit (Phase 2 / Round 1 / item 1.3): forced submit_journal
// tool call. Pre-fix the agent emitted free-form Markdown that silently
// truncated to empty when adaptive thinking ate the budget; the tool now
// holds the markdown body in the `summary` field, decoupling output shape
// from token contention.

export interface JournalEntry {
  summary: string;
  tags: string[];
  total_trades: number;
  total_r: number;
}

const submitJournalTool = {
  name: 'submit_journal',
  description:
    'Submit the day-end journal entry. Call this tool exactly once. The full Markdown journal body goes ' +
    'in the `summary` field (no length cap from us, only Anthropic max_tokens).',
  input_schema: {
    type: 'object' as const,
    properties: {
      summary: {
        type: 'string',
        description:
          'Full Markdown journal — sections per the system prompt. Must be at least 100 chars; shorter is rejected.',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Short tags for indexing — instruments, kill-zones, themes mentioned. Empty array OK.',
      },
      total_trades: { type: 'number', description: 'Number of trades closed today (from the input data).' },
      total_r: { type: 'number', description: 'Total R for the day across all closed trades.' },
    },
    required: ['summary', 'tags', 'total_trades', 'total_r'],
  },
};

/**
 * Read the journal entry from a forced submit_journal tool_use block.
 * Returns null on missing tool / short summary (< 100 chars) — caller
 * skips save and logs warning.
 */
export function extractJournalFromTool(content: unknown[]): JournalEntry | null {
  if (!Array.isArray(content) || content.length === 0) return null;

  for (const block of content) {
    if (
      block &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'tool_use' &&
      (block as { name?: unknown }).name === 'submit_journal'
    ) {
      const rawInput = (block as { input?: unknown }).input;
      if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) return null;
      const raw = rawInput as Record<string, unknown>;

      const summary = typeof raw.summary === 'string' ? raw.summary : '';
      if (summary.length < 100) return null;

      const tags = Array.isArray(raw.tags)
        ? (raw.tags as unknown[]).map((t) => String(t)).filter((t) => t.length > 0)
        : [];

      const totalTradesRaw = Number(raw.total_trades);
      const total_trades = Number.isFinite(totalTradesRaw) ? Math.max(0, Math.floor(totalTradesRaw)) : 0;

      const totalRRaw = Number(raw.total_r);
      const total_r = Number.isFinite(totalRRaw) ? totalRRaw : 0;

      return { summary, tags, total_trades, total_r };
    }
  }
  return null;
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

  const timeoutMs = 30_000;
  let response: Awaited<ReturnType<typeof anthropic.messages.create>>;
  try {
    response = await withTimeout(
      anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4000,
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages: [
          {
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

Write the journal entry in the exact Markdown format from your system prompt and call the submit_journal tool with the Markdown body in the summary field.`,
          },
        ],
        tools: [submitJournalTool],
        tool_choice: { type: 'tool', name: 'submit_journal' },
      } as Parameters<typeof anthropic.messages.create>[0]),
      timeoutMs,
      'EOD Journal',
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[EOD Journal] API call failed for ${bucket.date}: ${msg}.`);
    return '';
  }

  const m = response as Anthropic.Messages.Message;
  console.log(`[EOD Journal] stop_reason=${m.stop_reason} content_blocks=${m.content.length}`);

  const journal = extractJournalFromTool(m.content as unknown[]);
  if (journal === null) {
    console.warn(`[EOD Journal] No usable journal in tool_use for ${bucket.date}; skipping save.`);
    return '';
  }

  const path = saveJournalEntry(bucket.date, journal.summary);
  console.log(`EOD Journal saved: ${path} (trades=${journal.total_trades}, R=${journal.total_r}, tags=${journal.tags.length})`);
  return journal.summary;
}

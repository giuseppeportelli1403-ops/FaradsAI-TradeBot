// Tests for EOD Journal helpers — W3 (2026-04-28). The full agent run is
// integration-shaped (DB + Anthropic); these tests cover the pure helpers
// that turn a Date into a YYYY-MM-DD bucket + write the markdown to disk.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  dayBucket,
  journalPathFor,
  saveJournalEntry,
  loadRecentJournal,
} from '../src/agents/eod-journal-agent.js';

describe('dayBucket', () => {
  it('returns YYYY-MM-DD for a UTC noon timestamp', () => {
    const result = dayBucket(new Date('2026-04-28T12:00:00Z'));
    expect(result.date).toBe('2026-04-28');
    expect(result.startIso).toBe('2026-04-28T00:00:00.000Z');
    expect(result.endIso).toBe('2026-04-29T00:00:00.000Z');
  });

  it('uses UTC bucketing — 23:30 stays in same UTC day', () => {
    const result = dayBucket(new Date('2026-04-28T23:30:00Z'));
    expect(result.date).toBe('2026-04-28');
  });

  it('rolls into next UTC day at 00:00 UTC', () => {
    const result = dayBucket(new Date('2026-04-29T00:00:00Z'));
    expect(result.date).toBe('2026-04-29');
  });

  it('returns a 24h window in startIso/endIso', () => {
    const { startIso, endIso } = dayBucket(new Date('2026-04-28T15:00:00Z'));
    const span = new Date(endIso).getTime() - new Date(startIso).getTime();
    expect(span).toBe(24 * 60 * 60_000);
  });
});

describe('journalPathFor', () => {
  it('produces a path ending in {date}.md', () => {
    const path = journalPathFor('2026-04-28');
    expect(path.endsWith('2026-04-28.md')).toBe(true);
  });
});

describe('saveJournalEntry', () => {
  // Note: saveJournalEntry uses a fixed JOURNAL_DIR (relative to module
  // path). Since we cannot easily redirect that from the test, we save to
  // the real journal/ directory and clean up afterwards. Use a unique
  // sentinel date to avoid collisions with real journal entries.

  const sentinelDate = '1999-01-01';

  beforeEach(() => {
    // Best-effort cleanup of any prior sentinel
    const path = journalPathFor(sentinelDate);
    if (existsSync(path)) rmSync(path);
  });

  afterEach(() => {
    const path = journalPathFor(sentinelDate);
    if (existsSync(path)) rmSync(path);
  });

  it('writes the markdown to journal/{date}.md and returns the path', () => {
    const path = saveJournalEntry(sentinelDate, '# Test journal\n\nContent.');
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf-8')).toBe('# Test journal\n\nContent.');
  });

  it('overwrites an existing entry on second call (idempotent rerun)', () => {
    saveJournalEntry(sentinelDate, '# First write');
    saveJournalEntry(sentinelDate, '# Second write');
    const path = journalPathFor(sentinelDate);
    expect(readFileSync(path, 'utf-8')).toBe('# Second write');
  });

  it('creates the journal directory if it does not exist', () => {
    // The journal/ dir should already exist from prior runs, but
    // saveJournalEntry must be defensive.
    saveJournalEntry(sentinelDate, '# Content');
    expect(existsSync(journalPathFor(sentinelDate))).toBe(true);
  });
});

describe('loadRecentJournal — ICT preamble lookup (B, 2026-04-28)', () => {
  // Sentinel dates well in the past so they don't collide with real entries.
  const targetDate = '1999-06-15';
  const sentinelDayBefore = '1999-06-14';
  const sentinelTwoDaysBefore = '1999-06-13';

  beforeEach(() => {
    [sentinelDayBefore, sentinelTwoDaysBefore].forEach((d) => {
      const path = journalPathFor(d);
      if (existsSync(path)) rmSync(path);
    });
  });

  afterEach(() => {
    [sentinelDayBefore, sentinelTwoDaysBefore].forEach((d) => {
      const path = journalPathFor(d);
      if (existsSync(path)) rmSync(path);
    });
  });

  it('returns yesterday\'s journal when present', () => {
    saveJournalEntry(sentinelDayBefore, '# Yesterday\n\nWe traded EURUSD.');
    const result = loadRecentJournal(new Date(`${targetDate}T08:00:00Z`));
    expect(result).not.toBeNull();
    expect(result!.date).toBe(sentinelDayBefore);
    expect(result!.markdown).toContain('EURUSD');
  });

  it('walks back to find the most recent journal when yesterday is missing', () => {
    // Skip yesterday; only "two days ago" exists. Simulates Monday morning
    // looking back to Friday across the weekend gap.
    saveJournalEntry(sentinelTwoDaysBefore, '# Two days ago');
    const result = loadRecentJournal(new Date(`${targetDate}T08:00:00Z`));
    expect(result).not.toBeNull();
    expect(result!.date).toBe(sentinelTwoDaysBefore);
  });

  it('returns null when no journal exists in the lookback window', () => {
    // No journal saved. Default maxLookbackDays=5 covers 5 prior dates.
    const result = loadRecentJournal(new Date(`${targetDate}T08:00:00Z`));
    expect(result).toBeNull();
  });

  it('respects custom maxLookbackDays — narrower window misses older entry', () => {
    // Two days ago, but ask only 1 day back.
    saveJournalEntry(sentinelTwoDaysBefore, '# Two days ago');
    const result = loadRecentJournal(new Date(`${targetDate}T08:00:00Z`), 1);
    expect(result).toBeNull();
  });

  it('prefers the most recent (yesterday wins over 2-days-ago)', () => {
    saveJournalEntry(sentinelTwoDaysBefore, '# Older');
    saveJournalEntry(sentinelDayBefore, '# Newer');
    const result = loadRecentJournal(new Date(`${targetDate}T08:00:00Z`));
    expect(result!.date).toBe(sentinelDayBefore);
    expect(result!.markdown).toContain('Newer');
  });
});

// 2026-05-05 audit (Phase 2 / Round 1 / item 1.3): forced submit_journal
// tool call. Replaces text-extract pattern that silently saved empty
// journals when output truncated.
import { extractJournalFromTool } from '../src/agents/eod-journal-agent.js';

describe('extractJournalFromTool — read journal from submit_journal tool_use', () => {
  const longSummary = '# 2026-05-05 EOD Journal\n\n## Trades\n\nOne SILVER long executed during London Open at 73.398. Hit TP1 cleanly, Legs B+C rolled to BE on Fed-speak headline. Net +0.5R for the day.\n\n## Lessons\n\nThe FVG fill held — clean structure pays.';

  it('extracts a complete journal from a submit_journal tool_use block', () => {
    const content = [
      {
        type: 'tool_use', id: 't', name: 'submit_journal',
        input: { summary: longSummary, tags: ['SILVER', 'London Open'], total_trades: 1, total_r: 0.5 },
      },
    ];
    const journal = extractJournalFromTool(content as never);
    expect(journal).not.toBeNull();
    expect(journal?.summary).toBe(longSummary);
    expect(journal?.total_trades).toBe(1);
    expect(journal?.tags).toContain('SILVER');
  });

  it('returns null on missing tool block', () => {
    expect(extractJournalFromTool([{ type: 'text', text: 'oops' }] as never)).toBeNull();
  });

  it('returns null when summary is too short (< 100 chars)', () => {
    const content = [
      { type: 'tool_use', id: 't', name: 'submit_journal',
        input: { summary: 'too short', tags: [], total_trades: 0, total_r: 0 } },
    ];
    expect(extractJournalFromTool(content as never)).toBeNull();
  });

  it('returns null when summary is missing', () => {
    const content = [
      { type: 'tool_use', id: 't', name: 'submit_journal',
        input: { tags: [], total_trades: 0, total_r: 0 } },
    ];
    expect(extractJournalFromTool(content as never)).toBeNull();
  });

  it('coerces non-finite numerics defensively', () => {
    const content = [
      { type: 'tool_use', id: 't', name: 'submit_journal',
        input: { summary: longSummary, tags: [], total_trades: NaN, total_r: 'not-a-number' } },
    ];
    const journal = extractJournalFromTool(content as never);
    expect(journal?.total_trades).toBe(0);
    expect(journal?.total_r).toBe(0);
  });

  it('handles tags as empty array when missing', () => {
    const content = [
      { type: 'tool_use', id: 't', name: 'submit_journal',
        input: { summary: longSummary, total_trades: 0, total_r: 0 } },
    ];
    const journal = extractJournalFromTool(content as never);
    expect(journal?.tags).toEqual([]);
  });
});

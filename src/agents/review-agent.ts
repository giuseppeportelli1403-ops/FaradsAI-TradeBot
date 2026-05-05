// Weekly Review Agent — Strategy Improver
// Fires every Sunday at 00:00 UTC
// Analyses the full week, detects patterns, updates both strategy files

import Anthropic from '@anthropic-ai/sdk';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadPromptWithSystemTime, loadStrategy } from './load-prompt.js';
import { withTimeout } from './llm-output.js';
import { alertSystemWarning } from '../notifications/telegram.js';
import { getTradesForWeek, getLessons, getLessonWinRate } from '../database/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const anthropic = new Anthropic();

function saveFile(filename: string, content: string): void {
  writeFileSync(join(__dirname, '..', '..', 'memory', filename), content, 'utf-8');
}

// 2026-05-05 audit (Phase 2 / Round 1 / item 1.4): forced submit_review
// tool calling. Largest schema of the four agents — multi-section. Pre-fix
// the prose-then-JSON pattern blew the budget when the report grew, then
// the entire week's review was lost (Telegram alert was the only signal).

export interface IctUpdate {
  section: string;
  change: string;
  basis: string;
}

export interface BannedPattern {
  pattern: string;
  win_rate: string;
  trade_count: number;
}

export interface CalibrationMetrics {
  total_calls: number;
  approved: number;
  rejected: number;
  apf_correlation: number;
}

export interface ReviewOutput {
  report: string;
  ict_updates: IctUpdate[];
  banned_patterns: BannedPattern[];
  alerts: string[];
  calibration_metrics: CalibrationMetrics | null;
}

const submitReviewTool = {
  name: 'submit_review',
  description:
    'Submit the weekly review. Call exactly once. The full prose report goes in `report`; structured ' +
    'recommendations go in their respective fields. ict_updates / banned_patterns / alerts are arrays — empty if nothing applies.',
  input_schema: {
    type: 'object' as const,
    properties: {
      report: {
        type: 'string',
        description:
          'Markdown weekly report. Cite specific trade IDs and stats. Be honest. ~400-1000 words.',
      },
      ict_updates: {
        type: 'array',
        description: 'Proposed strategy.md changes. AUDIT-ONLY (logged, NOT applied). Empty array OK.',
        items: {
          type: 'object',
          properties: {
            section: { type: 'string', description: 'Strategy section number, e.g. "5", "7.3".' },
            change: { type: 'string', description: 'Concrete change to make, written for a human reviewer.' },
            basis: { type: 'string', description: 'What in this week\'s data motivates the change.' },
          },
          required: ['section', 'change', 'basis'],
        },
      },
      banned_patterns: {
        type: 'array',
        description: 'New patterns to ban based on poor win-rate evidence. Appended to strategy.md Section 6.',
        items: {
          type: 'object',
          properties: {
            pattern: { type: 'string' },
            win_rate: { type: 'string', description: 'e.g. "0%" or "1/5".' },
            trade_count: { type: 'number' },
          },
          required: ['pattern', 'win_rate', 'trade_count'],
        },
      },
      alerts: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Operator alerts — sent to Telegram. Use for cron failures, data degradation, suspicious metrics, etc.',
      },
      calibration_metrics: {
        type: 'object',
        description:
          'Analyst calibration math for the week. apf_correlation is the correlation between analyst confidence and trade-PnL outcome.',
        properties: {
          total_calls: { type: 'number' },
          approved: { type: 'number' },
          rejected: { type: 'number' },
          apf_correlation: { type: 'number' },
        },
      },
    },
    required: ['report'],
  },
};

function coerceFiniteNum(v: unknown, def: number = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

/**
 * Read the review from a forced submit_review tool_use block. Drops malformed
 * row entries from the arrays rather than failing the whole review (we'd
 * rather get partial recommendations than none). Returns null only on
 * missing tool block or missing/empty report.
 */
export function extractReviewFromTool(content: unknown[]): ReviewOutput | null {
  if (!Array.isArray(content) || content.length === 0) return null;

  for (const block of content) {
    if (
      block &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'tool_use' &&
      (block as { name?: unknown }).name === 'submit_review'
    ) {
      const rawInput = (block as { input?: unknown }).input;
      if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) return null;
      const raw = rawInput as Record<string, unknown>;

      const report = typeof raw.report === 'string' ? raw.report : '';
      if (report.length === 0) return null;

      const ictUpdates: IctUpdate[] = Array.isArray(raw.ict_updates)
        ? (raw.ict_updates as unknown[])
            .filter((u): u is Record<string, unknown> => !!u && typeof u === 'object' && !Array.isArray(u))
            .map((u) => ({
              section: typeof u.section === 'string' ? u.section : '',
              change: typeof u.change === 'string' ? u.change : '',
              basis: typeof u.basis === 'string' ? u.basis : '',
            }))
            .filter((u) => u.section.length > 0 && u.change.length > 0 && u.basis.length > 0)
        : [];

      const bannedPatterns: BannedPattern[] = Array.isArray(raw.banned_patterns)
        ? (raw.banned_patterns as unknown[])
            .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object' && !Array.isArray(p))
            .map((p) => ({
              pattern: typeof p.pattern === 'string' ? p.pattern : '',
              win_rate: typeof p.win_rate === 'string' ? p.win_rate : '',
              trade_count: coerceFiniteNum(p.trade_count),
            }))
            .filter((p) => p.pattern.length > 0)
        : [];

      const alerts: string[] = Array.isArray(raw.alerts)
        ? (raw.alerts as unknown[]).map((a) => String(a)).filter((a) => a.length > 0)
        : [];

      let calibration_metrics: CalibrationMetrics | null = null;
      if (raw.calibration_metrics && typeof raw.calibration_metrics === 'object' && !Array.isArray(raw.calibration_metrics)) {
        const cm = raw.calibration_metrics as Record<string, unknown>;
        calibration_metrics = {
          total_calls: coerceFiniteNum(cm.total_calls),
          approved: coerceFiniteNum(cm.approved),
          rejected: coerceFiniteNum(cm.rejected),
          apf_correlation: coerceFiniteNum(cm.apf_correlation),
        };
      }

      return { report, ict_updates: ictUpdates, banned_patterns: bannedPatterns, alerts, calibration_metrics };
    }
  }
  return null;
}

export async function runWeeklyReviewAgent(): Promise<string> {
  console.log('Weekly Review Agent starting...');

  const systemPrompt = loadPromptWithSystemTime('review-agent.md');

  // Calculate week boundaries (last Mon 00:00 to this Sun 00:00)
  const now = new Date();
  const weekEnd = new Date(now);
  weekEnd.setUTCHours(0, 0, 0, 0);
  const weekStart = new Date(weekEnd);
  weekStart.setUTCDate(weekStart.getUTCDate() - 7);

  const weekStartStr = weekStart.toISOString();
  const weekEndStr = weekEnd.toISOString();

  // Gather all data
  const trades = getTradesForWeek(weekStartStr, weekEndStr);
  const ictLessons = getLessons({ strategy_tag: 'ICT_INTRADAY', limit: 100 });
  const swingLessons = getLessons({ strategy_tag: 'SWING', limit: 100 });
  const ictWinRate = getLessonWinRate({ strategy_tag: 'ICT_INTRADAY' });
  const swingWinRate = getLessonWinRate({ strategy_tag: 'SWING' });

  const ictStrategy = loadStrategy('strategy.md');
  const swingStrategy = loadStrategy('swing_strategy.md');

  if (trades.length === 0) {
    console.log('No trades this week. Skipping review.');
    return 'No trades to review.';
  }

  const timeoutMs = 60_000;
  const response = await withTimeout(
    anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 12000,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: `WEEK: ${weekStartStr.split('T')[0]} to ${weekEndStr.split('T')[0]}

TRADES THIS WEEK (${trades.length}):
${JSON.stringify(trades, null, 2)}

ICT LESSONS (${ictLessons.length} total, win rate ${ictWinRate.win_rate}%):
${JSON.stringify(ictLessons.slice(0, 20), null, 2)}

SWING LESSONS (${swingLessons.length} total, win rate ${swingWinRate.win_rate}%):
${JSON.stringify(swingLessons.slice(0, 20), null, 2)}

CURRENT ICT STRATEGY:
${ictStrategy}

CURRENT SWING STRATEGY:
${swingStrategy}

Call the submit_review tool with your weekly report and structured recommendations.`,
        },
      ],
      tools: [submitReviewTool],
      tool_choice: { type: 'tool', name: 'submit_review' },
    } as Parameters<typeof anthropic.messages.create>[0]),
    timeoutMs,
    'Weekly Review',
  ).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Review] API call failed: ${msg}`);
    return null;
  });

  if (response === null) {
    await alertSystemWarning('Weekly Review Agent failed to call Anthropic API. No strategy updates this week.').catch(() => {});
    return 'Weekly Review API failure — see pm2-err.log.';
  }

  const m = response as Anthropic.Messages.Message;
  console.log(`[Review] stop_reason=${m.stop_reason} content_blocks=${m.content.length}`);

  const result = extractReviewFromTool(m.content as unknown[]);

  if (result === null) {
    console.error('[Review] No usable review in submit_review tool_use response.');
    await alertSystemWarning('Weekly Review Agent — submit_review tool not called or report empty. No strategy updates applied this week. Check pm2-out.log.').catch(() => {
      /* don't let alert failure mask the real failure */
    });
    return '';
  }

  // Log the report
  console.log('=== WEEKLY PERFORMANCE REPORT ===');
  console.log(result.report || 'No report generated');

  // 2026-04-29 audit fix (P0-RV1, RV2, RV3): DISABLE auto-write.
  // The prior section-patcher had multiple silent corruption paths:
  //   - Tier-threshold values (80/60/45) lived in same Section 5 region as
  //     scoring weights — \\b80\\b would replace the Tier 1 cutoff.
  //   - "Increase X from 10 to 20" replaced both +10 and -10 in news scoring.
  //   - "Bump"/"Raise"/arrow phrasings escaped the regex silently.
  //   - Greedy `(?=## Section 6)` lookahead let `[\s\S]*` swallow Section 7
  //     if Section 6 was missing.
  // Until the patcher is rewritten to operate on table-row anchors (Codex
  // recommendation), we run AUDIT-ONLY: log proposed changes to the change
  // log, never modify rule sections. Banned patterns + alerts are surfaced.
  //
  // Codex final-review fix (P1, 2026-04-29): single mutable `workingStrategy`
  // through the whole function. Pre-fix the banned-patterns block reset
  // workingStrategy = ictStrategy, so banned-patterns saves OVERWROTE the
  // ict_updates change-log rows that had just been written.
  let workingStrategy = ictStrategy;
  let strategyMutated = false;
  const date = new Date().toISOString().slice(0, 10);

  if (result.ict_updates && result.ict_updates.length > 0) {
    const newChangeLogRows = result.ict_updates.map(
      (u) => `| ${date} | Weekly Review Agent (PROPOSED, NOT APPLIED) | ${u.change} | ${u.basis} |`,
    );
    workingStrategy = workingStrategy + '\n' + newChangeLogRows.join('\n');
    strategyMutated = true;
    console.log(`[Review] ICT updates: ${result.ict_updates.length} PROPOSED, 0 applied (auto-write disabled per 2026-04-29 audit).`);
  }

  // 2026-04-29 audit fix (P0-RV4): banned_patterns was being silently
  // dropped — code didn't handle it at all. Now we append to Section 6
  // of strategy.md when patterns are present.
  if (result.banned_patterns && result.banned_patterns.length > 0) {
    const bannedRows = result.banned_patterns.map(
      (p) => `| ${p.pattern} | ${p.win_rate} | ${p.trade_count} | ${date} |`,
    );
    // Conservative: append after the placeholder comment line in Section 6.
    // Won't delete anything; just adds rows.
    const section6PlaceholderRe = /(## Section 6: Banned Patterns[\s\S]*?<!-- Format[^\n]*-->\n)/;
    if (section6PlaceholderRe.test(workingStrategy)) {
      workingStrategy = workingStrategy.replace(section6PlaceholderRe, `$1\n${bannedRows.join('\n')}\n`);
      strategyMutated = true;
      console.log(`[Review] Banned ${result.banned_patterns.length} pattern(s) under Section 6.`);
    } else {
      console.warn('[Review] Could not locate Section 6 placeholder — banned patterns NOT applied. Manual update required.');
    }
  }

  // Single save for the whole pass — eliminates the overwrite race.
  if (strategyMutated) {
    saveFile('strategy.md', workingStrategy);
  }

  // 2026-04-29 audit fix (P0-RV5): SYSTEM_REVIEW + other alerts now go to
  // Telegram, not just console.warn. Pre-fix Giuseppe never saw them.
  if (result.alerts && result.alerts.length > 0) {
    for (const alert of result.alerts) {
      console.warn(`[ALERT] ${alert}`);
      await alertSystemWarning(`Weekly Review alert: ${alert}`).catch(() => {
        /* don't let alert failure block the rest */
      });
    }
  }

  return result.report;
}

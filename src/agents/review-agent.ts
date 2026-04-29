// Weekly Review Agent — Strategy Improver
// Fires every Sunday at 00:00 UTC
// Analyses the full week, detects patterns, updates both strategy files

import Anthropic from '@anthropic-ai/sdk';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadPromptWithSystemTime, loadStrategy } from './load-prompt.js';
import { extractText, parseLastJsonObject, withTimeout } from './llm-output.js';
import { alertSystemWarning } from '../notifications/telegram.js';
import { getTradesForWeek, getLessons, getLessonWinRate } from '../database/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const anthropic = new Anthropic();

function saveFile(filename: string, content: string): void {
  writeFileSync(join(__dirname, '..', '..', 'memory', filename), content, 'utf-8');
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

  // 2026-04-29 audit: 60s timeout (Codex AN6). Weekly Review runs only once
  // per week with effort='max' so Sonnet can take longer; 60s is generous.
  const timeoutMs = 60_000;
  const response = await withTimeout(
    anthropic.messages.create({
    // 2026-04-29: downgraded Sonnet → Haiku 4.5 per user direction.
    // Weekly Review runs once per week, so absolute cost was small
    // either way — but the bot's auto-write paths to strategy.md were
    // disabled in audit-2 (P0-RV1/RV2/RV3) and the review output is
    // now AUDIT-ONLY (logs proposed changes, no auto-edits to rule
    // sections). Haiku is sufficient for that audit-log role. Revert
    // to 'claude-sonnet-4-6' if the weekly write-back logic is ever
    // re-enabled.
    model: 'claude-haiku-4-5-20251001',
    // max_tokens 16000 → 12000 (2026-04-21) — weekly review output is
    // structured + concise, rarely needs more than 8k tokens.
    max_tokens: 12000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'max' },
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages: [{
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

Produce your weekly report and strategy update instructions.`,
      }],
    }),
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

  // 2026-04-29 audit fix (P0-A1): use extractText to read all blocks. Pre-
  // fix `content[0].type === 'text'` returned '' whenever adaptive thinking
  // was first; the catch silently lost the entire week's review.
  const text = extractText(response.content);

  // 2026-04-29 audit fix (P0-RV1, RV3): parseLastJsonObject (balanced-brace,
  // last-object). Pre-fix the greedy regex matched from first `{` to last
  // `}` and could splice prose example objects.
  const result = parseLastJsonObject<{
    report?: string;
    ict_updates?: Array<{ section: string; change: string; basis: string }>;
    banned_patterns?: Array<{ pattern: string; win_rate: string; trade_count: number }>;
    alerts?: string[];
  }>(text);

  if (result === null) {
    console.error('[Review] Failed to parse weekly review JSON. Raw response:');
    console.error(text.length > 2000 ? text.slice(0, 2000) + '...[truncated]' : text);
    // Fail loudly via Telegram so Giuseppe knows the week's review is lost.
    await alertSystemWarning('Weekly Review Agent JSON parse failed — no strategy updates applied this week. Check pm2-err.log.').catch(() => {
      /* don't let alert failure mask the real failure */
    });
    return text;
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

  return result.report || text;
}

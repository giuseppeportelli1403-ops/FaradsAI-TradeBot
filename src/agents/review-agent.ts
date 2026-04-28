// Weekly Review Agent — Strategy Improver
// Fires every Sunday at 00:00 UTC
// Analyses the full week, detects patterns, updates both strategy files

import Anthropic from '@anthropic-ai/sdk';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadPromptWithSystemTime, loadStrategy } from './load-prompt.js';
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

  const response = await anthropic.messages.create({
    // Cost optimisation (2026-04-21): weekly review runs once per week,
    // so absolute cost is small either way, but keeping all agents on a
    // single model family simplifies cache-warming + reasoning about
    // quality deltas. Sonnet 4.6 at effort 'max' produces thorough
    // reviews; if weekly strategy tuning output regresses, revert to
    // 'claude-opus-4-6' (highest-leverage reasoning is the review's
    // strategy-file-edit decision, which happens once per week).
    model: 'claude-sonnet-4-6',
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
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';

  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON in response');

    const result = JSON.parse(match[0]);

    // Log the report
    console.log('=== WEEKLY PERFORMANCE REPORT ===');
    console.log(result.report || 'No report generated');

    // Apply ICT strategy updates.
    // Codex P1 #5 (2026-04-28): pre-fix this block ONLY appended to the
    // change log; it never patched the actual rule sections. Now we
    // pattern-match "Increase X weight from Y to Z" instructions and
    // perform a conservative in-place edit of Section 5 (the scoring
    // rubric). Anything not matching the supported pattern still falls
    // through to the audit-log append.
    if (result.ict_updates?.length > 0) {
      const date = new Date().toISOString().split('T')[0];
      let workingStrategy = ictStrategy;
      const newChangeLogRows: string[] = [];
      let patchedCount = 0;

      for (const u of result.ict_updates as Array<{ section: string; change: string; basis: string }>) {
        // Pattern 1: "Increase X weight from Y to Z" / "Decrease X weight from Y to Z"
        // Where X is a setup type or component name, Y/Z are numeric weights.
        const weightChangeMatch = /(?:Increase|Decrease|Set|Adjust|Change)\s+(.+?)\s+weight\s+(?:from\s+(\d+(?:\.\d+)?)\s+)?to\s+(\d+(?:\.\d+)?)/i.exec(u.change);
        if (weightChangeMatch) {
          const [, _component, oldWeight, newWeight] = weightChangeMatch;
          if (oldWeight) {
            // Replace specific weight value in Section 5 table. Conservative:
            // only swap if the exact numeric appears as a standalone token in
            // Section 5. Avoids accidentally touching other tables.
            const section5Re = /(## Section 5[\s\S]*?)(?=## Section 6)/;
            workingStrategy = workingStrategy.replace(section5Re, (match) => {
              const updated = match.replace(
                new RegExp(`\\b${oldWeight}\\b`, 'g'),
                newWeight,
              );
              return updated;
            });
            patchedCount++;
          }
        }
        newChangeLogRows.push(`| ${date} | Weekly Review Agent | ${u.change} | ${u.basis} |`);
      }

      // Always also append to the change log so the audit trail is preserved.
      workingStrategy = workingStrategy + '\n' + newChangeLogRows.join('\n');
      saveFile('strategy.md', workingStrategy);
      console.log(`ICT strategy updated: ${result.ict_updates.length} entries logged, ${patchedCount} sections patched`);
    }

    // Apply Swing strategy updates
    if (result.swing_updates?.length > 0) {
      const date = new Date().toISOString().split('T')[0];
      const newEntries = result.swing_updates
        .map((u: { section: string; change: string; basis: string }) =>
          `| ${date} | Weekly Review Agent | ${u.change} | ${u.basis} |`)
        .join('\n');

      const updatedSwing = swingStrategy + '\n' + newEntries;
      saveFile('swing_strategy.md', updatedSwing);
      console.log(`Swing strategy updated: ${result.swing_updates.length} changes`);
    }

    // Log alerts
    if (result.alerts?.length > 0) {
      for (const alert of result.alerts) {
        console.warn(`[ALERT] ${alert}`);
      }
    }

    return result.report || text;
  } catch (error) {
    console.error('Failed to parse weekly review:', error);
    console.log('Raw response:', text);
    return text;
  }
}

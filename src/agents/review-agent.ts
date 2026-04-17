// Weekly Review Agent — Strategy Improver
// Fires every Sunday at 00:00 UTC
// Analyses the full week, detects patterns, updates both strategy files

import Anthropic from '@anthropic-ai/sdk';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadPrompt, loadStrategy } from './load-prompt.js';
import { getTradesForWeek, getLessons, getLessonWinRate } from '../database/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const anthropic = new Anthropic();

function saveFile(filename: string, content: string): void {
  writeFileSync(join(__dirname, '..', '..', 'memory', filename), content, 'utf-8');
}

export async function runWeeklyReviewAgent(): Promise<string> {
  console.log('Weekly Review Agent starting...');

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

  const ictStrategy = loadFile('strategy.md');
  const swingStrategy = loadFile('swing_strategy.md');

  if (trades.length === 0) {
    console.log('No trades this week. Skipping review.');
    return 'No trades to review.';
  }

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    system: REVIEW_SYSTEM_PROMPT,
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

    // Apply ICT strategy updates (append to change log)
    if (result.ict_updates?.length > 0) {
      const date = new Date().toISOString().split('T')[0];
      const newEntries = result.ict_updates
        .map((u: { section: string; change: string; basis: string }) =>
          `| ${date} | Weekly Review Agent | ${u.change} | ${u.basis} |`)
        .join('\n');

      const updatedIct = ictStrategy + '\n' + newEntries;
      saveFile('strategy.md', updatedIct);
      console.log(`ICT strategy updated: ${result.ict_updates.length} changes`);
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

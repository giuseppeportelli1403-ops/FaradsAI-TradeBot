// Reflection Agent — Post-Trade Structured Lesson Writer
// Fires after every trade fully closes (both legs, from either ICT or Swing)
// Uses Claude to analyse the trade and generate a structured lesson

import Anthropic from '@anthropic-ai/sdk';
import { loadPrompt } from './load-prompt.js';
import { getTradeById, insertLesson } from '../database/index.js';
import type { Lesson, StrategyTag } from '../types.js';

const anthropic = new Anthropic();

export async function runReflectionAgent(tradeId: string): Promise<void> {
  console.log(`Reflection Agent analysing trade: ${tradeId}`);

  const systemPrompt = loadPrompt('reflection-agent.md');
  const trade = getTradeById(tradeId);
  if (!trade) {
    console.error(`Trade ${tradeId} not found in database`);
    return;
  }

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1500,
    system: systemPrompt,
    messages: [{
      role: 'user',
      content: `Analyse this completed trade and generate a structured lesson JSON:

TRADE RECORD:
${JSON.stringify(trade, null, 2)}

Generate a lesson with ALL these fields:
- lesson_id: "lesson-{timestamp}"
- timestamp: current UTC
- strategy_tag: "${trade.strategy_tag}"
- instrument, instrument_category, direction, setup_type
- kill_zone, hold_duration (calculate from opened_at to closed_at)
- news_category, news_description
- composite_score
- analyst_decision
- position_a_outcome, position_b_outcome
- pnl_a_r, pnl_b_r, pnl_total_r (calculate R values from SL distance)
- was_bias_correct, was_trigger_valid, was_news_correctly_weighted, was_split_execution_clean (booleans)
- score_accuracy_notes
- lesson (the actual insight — SPECIFIC and ACTIONABLE)
- rule_suggestion (optional rule change suggestion)

Output ONLY the JSON object.`,
    }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';

  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON found in response');

    const lesson: Lesson = JSON.parse(match[0]);

    // Ensure required fields
    lesson.lesson_id = lesson.lesson_id || `lesson-${Date.now()}`;
    lesson.timestamp = lesson.timestamp || new Date().toISOString();
    lesson.strategy_tag = trade.strategy_tag as StrategyTag;
    lesson.instrument = trade.instrument;

    insertLesson(lesson);
    console.log(`Lesson saved: ${lesson.lesson_id}`);
    console.log(`Key insight: ${lesson.lesson.substring(0, 100)}...`);

    if (lesson.rule_suggestion) {
      console.log(`Rule suggestion: ${lesson.rule_suggestion}`);
    }
  } catch (error) {
    console.error('Failed to parse reflection lesson:', error);
    console.error('Raw response:', text);
  }
}

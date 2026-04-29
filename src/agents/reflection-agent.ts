// Reflection Agent — Post-Trade Structured Lesson Writer
// Fires after every trade fully closes (both legs, from either ICT or Swing)
// Uses Claude to analyse the trade and generate a structured lesson

import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import { loadPromptWithSystemTime } from './load-prompt.js';
import { extractText, parseLastJsonObject, withTimeout } from './llm-output.js';
import { getTradeById, insertLesson } from '../database/index.js';
import type { Lesson, StrategyTag } from '../types.js';

const anthropic = new Anthropic();

export async function runReflectionAgent(tradeId: string): Promise<void> {
  console.log(`Reflection Agent analysing trade: ${tradeId}`);

  const systemPrompt = loadPromptWithSystemTime('reflection-agent.md');
  const trade = getTradeById(tradeId);
  if (!trade) {
    console.error(`Trade ${tradeId} not found in database`);
    return;
  }

  // 2026-04-29 audit: 45s timeout (Reflection runs effort='high' on a
  // larger context than Analyst, so allow more wall time).
  const timeoutMs = 45_000;
  let response: Awaited<ReturnType<typeof anthropic.messages.create>>;
  try {
    response = await withTimeout(anthropic.messages.create({
      // 2026-04-29: re-downgraded Sonnet → Haiku 4.5 per user direction.
      // Caveat from the 2026-04-28 codex review still applies: Reflection
      // writes structured lessons that the Weekly Review Agent learns
      // from, so bad-but-parseable Haiku output can pollute the learning
      // loop without surfacing as a runtime error. Mitigation:
      // Reflection runs at most ~5-15× per week (one per closed trade)
      // so we will eyeball every lesson during the demo window and
      // upgrade to Sonnet if quality drops. Revert via 'claude-sonnet-4-6'.
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
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
    }), timeoutMs, 'Reflection');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Reflection] API call failed for trade ${tradeId}: ${msg}. Lesson NOT saved.`);
    return;
  }

  // 2026-04-29 audit fix (P0-A1): use extractText to read ALL content blocks.
  // Pre-fix `response.content[0].type === 'text' ? ...` returned '' whenever
  // adaptive thinking placed a ThinkingBlock at index 0 — meaning Reflection
  // wrote ZERO lessons across many cycles.
  const text = extractText(response.content);

  // 2026-04-29 audit fix (P0-RF2): use parseLastJsonObject (balanced-brace,
  // last-object-wins). Pre-fix the greedy regex `/\{[\s\S]*\}/` matched from
  // the first `{` to the LAST `}` — any `}` in trailing prose corrupted the
  // parse target.
  const lesson = parseLastJsonObject<Lesson>(text);
  if (lesson === null) {
    console.error('[Reflection] Failed to parse lesson JSON from response. Raw text:');
    console.error(text.length > 1000 ? text.slice(0, 1000) + '...[truncated]' : text);
    return;
  }

  try {
    // Ensure required fields. crypto.randomUUID() not Date.now() to avoid
    // collisions if two reflections fire within the same millisecond
    // (Codex P2-2).
    lesson.lesson_id = lesson.lesson_id || `lesson-${randomUUID()}`;
    lesson.timestamp = lesson.timestamp || new Date().toISOString();
    lesson.strategy_tag = trade.strategy_tag as StrategyTag;
    lesson.instrument = trade.instrument;

    insertLesson(lesson);
    console.log(`Lesson saved: ${lesson.lesson_id}`);
    if (typeof lesson.lesson === 'string') {
      console.log(`Key insight: ${lesson.lesson.substring(0, 100)}...`);
    }

    if (lesson.rule_suggestion) {
      console.log(`Rule suggestion: ${lesson.rule_suggestion}`);
    }
  } catch (error) {
    console.error('[Reflection] insertLesson failed:', error);
    console.error('Raw lesson object:', JSON.stringify(lesson));
  }
}

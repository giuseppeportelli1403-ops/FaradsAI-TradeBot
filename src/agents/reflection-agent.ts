// Reflection Agent — Post-Trade Structured Lesson Writer
// Fires after every trade fully closes (both legs, from either ICT or Swing).
// Uses Claude to analyse the trade and generate a structured lesson.
//
// 2026-05-05 audit (Phase 2 / Round 1 / item 1.1): replaced free-form-prose-
// then-JSON-parse pattern with forced submit_lesson tool calling. Same
// blueprint as the analyst fix (`82a4996`). Eliminates the truncation /
// silent-skip failure mode where Reflection had been writing 0 lessons
// across "an unknown number of cycles" (per Researcher Agent's mirror-bug
// comment). Returns null on missing/invalid tool call so the caller can
// log a warning — a fake/synthetic lesson would be worse than no lesson.
//
// Why Haiku 4.5 still works: Haiku 4.5 supports tools and tool_choice
// without thinking. The mutual-exclusion that Codex caught for the analyst
// (adaptive thinking + forced tool_choice) doesn't apply here — Haiku
// doesn't expose adaptive thinking at all.

import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import { loadPromptWithSystemTime } from './load-prompt.js';
import { withTimeout } from './llm-output.js';
import { getTradeById, insertLesson } from '../database/index.js';
import type { Lesson, StrategyTag, Direction } from '../types.js';

const anthropic = new Anthropic();

const submitLessonTool = {
  name: 'submit_lesson',
  description:
    'Submit the structured lesson learned from the closed trade. Call this tool exactly once. ' +
    'Your full lesson text goes in the `lesson` field — do not write a separate text block.',
  input_schema: {
    type: 'object' as const,
    properties: {
      lesson_id: { type: 'string', description: 'Format "lesson-{timestamp-or-uuid}"; we will fill if you omit.' },
      timestamp: { type: 'string', description: 'UTC ISO timestamp; we will fill if you omit.' },
      strategy_tag: { type: 'string', enum: ['ICT_INTRADAY', 'SWING'] },
      instrument: { type: 'string' },
      instrument_category: { type: 'string', description: 'e.g. fx, commodity, index, equity' },
      direction: { type: 'string', enum: ['long', 'short'] },
      setup_type: { type: 'string', description: 'e.g. OB Retest, FVG Fill, Liquidity Sweep, Range Sweep Reversal' },
      kill_zone: { type: 'string', enum: ['London Open', 'NY Open', 'London Close', 'outside'] },
      hold_duration: { type: 'string', description: 'Calculated from opened_at to closed_at, e.g. "2h 15m".' },
      news_category: { type: 'string', description: 'A / B / C / none' },
      news_description: { type: 'string' },
      composite_score: { type: 'number' },
      analyst_decision: { type: 'string', description: 'APPROVE / MODIFY — what the analyst returned.' },
      position_a_outcome: { type: 'string', description: 'e.g. "TP1 hit", "SL hit", "BE exit"' },
      position_b_outcome: { type: 'string' },
      pnl_a_r: { type: 'number', description: 'Leg A P&L in R units' },
      pnl_b_r: { type: 'number' },
      pnl_total_r: { type: 'number', description: 'Size-weighted total P&L in R' },
      was_bias_correct: { type: 'boolean' },
      was_trigger_valid: { type: 'boolean' },
      was_news_correctly_weighted: { type: 'boolean' },
      was_split_execution_clean: { type: 'boolean' },
      score_accuracy_notes: { type: 'string' },
      lesson: {
        type: 'string',
        description:
          'SPECIFIC and ACTIONABLE insight. Cite instrument, kill-zone, news context, and what to repeat or avoid. ' +
          'Bad: "trade worked out well". Good: see prompts/reflection-agent.md examples.',
      },
      rule_suggestion: { type: 'string', description: 'Optional. Empty string if none.' },
    },
    required: [
      'strategy_tag', 'instrument', 'instrument_category', 'direction', 'setup_type',
      'kill_zone', 'hold_duration', 'news_category', 'news_description', 'composite_score',
      'analyst_decision', 'position_a_outcome', 'position_b_outcome',
      'pnl_a_r', 'pnl_b_r', 'pnl_total_r',
      'was_bias_correct', 'was_trigger_valid', 'was_news_correctly_weighted', 'was_split_execution_clean',
      'score_accuracy_notes', 'lesson', 'rule_suggestion',
    ],
  },
};

/** Coerce a value to a strict boolean. Accepts true/false, "true"/"false" strings, 1/0 numbers. */
function coerceBool(v: unknown): boolean {
  if (v === true || v === 1) return true;
  if (typeof v === 'string') return v.toLowerCase() === 'true';
  return false;
}

/** Coerce a value to a finite number. Returns null on non-finite/non-numeric so the caller can fail-closed
 *  instead of writing falsified zero stats to the DB (Codex Round-1 review finding 2026-05-05). */
function coerceFiniteNum(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Read the lesson from a forced `submit_lesson` tool_use block. Returns
 * null on any shape problem — caller logs a warning, no synthetic lesson
 * is written.
 */
export function extractLessonFromTool(content: unknown[]): Lesson | null {
  if (!Array.isArray(content) || content.length === 0) return null;

  for (const block of content) {
    if (
      block &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'tool_use' &&
      (block as { name?: unknown }).name === 'submit_lesson'
    ) {
      const rawInput = (block as { input?: unknown }).input;
      if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) return null;
      const raw = rawInput as Record<string, unknown>;

      // Required string fields — empty/missing → null result.
      const requiredStrings = [
        'instrument', 'instrument_category', 'setup_type', 'kill_zone',
        'news_category', 'news_description', 'analyst_decision',
        'position_a_outcome', 'position_b_outcome', 'hold_duration',
        'score_accuracy_notes', 'lesson',
      ];
      for (const key of requiredStrings) {
        if (typeof raw[key] !== 'string' || (raw[key] as string).length === 0) {
          // The 'lesson' field empty is the strongest signal — if the model
          // didn't write a lesson, there's nothing useful here. Same logic
          // for the other required strings (no signal → no save).
          return null;
        }
      }

      const direction = String(raw.direction ?? '').toLowerCase();
      if (direction !== 'long' && direction !== 'short') return null;
      const strategyRaw = String(raw.strategy_tag ?? '').toUpperCase();
      const strategy_tag = (strategyRaw === 'SWING' ? 'SWING' : 'ICT_INTRADAY') as StrategyTag;

      // Required numerics — fail-closed if any are non-finite. The DB row is
      // load-bearing for win-rate calcs (a falsified 0 PnL counts as a non-win
      // and skews stats), so we'd rather have no lesson than a false one.
      const composite_score = coerceFiniteNum(raw.composite_score);
      const pnl_a_r = coerceFiniteNum(raw.pnl_a_r);
      const pnl_b_r = coerceFiniteNum(raw.pnl_b_r);
      const pnl_total_r = coerceFiniteNum(raw.pnl_total_r);
      if (composite_score === null || pnl_a_r === null || pnl_b_r === null || pnl_total_r === null) {
        return null;
      }

      return {
        lesson_id: typeof raw.lesson_id === 'string' && raw.lesson_id.length > 0
          ? raw.lesson_id
          : `lesson-${randomUUID()}`,
        timestamp: typeof raw.timestamp === 'string' && raw.timestamp.length > 0
          ? raw.timestamp
          : new Date().toISOString(),
        strategy_tag,
        instrument: String(raw.instrument),
        instrument_category: String(raw.instrument_category),
        direction: direction as Direction,
        setup_type: String(raw.setup_type),
        kill_zone: String(raw.kill_zone),
        news_category: String(raw.news_category),
        news_description: String(raw.news_description),
        composite_score,
        analyst_decision: String(raw.analyst_decision),
        position_a_outcome: String(raw.position_a_outcome),
        position_b_outcome: String(raw.position_b_outcome),
        position_c_outcome: null,
        pnl_a_r,
        pnl_b_r,
        pnl_c_r: null,
        pnl_total_r,
        was_bias_correct: coerceBool(raw.was_bias_correct),
        was_trigger_valid: coerceBool(raw.was_trigger_valid),
        was_news_correctly_weighted: coerceBool(raw.was_news_correctly_weighted),
        was_split_execution_clean: coerceBool(raw.was_split_execution_clean),
        hold_duration: String(raw.hold_duration),
        score_accuracy_notes: String(raw.score_accuracy_notes),
        lesson: String(raw.lesson),
        rule_suggestion: typeof raw.rule_suggestion === 'string' ? raw.rule_suggestion : '',
      };
    }
  }
  return null;
}

export async function runReflectionAgent(tradeId: string): Promise<void> {
  console.log(`Reflection Agent analysing trade: ${tradeId}`);

  const systemPrompt = loadPromptWithSystemTime('reflection-agent.md');
  const trade = getTradeById(tradeId);
  if (!trade) {
    console.error(`Trade ${tradeId} not found in database`);
    return;
  }

  const timeoutMs = 45_000;
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
            content: `Analyse this completed trade and call the submit_lesson tool with the structured lesson:

TRADE RECORD:
${JSON.stringify(trade, null, 2)}

Calculate hold_duration from opened_at → closed_at. The lesson field must be SPECIFIC and ACTIONABLE — see the system prompt for examples.`,
          },
        ],
        tools: [submitLessonTool],
        tool_choice: { type: 'tool', name: 'submit_lesson' },
      } as Parameters<typeof anthropic.messages.create>[0]),
      timeoutMs,
      'Reflection',
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Reflection] API call failed for trade ${tradeId}: ${msg}. Lesson NOT saved.`);
    return;
  }

  const msg = response as Anthropic.Messages.Message;
  console.log(`[Reflection] stop_reason=${msg.stop_reason} content_blocks=${msg.content.length}`);

  const lesson = extractLessonFromTool(msg.content as unknown[]);
  if (lesson === null) {
    console.error(`[Reflection] No usable lesson from tool_use response for trade ${tradeId}. Lesson NOT saved.`);
    return;
  }

  // Override these from the trade record for consistency — the LLM's strategy_tag/instrument
  // would always match anyway, but we make it bulletproof.
  lesson.strategy_tag = trade.strategy_tag as StrategyTag;
  lesson.instrument = trade.instrument;

  try {
    insertLesson(lesson);
    console.log(`Lesson saved: ${lesson.lesson_id}`);
    console.log(`Key insight: ${lesson.lesson.substring(0, 100)}...`);
    if (lesson.rule_suggestion) {
      console.log(`Rule suggestion: ${lesson.rule_suggestion}`);
    }
  } catch (error) {
    console.error('[Reflection] insertLesson failed:', error);
    console.error('Raw lesson object:', JSON.stringify(lesson));
  }
}

// Tests for extractLessonFromTool — Reflection's tool_use extractor.
//
// 2026-05-05 audit: replaced the free-form-prose-then-JSON pattern with a
// forced submit_lesson tool call (same blueprint as the analyst fix). The
// extractor reads a Lesson directly from the tool_use block. Returns null
// on missing/invalid tool call — caller logs warning, NO synthetic lesson
// is written. This is intentional: a fake lesson would poison the learning
// loop more than a missing one.

import { describe, it, expect } from 'vitest';
import { extractLessonFromTool } from '../src/agents/reflection-agent.js';

describe('extractLessonFromTool — read lesson from submit_lesson tool_use', () => {
  const validInput = {
    lesson_id: 'lesson-abc',
    timestamp: '2026-05-05T10:00:00Z',
    strategy_tag: 'ICT_INTRADAY',
    instrument: 'EURUSD',
    instrument_category: 'fx',
    direction: 'long',
    setup_type: 'OB Retest',
    kill_zone: 'London Open',
    hold_duration: '1h 45m',
    news_category: 'B',
    news_description: 'EU PMI moderately above expectations.',
    composite_score: 75,
    analyst_decision: 'APPROVE',
    position_a_outcome: 'TP1 hit',
    position_b_outcome: 'TP2 hit',
    position_c_outcome: 'TP3 hit',
    pnl_a_r: 1.0,
    pnl_b_r: 2.0,
    pnl_c_r: 3.0,
    pnl_total_r: 2.0,
    was_bias_correct: true,
    was_trigger_valid: true,
    was_news_correctly_weighted: true,
    was_split_execution_clean: true,
    score_accuracy_notes: 'Score reflected the clean structure.',
    lesson: 'OB retest in London Open on EUR with Cat B PMI aligned consistently hits TP2.',
    rule_suggestion: '',
  };

  it('extracts a complete lesson from a submit_lesson tool_use block', () => {
    const content = [
      { type: 'thinking', thinking: 'reviewing the trade...' },
      {
        type: 'tool_use',
        id: 'tool_01',
        name: 'submit_lesson',
        input: validInput,
      },
    ];
    const lesson = extractLessonFromTool(content as never);
    expect(lesson).not.toBeNull();
    expect(lesson?.instrument).toBe('EURUSD');
    expect(lesson?.pnl_total_r).toBeCloseTo(2.0);
    expect(lesson?.was_bias_correct).toBe(true);
  });

  it('returns null when no submit_lesson block is present', () => {
    const content = [{ type: 'text', text: 'I forgot the tool.' }];
    const lesson = extractLessonFromTool(content as never);
    expect(lesson).toBeNull();
  });

  it('returns null on empty content', () => {
    expect(extractLessonFromTool([] as never)).toBeNull();
  });

  it('ignores tool_use blocks with the wrong tool name', () => {
    const content = [
      { type: 'tool_use', id: 'x', name: 'submit_other', input: validInput },
    ];
    expect(extractLessonFromTool(content as never)).toBeNull();
  });

  it('returns null when input is not an object', () => {
    const content = [
      { type: 'tool_use', id: 'x', name: 'submit_lesson', input: 'not an object' },
    ];
    expect(extractLessonFromTool(content as never)).toBeNull();
  });

  it('returns null when required fields are missing', () => {
    const content = [
      {
        type: 'tool_use', id: 'x', name: 'submit_lesson',
        input: { instrument: 'EURUSD' }, // tons of required fields missing
      },
    ];
    expect(extractLessonFromTool(content as never)).toBeNull();
  });

  it('coerces nullable position_c_outcome / pnl_c_r correctly', () => {
    // Legacy 2-leg lesson — Leg C fields are explicit null per Lesson type.
    const input = { ...validInput, position_c_outcome: null, pnl_c_r: null };
    const content = [
      { type: 'tool_use', id: 'x', name: 'submit_lesson', input },
    ];
    const lesson = extractLessonFromTool(content as never);
    expect(lesson).not.toBeNull();
    expect(lesson?.position_c_outcome).toBeNull();
    expect(lesson?.pnl_c_r).toBeNull();
  });

  it('coerces booleans defensively (LLM may emit "true" string)', () => {
    const input = { ...validInput, was_bias_correct: 'true', was_trigger_valid: 1 };
    const content = [
      { type: 'tool_use', id: 'x', name: 'submit_lesson', input },
    ];
    const lesson = extractLessonFromTool(content as never);
    expect(lesson).not.toBeNull();
    expect(lesson?.was_bias_correct).toBe(true);
    expect(lesson?.was_trigger_valid).toBe(true);
  });

  it('coerces non-finite pnl values to 0', () => {
    const input = { ...validInput, pnl_total_r: NaN, pnl_a_r: Infinity };
    const content = [
      { type: 'tool_use', id: 'x', name: 'submit_lesson', input },
    ];
    const lesson = extractLessonFromTool(content as never);
    expect(lesson).not.toBeNull();
    expect(lesson?.pnl_total_r).toBe(0);
    expect(lesson?.pnl_a_r).toBe(0);
  });

  it('returns null when lesson text is empty (insufficient signal)', () => {
    const input = { ...validInput, lesson: '' };
    const content = [
      { type: 'tool_use', id: 'x', name: 'submit_lesson', input },
    ];
    expect(extractLessonFromTool(content as never)).toBeNull();
  });
});

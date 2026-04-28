// Tests for the insertLesson Leg-C schema fix (2026-04-29 audit P0-RF1).
// Pre-fix the lessons table had position_c_outcome and pnl_c_r columns
// AND the Lesson interface declared them, but the INSERT statement
// omitted both. Every Reflection run silently dropped Leg-C outcome data
// on the floor.
import { describe, it, expect, beforeAll } from 'vitest';
import { initDatabaseAsync, insertLesson, getLessons, getDb } from '../src/database/index.js';
import type { Lesson } from '../src/types.js';

function mkLesson(overrides: Partial<Lesson>): Lesson {
  return {
    lesson_id: `test-leg-c-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    strategy_tag: 'ICT_INTRADAY',
    instrument: 'EURUSD',
    instrument_category: 'fx',
    direction: 'long',
    setup_type: 'OB_retest',
    kill_zone: 'London Open',
    hold_duration: '2h 15m',
    news_category: 'B',
    news_description: 'Cat B aligned',
    composite_score: 75,
    analyst_decision: 'APPROVE',
    position_a_outcome: 'tp1_hit',
    position_b_outcome: 'tp2_hit',
    position_c_outcome: 'tp3_hit',
    pnl_a_r: 1.5,
    pnl_b_r: 2.0,
    pnl_c_r: 3.0,
    pnl_total_r: 2.17,
    was_bias_correct: true,
    was_trigger_valid: true,
    was_news_correctly_weighted: true,
    was_split_execution_clean: true,
    score_accuracy_notes: 'score reflected quality',
    lesson: 'Test lesson — full 3-leg outcome should persist',
    rule_suggestion: '',
    ...overrides,
  };
}

describe('insertLesson — Leg C persistence (2026-04-29 audit P0-RF1)', () => {
  beforeAll(async () => {
    await initDatabaseAsync();
  });

  it('persists position_c_outcome and pnl_c_r columns (was silently dropped pre-fix)', () => {
    const id = `test-leg-c-${Math.random().toString(36).slice(2, 10)}`;
    insertLesson(mkLesson({
      lesson_id: id,
      position_c_outcome: 'tp3_hit',
      pnl_c_r: 3.5,
    }));

    const result = getDb().exec(
      'SELECT position_c_outcome, pnl_c_r FROM lessons WHERE lesson_id = ?',
      [id],
    );
    const row = result[0]?.values[0];
    expect(row).toBeDefined();
    expect(row![0]).toBe('tp3_hit');
    expect(row![1]).toBe(3.5);
  });

  it('persists null Leg-C fields when the trade was a TP1-only outcome', () => {
    const id = `test-leg-c-null-${Math.random().toString(36).slice(2, 10)}`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    insertLesson(mkLesson({
      lesson_id: id,
      position_c_outcome: undefined as any,
      pnl_c_r: undefined as any,
    }));

    const result = getDb().exec(
      'SELECT position_c_outcome, pnl_c_r FROM lessons WHERE lesson_id = ?',
      [id],
    );
    const row = result[0]?.values[0];
    expect(row).toBeDefined();
    expect(row![0]).toBeNull();
    expect(row![1]).toBeNull();
  });

  it('coerces string "false" booleans to 0 (not 1, which is what truthiness gave pre-fix)', () => {
    const id = `test-bool-${Math.random().toString(36).slice(2, 10)}`;
    insertLesson(mkLesson({
      lesson_id: id,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      was_bias_correct: 'false' as any,
    }));

    const result = getDb().exec(
      'SELECT was_bias_correct FROM lessons WHERE lesson_id = ?',
      [id],
    );
    const row = result[0]?.values[0];
    expect(row![0]).toBe(0);
  });

  it('coerces string "true" booleans to 1', () => {
    const id = `test-bool-true-${Math.random().toString(36).slice(2, 10)}`;
    insertLesson(mkLesson({
      lesson_id: id,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      was_bias_correct: 'true' as any,
    }));

    const result = getDb().exec(
      'SELECT was_bias_correct FROM lessons WHERE lesson_id = ?',
      [id],
    );
    const row = result[0]?.values[0];
    expect(row![0]).toBe(1);
  });

  it('persists boolean true correctly', () => {
    const id = `test-bool-bool-${Math.random().toString(36).slice(2, 10)}`;
    insertLesson(mkLesson({ lesson_id: id, was_bias_correct: true }));

    const result = getDb().exec('SELECT was_bias_correct FROM lessons WHERE lesson_id = ?', [id]);
    const row = result[0]?.values[0];
    expect(row![0]).toBe(1);
  });

  it('round-trips a full Lesson via getLessons() including Leg-C fields', () => {
    const id = `test-roundtrip-${Math.random().toString(36).slice(2, 10)}`;
    insertLesson(mkLesson({
      lesson_id: id,
      setup_type: `unique_setup_${id.slice(-6)}`,
      pnl_c_r: 3.7,
      position_c_outcome: 'BE exit',
    }));

    const found = getLessons({ setup_type: `unique_setup_${id.slice(-6)}` });
    expect(found.length).toBe(1);
    expect(found[0].pnl_c_r).toBe(3.7);
    expect(found[0].position_c_outcome).toBe('BE exit');
  });
});

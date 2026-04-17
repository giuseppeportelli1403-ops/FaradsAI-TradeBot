// Tests for getLessonWinRate SQL fix
import { describe, it, expect, beforeAll } from 'vitest';
import { initDatabaseAsync, insertLesson, getLessonWinRate } from '../src/database/index.js';
import type { Lesson } from '../src/types.js';

function makLesson(overrides: Partial<Lesson>): Lesson {
  return {
    lesson_id: `lesson-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    strategy_tag: 'ICT_INTRADAY',
    instrument: 'EURUSD',
    instrument_category: 'forex',
    direction: 'long',
    setup_type: 'FVG',
    kill_zone: 'london',
    hold_duration: '1h',
    news_category: 'C',
    news_description: '',
    composite_score: 70,
    analyst_decision: 'APPROVE',
    position_a_outcome: 'tp1_hit',
    position_b_outcome: 'tp2_hit',
    pnl_a_r: 1.0,
    pnl_b_r: 2.0,
    pnl_total_r: 3.0,
    was_bias_correct: true,
    was_trigger_valid: true,
    was_news_correctly_weighted: true,
    was_split_execution_clean: true,
    score_accuracy_notes: '',
    lesson: 'Test lesson',
    rule_suggestion: '',
    ...overrides,
  };
}

describe('getLessonWinRate', () => {
  beforeAll(async () => {
    await initDatabaseAsync();

    // Insert 3 winning lessons (pnl_total_r > 0) and 2 losing
    insertLesson(makLesson({ lesson_id: 'wr-win-1', pnl_total_r: 2.5, setup_type: 'FVG', kill_zone: 'london', strategy_tag: 'ICT_INTRADAY' }));
    insertLesson(makLesson({ lesson_id: 'wr-win-2', pnl_total_r: 1.0, setup_type: 'FVG', kill_zone: 'london', strategy_tag: 'ICT_INTRADAY' }));
    insertLesson(makLesson({ lesson_id: 'wr-win-3', pnl_total_r: 0.5, setup_type: 'OB', kill_zone: 'ny', strategy_tag: 'SWING' }));
    insertLesson(makLesson({ lesson_id: 'wr-loss-1', pnl_total_r: -1.0, setup_type: 'FVG', kill_zone: 'london', strategy_tag: 'ICT_INTRADAY' }));
    insertLesson(makLesson({ lesson_id: 'wr-loss-2', pnl_total_r: -2.0, setup_type: 'OB', kill_zone: 'ny', strategy_tag: 'SWING' }));
  });

  it('returns correct win rate with 0 filters', () => {
    const result = getLessonWinRate({});
    expect(result.total).toBe(5);
    expect(result.wins).toBe(3);
    expect(result.win_rate).toBe(60);
  });

  it('returns correct win rate with 1 filter', () => {
    const result = getLessonWinRate({ setup_type: 'FVG' });
    expect(result.total).toBe(3);
    expect(result.wins).toBe(2);
    expect(result.win_rate).toBeCloseTo(66.7, 0);
  });

  it('returns correct win rate with 3 filters', () => {
    const result = getLessonWinRate({ setup_type: 'FVG', kill_zone: 'london', strategy_tag: 'ICT_INTRADAY' });
    expect(result.total).toBe(3);
    expect(result.wins).toBe(2);
    expect(result.win_rate).toBeCloseTo(66.7, 0);
  });
});

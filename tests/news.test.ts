import { describe, it, expect } from 'vitest';
import { isNewsOpposing } from '../src/news/index.js';

describe('isNewsOpposing', () => {
  it('Cat A bearish news + bullish bias → true (opposing)', () => {
    expect(isNewsOpposing('bearish', 'A', 'bullish')).toBe(true);
  });

  it('Cat A bullish news + bearish bias → true (opposing)', () => {
    expect(isNewsOpposing('bullish', 'A', 'bearish')).toBe(true);
  });

  it('Cat B opposing news → false (not strong enough to block)', () => {
    expect(isNewsOpposing('bearish', 'B', 'bullish')).toBe(false);
  });

  it('Cat A aligned news → false (supports trade)', () => {
    expect(isNewsOpposing('bullish', 'A', 'bullish')).toBe(false);
    expect(isNewsOpposing('bearish', 'A', 'bearish')).toBe(false);
  });

  it('Neutral sentiment + any category → false', () => {
    expect(isNewsOpposing('neutral', 'A', 'bullish')).toBe(false);
    expect(isNewsOpposing('neutral', 'A', 'bearish')).toBe(false);
    expect(isNewsOpposing('neutral', 'B', 'bullish')).toBe(false);
  });

  it('Cat C + any direction → false', () => {
    expect(isNewsOpposing('bearish', 'C', 'bullish')).toBe(false);
    expect(isNewsOpposing('bullish', 'C', 'bearish')).toBe(false);
  });

  it('Category none + any direction → false', () => {
    expect(isNewsOpposing('bearish', 'none', 'bullish')).toBe(false);
    expect(isNewsOpposing('bullish', 'none', 'bearish')).toBe(false);
  });
});

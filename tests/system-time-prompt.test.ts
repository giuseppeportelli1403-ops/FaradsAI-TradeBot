// Tests for buildSystemTimeBlock — W1 (2026-04-28). AutoHedge-inspired
// pattern: every system prompt gets a small block prepending the current
// UTC time + day of week. Kills the "what session am I in?" hallucinations
// the LLM otherwise produces from training-data baseline assumptions.
import { describe, it, expect } from 'vitest';
import { buildSystemTimeBlock } from '../src/agents/load-prompt.js';

describe('buildSystemTimeBlock', () => {
  it('produces a non-empty markdown block for any Date', () => {
    const block = buildSystemTimeBlock(new Date('2026-04-28T12:00:00Z'));
    expect(block.length).toBeGreaterThan(50);
    expect(block).toContain('CURRENT TIME');
  });

  it('emits the input Date as ISO 8601 UTC', () => {
    const block = buildSystemTimeBlock(new Date('2026-04-28T12:00:00Z'));
    expect(block).toContain('2026-04-28T12:00:00');
  });

  it('emits the correct UTC day of week (Tuesday for 2026-04-28)', () => {
    const block = buildSystemTimeBlock(new Date('2026-04-28T12:00:00Z'));
    expect(block).toContain('Tuesday');
  });

  it('emits the correct UTC day of week (Sunday for 2026-04-26)', () => {
    const block = buildSystemTimeBlock(new Date('2026-04-26T12:00:00Z'));
    expect(block).toContain('Sunday');
  });

  it('uses UTC day even when local timezone would say something different', () => {
    // 2026-04-28T01:00:00Z is still Tuesday in UTC; in some Pacific timezones
    // it would be Monday. The block must use UTC day.
    const block = buildSystemTimeBlock(new Date('2026-04-28T01:00:00Z'));
    expect(block).toContain('Tuesday');
  });

  it('produces different content for different input times', () => {
    const a = buildSystemTimeBlock(new Date('2026-04-28T07:00:00Z'));
    const b = buildSystemTimeBlock(new Date('2026-04-28T13:00:00Z'));
    expect(a).not.toBe(b);
  });

  it('begins with a markdown horizontal rule for visual separation', () => {
    const block = buildSystemTimeBlock(new Date('2026-04-28T12:00:00Z'));
    expect(block).toMatch(/^\n+---/);
  });
});

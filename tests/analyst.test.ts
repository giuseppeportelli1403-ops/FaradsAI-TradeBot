// Tests for parseAnalystResponse — defaults to REJECT on parse failure
import { describe, it, expect } from 'vitest';
import { parseAnalystResponse } from '../src/agents/analyst-agent.js';

describe('parseAnalystResponse', () => {
  it('returns REJECT when text is complete garbage', () => {
    const result = parseAnalystResponse('this is not json at all');
    expect(result.decision).toBe('REJECT');
    expect(result.confidence).toBeLessThanOrEqual(0.5);
  });

  it('returns REJECT when JSON is malformed', () => {
    const result = parseAnalystResponse('{ decision: APPROVE, broken }');
    expect(result.decision).toBe('REJECT');
  });

  it('returns REJECT when no JSON object found', () => {
    const result = parseAnalystResponse('I think we should approve this trade.');
    expect(result.decision).toBe('REJECT');
  });

  it('correctly parses valid APPROVE JSON', () => {
    const text = `Here is my analysis:\n{"decision":"APPROVE","reason":"All checks passed","modifications":{},"confidence":0.9}`;
    const result = parseAnalystResponse(text);
    expect(result.decision).toBe('APPROVE');
    expect(result.reason).toBe('All checks passed');
    expect(result.confidence).toBe(0.9);
  });

  it('correctly parses valid REJECT JSON', () => {
    const text = `{"decision":"REJECT","reason":"SL on wrong side","modifications":{},"confidence":0.85}`;
    const result = parseAnalystResponse(text);
    expect(result.decision).toBe('REJECT');
    expect(result.reason).toBe('SL on wrong side');
  });

  it('correctly parses valid MODIFY JSON', () => {
    const text = `{"decision":"MODIFY","reason":"Size too large","modifications":{"size_per_leg":0.5},"confidence":0.75}`;
    const result = parseAnalystResponse(text);
    expect(result.decision).toBe('MODIFY');
    expect(result.modifications).toEqual({ size_per_leg: 0.5 });
  });
});

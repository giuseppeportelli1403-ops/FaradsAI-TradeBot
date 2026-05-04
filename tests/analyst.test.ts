// Tests for parseAnalystResponse — defaults to REJECT on parse failure
import { describe, it, expect } from 'vitest';
import { parseAnalystResponse, extractAnalystDecisionFromTool } from '../src/agents/analyst-agent.js';

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

// 2026-05-05: forced submit_decision tool extractor. Replaces the brittle
// "JSON-at-end-of-prose" path that produced 0/6 parseable analyst calls.
describe('extractAnalystDecisionFromTool — read decision from tool_use block', () => {
  it('extracts an APPROVE decision from a tool_use block', () => {
    const content = [
      { type: 'thinking', thinking: 'Let me run the 6 checks...' },
      {
        type: 'tool_use',
        id: 'tool_01',
        name: 'submit_decision',
        input: {
          decision: 'APPROVE',
          reason: 'All 6 checks pass; sizing math reconciles within 1.2%.',
          confidence: 0.84,
          modifications: {},
        },
      },
    ];
    const d = extractAnalystDecisionFromTool(content as never);
    expect(d.decision).toBe('APPROVE');
    expect(d.confidence).toBeCloseTo(0.84, 2);
    expect(d.reason).toMatch(/6 checks/);
  });

  it('extracts a REJECT decision', () => {
    const content = [
      {
        type: 'tool_use', id: 't', name: 'submit_decision',
        input: { decision: 'REJECT', reason: 'Calendar veto fires in 4 minutes', confidence: 0.95, modifications: {} },
      },
    ];
    const d = extractAnalystDecisionFromTool(content as never);
    expect(d.decision).toBe('REJECT');
  });

  it('extracts a MODIFY with modifications object', () => {
    const content = [
      {
        type: 'tool_use', id: 't', name: 'submit_decision',
        input: { decision: 'MODIFY', reason: 'Tighten SL by 5 pips', confidence: 0.7, modifications: { sl: 1.0985 } },
      },
    ];
    const d = extractAnalystDecisionFromTool(content as never);
    expect(d.decision).toBe('MODIFY');
    expect(d.modifications).toEqual({ sl: 1.0985 });
  });

  it('fails closed (REJECT) when no submit_decision block is present', () => {
    const content = [{ type: 'text', text: 'I forgot to call the tool.' }];
    const d = extractAnalystDecisionFromTool(content as never);
    expect(d.decision).toBe('REJECT');
    expect(d.confidence).toBe(0);
    expect(d.reason).toMatch(/no.*submit_decision/i);
  });

  it('fails closed when decision value is invalid', () => {
    const content = [
      {
        type: 'tool_use', id: 't', name: 'submit_decision',
        input: { decision: 'YES_WHY_NOT', reason: '?', confidence: 1, modifications: {} },
      },
    ];
    const d = extractAnalystDecisionFromTool(content as never);
    expect(d.decision).toBe('REJECT');
    expect(d.reason).toMatch(/invalid decision/i);
  });

  it('clamps out-of-range confidence to [0,1]', () => {
    const content = [
      {
        type: 'tool_use', id: 't', name: 'submit_decision',
        input: { decision: 'APPROVE', reason: 'ok', confidence: 1.7, modifications: {} },
      },
    ];
    const d = extractAnalystDecisionFromTool(content as never);
    expect(d.confidence).toBe(1);
  });

  it('zeroes non-finite confidence', () => {
    const content = [
      {
        type: 'tool_use', id: 't', name: 'submit_decision',
        input: { decision: 'APPROVE', reason: 'ok', confidence: 'not-a-number', modifications: {} },
      },
    ];
    const d = extractAnalystDecisionFromTool(content as never);
    expect(d.confidence).toBe(0);
  });

  it('ignores tool_use blocks for other tools', () => {
    const content = [
      {
        type: 'tool_use', id: 't', name: 'something_else',
        input: { foo: 'bar' },
      },
    ];
    const d = extractAnalystDecisionFromTool(content as never);
    expect(d.decision).toBe('REJECT');
    expect(d.reason).toMatch(/no.*submit_decision/i);
  });

  it('fails closed on empty content array', () => {
    const d = extractAnalystDecisionFromTool([] as never);
    expect(d.decision).toBe('REJECT');
    expect(d.confidence).toBe(0);
  });
});

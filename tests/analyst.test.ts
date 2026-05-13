// Tests for parseAnalystResponse — defaults to REJECT on parse failure.
//
// 2026-05-11: binary contract — APPROVE | REJECT only. The MODIFY-accepts
// cases were removed; a coercion test for the tool-use path was added to
// guard against prompt regression / model drift emitting MODIFY despite
// the new schema. `modifications` removed from EXPECTED outputs (input
// fixtures may still carry it — the parser ignores it on input).
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
        input: { decision: 'REJECT', reason: 'Calendar veto fires in 4 minutes', confidence: 0.95 },
      },
    ];
    const d = extractAnalystDecisionFromTool(content as never);
    expect(d.decision).toBe('REJECT');
  });

  it('coerces legacy MODIFY tool-use input to fail-closed REJECT', () => {
    // 2026-05-11 binary-contract guard. If a future prompt regression or
    // model drift makes the analyst emit MODIFY despite the new schema,
    // the tool extractor must coerce to fail-closed REJECT (matching the
    // parseAnalystResponse coercion path tested in analyst-parse.test.ts).
    const content = [{
      type: 'tool_use',
      id: 't',
      name: 'submit_decision',
      input: { decision: 'MODIFY', reason: 'size too high', confidence: 0.8, modifications: { sl: 1.0985 } },
    }];
    const d = extractAnalystDecisionFromTool(content as never);
    expect(d.decision).toBe('REJECT');
    expect(d.confidence).toBe(0);
    expect(d.reason).toMatch(/Legacy MODIFY rejected/);
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
        input: { decision: 'YES_WHY_NOT', reason: '?', confidence: 1 },
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
        input: { decision: 'APPROVE', reason: 'ok', confidence: 1.7 },
      },
    ];
    const d = extractAnalystDecisionFromTool(content as never);
    expect(d.confidence).toBe(1);
  });

  it('zeroes non-finite confidence', () => {
    const content = [
      {
        type: 'tool_use', id: 't', name: 'submit_decision',
        input: { decision: 'APPROVE', reason: 'ok', confidence: 'not-a-number' },
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

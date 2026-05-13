// Tests for parseAnalystResponse — the validation/normalisation layer
// added during the 2026-04-29 audit. Pre-fix the analyst would silently
// REJECT 100% of trades when adaptive thinking placed a thinking block
// at content[0] (extracting '' as the text). Now extractText handles
// that and parseAnalystResponse strictly validates the shape.
//
// 2026-05-11: binary contract — APPROVE | REJECT only. Legacy MODIFY
// is coerced to fail-closed REJECT (with 'Legacy MODIFY rejected' reason)
// for any prompt regression / model drift. The 'modifications' field
// no longer exists in AnalystDecision; input fixtures may still carry
// it (the parser ignores it on input) but expected outputs do not.
import { describe, it, expect } from 'vitest';
import { parseAnalystResponse } from '../src/agents/analyst-agent.js';

describe('parseAnalystResponse', () => {
  it('parses a clean APPROVE decision', () => {
    const input = '{"decision":"APPROVE","reason":"all checks pass","modifications":{},"confidence":0.85}';
    const out = parseAnalystResponse(input);
    expect(out).toEqual({
      decision: 'APPROVE',
      reason: 'all checks pass',
      confidence: 0.85,
    });
  });

  it('parses prose-wrapped JSON', () => {
    const input = 'Here is my decision:\n\n{"decision":"REJECT","reason":"R:R below 2:1","modifications":{},"confidence":0.9}\n\nThanks!';
    const out = parseAnalystResponse(input);
    expect(out.decision).toBe('REJECT');
    expect(out.confidence).toBe(0.9);
  });

  it('normalises lowercase decision to uppercase', () => {
    const input = '{"decision":"approve","reason":"ok","modifications":{},"confidence":0.7}';
    const out = parseAnalystResponse(input);
    expect(out.decision).toBe('APPROVE');
  });

  it('fail-closed REJECT on invalid decision value (not APPROVE/REJECT)', () => {
    const input = '{"decision":"maybe","reason":"unsure","modifications":{},"confidence":0.6}';
    const out = parseAnalystResponse(input);
    expect(out.decision).toBe('REJECT');
    expect(out.confidence).toBe(0); // fail-closed default is 0, not 0.5
    expect(out.reason).toMatch(/invalid decision/i);
  });

  it('fail-closed REJECT on legacy MODIFY (binary contract as of 2026-05-11)', () => {
    const input = '{"decision":"MODIFY","reason":"size off","modifications":{"size_per_leg":0.5},"confidence":0.8}';
    const out = parseAnalystResponse(input);
    expect(out.decision).toBe('REJECT');
    expect(out.confidence).toBe(0);
    expect(out.reason).toMatch(/Legacy MODIFY rejected/);
  });

  it('fail-closed REJECT on empty-mods MODIFY (the 2026-05-11 bug shape)', () => {
    const input = '{"decision":"MODIFY","reason":"All checks pass. Returning APPROVE.","modifications":{},"confidence":0.82}';
    const out = parseAnalystResponse(input);
    expect(out.decision).toBe('REJECT');
    expect(out.reason).toMatch(/Legacy MODIFY rejected/);
  });

  it('clamps confidence > 1 to 1', () => {
    const input = '{"decision":"APPROVE","reason":"ok","modifications":{},"confidence":2.5}';
    const out = parseAnalystResponse(input);
    expect(out.confidence).toBe(1);
  });

  it('clamps confidence < 0 to 0', () => {
    const input = '{"decision":"APPROVE","reason":"ok","modifications":{},"confidence":-0.5}';
    const out = parseAnalystResponse(input);
    expect(out.confidence).toBe(0);
  });

  it('coerces string-numeric confidence', () => {
    const input = '{"decision":"APPROVE","reason":"ok","modifications":{},"confidence":"0.75"}';
    const out = parseAnalystResponse(input);
    expect(out.confidence).toBe(0.75);
  });

  it('falls back to 0 confidence on string "high" / non-numeric', () => {
    const input = '{"decision":"APPROVE","reason":"ok","modifications":{},"confidence":"high"}';
    const out = parseAnalystResponse(input);
    expect(out.confidence).toBe(0); // not 0.5 — we don't know
  });

  it('returns fail-closed REJECT on unparseable text', () => {
    const out = parseAnalystResponse('this is not JSON at all');
    expect(out.decision).toBe('REJECT');
    expect(out.confidence).toBe(0);
    expect(out.reason).toMatch(/Could not parse/);
  });

  it('returns fail-closed REJECT on empty string', () => {
    const out = parseAnalystResponse('');
    expect(out.decision).toBe('REJECT');
    expect(out.confidence).toBe(0);
  });

  it('uses LAST balanced object when there are multiple (avoids prose example)', () => {
    const input = 'Example: {"decision":"REJECT"} Final answer: {"decision":"APPROVE","confidence":0.95,"reason":"ok","modifications":{}}';
    const out = parseAnalystResponse(input);
    expect(out.decision).toBe('APPROVE');
    expect(out.confidence).toBe(0.95);
  });

  it('treats missing reason as empty string', () => {
    const input = '{"decision":"APPROVE","modifications":{},"confidence":0.8}';
    const out = parseAnalystResponse(input);
    expect(out.reason).toBe('');
  });
});

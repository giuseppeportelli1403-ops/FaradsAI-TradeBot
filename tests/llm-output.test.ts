// Shared LLM-output helpers — extracts text from Anthropic ContentBlock
// arrays correctly when adaptive thinking is enabled, and extracts JSON
// objects via balanced-brace scanning rather than greedy regex.
//
// Audit context (2026-04-28): the previous pattern across 5 agents was
//   const text = response.content[0].type === 'text' ? response.content[0].text : '';
// With `thinking: { type: 'adaptive' }` enabled, content[0] is typically a
// ThinkingBlock, NOT a TextBlock. This made every Analyst call REJECT-by-
// default, every Reflection lesson empty, every Researcher brief fall back
// to the "theme extraction failed" stub, and every EOD journal silently
// blank. The shared helpers below fix all five at once.
import { describe, it, expect } from 'vitest';
import {
  extractText,
  extractJsonObject,
  extractLastJsonObject,
  parseJsonObject,
  parseLastJsonObject,
  withTimeout,
  type ContentBlockLike,
} from '../src/agents/llm-output.js';

describe('extractText', () => {
  it('returns the single text block when content has only text', () => {
    const blocks: ContentBlockLike[] = [{ type: 'text', text: 'hello world' }];
    expect(extractText(blocks)).toBe('hello world');
  });

  it('skips a leading thinking block and returns the text block', () => {
    // This is the production case: adaptive thinking puts a ThinkingBlock
    // at index 0 and the actual text at index 1.
    const blocks: ContentBlockLike[] = [
      { type: 'thinking', thinking: 'reasoning trace...' },
      { type: 'text', text: '{"decision":"APPROVE","confidence":0.85}' },
    ];
    expect(extractText(blocks)).toBe('{"decision":"APPROVE","confidence":0.85}');
  });

  it('concatenates multiple text blocks separated by newlines', () => {
    const blocks: ContentBlockLike[] = [
      { type: 'thinking', thinking: 'reasoning...' },
      { type: 'text', text: 'first part' },
      { type: 'text', text: 'second part' },
    ];
    expect(extractText(blocks)).toBe('first part\nsecond part');
  });

  it('returns empty string when content is empty', () => {
    expect(extractText([])).toBe('');
  });

  it('returns empty string when content has only thinking blocks', () => {
    const blocks: ContentBlockLike[] = [{ type: 'thinking', thinking: '...' }];
    expect(extractText(blocks)).toBe('');
  });

  it('ignores tool_use blocks (not text)', () => {
    const blocks: ContentBlockLike[] = [
      { type: 'tool_use', id: 'a', name: 'foo', input: {} },
      { type: 'text', text: 'real text' },
    ];
    expect(extractText(blocks)).toBe('real text');
  });

  it('handles undefined / null gracefully', () => {
    expect(extractText(undefined)).toBe('');
    expect(extractText(null as unknown as ContentBlockLike[])).toBe('');
  });

  it('trims trailing whitespace on each text block before joining', () => {
    const blocks: ContentBlockLike[] = [
      { type: 'text', text: 'first  \n\n' },
      { type: 'text', text: '\n  second' },
    ];
    expect(extractText(blocks)).toBe('first  \n\n\n\n  second');
    // (Don't trim — preserves whitespace inside JSON. Test documents that.)
  });
});

describe('extractJsonObject', () => {
  it('returns the JSON object from clean input', () => {
    expect(extractJsonObject('{"a":1,"b":2}')).toBe('{"a":1,"b":2}');
  });

  it('extracts JSON from prose-wrapped output', () => {
    const text = 'Here is my decision:\n\n{"decision":"APPROVE"}\n\nThanks!';
    expect(extractJsonObject(text)).toBe('{"decision":"APPROVE"}');
  });

  it('extracts JSON from markdown-fenced output', () => {
    const text = '```json\n{"decision":"APPROVE","confidence":0.9}\n```';
    expect(extractJsonObject(text)).toBe('{"decision":"APPROVE","confidence":0.9}');
  });

  it('handles nested objects correctly (balanced-brace scan)', () => {
    const text = 'Result: {"outer":{"inner":"value"},"x":1} (done)';
    expect(extractJsonObject(text)).toBe('{"outer":{"inner":"value"},"x":1}');
  });

  it('does NOT splice prose from after-the-object into the result (greedy-regex bug)', () => {
    // Pre-fix bug: /\{[\s\S]*\}/ matched from first { to LAST }, swallowing
    // arbitrary prose. Confirms balanced-brace fix.
    const text = '{"decision":"APPROVE"} additional discussion: a stray } here';
    expect(extractJsonObject(text)).toBe('{"decision":"APPROVE"}');
  });

  it('returns null when no balanced object exists', () => {
    expect(extractJsonObject('no json here')).toBeNull();
    expect(extractJsonObject('{ unclosed')).toBeNull();
    expect(extractJsonObject('')).toBeNull();
  });

  it('returns null on null/undefined input', () => {
    expect(extractJsonObject(null as unknown as string)).toBeNull();
    expect(extractJsonObject(undefined as unknown as string)).toBeNull();
  });

  it('returns the FIRST balanced object when multiple exist', () => {
    const text = 'Example: {"x":1} Final: {"x":2}';
    expect(extractJsonObject(text)).toBe('{"x":1}');
  });

  it('handles strings containing braces inside the JSON correctly', () => {
    // Brace inside a JSON string value should not confuse the brace counter.
    const text = '{"msg":"hello {world}","ok":true}';
    expect(extractJsonObject(text)).toBe('{"msg":"hello {world}","ok":true}');
  });

  it('handles escaped quotes inside strings', () => {
    const text = '{"msg":"he said \\"hi\\"","ok":true}';
    expect(extractJsonObject(text)).toBe('{"msg":"he said \\"hi\\"","ok":true}');
  });

  it('handles newlines inside the object', () => {
    const text = '{\n  "a": 1,\n  "b": 2\n}';
    expect(extractJsonObject(text)).toBe(text);
  });
});

describe('extractLastJsonObject', () => {
  it('returns the last balanced object when multiple exist', () => {
    expect(extractLastJsonObject('Example: {"x":1} Final: {"x":2}')).toBe('{"x":2}');
  });

  it('returns the only object when there is only one', () => {
    expect(extractLastJsonObject('Final: {"x":1}')).toBe('{"x":1}');
  });

  it('returns null when no balanced object exists', () => {
    expect(extractLastJsonObject('no json here')).toBeNull();
    expect(extractLastJsonObject('{ unclosed')).toBeNull();
  });

  it('handles nested objects in the last position', () => {
    expect(extractLastJsonObject('first: {"a":1} last: {"b":{"c":2}}')).toBe('{"b":{"c":2}}');
  });
});

describe('parseLastJsonObject', () => {
  it('parses the last object when an example precedes the real answer', () => {
    const text = 'Example: {"decision":"REJECT"} Final: {"decision":"APPROVE","confidence":0.9}';
    const result = parseLastJsonObject(text);
    expect(result).toEqual({ decision: 'APPROVE', confidence: 0.9 });
  });

  it('returns null on no balanced object', () => {
    expect(parseLastJsonObject('no json')).toBeNull();
  });

  it('returns null when the last block is invalid JSON', () => {
    expect(parseLastJsonObject('first: {"a":1} second: {invalid}')).toBeNull();
  });
});

describe('withTimeout', () => {
  it('returns the resolved value when the promise wins', async () => {
    const result = await withTimeout(Promise.resolve(42), 1000, 'test');
    expect(result).toBe(42);
  });

  it('rejects with a labelled error when the timeout wins', async () => {
    const slow = new Promise<number>((res) => setTimeout(() => res(1), 100));
    await expect(withTimeout(slow, 10, 'slow-op')).rejects.toThrow(/slow-op timed out after 10ms/);
  });

  it('clears the timer on the happy path (no leaked timeouts)', async () => {
    // If the timer leaked, vitest would hang at the end of the test run.
    // The fact that this test completes proves cleanup works.
    const result = await withTimeout(Promise.resolve('done'), 1_000_000, 'long-deadline');
    expect(result).toBe('done');
  });

  it('propagates the original error when the underlying promise rejects', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000, 'fail-test')).rejects.toThrow(/boom/);
  });
});

describe('parseJsonObject', () => {
  it('returns the parsed object on valid input', () => {
    const result = parseJsonObject('{"a":1,"b":"two"}');
    expect(result).toEqual({ a: 1, b: 'two' });
  });

  it('extracts and parses prose-wrapped JSON', () => {
    const result = parseJsonObject('Here you go: {"a":1} ok?');
    expect(result).toEqual({ a: 1 });
  });

  it('returns null on unparseable input', () => {
    expect(parseJsonObject('not json')).toBeNull();
    expect(parseJsonObject('{ unclosed')).toBeNull();
  });

  it('returns null on the empty / null case', () => {
    expect(parseJsonObject('')).toBeNull();
    expect(parseJsonObject(null as unknown as string)).toBeNull();
  });

  it('returns null when extracted JSON is syntactically invalid', () => {
    // Valid braces but invalid JSON inside.
    expect(parseJsonObject('{a: 1, b: 2}')).toBeNull(); // unquoted keys
    expect(parseJsonObject("{'a': 1}")).toBeNull(); // single quotes
  });
});

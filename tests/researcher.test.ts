// Tests for extractThemesFromTool — Researcher's tool_use extractor.
//
// 2026-05-05 audit (Phase 2 / Round 1 / item 1.2): replaced the regex-based
// JSON-array parse with a forced submit_themes tool call. Returns null on
// missing/invalid tool input — caller logs a warning and the brief saves
// with empty themes (NOT a fake "THEME EXTRACTION FAILED" placeholder
// that pre-fix poisoned downstream consumers).

import { describe, it, expect } from 'vitest';
import { extractThemesFromTool } from '../src/agents/researcher-agent.js';

describe('extractThemesFromTool — read themes from submit_themes tool_use', () => {
  it('extracts 3-5 themes from a valid tool_use block', () => {
    const content = [
      {
        type: 'tool_use',
        id: 'tool_01',
        name: 'submit_themes',
        input: { themes: ['EUR weakness on PMI miss', 'USD strength on Fed hawkish', 'Gold rotation'] },
      },
    ];
    const themes = extractThemesFromTool(content as never);
    expect(themes).not.toBeNull();
    expect(themes).toHaveLength(3);
    expect(themes?.[0]).toContain('EUR');
  });

  it('caps at 5 themes even if model emits more', () => {
    const content = [
      {
        type: 'tool_use', id: 'x', name: 'submit_themes',
        input: { themes: ['t1', 't2', 't3', 't4', 't5', 't6', 't7'] },
      },
    ];
    const themes = extractThemesFromTool(content as never);
    expect(themes).toHaveLength(5);
  });

  it('returns null when no submit_themes block is present', () => {
    const content = [{ type: 'text', text: 'I forgot the tool.' }];
    expect(extractThemesFromTool(content as never)).toBeNull();
  });

  it('returns null on empty themes array (no signal)', () => {
    const content = [
      { type: 'tool_use', id: 'x', name: 'submit_themes', input: { themes: [] } },
    ];
    expect(extractThemesFromTool(content as never)).toBeNull();
  });

  it('returns null when themes is not an array', () => {
    const content = [
      { type: 'tool_use', id: 'x', name: 'submit_themes', input: { themes: 'one big string' } },
    ];
    expect(extractThemesFromTool(content as never)).toBeNull();
  });

  it('coerces non-string themes to strings (defensive)', () => {
    const content = [
      {
        type: 'tool_use', id: 'x', name: 'submit_themes',
        input: { themes: ['valid', 42, 'another'] },
      },
    ];
    const themes = extractThemesFromTool(content as never);
    expect(themes?.[1]).toBe('42');
  });

  it('drops empty strings from the array', () => {
    const content = [
      {
        type: 'tool_use', id: 'x', name: 'submit_themes',
        input: { themes: ['valid', '', '   ', 'another'] },
      },
    ];
    const themes = extractThemesFromTool(content as never);
    expect(themes).toEqual(['valid', 'another']);
  });

  it('returns null if all themes are empty after filtering', () => {
    const content = [
      {
        type: 'tool_use', id: 'x', name: 'submit_themes',
        input: { themes: ['', '   ', '\n'] },
      },
    ];
    expect(extractThemesFromTool(content as never)).toBeNull();
  });

  it('returns null on empty content', () => {
    expect(extractThemesFromTool([] as never)).toBeNull();
  });
});

// Regression test for Spec 002 / MODIFY removal — pins the
// [analyst-coercion] log marker that the daily VPS log grep depends on:
//   ssh bot@162.55.212.198 "grep -c '\[analyst-coercion\]' ~/trading-bot/data/pm2-out.log"
// Expected to stay at 0 after rollout. A non-zero count means the model
// is still trying to emit MODIFY against the new schema; investigate.

import { describe, it, expect, vi } from 'vitest';
import {
  parseAnalystResponse,
  extractAnalystDecisionFromTool,
  getSubmitDecisionTool,
} from '../src/agents/analyst-agent.js';

describe('[analyst-coercion] log marker — DO NOT change without updating VPS grep', () => {
  it('parseAnalystResponse emits [analyst-coercion] on legacy MODIFY input', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      parseAnalystResponse('{"decision":"MODIFY","reason":"x","confidence":0.5}');
      const allCalls = warnSpy.mock.calls.flat().map((a) => String(a)).join(' ');
      expect(allCalls).toContain('[analyst-coercion]');
      expect(allCalls).toContain('legacy MODIFY -> REJECT');
      expect(allCalls).toContain('parseAnalystResponse');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('extractAnalystDecisionFromTool emits [analyst-coercion] on legacy MODIFY tool input', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const content = [
        {
          type: 'tool_use', id: 't', name: 'submit_decision',
          input: { decision: 'MODIFY', reason: 'x', confidence: 0.5, modifications: {} },
        },
      ];
      extractAnalystDecisionFromTool(content as never);
      const allCalls = warnSpy.mock.calls.flat().map((a) => String(a)).join(' ');
      expect(allCalls).toContain('[analyst-coercion]');
      expect(allCalls).toContain('legacy MODIFY -> REJECT');
      expect(allCalls).toContain('extractAnalystDecisionFromTool');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does NOT emit [analyst-coercion] on legitimate APPROVE/REJECT', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      parseAnalystResponse('{"decision":"APPROVE","reason":"x","confidence":0.8}');
      parseAnalystResponse('{"decision":"REJECT","reason":"x","confidence":0.8}');
      const allCalls = warnSpy.mock.calls.flat().map((a) => String(a)).join(' ');
      expect(allCalls).not.toContain('[analyst-coercion]');
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('getSubmitDecisionTool() schema — binary enum regression test', () => {
  it('exposes enum [APPROVE, REJECT] only — NO MODIFY', () => {
    const tool = getSubmitDecisionTool();
    const schema = tool.input_schema as {
      properties: { decision: { enum: string[] } };
      required: string[];
    };
    expect(schema.properties.decision.enum).toEqual(['APPROVE', 'REJECT']);
    expect(schema.properties.decision.enum).not.toContain('MODIFY');
  });

  it('does NOT include `modifications` in properties or required', () => {
    const tool = getSubmitDecisionTool();
    const schema = tool.input_schema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(schema.properties)).not.toContain('modifications');
    expect(schema.required).not.toContain('modifications');
  });

  it('description string reinforces binary contract for the model', () => {
    const tool = getSubmitDecisionTool();
    expect(tool.description).toMatch(/BINARY/);
    expect(tool.description).toMatch(/no MODIFY verdict|There is no MODIFY/i);
  });
});

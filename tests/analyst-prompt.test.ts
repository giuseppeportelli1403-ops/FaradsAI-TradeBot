// Static prompt-content tests for prompts/analyst-agent.md.
//
// 2026-05-12 — Spec 002 / MODIFY removal. Asserts the binary contract
// is in place AND broad-pattern guards that no model-facing prompt
// re-introduces MODIFY language. The prompts must contain ZERO
// `modif*` matches (case-insensitive).
//
// If the broad-pattern guard fires, you are about to ship a prompt
// that asks the model to emit MODIFY again — STOP and read
// memory/project_farad_modify_removed.md before merging.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = join(__dirname, '..', 'prompts', 'analyst-agent.md');

let promptText: string;

beforeAll(() => {
  promptText = readFileSync(PROMPT_PATH, 'utf-8');
});

describe('analyst-agent.md binary-contract calibration', () => {
  it('contains the APPROVE rate target and the binary REJECT band', () => {
    expect(promptText).toContain('APPROVE rate target: 60-80%');
    expect(promptText).toContain('REJECT rate target: 20-40%');
  });

  it('contains the binary DECISION RULE table + no-third-verdict clause', () => {
    expect(promptText).toContain('DECISION RULE');
    expect(promptText).toContain('No third verdict');
    // The binary contract statement at the top
    expect(promptText).toMatch(/decision contract is BINARY/i);
    // The wait-defer-is-REJECT rule
    expect(promptText).toContain('"Wait for X event to clear" is REJECT');
    // The "all-6-pass with concerns is APPROVE" rule
    expect(promptText).toContain('"All 6 checks pass but I have qualitative concerns" is APPROVE');
  });

  it('CHECK 2 explicit deferred-resubmit clause for inside-veto-window case', () => {
    expect(promptText).toContain('central-bank decision');
    expect(promptText).toContain('AHE, Unemployment Rate, Retail Sales');
    expect(promptText).toContain('inside the −60/+30 veto window');
    expect(promptText).toContain('→ REJECT with reason');
    expect(promptText).toContain('flag in `reason` as a caveat');
    expect(promptText).toContain('do NOT downgrade');
  });
});

describe('Spec 002 broad-pattern guard — ZERO modif* in any model-facing prompt', () => {
  const PROMPT_FILES = [
    'prompts/analyst-agent.md',
    'prompts/ict-agent.md',
    'prompts/reflection-agent.md',
    'prompts/review-agent.md',
  ];
  const root = join(__dirname, '..');

  for (const relPath of PROMPT_FILES) {
    it(`${relPath} contains ZERO 'modif*' matches`, () => {
      const text = readFileSync(join(root, relPath), 'utf-8');
      const matches = text.match(/modif/gi);
      expect(
        matches,
        `Expected zero modif* matches in ${relPath}, found ${matches?.length ?? 0}. Lines:\n${
          text
            .split('\n')
            .map((l, i) => (l.match(/modif/i) ? `${i + 1}: ${l}` : null))
            .filter(Boolean)
            .join('\n')
        }`,
      ).toBeNull();
    });
  }
});

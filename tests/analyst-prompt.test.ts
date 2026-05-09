// Static prompt-content tests for prompts/analyst-agent.md.
// Same pattern as tests/ict-prompt.test.ts — guards against accidental
// deletion of the 2026-05-09 calibration directives. Real validation
// of the analyst's behavior is production observation (APPROVE rate,
// MODIFY-with-empty-modifications count, trade-placement count).
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

describe('analyst-agent.md decision-rule calibration', () => {
  it('contains the APPROVE rate target (60-80%) and MODIFY/REJECT bands', () => {
    expect(promptText).toContain('APPROVE rate target: 60-80%');
    expect(promptText).toContain('MODIFY rate target: 5-15%');
    expect(promptText).toContain('REJECT rate target: 15-25%');
  });

  it('contains the explicit DECISION RULE table + strict MODIFY clause', () => {
    // The decision-rule table header
    expect(promptText).toContain('DECISION RULE — pick exactly one');
    // The strict-MODIFY-requires-non-empty-modifications rule
    expect(promptText).toContain(
      'MODIFY requires `modifications` to contain at least one specific proposal field',
    );
    // The "wait is REJECT not MODIFY" rule
    expect(promptText).toContain('"Wait for X event to clear" is REJECT, not MODIFY');
    // The "all-6-pass with concerns is APPROVE" rule
    expect(promptText).toContain(
      '"All 6 checks pass but I have qualitative concerns" is APPROVE, not MODIFY',
    );
  });
});

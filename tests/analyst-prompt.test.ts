// Static prompt-content tests for prompts/analyst-agent.md.
// Same pattern as tests/ict-prompt.test.ts — guards against accidental
// deletion of the 2026-05-09 calibration directives. Real validation
// of the analyst's behavior is production observation (APPROVE rate,
// trade-placement count).
//
// 2026-05-11: binary contract — APPROVE | REJECT only. Old MODIFY-band
// assertions removed; new tests guard the binary calibration bands, the
// DECISION RULE table containing only APPROVE/REJECT, and the broader
// modif* negative assertion (codex finding 7 — re-teaching risk via
// `modified`/`modifying` word forms that Group B's narrow grep missed).
//
// Codex finding #3 (2026-05-11): a schema-enum regression test guards
// getSubmitDecisionTool() directly so any future regression that re-adds
// MODIFY to the enum or modifications to the schema properties is caught
// at test time, not in production.
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getSubmitDecisionTool } from '../src/agents/analyst-agent.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = join(__dirname, '..', 'prompts', 'analyst-agent.md');

let promptText: string;

beforeAll(() => {
  promptText = readFileSync(PROMPT_PATH, 'utf-8');
});

describe('analyst-agent.md decision-rule calibration', () => {
  it('contains the APPROVE rate target (60-85%) and REJECT band (15-40%) — binary contract', () => {
    expect(promptText).toContain('APPROVE rate target: 60-85%');
    expect(promptText).toContain('REJECT rate target: 15-40%');
  });

  it('explicitly states the contract is binary in model-facing text', () => {
    expect(promptText).toContain('APPROVE** or **REJECT');
  });

  it('mentions only APPROVE and REJECT in the DECISION RULE table', () => {
    const tableMatch = promptText.match(/## DECISION RULE[\s\S]*?(?=\n##|\n---|\n$)/);
    expect(tableMatch).not.toBeNull();
    const table = tableMatch![0];
    expect(table).toContain('**APPROVE**');
    expect(table).toContain('**REJECT**');
    expect(table).not.toMatch(/\*\*MODIFY\*\*/);
  });

  it('routes qualitative-concerns to APPROVE-with-caveat, not REJECT', () => {
    expect(promptText).toContain('"All 6 checks pass but I have qualitative concerns" is APPROVE, not REJECT');
  });

  it('routes wait-for-event to REJECT', () => {
    expect(promptText).toContain('"Wait for X event to clear" is REJECT');
  });

  it('the analyst prompt does NOT contain any modif* word form (codex finding 7 — re-teaching risk)', () => {
    // Group B used a narrow regex (MODIFY|modifications|modify) which missed
    // forms like `modified`, `modifying`. Use a broader pattern here.
    expect(promptText).not.toMatch(/modif/i);
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

// Codex finding #3 (2026-05-11): the original root cause was the schema
// licensing 'MODIFY' in its enum + 'Empty object {} otherwise' description
// on modifications. This test guards the schema directly so any future
// regression that re-adds MODIFY to the enum or modifications to the
// properties is caught at test time.
describe('submit_decision tool schema — binary contract regression guard', () => {
  it('submit_decision tool schema enum is exactly [APPROVE, REJECT] with no modifications property', () => {
    const tool = getSubmitDecisionTool();

    expect(tool.name).toBe('submit_decision');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const props = tool.input_schema.properties as any;
    expect(props.decision.enum).toEqual(['APPROVE', 'REJECT']);
    expect(props).not.toHaveProperty('modifications');
    expect(tool.input_schema.required).toEqual(['decision', 'reason', 'confidence']);
    expect(tool.input_schema.required).not.toContain('modifications');
  });
});

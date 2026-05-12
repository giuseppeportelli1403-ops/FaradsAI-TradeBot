// Static prompt-content tests for prompts/ict-agent.md.
// These guard against accidental deletion of L3 directives — they verify
// the prompt file STILL contains the literal directives we shipped, NOT
// behavioral correctness of the agent (which is only validatable in
// production).
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = join(__dirname, '..', 'prompts', 'ict-agent.md');

let promptText: string;

beforeAll(() => {
  promptText = readFileSync(PROMPT_PATH, 'utf-8');
});

describe('ict-agent.md L3 directives', () => {
  it('STEP 1 mandates parallel batching of get_daily_pnl + get_portfolio + get_economic_calendar', () => {
    expect(promptText).toContain(
      'IN PARALLEL (emit all three as parallel tool_use blocks',
    );
    // The three tool calls must appear in the rendered prompt. Order
    // doesn't matter for the test, but all three must be present.
    expect(promptText).toMatch(/get_daily_pnl\(\)/);
    expect(promptText).toMatch(/get_portfolio\(\)/);
    expect(promptText).toMatch(/get_economic_calendar\(1\)/);
  });

  it('STEP 3 mandates parallel batching of read-only fetches per candidate', () => {
    expect(promptText).toContain(
      'CRITICAL — batch all read-only data tools in a single response',
    );
    // Minimum batch per candidate
    expect(promptText).toMatch(/get_prices\(instrument, '1h', 50\)/);
    expect(promptText).toMatch(/get_prices\(instrument, '15m', 50\)/);
    expect(promptText).toMatch(/get_news_context\(instrument\)/);
    expect(promptText).toMatch(
      /get_lessons\(setup_type, instrument_category, kill_zone, 'ICT_INTRADAY'\)/,
    );
  });

  it('TP2 R:R precision rule cites 1.31 (not 1.30) as the safe target', () => {
    // The precision rule itself
    expect(promptText).toContain('TP2 ≥ 1.31 × |entry − SL|');
    // Step L checklist updated to use 1.01 / 1.31 as the safe-target margins
    expect(promptText).toContain(
      'R:R to TP1 ≥ 1.01 and R:R to TP2 ≥ 1.31',
    );
  });

  it('analyst response interpretation rule (2026-05-08 incident guard, post-Spec-002 binary)', () => {
    // Structured-field-only rule must be present so the agent doesn't
    // misread non-APPROVE prose as APPROVE.
    expect(promptText).toContain(
      'structured `decision` field is the ONLY authority',
    );
    // The 2026-05-08 incident reference tells future readers what bug
    // this guard exists for.
    expect(promptText).toContain('2026-05-08');
    // Binary-contract aware: the analyst contract is APPROVE / REJECT only.
    expect(promptText).toMatch(/contract is BINARY|APPROVE \/ REJECT/);
  });

  it('contains ZERO modif* matches (Spec 002 broad-pattern guard)', () => {
    const matches = promptText.match(/modif/gi);
    expect(matches, `Expected zero modif* in prompts/ict-agent.md, got ${matches?.length ?? 0}`).toBeNull();
  });

  it('STEP 3 contains L0 feasibility pre-flight directive', () => {
    expect(promptText).toContain('L0. Sizing feasibility pre-flight');
    expect(promptText).toContain('leg_b_notional = (balance × tier_risk_pct / 100) × 0.30 / |entry − sl|');
    expect(promptText).toContain('skip this candidate');
    expect(promptText).toContain('do NOT submit to `request_analyst_review`');
  });
});

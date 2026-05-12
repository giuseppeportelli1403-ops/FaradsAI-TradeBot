// Static prompt-content tests for prompts/ict-agent.md.
// These guard against accidental deletion of L3 directives — they verify
// the prompt file STILL contains the literal directives we shipped, NOT
// behavioral correctness of the agent (which is only validatable in
// production).
//
// 2026-05-11: binary contract — APPROVE | REJECT only. The
// MODIFY-resubmit assertions were removed; new tests assert the prompt
// does NOT teach modification-and-resubmit (the next 15M scheduler tick
// is the only retry path) and does NOT contain any modif* word form
// (codex finding 7 + spec-reviewer catch — broader than Group B's grep).
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

  it('does NOT instruct the agent to resubmit on REJECT (contract is binary 2026-05-11)', () => {
    // The ICT prompt must not tell the agent to apply modifications and
    // re-request — the next 15M scheduler tick is the only path to retry.
    expect(promptText).not.toMatch(/modifications` field is your action list/);
    expect(promptText).not.toMatch(/apply the modifications and re-submit/);
  });

  it('keeps the anti-pattern rule that decision-field is sole authority', () => {
    // The 2026-05-08 incident rule (do not act on prose if decision !== APPROVE)
    // is still load-bearing — keep asserting it.
    expect(promptText).toMatch(/structured `decision` field is the ONLY authority/);
  });

  it('ict prompt does NOT contain any modif* word form (codex finding 7 + spec-reviewer catch)', () => {
    // Broader pattern than the narrow Group B grep — guards against any
    // future leak via modified, modifying, modifier, etc.
    expect(promptText).not.toMatch(/modif/i);
  });

  it('STEP 3 contains L0 feasibility pre-flight directive', () => {
    expect(promptText).toContain('L0. Sizing feasibility pre-flight');
    expect(promptText).toContain('leg_b_notional = (balance × tier_risk_pct / 100) × 0.30 / |entry − sl|');
    expect(promptText).toContain('skip this candidate');
    expect(promptText).toContain('do NOT submit to `request_analyst_review`');
  });
});

// PR 1 2026-05-12 — trade-frequency loosening threshold assertions.
// Design: docs/superpowers/specs/2026-05-12-trade-frequency-loosening-design.md
// These tests are written in RED phase (T4) and pass when T5 lands.
// Codex twin (2026-05-12) flagged 3 BLOCKERS: stale 40/45 refs at lines 119+173,
// stale 55 ref at line 268, and the "credible candidate exists" framing
// reversal. T5 must address all of these.
describe('ict-agent.md PR 1 loosened thresholds (T4 red → T5 green)', () => {
  it('OB Retest body threshold is 0.3, not 0.4', () => {
    const obLine = promptText.match(/OB Retest:.*$/m)?.[0] ?? '';
    expect(obLine).toMatch(/body ≥ 0\.3×range/);
    expect(obLine).not.toMatch(/body ≥ 0\.4×range/);
  });

  it('OB Retest opposing wick threshold is 0.7×body, not 1.0×body', () => {
    const obLine = promptText.match(/OB Retest:.*$/m)?.[0] ?? '';
    expect(obLine).toMatch(/opposing wick ≥ 0\.7×body/);
    expect(obLine).not.toMatch(/opposing wick ≥ 1\.0×body/);
  });

  it('FVG Fill confirmation body threshold is 0.3, not 0.4', () => {
    const fvgLine = promptText.match(/FVG Fill:.*$/m)?.[0] ?? '';
    expect(fvgLine).toMatch(/body ≥ 0\.3×range/);
    expect(fvgLine).not.toMatch(/body ≥ 0\.4×range/);
  });

  it('Force-Propose threshold is 40, not 55', () => {
    const forcePropose = promptText.match(/Force-Propose Rule[\s\S]{0,800}/)?.[0] ?? '';
    expect(forcePropose).toMatch(/composite score ≥ 40/);
    expect(forcePropose).not.toMatch(/composite score ≥ 55/);
  });

  it('Tier 3 floor references reflect new 30/35 values (codex BLOCKER #7)', () => {
    // Stale references at original lines 119 and 173 cite 40/45. They must
    // be updated to 30/35 — otherwise the prompt internally contradicts the
    // scanner code change.
    const tier3Lines = promptText.split('\n').filter((l) => /Tier 3 floor|tier-3 floor|tier 3 floor/i.test(l));
    const concatenated = tier3Lines.join('\n');
    expect(concatenated).toMatch(/30 for tight-spread/);
    expect(concatenated).toMatch(/35 for medium-spread/);
    expect(concatenated).not.toMatch(/40 for tight-spread/);
    expect(concatenated).not.toMatch(/45 for medium-spread/);
  });

  it('does NOT retain the "credible candidate exists" framing as-is (codex BLOCKER #6)', () => {
    // The OLD line justified force-propose 55 as "above both Tier 3 floors"
    // — selectivity narrative. With force-propose at 40 and Tier 3 floors
    // at 30/35, that narrative is reversed. The new text must acknowledge
    // the reduced selectivity (e.g., mention "PR 1 2026-05-12 loosening")
    // rather than carry forward the pre-PR-1 framing verbatim.
    const forceProposeText = promptText.match(/Force-Propose Rule[\s\S]{0,1200}/)?.[0] ?? '';
    if (forceProposeText.includes('"credible candidate exists"')) {
      // If the phrase remains, it must be in updated context that explains
      // the reduced selectivity. Look for a co-located "PR 1" reference.
      expect(forceProposeText).toMatch(/PR 1|loosen|selectivity/i);
    } else {
      // Phrase dropped entirely is also acceptable.
      expect(true).toBe(true);
    }
  });
});

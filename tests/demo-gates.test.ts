// Tests for the demo-phase gate relaxations toggled by DEMO_RELAXED_GATES=true.
// Three relaxations:
//   1. loadPromptWithDemoContext appends a rule-override block when flag is on
//   2. Scanner kill-zone bonus goes from 15/0 to 15/10 when flag is on
//   3. Scanner Tier 3 bracket (score 45-59) activates when flag is on
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadPrompt, loadPromptWithDemoContext } from '../src/agents/load-prompt.js';

describe('loadPromptWithDemoContext', () => {
  const originalFlag = process.env.DEMO_RELAXED_GATES;

  beforeEach(() => {
    delete process.env.DEMO_RELAXED_GATES;
  });

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.DEMO_RELAXED_GATES;
    else process.env.DEMO_RELAXED_GATES = originalFlag;
  });

  it('omits the demo-gates block when DEMO_RELAXED_GATES is unset (system-time still injected)', () => {
    const base = loadPrompt('ict-agent.md');
    const wrapped = loadPromptWithDemoContext('ict-agent.md');
    // W1 (2026-04-28): every system prompt now carries a CURRENT TIME block
    // appended by buildSystemTimeBlock. The demo-gates block is still NOT
    // present unless the env flag is set.
    expect(wrapped.startsWith(base)).toBe(true);
    expect(wrapped).toContain('CURRENT TIME');
    expect(wrapped).not.toContain('DEMO-PHASE RELAXED GATES');
  });

  it('omits the demo-gates block when DEMO_RELAXED_GATES is anything other than "true"', () => {
    process.env.DEMO_RELAXED_GATES = 'false';
    const base = loadPrompt('ict-agent.md');
    const wrapped = loadPromptWithDemoContext('ict-agent.md');
    expect(wrapped.startsWith(base)).toBe(true);
    expect(wrapped).toContain('CURRENT TIME');
    expect(wrapped).not.toContain('DEMO-PHASE RELAXED GATES');
  });

  it('appends the demo-context block when DEMO_RELAXED_GATES=true', () => {
    process.env.DEMO_RELAXED_GATES = 'true';
    const base = loadPrompt('ict-agent.md');
    const wrapped = loadPromptWithDemoContext('ict-agent.md');
    expect(wrapped.length).toBeGreaterThan(base.length);
    expect(wrapped.startsWith(base)).toBe(true);
    expect(wrapped).toContain('DEMO-PHASE RELAXED GATES');
  });

  it('demo block lists all three specific relaxations', () => {
    process.env.DEMO_RELAXED_GATES = 'true';
    // Pre-2026-04-23 this test targeted swing-agent.md; after the Swing Agent
    // was removed, the same DEMO_RELAXED_GATES_CONTEXT is still exercised via
    // ict-agent.md since loadPromptWithDemoContext appends the shared block
    // regardless of which trade-gating prompt is loaded.
    const wrapped = loadPromptWithDemoContext('ict-agent.md');
    expect(wrapped).toContain('R:R minimum');
    expect(wrapped).toContain('1.5:1');
    expect(wrapped).toContain('Tier 3 bracket');
    // Tier 3 band moved 50-64 → 45-59 on 2026-04-22 when Tier 3 threshold
    // dropped to 45 in commit ce339a8.
    expect(wrapped).toContain('45-59');
    expect(wrapped).toContain('0.5% risk');
    expect(wrapped).toContain('Kill-zone score bonus');
  });

  it('demo block explicitly preserves the three hard-guards', () => {
    process.env.DEMO_RELAXED_GATES = 'true';
    const wrapped = loadPromptWithDemoContext('ict-agent.md');
    // Kill-switch values synced to 6% daily / 10% weekly on 2026-04-22 —
    // matches the runtime gate (pct <= -6) that trading-agent.ts enforces.
    expect(wrapped).toContain('Daily 6% loss kill switch');
    expect(wrapped).toContain('Weekly 10% loss kill switch');
    expect(wrapped).toContain('Split-position method');
    expect(wrapped).toContain('Live-trading opt-in gate');
  });

  it('demo block names the tight-spread tickers so the agent knows the R:R 1.5:1 symbols', () => {
    process.env.DEMO_RELAXED_GATES = 'true';
    const wrapped = loadPromptWithDemoContext('analyst-agent.md');
    // Indices (US100 / US500 / US30 / DE40) removed from the tight-spread
    // list on 2026-04-22 — they're TWELVE_DATA_UNAVAILABLE and shouldn't be
    // advertised as valid demo-R:R candidates. FX, gold, and single-name
    // US stocks remain.
    expect(wrapped).toContain('EURUSD');
    expect(wrapped).toContain('GOLD');
    expect(wrapped).toContain('AAPL');
    expect(wrapped).not.toContain('US100');
    expect(wrapped).not.toContain('US500');
    expect(wrapped).not.toContain('DE40');
  });
});

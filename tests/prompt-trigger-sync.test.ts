// tests/prompt-trigger-sync.test.ts
//
// Hygiene: the LLM is given BOTH prompts/ict-agent.md (system) and
// memory/strategy.md (user-message context). They MUST agree on every
// numeric trigger threshold or the LLM gets contradictory rules.
// History: PR 1 (2026-05-12) updated ict-agent.md but forgot strategy.md;
// the drift was identified during 2026-05-13 displacement-continuation
// brainstorm and fixed in the same PR (commits 32c09f9 + 4f04e41).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..');

function extractThresholds(text: string): Record<string, number[]> {
  const numbers: Record<string, number[]> = {};
  const lines = text.split('\n');
  for (const line of lines) {
    // body >= X x range
    // Handles all observed phrasings in both files, including markdown bold (**):
    //   ict-agent.md: "body >= 0.3xrange"  "body >= 0.4 x range"  "body >= 0.6 x range"
    //   strategy.md:  "body >= **0.4 x candle range**"  "body >= 0.3 x candle range"
    const bodyRange = line.match(/body\s*[>=≥]+\s*\*{0,2}\s*([\d.]+)\s*[×x*]\s*(?:candle\s+)?range/i);
    if (bodyRange) {
      numbers.body_range = numbers.body_range || [];
      numbers.body_range.push(Number(bodyRange[1]));
    }
    // opposing wick >= Y x body
    const wickBody = line.match(/(?:opposing\s+)?wick\s*[>=≥]+\s*\*{0,2}\s*([\d.]+)\s*[×x*]\s*body/i);
    if (wickBody) {
      numbers.wick_body = numbers.wick_body || [];
      numbers.wick_body.push(Number(wickBody[1]));
    }
    // body >= Z x ATR-of-bodies (Displacement Continuation trigger)
    // Handles: "body >= 1.0 x ATR-of-bodies(14)"  "body >= **1.0 x ATR-of-bodies(14)**"
    const bodyAtr = line.match(/body\s*[>=≥]+\s*\*{0,2}\s*([\d.]+)\s*[×x*]\s*ATR-?of-?bodies/i);
    if (bodyAtr) {
      numbers.body_atr = numbers.body_atr || [];
      numbers.body_atr.push(Number(bodyAtr[1]));
    }
  }
  return numbers;
}

describe('prompt trigger spec sync (strategy.md vs ict-agent.md)', () => {
  const ictPath = join(REPO_ROOT, 'prompts/ict-agent.md');
  const strategyPath = join(REPO_ROOT, 'memory/strategy.md');

  it('body x range thresholds match between strategy.md and ict-agent.md', () => {
    const ict = extractThresholds(readFileSync(ictPath, 'utf-8'));
    const strat = extractThresholds(readFileSync(strategyPath, 'utf-8'));
    // Use Set to ignore duplicates across triggers using same threshold value
    expect(new Set(ict.body_range)).toEqual(new Set(strat.body_range));
  });

  it('wick x body thresholds match between strategy.md and ict-agent.md', () => {
    const ict = extractThresholds(readFileSync(ictPath, 'utf-8'));
    const strat = extractThresholds(readFileSync(strategyPath, 'utf-8'));
    expect(new Set(ict.wick_body)).toEqual(new Set(strat.wick_body));
  });

  it('body x ATR-of-bodies thresholds match (Displacement Continuation)', () => {
    const ict = extractThresholds(readFileSync(ictPath, 'utf-8'));
    const strat = extractThresholds(readFileSync(strategyPath, 'utf-8'));
    expect(new Set(ict.body_atr || [])).toEqual(new Set(strat.body_atr || []));
  });
});

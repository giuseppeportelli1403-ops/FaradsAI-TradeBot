// Unit tests for scripts/dump-reject-metrics.ts — pure-function tests only.
// Real log lines captured from pm2-out.log on 2026-04-21 → 2026-04-23 drive
// every classification fixture below. If the LLM's phrasing drifts and one
// of these starts missing its category, a test fails and we learn about it.

import { describe, it, expect } from 'vitest';
import {
  classifyLine,
} from '../scripts/dump-reject-metrics.js';

describe('classifyLine — skip categories (priority-ordered, first match wins)', () => {
  it('classifies analyst_reject (priority 1) from Analyst output', () => {
    expect(classifyLine('Analyst Decision: REJECT — TIMING. Do not enter 15 minutes ahead...')).toBe('analyst_reject');
    expect(classifyLine('GBPUSD REJECTED — Score 15/100. Bias contradiction.')).toBe('analyst_reject');
  });

  it('classifies news_opposing (priority 2)', () => {
    expect(classifyLine('Expected PMI contraction = potential bearish catalyst. NEWS RISK OVERRIDE.')).toBe('news_opposing');
    expect(classifyLine('opposing news detected for EURUSD; skip entirely per Step 3E')).toBe('news_opposing');
    expect(classifyLine('the opposing PMI risk is a disqualifier. GBPUSD: SKIP')).toBe('news_opposing');
  });

  it('classifies no_trigger (priority 3)', () => {
    expect(classifyLine('NO ENTRY TRIGGER CONFIRMED ON 15M — GOLD')).toBe('no_trigger');
    expect(classifyLine('No trigger. WATCHING. Moving on.')).toBe('no_trigger');
    expect(classifyLine('NO VALID ENTRY LOCATION ON USDJPY — PREMIUM TERRITORY, NO TRIGGER')).toBe('no_trigger');
  });

  it('classifies rr_fail (priority 4)', () => {
    expect(classifyLine('R:R to TP2 = 0.50:1 — minimum is 1.5:1 (non-negotiable)')).toBe('rr_fail');
    expect(classifyLine('R:R to TP1 0.35:1 ❌ — fails Tier 2 gate')).toBe('rr_fail');
  });

  it('classifies bias_unclear (priority 5)', () => {
    expect(classifyLine('1H Bias NEUTRAL → SKIPPED')).toBe('bias_unclear');
    expect(classifyLine('1H Bias CONFLICTED → SKIPPED')).toBe('bias_unclear');
    expect(classifyLine('bias unclear — too much noise in recent swings')).toBe('bias_unclear');
  });

  it('classifies score_too_low (priority 6) — unambiguous fixtures only', () => {
    // Note: real log lines sometimes contain both "No trigger" AND
    // "Below Tier 3 threshold", which correctly classify as the higher-
    // priority `no_trigger`. This test uses fixtures that only match
    // score_too_low to verify the pattern works in isolation.
    expect(classifyLine('Score 47 — Below even Tier 3 threshold (50). SKIP GBPUSD.')).toBe('score_too_low');
    expect(classifyLine('Below Tier 3 threshold (50)')).toBe('score_too_low');
  });

  it('classifies outside_kill_zone (priority 7 — lowest)', () => {
    expect(classifyLine('[Scheduler] Candle close at 2026-04-23T10:00:00.415Z — skipping ICT cycle (outside kill zone: outside)')).toBe('outside_kill_zone');
  });

  it('priority order: a line that matches news_opposing AND bias_unclear classifies as news_opposing', () => {
    const bothMatch = 'opposing news detected AND 1H Bias NEUTRAL → SKIPPED';
    expect(classifyLine(bothMatch)).toBe('news_opposing');
  });
});

describe('classifyLine — execute categories', () => {
  it('classifies place_order_executed', () => {
    expect(classifyLine('[ICT Agent] Calling tool: place_order')).toBe('place_order_executed');
  });

  it('classifies log_trade_attempted', () => {
    expect(classifyLine('[ICT Agent] Calling tool: log_trade')).toBe('log_trade_attempted');
  });

  it('classifies log_trade_failed', () => {
    expect(classifyLine('[ICT Agent] Tool log_trade failed: insertTrade: required field(s) missing')).toBe('log_trade_failed');
    expect(classifyLine('[ICT Agent] Tool log_trade failed: CHECK constraint failed: status IN...')).toBe('log_trade_failed');
  });

  it('classifies ict_cycle_complete', () => {
    expect(classifyLine('ICT Trading Agent decision cycle complete.')).toBe('ict_cycle_complete');
    expect(classifyLine('[Scheduler] ICT Trading Agent complete.')).toBe('ict_cycle_complete');
  });
});

describe('classifyLine — no match', () => {
  it('returns null for lines that match nothing', () => {
    expect(classifyLine('some random log line')).toBeNull();
    expect(classifyLine('')).toBeNull();
    expect(classifyLine('[Fetcher] AAPL candles loaded from cache')).toBeNull();
  });
});

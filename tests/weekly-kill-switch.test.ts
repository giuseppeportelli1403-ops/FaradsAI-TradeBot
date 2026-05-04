// Tests for the weekly 10% kill switch added 2026-05-04 (Phase A3, doc-vs-code
// audit Finding #6).
//
// Pre-fix, strategy.md Section 7.2 said "Weekly loss limit: 10% of account
// equity. Non-negotiable. When triggered: No new positions opened
// (code-enforced in executeTool paths)" — but no caller invoked getWeeklyPnl
// anywhere in the trading path. A 10% weekly drawdown would not stop the bot.
// Daily 6% catches the worst day, but four bad days in a week could clear
// 10% with the bot still trading.
//
// Strategy doc convention: weekly resets Sunday 00:00 UTC (matches the
// weekly-review cron at `0 0 * * 0`). So the "current week" runs from
// the most recent Sunday 00:00 UTC to next Sunday 00:00 UTC.

import { describe, it, expect } from 'vitest';
import { validateWeeklyKillSwitch, computeWeekStartUTC } from '../src/agents/trading-agent.js';

describe('computeWeekStartUTC', () => {
  it('returns the Sunday date when called on a Sunday', () => {
    // 2026-05-03 is a Sunday. Week-start = same day.
    const now = new Date('2026-05-03T15:30:00Z');
    expect(computeWeekStartUTC(now)).toBe('2026-05-03');
  });

  it('returns last Sunday when called on a Monday', () => {
    // 2026-05-04 is a Monday. Week-start = 2026-05-03 (Sunday).
    const now = new Date('2026-05-04T08:00:00Z');
    expect(computeWeekStartUTC(now)).toBe('2026-05-03');
  });

  it('returns last Sunday when called on a Saturday', () => {
    // 2026-05-09 is a Saturday. Week-start = 2026-05-03 (Sunday, 6 days ago).
    const now = new Date('2026-05-09T23:59:00Z');
    expect(computeWeekStartUTC(now)).toBe('2026-05-03');
  });

  it('respects month boundaries', () => {
    // 2026-05-01 is a Friday. Week-start = 2026-04-26 (Sunday).
    const now = new Date('2026-05-01T12:00:00Z');
    expect(computeWeekStartUTC(now)).toBe('2026-04-26');
  });

  it('respects year boundaries', () => {
    // 2027-01-02 is a Saturday. Week-start = 2026-12-27 (Sunday).
    const now = new Date('2027-01-02T12:00:00Z');
    expect(computeWeekStartUTC(now)).toBe('2026-12-27');
  });

  it('uses UTC even when local time is a different day', () => {
    // 2026-05-04T03:00:00Z is Mon UTC but Sun in some timezones —
    // we must always use UTC. Week-start = 2026-05-03 (Sunday UTC).
    const now = new Date('2026-05-04T03:00:00Z');
    expect(computeWeekStartUTC(now)).toBe('2026-05-03');
  });
});

describe('validateWeeklyKillSwitch', () => {
  it('returns ok when weekly P&L is positive (no loss)', () => {
    const result = validateWeeklyKillSwitch({ weeklyPnl: 50, equity: 1000 });
    expect(result.ok).toBe(true);
  });

  it('returns ok when weekly P&L is flat', () => {
    const result = validateWeeklyKillSwitch({ weeklyPnl: 0, equity: 1000 });
    expect(result.ok).toBe(true);
  });

  it('returns ok when weekly loss is below threshold (8% loss on $1000)', () => {
    const result = validateWeeklyKillSwitch({ weeklyPnl: -80, equity: 1000 });
    expect(result.ok).toBe(true);
  });

  it('returns ok at exactly -9.99% (just under threshold)', () => {
    const result = validateWeeklyKillSwitch({ weeklyPnl: -99.9, equity: 1000 });
    expect(result.ok).toBe(true);
  });

  it('blocks at exactly -10% (threshold)', () => {
    const result = validateWeeklyKillSwitch({ weeklyPnl: -100, equity: 1000 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('WEEKLY_KILL_SWITCH_ACTIVE');
      expect(result.reason).toMatch(/-10/);
    }
  });

  it('blocks beyond threshold (-12% loss)', () => {
    const result = validateWeeklyKillSwitch({ weeklyPnl: -120, equity: 1000 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('WEEKLY_KILL_SWITCH_ACTIVE');
      expect(result.currentPct).toBeCloseTo(-12, 1);
      expect(result.thresholdPct).toBe(-10);
    }
  });

  it('returns ok when equity is 0 (no division by zero crash)', () => {
    // Edge case: account at $0 equity. Cannot compute pct meaningfully.
    // Fail-OPEN here because a $0 account can't take any position anyway —
    // downstream size validation will reject. We don't want a divide-by-zero
    // error masquerading as a kill-switch trigger.
    const result = validateWeeklyKillSwitch({ weeklyPnl: -5, equity: 0 });
    expect(result.ok).toBe(true);
  });

  it('handles small accounts correctly (-$10 on $50 = -20%)', () => {
    const result = validateWeeklyKillSwitch({ weeklyPnl: -10, equity: 50 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.currentPct).toBeCloseTo(-20, 1);
    }
  });
});

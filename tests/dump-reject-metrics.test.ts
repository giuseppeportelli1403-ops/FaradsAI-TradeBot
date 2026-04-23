// Unit tests for scripts/dump-reject-metrics.ts — pure-function tests only.
// Real log lines captured from pm2-out.log on 2026-04-21 → 2026-04-23 drive
// every classification fixture below. If the LLM's phrasing drifts and one
// of these starts missing its category, a test fails and we learn about it.

import { describe, it, expect } from 'vitest';
import {
  classifyLine,
  extractInstrument,
  extractKillZone,
  UNIVERSE,
  aggregateLog,
  renderMarkdown,
  type MetricsReport,
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

describe('extractInstrument', () => {
  it('finds a universe ticker in the window', () => {
    const window = [
      'some context line',
      'Now processing GBPUSD for setup scoring',
      'another line',
    ];
    expect(extractInstrument(window)).toBe('GBPUSD');
  });

  it('finds the FIRST universe ticker when multiple appear', () => {
    const window = [
      'comparing EURUSD vs GBPUSD',
      'other',
    ];
    expect(extractInstrument(window)).toBe('EURUSD');
  });

  it('returns _unknown when no universe ticker in window', () => {
    const window = [
      'some unrelated context',
      'AAPL is not in the ICT universe',
      'other',
    ];
    expect(extractInstrument(window)).toBe('_unknown');
  });

  it('handles case-sensitive match (tickers are uppercase in logs)', () => {
    expect(extractInstrument(['processing eurusd lowercase'])).toBe('_unknown');
    expect(extractInstrument(['processing EURUSD uppercase'])).toBe('EURUSD');
  });

  it('UNIVERSE has exactly 7 tickers', () => {
    expect(UNIVERSE).toEqual(['GOLD', 'SILVER', 'OIL_CRUDE', 'EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD']);
  });
});

describe('extractKillZone', () => {
  // Real-format fixtures captured from live pm2-out.log on 2026-04-22/23.

  it('finds London Open from "Kill Zone: LONDON OPEN ACTIVE" format', () => {
    expect(extractKillZone(['Kill Zone: LONDON OPEN ACTIVE ✅ (07:00–10:00 UTC)'])).toBe('London Open');
  });

  it('finds London Open even with emoji between marker and name', () => {
    expect(extractKillZone(['**Kill Zone: 🟢 LONDON OPEN ACTIVE (07:00–10:00 UTC)**'])).toBe('London Open');
  });

  it('finds London Open in camelcase + "ACTIVE" appearing AFTER the zone name', () => {
    expect(extractKillZone(['**Kill Zone: London Open (07:00–10:00 UTC) ✅ ACTIVE**'])).toBe('London Open');
  });

  it('finds NY Open', () => {
    expect(extractKillZone(['Kill Zone: NY OPEN ACTIVE (13:00–16:00 UTC)'])).toBe('NY Open');
  });

  it('finds London Close (and does NOT mis-classify as London Open)', () => {
    expect(extractKillZone(['Kill Zone: LONDON CLOSE ACTIVE (15:00–17:00 UTC)'])).toBe('London Close');
  });

  it('returns outside when marker says INACTIVE', () => {
    expect(extractKillZone(['Kill Zone: INACTIVE (21:00 UTC — all sessions closed)'])).toBe('outside');
  });

  it('returns outside when no kill zone marker appears at all', () => {
    expect(extractKillZone(['random lines', 'no marker'])).toBe('outside');
  });

  it('returns outside when scheduler emits the "outside kill zone: outside" marker', () => {
    expect(extractKillZone(['[Scheduler] Candle close at ... — skipping ICT cycle (outside kill zone: outside)'])).toBe('outside');
  });

  it('ignores "Next kill zone: London Open" (forward-looking, not current)', () => {
    // A line talking about a FUTURE kill zone must not be mistaken for the
    // current one. Should fall through to the outside default.
    expect(extractKillZone(['Next kill zone: London Open at 07:00 UTC (5h away)'])).toBe('outside');
  });

  it('newest-first walk: most recent marker wins even if older marker conflicts', () => {
    // Window with an earlier "London Open" and a more recent "NY Open" active.
    const window = [
      'Kill Zone: LONDON OPEN ACTIVE',  // older
      'some intermediate line',
      'Kill Zone: NY OPEN ACTIVE',      // newer — should win
      'cycle complete',
    ];
    expect(extractKillZone(window)).toBe('NY Open');
  });

  it('matches KZ_ABBREV record format (e.g., NY_Open in JSON strings)', () => {
    // Some trade-record-style lines have "kill_zone":"NY_Open" — these also
    // include "kill zone" via the underscore variant in our regex. Treat
    // these as current kill-zone markers too.
    expect(extractKillZone(['"kill_zone":"NY_Open", ACTIVE'])).toBe('NY Open');
  });
});

describe('aggregateLog', () => {
  it('filters to the target UTC date and counts events', () => {
    const logLines = [
      '2026-04-22 23:59:00 +00:00: [Scheduler] kill zone: NY Open',
      '2026-04-22 23:59:00 +00:00: ICT Trading Agent decision cycle complete.',
      '2026-04-23 07:00:00 +00:00: Kill Zone: LONDON OPEN ACTIVE ✅ (07:00–10:00 UTC)',
      '2026-04-23 07:00:00 +00:00: Processing GBPUSD for setup',
      '2026-04-23 07:00:01 +00:00: NO ENTRY TRIGGER CONFIRMED ON 15M — GOLD',
      '2026-04-23 07:00:02 +00:00: ICT Trading Agent decision cycle complete.',
      '2026-04-23 08:00:00 +00:00: [ICT Agent] Calling tool: place_order',
      '2026-04-23 23:59:59 +00:00: ICT Trading Agent decision cycle complete.',
      '2026-04-24 00:00:01 +00:00: ICT Trading Agent decision cycle complete.', // next day
    ];
    const report = aggregateLog(logLines, '2026-04-23');

    expect(report.date).toBe('2026-04-23');
    expect(report.totalCycles).toBe(2); // 2 complete markers on 2026-04-23 (07:00:02 + 23:59:59)
    expect(report.placeOrderCount).toBe(1);
    expect(report.skipsByCategory.no_trigger).toBe(1);
    expect(report.skipsByCategory.analyst_reject).toBe(0);
    expect(report.skipsByCategory.news_opposing).toBe(0);
  });

  it('attributes skips to instrument via 10-line window', () => {
    const logLines = [
      '2026-04-23 07:00:00 +00:00: Kill Zone: LONDON OPEN ACTIVE ✅ (07:00–10:00 UTC)',
      '2026-04-23 07:00:00 +00:00: Processing GBPUSD for setup',
      '2026-04-23 07:00:01 +00:00: NO ENTRY TRIGGER CONFIRMED ON 15M — GBPUSD',
      '2026-04-23 07:00:02 +00:00: ICT Trading Agent decision cycle complete.',
    ];
    const report = aggregateLog(logLines, '2026-04-23');

    expect(report.skipsByInstrumentAndCategory.GBPUSD?.no_trigger).toBe(1);
  });

  it('attributes cycles to kill zones from the window', () => {
    const logLines = [
      '2026-04-23 07:00:00 +00:00: Kill Zone: LONDON OPEN ACTIVE ✅ (07:00–10:00 UTC)',
      '2026-04-23 07:00:01 +00:00: ICT Trading Agent decision cycle complete.',
      '2026-04-23 13:00:00 +00:00: Kill Zone: NY OPEN ACTIVE (13:00–16:00 UTC)',
      '2026-04-23 13:00:01 +00:00: ICT Trading Agent decision cycle complete.',
      '2026-04-23 20:00:00 +00:00: skipping ICT cycle (outside kill zone: outside)',
      '2026-04-23 20:00:01 +00:00: ICT Trading Agent decision cycle complete.',
    ];
    const report = aggregateLog(logLines, '2026-04-23');

    expect(report.cyclesByKillZone['London Open'].cycles).toBe(1);
    expect(report.cyclesByKillZone['NY Open'].cycles).toBe(1);
    expect(report.cyclesByKillZone['outside'].cycles).toBe(1);
  });

  it('counts log_trade success vs failure separately', () => {
    const logLines = [
      '2026-04-23 14:00:00 +00:00: [ICT Agent] Calling tool: log_trade',
      '2026-04-23 14:00:01 +00:00: [ICT Agent] Tool log_trade failed: insertTrade: required fields missing',
      '2026-04-23 14:00:02 +00:00: [ICT Agent] Calling tool: log_trade',
      '2026-04-23 14:00:03 +00:00: ICT Trading Agent decision cycle complete.',
    ];
    const report = aggregateLog(logLines, '2026-04-23');

    // log_trade_attempted is 2 (both calls), log_trade_failed is 1 (one explicitly failed).
    expect(report.logTradeAttempted).toBe(2);
    expect(report.logTradeFailed).toBe(1);
    expect(report.logTradeSucceeded).toBe(1); // 2 attempted - 1 failed = 1 presumed succeeded
  });

  it('captures executed-trade detail (capped at 20)', () => {
    const logLines: string[] = [
      '2026-04-23 07:00:00 +00:00: Kill Zone: LONDON OPEN ACTIVE ✅ (07:00–10:00 UTC)',
      '2026-04-23 07:00:00 +00:00: Processing USDJPY',
      '2026-04-23 07:00:01 +00:00: [ICT Agent] Calling tool: place_order',
    ];
    const report = aggregateLog(logLines, '2026-04-23');

    expect(report.executedTrades).toHaveLength(1);
    expect(report.executedTrades[0].timestamp).toBe('2026-04-23 07:00:01');
    expect(report.executedTrades[0].instrument).toBe('USDJPY');
  });
});

describe('renderMarkdown', () => {
  it('produces a well-formed markdown file from a MetricsReport', () => {
    const report: MetricsReport = {
      date: '2026-04-23',
      totalCycles: 664,
      placeOrderCount: 5,
      logTradeAttempted: 3,
      logTradeFailed: 3,
      logTradeSucceeded: 0,
      skipsByCategory: {
        outside_kill_zone: 181,
        bias_unclear: 52,
        no_trigger: 47,
        rr_fail: 8,
        news_opposing: 3,
        score_too_low: 2,
        analyst_reject: 1,
      },
      skipsByInstrumentAndCategory: {},
      cyclesByKillZone: {
        'London Open': { cycles: 120, executed: 2, skipped: 118 },
        'NY Open':     { cycles: 90,  executed: 3, skipped: 87  },
        'London Close':{ cycles: 40,  executed: 0, skipped: 40  },
        'outside':     { cycles: 414, executed: 0, skipped: 414 },
      },
      executedTrades: [],
    };
    const md = renderMarkdown(report, '2026-04-24T00:05:00Z');

    expect(md).toContain('# Farad Reject Metrics — 2026-04-23 (UTC)');
    expect(md).toContain('Generated: 2026-04-24T00:05:00Z');
    expect(md).toContain('**664**'); // total cycles
    expect(md).toContain('**5**');   // place_order count
    expect(md).toContain('Execute rate: 0.75%'); // 5/664 = 0.75%
    expect(md).toContain('outside_kill_zone');
    expect(md).toContain('181');
    expect(md).toContain('London Open');
  });

  it('handles zero cycles gracefully (no divide-by-zero)', () => {
    const report: MetricsReport = {
      date: '2026-04-23',
      totalCycles: 0,
      placeOrderCount: 0,
      logTradeAttempted: 0,
      logTradeFailed: 0,
      logTradeSucceeded: 0,
      skipsByCategory: {
        outside_kill_zone: 0, bias_unclear: 0, no_trigger: 0, rr_fail: 0,
        news_opposing: 0, score_too_low: 0, analyst_reject: 0,
      },
      skipsByInstrumentAndCategory: {},
      cyclesByKillZone: {
        'London Open': { cycles: 0, executed: 0, skipped: 0 },
        'NY Open':     { cycles: 0, executed: 0, skipped: 0 },
        'London Close':{ cycles: 0, executed: 0, skipped: 0 },
        'outside':     { cycles: 0, executed: 0, skipped: 0 },
      },
      executedTrades: [],
    };
    const md = renderMarkdown(report, '2026-04-24T00:05:00Z');
    expect(md).toContain('Execute rate: n/a'); // no cycles → n/a rather than NaN
  });
});

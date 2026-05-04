// Tests for the economic-calendar veto helper.
//
// Production motivation: pre-2026-04-28, the ICT trading agent had no
// awareness of high-impact macro events (FOMC, NFP, CPI, ECB, BoE) at the
// moment of decision. fetchEconomicCalendar was implemented in market-data.ts
// but never exposed via MCP_TOOLS, and there was no code-level pre-trade veto.
// Bot would happily place orders 5 minutes before NFP.
//
// This module provides:
//   - instrumentToCurrencies — maps a Farad ticker to relevant ISO currency codes
//   - shouldVetoOrderForCalendar — returns {veto:true, reason, event} when a
//     high-impact event for the trade's currencies falls inside the veto window
import { describe, it, expect } from 'vitest';
import {
  instrumentToCurrencies,
  shouldVetoOrderForCalendar,
  vetoWindowForEvent,
} from '../src/news/calendar-veto.js';
import type { EconomicEvent } from '../src/types.js';

function event(overrides: Partial<EconomicEvent>): EconomicEvent {
  return {
    date: '2026-04-28',
    time: '12:30:00',
    event: 'Test event',
    country: 'US',
    impact: 'high',
    actual: null,
    estimate: null,
    previous: null,
    affected_instruments: [],
    ...overrides,
  };
}

describe('instrumentToCurrencies', () => {
  it('splits FX majors into the two component currencies', () => {
    expect(instrumentToCurrencies('EURUSD')).toEqual(['EUR', 'USD']);
    expect(instrumentToCurrencies('GBPUSD')).toEqual(['GBP', 'USD']);
    expect(instrumentToCurrencies('USDJPY')).toEqual(['USD', 'JPY']);
    expect(instrumentToCurrencies('AUDUSD')).toEqual(['AUD', 'USD']);
  });

  it('maps USD-denominated commodities to USD-only', () => {
    expect(instrumentToCurrencies('GOLD')).toEqual(['USD']);
    expect(instrumentToCurrencies('SILVER')).toEqual(['USD']);
    expect(instrumentToCurrencies('OIL_CRUDE')).toEqual(['USD']);
  });

  it('handles cross-broker commodity aliases', () => {
    expect(instrumentToCurrencies('XAUUSD')).toEqual(['USD']);
    expect(instrumentToCurrencies('XAGUSD')).toEqual(['USD']);
    expect(instrumentToCurrencies('WTIUSD')).toEqual(['USD']);
    expect(instrumentToCurrencies('USOIL')).toEqual(['USD']);
  });

  it('returns empty for unknown tickers', () => {
    expect(instrumentToCurrencies('UNKNOWN_TICKER')).toEqual([]);
  });

  it('is case-insensitive', () => {
    expect(instrumentToCurrencies('eurusd')).toEqual(['EUR', 'USD']);
    expect(instrumentToCurrencies('gold')).toEqual(['USD']);
  });
});

describe('shouldVetoOrderForCalendar', () => {
  // Anchor "now" to a deterministic moment for stable assertions.
  const nowMs = Date.parse('2026-04-28T12:00:00Z');

  it('vetoes high-impact USD event 15 min ahead on EURUSD trade', () => {
    const events = [event({ date: '2026-04-28', time: '12:15:00', country: 'US', event: 'NFP', impact: 'high' })];
    const result = shouldVetoOrderForCalendar(['EUR', 'USD'], events, nowMs);
    expect(result.veto).toBe(true);
    if (result.veto) {
      expect(result.reason).toMatch(/NFP/);
      expect(result.reason).toMatch(/USD/);
    }
  });

  it('vetoes high-impact event that just fired (within 5 min past)', () => {
    const events = [event({ date: '2026-04-28', time: '11:58:00', country: 'US', event: 'CPI', impact: 'high' })];
    const result = shouldVetoOrderForCalendar(['USD'], events, nowMs);
    expect(result.veto).toBe(true);
  });

  it('does NOT veto medium-impact events', () => {
    const events = [event({ date: '2026-04-28', time: '12:15:00', country: 'US', impact: 'medium' })];
    const result = shouldVetoOrderForCalendar(['USD'], events, nowMs);
    expect(result.veto).toBe(false);
  });

  it('does NOT veto low-impact events', () => {
    const events = [event({ date: '2026-04-28', time: '12:15:00', country: 'US', impact: 'low' })];
    const result = shouldVetoOrderForCalendar(['USD'], events, nowMs);
    expect(result.veto).toBe(false);
  });

  it('does NOT veto events on irrelevant currencies (JP event on EURUSD)', () => {
    const events = [event({ date: '2026-04-28', time: '12:15:00', country: 'JP', event: 'BoJ' })];
    const result = shouldVetoOrderForCalendar(['EUR', 'USD'], events, nowMs);
    expect(result.veto).toBe(false);
  });

  it('does NOT veto events outside the default 5-min pre-event window', () => {
    // Phase A4 (2026-05-04, audit Finding #1): default veto window is now
    // -5 (pre) / +30 (post) min, matching strategy.md Section 7.6 and
    // ict-agent.md:140. Pre-fix the code did the opposite (-30/+5).
    // This test: event 60 min ahead, generic high-impact → no veto since
    // 60 > preMs (5).
    const events = [event({ date: '2026-04-28', time: '13:00:00', country: 'US' })]; // 60 min ahead
    const result = shouldVetoOrderForCalendar(['USD'], events, nowMs);
    expect(result.veto).toBe(false);
  });

  it('DOES veto events within the default 15-min post-event window', () => {
    // Phase E (2026-05-04): post-event window narrowed 30 → 15 min for
    // generic high-impact events. An event that fired 10 min ago is still
    // within the 15-min post-window and must veto.
    const events = [event({ date: '2026-04-28', time: '11:50:00', country: 'US' })]; // 10 min ago
    const result = shouldVetoOrderForCalendar(['USD'], events, nowMs);
    expect(result.veto).toBe(true);
  });

  it('does NOT veto events that fired more than 15 min ago (default post-window)', () => {
    // Phase E: 20 min ago is outside the new 15-min postMs window.
    const events = [event({ date: '2026-04-28', time: '11:40:00', country: 'US' })]; // 20 min ago
    const result = shouldVetoOrderForCalendar(['USD'], events, nowMs);
    expect(result.veto).toBe(false);
  });

  it('vetoes commodity trades on high-impact USD events', () => {
    const events = [event({ date: '2026-04-28', time: '12:15:00', country: 'US', event: 'FOMC' })];
    const result = shouldVetoOrderForCalendar(['USD'], events, nowMs);
    expect(result.veto).toBe(true);
  });

  it('matches eurozone country codes (DE, FR, etc) to EUR currency', () => {
    const events = [event({ date: '2026-04-28', time: '12:15:00', country: 'DE', event: 'German GDP' })];
    const result = shouldVetoOrderForCalendar(['EUR', 'USD'], events, nowMs);
    expect(result.veto).toBe(true);
  });

  it('matches GB and UK country codes to GBP currency', () => {
    const evGB = [event({ date: '2026-04-28', time: '12:15:00', country: 'GB', event: 'BoE rate' })];
    const evUK = [event({ date: '2026-04-28', time: '12:15:00', country: 'UK', event: 'BoE rate' })];
    expect(shouldVetoOrderForCalendar(['GBP'], evGB, nowMs).veto).toBe(true);
    expect(shouldVetoOrderForCalendar(['GBP'], evUK, nowMs).veto).toBe(true);
  });

  it('handles missing time field by treating event as midnight UTC', () => {
    const events = [event({ date: '2026-04-29', time: '', country: 'US', impact: 'high' })];
    // 2026-04-29 00:00 UTC is 12 hours after our nowMs (2026-04-28 12:00) — outside window
    const result = shouldVetoOrderForCalendar(['USD'], events, nowMs);
    expect(result.veto).toBe(false);
  });

  it('returns no-veto when events list is empty', () => {
    const result = shouldVetoOrderForCalendar(['USD'], [], nowMs);
    expect(result.veto).toBe(false);
  });

  it('returns no-veto when trade has no relevant currencies', () => {
    const events = [event({ date: '2026-04-28', time: '12:15:00', country: 'US', impact: 'high' })];
    const result = shouldVetoOrderForCalendar([], events, nowMs);
    expect(result.veto).toBe(false);
  });

  it('respects custom veto-window override', () => {
    const events = [event({ date: '2026-04-28', time: '12:45:00', country: 'US', impact: 'high' })]; // 45 min ahead
    expect(shouldVetoOrderForCalendar(['USD'], events, nowMs).veto).toBe(false); // default 30
    expect(shouldVetoOrderForCalendar(['USD'], events, nowMs, 60 * 60_000).veto).toBe(true); // custom 60
  });
});

describe('vetoWindowForEvent — per-event window widening (CR-1)', () => {
  // Codex review CR-1: the default −5/+30 window is right for a generic
  // medium-impact macro event, but FOMC / NFP / CPI / rate decisions are
  // larger market-movers. Widen the window to −30/+60 for those events so
  // the bot doesn't open positions 50 min before NFP.

  it('returns the wider window (60 pre / 30 post) for FOMC events', () => {
    const result = vetoWindowForEvent({ event: 'FOMC Rate Decision' } as EconomicEvent);
    expect(result.preMs).toBe(60 * 60_000);
    expect(result.postMs).toBe(30 * 60_000);
  });

  it('returns the wider window for NFP / non-farm payrolls', () => {
    expect(vetoWindowForEvent({ event: 'NFP release' } as EconomicEvent).preMs).toBe(60 * 60_000);
    expect(vetoWindowForEvent({ event: 'Non-farm payrolls' } as EconomicEvent).preMs).toBe(60 * 60_000);
    expect(vetoWindowForEvent({ event: 'Nonfarm payrolls report' } as EconomicEvent).preMs).toBe(60 * 60_000);
  });

  it('returns the wider window for CPI / inflation events', () => {
    expect(vetoWindowForEvent({ event: 'CPI release' } as EconomicEvent).preMs).toBe(60 * 60_000);
    expect(vetoWindowForEvent({ event: 'Core CPI MoM' } as EconomicEvent).preMs).toBe(60 * 60_000);
  });

  it('returns the wider window for ECB / BoE / BoJ rate decisions', () => {
    expect(vetoWindowForEvent({ event: 'ECB Rate Decision' } as EconomicEvent).preMs).toBe(60 * 60_000);
    expect(vetoWindowForEvent({ event: 'BoE Bank Rate' } as EconomicEvent).preMs).toBe(60 * 60_000);
    expect(vetoWindowForEvent({ event: 'BoJ Policy Statement' } as EconomicEvent).preMs).toBe(60 * 60_000);
    expect(vetoWindowForEvent({ event: 'Federal Reserve rate decision' } as EconomicEvent).preMs).toBe(60 * 60_000);
  });

  it('returns the default window (5 pre / 15 post) for generic events', () => {
    // Phase E (2026-05-04, strategy loosening): post-event window narrowed
    // from 30 → 15 min for non-Tier-1 events. Tier-1 still uses 60/30.
    // Phase A4 (2026-05-04 same day) also fixed the preMs/postMs convention
    // — pre-Phase-A4 the code did 30/5 (opposite of doc).
    const result = vetoWindowForEvent({ event: 'German Manufacturing PMI' } as EconomicEvent);
    expect(result.preMs).toBe(5 * 60_000);
    expect(result.postMs).toBe(15 * 60_000);
  });

  it('returns the default window for unknown / empty event names', () => {
    expect(vetoWindowForEvent({ event: '' } as EconomicEvent).preMs).toBe(5 * 60_000);
    expect(vetoWindowForEvent({} as EconomicEvent).preMs).toBe(5 * 60_000);
    expect(vetoWindowForEvent({ event: '' } as EconomicEvent).postMs).toBe(15 * 60_000);
  });

  it('is case-insensitive on event title matching', () => {
    expect(vetoWindowForEvent({ event: 'fomc minutes' } as EconomicEvent).preMs).toBe(60 * 60_000);
    expect(vetoWindowForEvent({ event: 'NFP RELEASE' } as EconomicEvent).preMs).toBe(60 * 60_000);
  });

  // CR-5 (2026-04-28): close gaps Codex flagged on second-pass review.
  describe('CR-5: additional Tier-1 events get widened window', () => {
    it.each([
      'Core PCE Price Index',
      'PCE Price Index',
      'Average Hourly Earnings',
      'Unemployment Rate',
      'Retail Sales',
      'ISM Manufacturing PMI',
      'ISM Services PMI',
      'ECB Press Conference',
    ])('matches "%s" with the widened window', (eventName) => {
      const result = vetoWindowForEvent({ event: eventName } as EconomicEvent);
      expect(result.preMs).toBe(60 * 60_000);
      expect(result.postMs).toBe(30 * 60_000);
    });
  });
});

describe('shouldVetoOrderForCalendar — per-event window integration (CR-1)', () => {
  const nowMs = Date.parse('2026-04-28T12:00:00Z');

  it('vetoes FOMC event 50 min ahead (within widened 60-min pre-window)', () => {
    const events = [
      {
        date: '2026-04-28', time: '12:50:00',
        event: 'FOMC Rate Decision', country: 'US', impact: 'high' as const,
        actual: null, estimate: null, previous: null, affected_instruments: [],
      },
    ];
    const result = shouldVetoOrderForCalendar(['USD'], events, nowMs);
    expect(result.veto).toBe(true);
  });

  it('does NOT veto a generic high-impact event 50 min ahead (outside default 30-min)', () => {
    const events = [
      {
        date: '2026-04-28', time: '12:50:00',
        event: 'German Industrial Orders', country: 'DE', impact: 'high' as const,
        actual: null, estimate: null, previous: null, affected_instruments: [],
      },
    ];
    const result = shouldVetoOrderForCalendar(['EUR'], events, nowMs);
    expect(result.veto).toBe(false);
  });

  it('vetoes NFP event 25 min after now (within widened 30-min post-window)', () => {
    const events = [
      {
        date: '2026-04-28', time: '11:35:00',
        event: 'Non-farm payrolls', country: 'US', impact: 'high' as const,
        actual: null, estimate: null, previous: null, affected_instruments: [],
      },
    ];
    const result = shouldVetoOrderForCalendar(['USD'], events, nowMs);
    expect(result.veto).toBe(true);
  });

  it('does NOT veto a generic high-impact event 20 min after now (outside default 15-min post)', () => {
    // Phase E (2026-05-04): default post-event window narrowed 30 → 15 min.
    // An event 20 min ago is outside the 15-min veto tail and trading resumes.
    const events = [
      {
        date: '2026-04-28', time: '11:40:00',
        event: 'German Industrial Orders', country: 'DE', impact: 'high' as const,
        actual: null, estimate: null, previous: null, affected_instruments: [],
      },
    ];
    const result = shouldVetoOrderForCalendar(['EUR'], events, nowMs);
    expect(result.veto).toBe(false);
  });

  describe('NO_VETO_PATTERNS — regional Fed/ECB/BoE speakers (Phase E)', () => {
    it('does NOT veto Fed regional president speeches', () => {
      const names = ['Williams', 'Bullard', 'Daly', 'Kashkari', 'Bostic', 'Mester', 'Goolsbee', 'Logan'];
      for (const name of names) {
        const events = [
          {
            date: '2026-04-28', time: '12:15:00',
            event: `Fed ${name} Speaks`, country: 'US', impact: 'high' as const,
            actual: null, estimate: null, previous: null, affected_instruments: [],
          },
        ];
        const result = shouldVetoOrderForCalendar(['EUR', 'USD'], events, nowMs);
        expect(result.veto).toBe(false);
      }
    });

    it('does NOT veto ECB non-Lagarde speakers', () => {
      const names = ['Lane', 'Schnabel', 'de Guindos', 'Knot', 'Villeroy'];
      for (const name of names) {
        const events = [
          {
            date: '2026-04-28', time: '12:15:00',
            event: `ECB ${name} Speech`, country: 'EU', impact: 'high' as const,
            actual: null, estimate: null, previous: null, affected_instruments: [],
          },
        ];
        const result = shouldVetoOrderForCalendar(['EUR'], events, nowMs);
        expect(result.veto).toBe(false);
      }
    });

    it('STILL vetoes Powell (Fed Chair) — matches EXTRA_WIDE_PATTERNS', () => {
      const events = [
        {
          date: '2026-04-28', time: '12:15:00',
          event: 'Fed Chair Powell Speaks', country: 'US', impact: 'high' as const,
          actual: null, estimate: null, previous: null, affected_instruments: [],
        },
      ];
      const result = shouldVetoOrderForCalendar(['EUR', 'USD'], events, nowMs);
      // Powell matches "Fed chair" in EXTRA_WIDE_PATTERNS so the wide veto applies.
      expect(result.veto).toBe(true);
    });

    it('STILL vetoes generic FOMC press conference (Tier-1 path overrides NO_VETO check)', () => {
      const events = [
        {
          date: '2026-04-28', time: '12:15:00',
          event: 'FOMC Press Conference', country: 'US', impact: 'high' as const,
          actual: null, estimate: null, previous: null, affected_instruments: [],
        },
      ];
      const result = shouldVetoOrderForCalendar(['USD'], events, nowMs);
      expect(result.veto).toBe(true);
    });
  });
});

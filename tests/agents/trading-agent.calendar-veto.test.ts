// Regression test: FF-only calendar veto path fires correctly after Finnhub removal.
//
// Why this test exists: Codex twin review during planning (spec/news-pruning)
// flagged that Task 3's test only verifies `fetchEconomicCalendar` is removed —
// it doesn't prove the live veto path still fires. Since shouldVetoOrderForCalendar
// is the hard pre-LLM gate, this test exercises the post-removal code path
// with a known FOMC event 30 minutes ahead of "now".
//
// The mock proves the code path now flows through FF (not Finnhub):
// `fetchEconomicCalendar` is gone and cannot be called.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  instrumentToCurrencies,
  shouldVetoOrderForCalendar,
} from '../../src/news/calendar-veto.js';
import type { EconomicEvent } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Mock fetchForexFactoryCalendar so the test is deterministic and offline.
// The mock target is the FF module that trading-agent.ts imports directly.
// ---------------------------------------------------------------------------
vi.mock('../../src/news/forex-factory-calendar.js', () => ({
  fetchForexFactoryCalendar: vi.fn(),
  // Preserve other named exports that may be imported elsewhere in the suite.
  parseForexFactoryXml: vi.fn(),
  fetchForexFactoryWeek: vi.fn(),
  _resetForexFactoryCache: vi.fn(),
}));

// Pull the mock reference AFTER vi.mock hoisting.
import { fetchForexFactoryCalendar } from '../../src/news/forex-factory-calendar.js';

// ---------------------------------------------------------------------------
// Fixture helpers — same shape as tests/calendar-veto.test.ts
// ---------------------------------------------------------------------------
function makeEvent(overrides: Partial<EconomicEvent>): EconomicEvent {
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

// "now" anchored to a deterministic moment: 2026-05-13T14:00:00Z
const NOW_MS = Date.parse('2026-05-13T14:00:00Z');

// FOMC Statement 30 minutes from NOW_MS: 2026-05-13T14:30:00Z
const FOMC_EVENT: EconomicEvent = makeEvent({
  date: '2026-05-13',
  time: '14:30:00',
  event: 'FOMC Statement',
  country: 'US',
  impact: 'high',
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('trading-agent calendar-veto regression — FF-only path (post-Finnhub-removal)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('vetoes EURUSD trade when FF returns an FOMC event 30 min ahead', async () => {
    // Arrange: mock FF to return the FOMC event.
    vi.mocked(fetchForexFactoryCalendar).mockResolvedValue([FOMC_EVENT]);

    // Act: exercise the FF path end-to-end — fetch via the (mocked) helper,
    // then run the veto. Proves the post-removal code path actually goes
    // through fetchForexFactoryCalendar (a regression that removed the FF
    // call would fail toHaveBeenCalledOnce). Derive currencies the same
    // way trading-agent.ts does at src/agents/trading-agent.ts:1499.
    const tradeCurrencies = instrumentToCurrencies('EURUSD');
    const events = await fetchForexFactoryCalendar();
    const result = shouldVetoOrderForCalendar(tradeCurrencies, events, NOW_MS);

    // Assert: FF was actually invoked, veto fires, reason mentions FOMC + USD.
    expect(fetchForexFactoryCalendar).toHaveBeenCalledOnce();
    expect(result.veto).toBe(true);
    if (result.veto) {
      expect(result.reason).toMatch(/FOMC/i);
      expect(result.reason).toMatch(/USD/i);
    }
  });

  it('does NOT veto when FF returns an empty calendar (no events in window)', async () => {
    vi.mocked(fetchForexFactoryCalendar).mockResolvedValue([]);

    const tradeCurrencies = instrumentToCurrencies('EURUSD');
    const events = await fetchForexFactoryCalendar();
    const result = shouldVetoOrderForCalendar(tradeCurrencies, events, NOW_MS);

    expect(fetchForexFactoryCalendar).toHaveBeenCalledOnce();
    expect(result.veto).toBe(false);
  });

  it('vetoes XAUUSD (gold) trade on high-impact USD event 30 min ahead', () => {
    // Gold is a USD-denominated instrument — it must respect USD macro events.
    const tradeCurrencies = instrumentToCurrencies('XAUUSD');
    const result = shouldVetoOrderForCalendar(tradeCurrencies, [FOMC_EVENT], NOW_MS);

    expect(result.veto).toBe(true);
  });

  it('does NOT veto when FOMC is far outside the pre-event window (2h ahead)', () => {
    // FOMC wide window is 60-min pre. An event 120 min away must not veto.
    const farEvent = makeEvent({
      date: '2026-05-13',
      time: '16:00:00', // 120 min from NOW_MS
      event: 'FOMC Rate Decision',
      country: 'US',
      impact: 'high',
    });

    const tradeCurrencies = instrumentToCurrencies('EURUSD');
    const result = shouldVetoOrderForCalendar(tradeCurrencies, [farEvent], NOW_MS);

    expect(result.veto).toBe(false);
  });
});

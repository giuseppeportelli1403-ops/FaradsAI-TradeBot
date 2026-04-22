// Tests for INSTRUMENT_UNIVERSE shape guarantees.
// These lock down the Blocker 2 invariant: every entry must carry a valid
// `epic` field usable against the Capital.com REST API.

import { describe, it, expect } from 'vitest';
import { INSTRUMENT_UNIVERSE } from '../src/scanner/index.js';
import { _mapToTwelveDataSymbol } from '../src/mcp-server/market-data.js';

describe('INSTRUMENT_UNIVERSE', () => {
  it('every entry has a non-empty epic string', () => {
    for (const inst of INSTRUMENT_UNIVERSE) {
      expect(typeof inst.epic).toBe('string');
      expect(inst.epic.length).toBeGreaterThan(0);
    }
  });

  it('every epic is unique across the universe', () => {
    const epics = INSTRUMENT_UNIVERSE.map((i) => i.epic);
    const unique = new Set(epics);
    expect(unique.size).toBe(epics.length);
  });

  it('every epic matches ^[A-Z0-9_]+$ (uppercase alphanumeric + underscore)', () => {
    const epicPattern = /^[A-Z0-9_]+$/;
    for (const inst of INSTRUMENT_UNIVERSE) {
      expect(inst.epic).toMatch(epicPattern);
    }
  });

  // Load-bearing invariant. The researcher agent emits instrument *tickers* in
  // its shortlist briefs, and the trading/swing agents forward those strings
  // verbatim into Capital.com tool calls that expect an `epic`. This works
  // today only because every instrument has epic === ticker. The day someone
  // adds an instrument where the two diverge (e.g. display ticker `IBEX35`
  // with Capital epic `SP35`), every trade on that instrument will silently
  // route to the wrong market — or fail in a way that looks like bad strategy,
  // not a bug. If this test fails, you MUST also refactor researcher-agent.ts
  // to emit epics (not tickers) before adding the new instrument.
  it('epic === ticker for every entry (researcher-agent contract)', () => {
    for (const inst of INSTRUMENT_UNIVERSE) {
      expect(inst.epic).toBe(inst.ticker);
    }
  });

  // Load-bearing invariant added post-2026-04-22 audit. Every ticker the
  // scanner scores MUST resolve to a non-null Twelve Data symbol; otherwise
  // fetchCandles returns [] for that ticker on every cycle, the scanner
  // silently drops it, and the agent never sees it in ranked results — but
  // the LLM may still try to trade it if the TIGHT_SPREAD_TICKERS list (in
  // load-prompt.ts) advertises it. Catching drift here at build time is
  // cheaper than finding out at runtime via a place_order call on an
  // instrument we have no market data for.
  it('every ticker resolves to a non-null Twelve Data symbol (no UNAVAILABLE entries in universe)', () => {
    for (const inst of INSTRUMENT_UNIVERSE) {
      const mapped = _mapToTwelveDataSymbol(inst.ticker);
      expect(
        mapped,
        `INSTRUMENT_UNIVERSE lists "${inst.ticker}" as tradeable, but it's in TWELVE_DATA_UNAVAILABLE. Either remove from the universe or add a real TD routing.`,
      ).not.toBeNull();
    }
  });
});

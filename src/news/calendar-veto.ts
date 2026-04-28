// Economic-calendar veto helper.
//
// Pre-2026-04-28, the ICT trading agent had zero awareness of high-impact
// macro events at decision time. fetchEconomicCalendar in market-data.ts was
// implemented but never exposed via MCP_TOOLS, and there was no code-level
// pre-trade veto. This module supplies both pieces: a pure helper that the
// place_order executor calls before submitting any order to Capital.com.
//
// Defense-in-depth pattern: the agent ALSO sees the calendar via the
// `get_economic_calendar` MCP tool (added in trading-agent.ts), but the code
// veto is the load-bearing layer — prompt-only rules can be ignored by the
// LLM under pressure.
import type { EconomicEvent } from '../types.js';

/**
 * Map of ISO currency code → list of country codes that the calendar feed
 * tags as that currency's home jurisdiction. Eurozone is intentionally broad
 * (the major eurozone members publish their own GDP/CPI prints that move
 * EUR); GB/UK both appear in different feeds and we accept either.
 */
const CURRENCY_COUNTRIES: Record<string, ReadonlyArray<string>> = {
  USD: ['US'],
  EUR: ['EU', 'EZ', 'DE', 'FR', 'IT', 'ES', 'NL', 'BE', 'AT', 'PT', 'IE', 'FI', 'GR'],
  GBP: ['GB', 'UK'],
  JPY: ['JP'],
  AUD: ['AU'],
  NZD: ['NZ'],
  CAD: ['CA'],
  CHF: ['CH'],
};

const COMMODITY_TICKERS: ReadonlyArray<string> = [
  'GOLD', 'SILVER', 'OIL_CRUDE', 'XAUUSD', 'XAGUSD', 'WTIUSD', 'USOIL',
];

const DEFAULT_VETO_WINDOW_MS = 30 * 60_000;
// Allow a 5-minute "shock" tail past the print where we still veto — the
// market often moves violently for several minutes after high-impact data,
// and an order placed 2 min after NFP is just as exposed as one placed
// 2 min before.
const POST_EVENT_SHOCK_MS = 5 * 60_000;

// Per-event window widening (CR-1, 2026-04-28). FOMC / NFP / CPI / major
// rate decisions move markets violently for far longer than a generic
// medium-impact print.
//
// Window semantics: preMs = how far BEFORE the event we start vetoing
// new orders; postMs = how far AFTER the event we keep vetoing. So
// preMs=60min / postMs=30min means "block new orders from 60 min before
// the print to 30 min after". The wider preMs lets the bot stay out of
// the lead-up; the smaller postMs lets it re-engage once the post-print
// shock has settled. Originally these constants were described in the
// commit message as "−30/+60" which is the OPPOSITE direction — the
// implementation has always been 60-pre / 30-post per the CR-9 cleanup.
const EXTRA_WIDE_PRE_MS = 60 * 60_000;
const EXTRA_WIDE_POST_MS = 30 * 60_000;
const EXTRA_WIDE_PATTERNS: ReadonlyArray<RegExp> = [
  // Central-bank rate decisions — biggest scheduled movers
  /\bFOMC\b/i,
  /\bFederal Reserve\b/i,
  /\bFed (rate|funds|decision|chair|meeting|minutes)\b/i,
  /\bECB\b/i,
  /\bEuropean Central Bank\b/i,
  /\bBoE\b/i,
  /\bBank of England\b/i,
  /\bBoJ\b/i,
  /\bBank of Japan\b/i,
  /\bRBA\b/i,
  /\bReserve Bank of Australia\b/i,
  /\bRBNZ\b/i,
  /\bReserve Bank of New Zealand\b/i,
  /\bBoC\b/i,
  /\bBank of Canada\b/i,
  /\bSNB\b/i,
  /\bSwiss National Bank\b/i,
  /\b(rate|cash rate|policy) (decision|statement|meeting)\b/i,
  /\bmonetary policy (decision|statement|meeting|report)\b/i,
  // Top-tier macro prints
  /\bNFP\b/i,
  /\bnon[- ]?farm payrolls?\b/i,
  /\bnonfarm payrolls?\b/i,
  /\bpayrolls report\b/i,
  /\bjobs report\b/i,
  /\bCPI\b/i,
  /\bcore CPI\b/i,
  /\binflation (data|report|print|reading|figure)\b/i,
  /\bGDP\b/i,
  /\bgross domestic product\b/i,
  // CR-5 (2026-04-28): additional Tier-1 events Codex flagged as missing.
  // Core PCE is the Fed's preferred inflation gauge — biggest USD/gold mover
  // outside FOMC + NFP itself. Average Hourly Earnings prints with NFP and
  // moves the wage-inflation narrative. Unemployment Rate prints same day.
  // Retail Sales is consensus-Tier-1 USD. ISM PMIs are top-3 leading
  // indicators. ECB press conference is the post-decision Q&A — bigger
  // mover than the announcement itself most months.
  /\b(core )?PCE( price index)?\b/i,
  /\baverage hourly earnings\b/i,
  /\bunemployment rate\b/i,
  /\bretail sales\b/i,
  /\bISM (manufacturing|services|composite|non[- ]?manufacturing)?( ?PMI)?\b/i,
  /\b(ECB|BoE|BoJ|RBA|RBNZ|BoC|SNB|Fed) press conference\b/i,
];

/**
 * Returns the (preMs, postMs) veto window for a given economic event.
 *
 * Default for generic high-impact events: −5 min / +30 min (kept narrow so
 * the bot isn't blocked from trading the whole morning every time a low-tier
 * regional event prints).
 *
 * Wider window for Tier-1 movers (FOMC, NFP, CPI, central-bank rate
 * decisions, GDP): −30 min / +60 min.
 */
export function vetoWindowForEvent(ev: EconomicEvent): { preMs: number; postMs: number } {
  const eventName = ev?.event ?? '';
  if (!eventName) return { preMs: DEFAULT_VETO_WINDOW_MS, postMs: POST_EVENT_SHOCK_MS };
  for (const pattern of EXTRA_WIDE_PATTERNS) {
    if (pattern.test(eventName)) {
      return { preMs: EXTRA_WIDE_PRE_MS, postMs: EXTRA_WIDE_POST_MS };
    }
  }
  return { preMs: DEFAULT_VETO_WINDOW_MS, postMs: POST_EVENT_SHOCK_MS };
}

/**
 * Maps a Farad ticker to the list of ISO currency codes whose macro events
 * could materially move it. FX pairs split into the two component currencies;
 * USD-denominated commodities (gold, silver, oil) are USD-only. Returns []
 * for unknown tickers — callers should treat empty as "no veto possible"
 * (i.e. fail-open for unrecognised universe additions).
 */
export function instrumentToCurrencies(ticker: string): string[] {
  const upper = ticker.toUpperCase();

  if (COMMODITY_TICKERS.includes(upper)) {
    return ['USD'];
  }

  if (/^[A-Z]{3}[A-Z]{3}$/.test(upper)) {
    return [upper.slice(0, 3), upper.slice(3, 6)];
  }

  return [];
}

function eventTimestampMs(ev: EconomicEvent): number | null {
  if (!ev.date) return null;
  const rawTime = (ev.time && ev.time.length > 0) ? ev.time : '00:00:00';
  // Some calendar feeds emit HH:MM, others HH:MM:SS — normalise.
  const time = rawTime.length === 5 ? `${rawTime}:00` : rawTime;
  const ms = Date.parse(`${ev.date}T${time}Z`);
  return Number.isFinite(ms) ? ms : null;
}

function eventCurrencies(ev: EconomicEvent): string[] {
  const country = (ev.country ?? '').toUpperCase();
  if (!country) return [];
  const matches: string[] = [];
  for (const [currency, countries] of Object.entries(CURRENCY_COUNTRIES)) {
    if (countries.includes(country)) matches.push(currency);
  }
  return matches;
}

export type VetoResult =
  | { veto: false }
  | { veto: true; reason: string; event: EconomicEvent };

/**
 * Return veto:true when any high-impact event in `events` for any currency in
 * `tradeCurrencies` falls inside the per-event window. The window is
 * derived from `vetoWindowForEvent(ev)` per-event — see CR-1 widening for
 * Tier-1 events (FOMC/NFP/CPI/rate decisions). Pure function — callers
 * supply now and events.
 *
 * @param vetoWindowMs Optional pre-event window override. When supplied,
 *   overrides the per-event lookup for the pre-event side; the post-event
 *   window remains per-event-derived. Used by callers who want a stricter
 *   blanket rule (e.g. tests, or operator-temporary tightening).
 */
export function shouldVetoOrderForCalendar(
  tradeCurrencies: string[],
  events: EconomicEvent[],
  nowMs: number,
  vetoWindowMs?: number,
): VetoResult {
  if (tradeCurrencies.length === 0) return { veto: false };

  for (const ev of events) {
    if (ev.impact !== 'high') continue;

    const evCcys = eventCurrencies(ev);
    if (!evCcys.some((c) => tradeCurrencies.includes(c))) continue;

    const ts = eventTimestampMs(ev);
    if (ts === null) continue;

    const window = vetoWindowForEvent(ev);
    const preMs = vetoWindowMs !== undefined ? vetoWindowMs : window.preMs;
    const postMs = window.postMs;

    const delta = ts - nowMs;
    if (delta >= -postMs && delta <= preMs) {
      const minutes = Math.round(delta / 60_000);
      const direction = minutes >= 0 ? `${minutes} min from now` : `${-minutes} min ago`;
      return {
        veto: true,
        reason: `High-impact ${evCcys.join('/')} event "${ev.event}" at ${ev.date} ${ev.time || '00:00'} (${direction})`,
        event: ev,
      };
    }
  }

  return { veto: false };
}

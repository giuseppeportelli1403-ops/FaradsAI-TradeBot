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

// Veto windows for high-impact events.
//
// Phase A4 (2026-05-04, audit Finding #1): preMs/postMs convention aligned
// with strategy.md Section 7.6 and ict-agent.md:140 which both specified
// "-5/+30 min" for generic high-impact events. Pre-fix the code did the
// opposite (30 before / 5 after).
//
// Phase E (2026-05-04, strategy loosening): post-event window narrowed
// from 30 min → 15 min for generic high-impact events. Rationale:
// post-event shock typically dies down in 10-15 minutes; 30-min veto was
// over-cautious for non-Tier-1 events. 5/15 default = 20-min total veto
// window for generic high-impact, vs 90-min total (60/30) for Tier-1.
//
// Tier-1 events (FOMC/NFP/CPI/etc) keep the wider 60/30 via
// EXTRA_WIDE_PRE_MS / EXTRA_WIDE_POST_MS below.
const PRE_EVENT_DEFAULT_MS = 5 * 60_000;     // 5 min before generic high-impact
const POST_EVENT_DEFAULT_MS = 15 * 60_000;   // 15 min after (was 30; narrowed Phase E 2026-05-04)

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

// NO_VETO_PATTERNS — events that should NOT trigger any veto regardless of
// impact tag. Added 2026-05-04 (Phase E) because regional Fed presidents
// speak constantly and rarely move USD the way FOMC press conferences or
// NFP do. The current calendar feed sometimes tags these as 'high' impact
// (per the upstream classifier), which previously caused the bot to skip
// otherwise valid setups for 15-30 minutes around each speech. Powell
// (Fed Chair), Lagarde (ECB President), Bailey (BoE Governor), and Ueda
// (BoJ Governor) are EXPLICITLY excluded from this bypass — they match
// EXTRA_WIDE_PATTERNS via the FOMC / Fed chair / press conference patterns
// above and continue to receive the wide veto.
const NO_VETO_PATTERNS: ReadonlyArray<RegExp> = [
  // Regional Fed presidents (non-Chair voting and non-voting members).
  // Names enumerated explicitly so a future "Powell speaks" feed entry
  // doesn't accidentally bypass via a generic "Fed speaker" match.
  /\bFed (Williams|Bullard|Daly|Kashkari|Bostic|Mester|Goolsbee|Logan|Harker|Barkin|Cook|Jefferson|Schmid|Musalem)\b/i,
  // ECB governing council non-President speakers (Lagarde stays vetoed).
  /\bECB (Lane|Schnabel|de Guindos|Cipollone|Knot|Villeroy|Visco|Holzmann|Kazaks|Vasle|Vujcic|Wunsch)\b/i,
  // BoE MPC non-Governor speakers (Bailey stays vetoed).
  /\bBoE (Pill|Mann|Ramsden|Dhingra|Greene|Lombardelli|Taylor)\b/i,
];

// 2026-05-05 audit (A7): Tier-1 venue phrases that REINSTATE the veto even
// when a regional speaker name otherwise matches NO_VETO_PATTERNS. Pre-fix:
// an event titled "Vice Chair Schmid Press Conference on PCE" would match
// "Schmid" → bypass veto, even though "Press Conference" + "PCE" together
// signal a Tier-1 movements event. Now: if any of these phrases appear in
// the event name, NO_VETO is overridden and the standard veto applies.
const NO_VETO_OVERRIDE_PATTERNS: ReadonlyArray<RegExp> = [
  /\bpress conference\b/i,
  /\bpress briefing\b/i,
  /\bFOMC\b/i,
  /\brate (decision|announcement|statement)\b/i,
  /\bmonetary policy (statement|report|decision)\b/i,
  /\bminutes\b/i,
  /\b(congressional|senate|house) (hearing|testimony)\b/i,
  /\btestimony before\b/i,
  /\bsemi[- ]?annual (testimony|report|monetary policy)\b/i,
];

/**
 * Returns true if the event name matches a NO_VETO bypass pattern AND does
 * NOT contain a Tier-1 venue override phrase. Exported for test coverage.
 */
export function shouldBypassVeto(eventName: string): boolean {
  if (!NO_VETO_PATTERNS.some((p) => p.test(eventName))) return false;
  if (NO_VETO_OVERRIDE_PATTERNS.some((p) => p.test(eventName))) return false;
  return true;
}

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
  if (!eventName) return { preMs: PRE_EVENT_DEFAULT_MS, postMs: POST_EVENT_DEFAULT_MS };
  for (const pattern of EXTRA_WIDE_PATTERNS) {
    if (pattern.test(eventName)) {
      return { preMs: EXTRA_WIDE_PRE_MS, postMs: EXTRA_WIDE_POST_MS };
    }
  }
  return { preMs: PRE_EVENT_DEFAULT_MS, postMs: POST_EVENT_DEFAULT_MS };
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

    // Phase E (2026-05-04): NO_VETO_PATTERNS bypass for regional speakers.
    // These events are sometimes tagged 'high' by the calendar feed but
    // rarely move markets enough to justify a trading freeze. Powell /
    // Lagarde / Bailey / Ueda still match EXTRA_WIDE_PATTERNS above and
    // continue to receive the wide veto.
    const eventName = ev?.event ?? '';
    if (shouldBypassVeto(eventName)) continue;

    const evCcys = eventCurrencies(ev);
    if (!evCcys.some((c) => tradeCurrencies.includes(c))) continue;

    const ts = eventTimestampMs(ev);
    if (ts === null) continue;

    const window = vetoWindowForEvent(ev);
    const preMs = vetoWindowMs !== undefined ? vetoWindowMs : window.preMs;
    const postMs = window.postMs;

    const delta = ts - nowMs;
    // 2026-05-05 audit (5.1): post-edge changed from inclusive >= to exclusive >.
    // "+30 min after" means veto until exactly 30 min after the event; at the
    // 30:00.000 mark the window has expired and trades should be allowed.
    // Pre-edge stays <= (5 min before exactly = still within veto window —
    // the conservative choice when the bot decides at the exact lead time).
    if (delta > -postMs && delta <= preMs) {
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

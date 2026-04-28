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
 * `tradeCurrencies` falls inside the window [now − 5min, now + vetoWindowMs].
 * Otherwise veto:false. Pure function — callers supply now and events.
 */
export function shouldVetoOrderForCalendar(
  tradeCurrencies: string[],
  events: EconomicEvent[],
  nowMs: number,
  vetoWindowMs: number = DEFAULT_VETO_WINDOW_MS,
): VetoResult {
  if (tradeCurrencies.length === 0) return { veto: false };

  for (const ev of events) {
    if (ev.impact !== 'high') continue;

    const evCcys = eventCurrencies(ev);
    if (!evCcys.some((c) => tradeCurrencies.includes(c))) continue;

    const ts = eventTimestampMs(ev);
    if (ts === null) continue;

    const delta = ts - nowMs;
    if (delta >= -POST_EVENT_SHOCK_MS && delta <= vetoWindowMs) {
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

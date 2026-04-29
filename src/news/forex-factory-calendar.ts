// Forex Factory economic-calendar fetcher — B3 (2026-04-28).
//
// Forex Factory is the de-facto industry-standard FX trading calendar. The
// official site doesn't expose a public API, but they ship a free XML feed
// via fairEconomy.media — a longstanding mirror that's been reliable since
// at least 2018. Format: weekly XML with timed events, currency tags, and
// impact ratings (low/medium/high).
//
// Two endpoints (free, no key):
//   - https://nfs.faireconomy.media/ff_calendar_thisweek.xml  (current week)
//   - https://nfs.faireconomy.media/ff_calendar_nextweek.xml  (next week)
//
// We poll thisweek hourly and nextweek daily, parse to the EconomicEvent
// shape used by the existing calendar veto, and merge with Finnhub's feed.
// FF and Finnhub both have known gaps; the union is more accurate than
// either alone.
import axios from 'axios';
import type { EconomicEvent } from '../types.js';

const FF_THIS_WEEK = 'https://nfs.faireconomy.media/ff_calendar_thisweek.xml';
const FF_NEXT_WEEK = 'https://nfs.faireconomy.media/ff_calendar_nextweek.xml';
const DEFAULT_TIMEOUT_MS = 8_000;

interface CachedFeed {
  fetchedAt: number;
  events: EconomicEvent[];
}

// Cache for 1 hour — events don't change minute-to-minute and FF respects
// reasonable polling. Failures fall through to whatever cache we have.
const CACHE_TTL_MS = 60 * 60_000;
const cache = new Map<string, CachedFeed>();

/** Exposed for tests — clear the FF cache. */
export function _resetForexFactoryCache(): void {
  cache.clear();
}

/**
 * Maps Forex Factory currency tags (USD/EUR/GBP/...) to ISO country codes
 * that match our existing CURRENCY_COUNTRIES table in calendar-veto.ts.
 * Single source of truth deliberately duplicated here so this file stays
 * standalone-testable.
 */
const FF_CURRENCY_TO_COUNTRY: Record<string, string> = {
  USD: 'US',
  EUR: 'EU',
  GBP: 'GB',
  JPY: 'JP',
  AUD: 'AU',
  NZD: 'NZ',
  CAD: 'CA',
  CHF: 'CH',
  CNY: 'CN',
};

/** Lightweight XML extraction — Forex Factory's format is consistent enough
 * that a tag-based regex scanner is more robust than a full XML parser
 * (which would add a dependency). Returns one EconomicEvent per <event>
 * block; skips malformed entries silently. */
export function parseForexFactoryXml(xml: string): EconomicEvent[] {
  if (typeof xml !== 'string' || xml.length === 0) return [];

  const events: EconomicEvent[] = [];
  // Match each <event>…</event> block. Non-greedy across newlines.
  const eventBlocks = xml.match(/<event>[\s\S]*?<\/event>/g) ?? [];

  // 2026-04-29 audit-3 r4 fix (market-data audit P0-3): telemetry for
  // silent format-change failure. If FF ever changes its tag name,
  // CDATA wrapping, or block structure, this regex returns []  silently
  // and the FF half of the calendar veto fails open with no signal.
  // Warn-log when we got non-trivial XML but zero blocks — operations
  // can grep for this string and investigate before more cycles run.
  if (eventBlocks.length === 0 && xml.length > 200) {
    console.warn(
      `[Forex Factory] Parsed 0 event blocks from XML of length ${xml.length}. Format change suspected — calendar-veto FF half is failing open. Investigate parser.`,
    );
  }

  for (const block of eventBlocks) {
    const get = (tag: string): string | null => {
      const m = block.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`));
      return m ? m[1].trim() : null;
    };

    const title = get('title');
    const country = get('country');
    const date = get('date'); // M-D-YYYY format in FF, or YYYY-MM-DD on newer feeds
    const time = get('time'); // "8:30am" / "2:00pm" or "All Day"
    const impact = (get('impact') ?? '').toLowerCase();
    const forecast = get('forecast');
    const previous = get('previous');

    if (!title || !country) continue;

    // Normalize impact rating. FF emits "High" / "Medium" / "Low" / "Holiday".
    let normImpact: EconomicEvent['impact'];
    if (impact === 'high') normImpact = 'high';
    else if (impact === 'medium') normImpact = 'medium';
    else normImpact = 'low';

    // Normalize date to YYYY-MM-DD. FF historic format: "MM-DD-YYYY"
    // (e.g. "04-28-2026"). Newer feeds may emit ISO. Handle both.
    let isoDate = '';
    if (date) {
      const isoMatch = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      const usMatch = date.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
      if (isoMatch) {
        isoDate = `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
      } else if (usMatch) {
        const [, mm, dd, yyyy] = usMatch;
        isoDate = `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
      }
    }
    if (!isoDate) continue;

    // Normalize time. FF emits "8:30am" / "2:00pm" / "All Day" / "Tentative".
    // Convert to 24h "HH:mm:ss"; "All Day" → "00:00:00"; "Tentative" → "".
    let isoTime = '';
    if (time && time !== 'All Day' && time !== 'Tentative') {
      const m = time.match(/^(\d{1,2}):(\d{2})(am|pm)$/i);
      if (m) {
        let hour = parseInt(m[1], 10);
        const min = m[2];
        const ampm = m[3].toLowerCase();
        if (ampm === 'pm' && hour < 12) hour += 12;
        if (ampm === 'am' && hour === 12) hour = 0;
        isoTime = `${String(hour).padStart(2, '0')}:${min}:00`;
      }
    } else if (time === 'All Day') {
      isoTime = '00:00:00';
    }

    // FF country tags are 3-char currency codes (USD/EUR/GBP). Map to the
    // 2-char country codes the calendar-veto helper expects.
    const countryCode = FF_CURRENCY_TO_COUNTRY[country.toUpperCase()] ?? country;

    events.push({
      date: isoDate,
      time: isoTime,
      event: title,
      country: countryCode,
      impact: normImpact,
      actual: null,
      estimate: forecast || null,
      previous: previous || null,
      affected_instruments: [],
    });
  }

  return events;
}

/**
 * Fetch + parse one Forex Factory week feed. Returns [] on network error,
 * non-200, or parse failure. Caches per-URL for 1 hour.
 */
export async function fetchForexFactoryWeek(url: string): Promise<EconomicEvent[]> {
  const cached = cache.get(url);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.events;
  }

  let response: { status: number; data: unknown };
  try {
    response = await axios.get(url, {
      timeout: DEFAULT_TIMEOUT_MS,
      headers: { Accept: 'application/xml,text/xml,*/*' },
    });
  } catch {
    return cached?.events ?? [];
  }

  if (response.status !== 200 || typeof response.data !== 'string') {
    return cached?.events ?? [];
  }

  const events = parseForexFactoryXml(response.data);
  cache.set(url, { fetchedAt: Date.now(), events });
  return events;
}

/**
 * Combined "this week + next week" calendar. Used by the calendar veto
 * helper as a richer / FX-calibrated alternative to Finnhub. Returns
 * union; deduped is unnecessary because each event is unique by date+title.
 */
export async function fetchForexFactoryCalendar(): Promise<EconomicEvent[]> {
  const [thisWeek, nextWeek] = await Promise.all([
    fetchForexFactoryWeek(FF_THIS_WEEK),
    fetchForexFactoryWeek(FF_NEXT_WEEK),
  ]);
  return [...thisWeek, ...nextWeek];
}

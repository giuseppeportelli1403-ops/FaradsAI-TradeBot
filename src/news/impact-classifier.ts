// Impact-based Cat A classifier.
//
// Pre-2026-04-28 the news category was assigned purely by sentiment magnitude:
//   absSentiment >= 0.35 → Cat A ("Major catalyst")
//   absSentiment >= 0.15 → Cat B
//   else                 → Cat C
//
// That meant emotionally-loaded puff pieces qualified as Cat A while plain
// FOMC announcements in measured language did not. The composite score adds
// +20 (or −15) for Cat A, so the misclassification flowed straight into trade
// sizing. This module replaces the Cat A criterion with a keyword whitelist
// of genuine high-impact macro events. Cat B/C continue to use sentiment
// magnitude as a fallback for everything not on the whitelist.
//
// Whitelist sourced from the Forex Factory / Investing.com economic calendars'
// "high impact" rows for FX majors + USD-denominated commodities. New entries
// should be added carefully — anything that matches lets through Cat A scoring.

const HIGH_IMPACT_PATTERNS: ReadonlyArray<RegExp> = [
  // ---- Central banks / rate decisions ----
  /\bFOMC\b/i,
  /\bFederal Reserve\b/i,
  /\bFed (rate|funds|decision|chair|hike|cut|hold|minutes|meeting|outlook)\b/i,
  /\bECB\b/i,
  /\bEuropean Central Bank\b/i,
  /\bBoE\b/i,
  /\bBank of England\b/i,
  /\bBoJ\b/i,
  /\bBank of Japan\b/i,
  /\bRBA\b/i,
  /\bReserve Bank of Australia\b/i,
  /\b(interest |cash )?rate (decision|hike|cut|hold|move|meeting)\b/i,
  /\bhawkish\b/i,
  /\bdovish\b/i,

  // ---- Macro prints ----
  /\bNFP\b/i,
  /\bnon[- ]?farm payrolls?\b/i,
  /\bpayrolls (report|data|print)\b/i,
  /\bjobs report\b/i,
  /\bCPI\b/i,
  /\bcore CPI\b/i,
  /\binflation (data|report|print|reading|figure)\b/i,
  /\bPPI\b/i,
  /\bGDP\b/i,
  /\bgross domestic product\b/i,
  /\bPCE\b/i,
  /\bISM (manufacturing|services|PMI|index)\b/i,
  /\bretail sales\b/i,
  /\bunemployment (rate|claims)\b/i,
  /\bjobless claims\b/i,

  // ---- Commodity-specific events ----
  /\bOPEC(\+|-plus)?\b/i,
  /\b(oil|crude) inventor(y|ies)\b/i,
  /\bcrude (oil )?stocks?\b/i,
];

/**
 * Returns true when the article (title + summary) mentions any high-impact
 * macro keyword. Word boundaries (\b) prevent false positives like "SPCE"
 * matching "PCE" or "LGDP" matching "GDP".
 */
export function matchesHighImpactKeyword(
  title: string | undefined | null,
  summary: string | undefined | null,
): boolean {
  const haystack = `${title ?? ''} ${summary ?? ''}`;
  if (haystack.trim().length === 0) return false;

  for (const pattern of HIGH_IMPACT_PATTERNS) {
    if (pattern.test(haystack)) return true;
  }
  return false;
}

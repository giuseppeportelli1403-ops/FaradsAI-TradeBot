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

// Strong patterns — match alone (no context required). These are unambiguous
// macro-event terms that essentially never collide with non-financial usage.
const STRONG_PATTERNS: ReadonlyArray<RegExp> = [
  // Central banks / rate decisions
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
  /\bBoC\b/i,
  /\bBank of Canada\b/i,
  /\bSNB\b/i,
  /\bSwiss National Bank\b/i,
  /\bRBNZ\b/i,
  /\bReserve Bank of New Zealand\b/i,
  /\bmonetary policy (statement|decision|meeting|report|outlook)\b/i,
  /\b(interest |cash )?rate (decision|hike|cut|hold|move|meeting)\b/i,
  /\bhawkish\b/i,
  /\bdovish\b/i,

  // Macro prints
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

  // Commodity-specific
  /\bOPEC(\+|-plus)?\b/i,
  /\b(oil|crude) inventor(y|ies)\b/i,
  /\bcrude (oil )?stocks?\b/i,

  // Trade / sanctions
  /\btariffs?\b/i,
  /\btrade war\b/i,
  /\bsanctions?\b/i,
];

// CR-5 (2026-04-28): banker surnames carry high false-positive risk —
// "Jordan" the country, "Bailey" the common surname, "Orr" the surfer,
// "Powell" the biographer. They only count as Cat A when the article ALSO
// mentions a central-bank context word.
const BANKER_SURNAME_PATTERNS: ReadonlyArray<RegExp> = [
  /\bPowell\b/i,
  /\bLagarde\b/i,
  /\bBailey\b/i,
  /\bUeda\b/i,
  /\bMacklem\b/i,
  /\bJordan\b/i,
  /\bOrr\b/i,
];

// CR-5: NZ Official Cash Rate is also abbreviated OCR (= optical character
// recognition). Require explicit NZ-rate context.
const OCR_PATTERN = /\bOCR\b/i;
const OCR_NZ_CONTEXT: ReadonlyArray<RegExp> = [
  /\bRBNZ\b/i,
  /\bReserve Bank of New Zealand\b/i,
  /\bNew Zealand\b/i,
  /\bcash rate\b/i,
  /\bOfficial Cash Rate\b/i,
];

// CR-9 (2026-04-28): tightened from broad single words ("rate", "policy",
// "chair", "governor", "president") to phrase-bound matches. Bare "rate"
// matched "mortgage rate" / "tax rate" / "exchange rate"; bare "policy"
// matched "tax policy" / "trade policy"; the surname false-positives this
// gate was supposed to prevent could squeak through. Phrase-bound patterns
// require the central-bank-specific noun phrase.
const CB_CONTEXT_PATTERNS: ReadonlyArray<RegExp> = [
  // Central-bank acronyms / institutions
  /\bFed\b/i,
  /\bECB\b/i,
  /\bBoE\b/i,
  /\bBoJ\b/i,
  /\bRBA\b/i,
  /\bRBNZ\b/i,
  /\bBoC\b/i,
  /\bSNB\b/i,
  /\bFOMC\b/i,
  /\bMPC\b/i,
  /\bcentral bank\b/i,
  /\bmonetary\b/i,

  // Phrase-bound rate references (NOT bare "rate" — too noisy)
  /\binterest rates?\b/i,
  /\bpolicy rate\b/i,
  /\bcash rate\b/i,
  /\bbank rate\b/i,
  /\brate (decision|hike|cut|hold|move|meeting|path|outlook)\b/i,

  // Phrase-bound policy references (NOT bare "policy")
  /\bmonetary policy\b/i,
  /\bquantitative (easing|tightening)\b/i,

  // Inflation and direction terms (high-signal)
  /\binflation\b/i,
  /\bhawkish\b/i,
  /\bdovish\b/i,

  // Chair/governor/president — only when preceded by "Fed", "ECB", "BoE",
  // etc — bare "chair" / "governor" alone is too broad ("board chair",
  // "governor of California"). Use word-boundary + central-bank-name
  // proximity. Approximation: just match "Fed Chair" / "ECB President" /
  // "BoE Governor" style phrases; bare title words drop out of the list.
  /\b(Fed|ECB|BoE|BoJ|RBA|RBNZ|BoC|SNB) (chair|governor|president|board)\b/i,
];

function anyMatch(haystack: string, patterns: ReadonlyArray<RegExp>): boolean {
  for (const p of patterns) if (p.test(haystack)) return true;
  return false;
}

/**
 * Returns true when the article (title + summary) qualifies as Cat A.
 *
 * Three classes of match:
 *   1. STRONG_PATTERNS — match alone. Unambiguous macro-event terms.
 *   2. BANKER_SURNAME_PATTERNS — only match when paired with a CB-context
 *      word elsewhere in the haystack (so "Jordan tourism" doesn't trigger
 *      Cat A, but "Jordan: SNB ready to act" does).
 *   3. OCR — only matches when paired with NZ/cash-rate context (so
 *      "OCR engine" stays out of trading decisions).
 *
 * Word boundaries (\b) prevent partial-substring false positives ("SPCE"
 * vs "PCE", "LGDP" vs "GDP", "Powerful" vs "Powell", "Bailout" vs "Bailey").
 */
export function matchesHighImpactKeyword(
  title: string | undefined | null,
  summary: string | undefined | null,
): boolean {
  const haystack = `${title ?? ''} ${summary ?? ''}`;
  if (haystack.trim().length === 0) return false;

  if (anyMatch(haystack, STRONG_PATTERNS)) return true;

  if (anyMatch(haystack, BANKER_SURNAME_PATTERNS) && anyMatch(haystack, CB_CONTEXT_PATTERNS)) {
    return true;
  }

  if (OCR_PATTERN.test(haystack) && anyMatch(haystack, OCR_NZ_CONTEXT)) {
    return true;
  }

  return false;
}

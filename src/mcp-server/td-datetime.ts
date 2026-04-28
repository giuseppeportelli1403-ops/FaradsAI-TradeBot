// Twelve Data datetime parser.
//
// Codex review CR-3 (2026-04-28) flagged that the prior inline parse —
//   Date.parse(String(v.datetime).replace(' ', 'T') + 'Z')
// — would silently produce invalid strings when TD already returned a
// timezone-qualified ISO datetime ("2026-04-28T12:00:00ZZ", "...+02:00Z").
// Date.parse returns NaN for those, the future-candle guard's
// `Number.isFinite(tsMs) && tsMs > futureCutoff` short-circuits, and the
// candle is silently kept — exactly the SILVER 2026-04-24 failure mode the
// guard was meant to prevent.
//
// Strategy: detect whether the string carries its own timezone suffix
// (Z or ±HH:MM / ±HHMM); parse as-is when present, normalise to
// space → T and append Z when not.

const HAS_TZ_SUFFIX = /(Z|[+-]\d{2}:?\d{2})$/;

/**
 * Returns the UTC milliseconds for a Twelve Data candle datetime string,
 * accepting any of:
 *   - 'YYYY-MM-DD HH:mm:ss'          (TD's default; assumed UTC since 2026-04-28
 *                                     when fetchCandles started passing timezone=UTC)
 *   - 'YYYY-MM-DDTHH:mm:ssZ'         (ISO 8601 UTC)
 *   - 'YYYY-MM-DDTHH:mm:ss.sssZ'     (ISO 8601 UTC with milliseconds)
 *   - 'YYYY-MM-DDTHH:mm:ss±HH:MM'    (ISO 8601 with offset)
 *   - 'YYYY-MM-DDTHH:mm:ss±HHMM'     (ISO 8601 compact offset)
 *
 * Returns null on empty / undefined / unparseable input. Callers should
 * treat null as "skip this candle" rather than "now or unknown".
 */
export function parseTwelveDataDatetime(input: string | null | undefined): number | null {
  if (typeof input !== 'string' || input.length === 0) return null;

  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  let toParse: string;
  if (HAS_TZ_SUFFIX.test(trimmed)) {
    // Already has Z or ±HH:MM / ±HHMM — parse as-is.
    toParse = trimmed;
  } else {
    // Bare 'YYYY-MM-DD HH:mm:ss' (or any non-TZ form) — normalise to ISO
    // UTC and append Z.
    toParse = `${trimmed.replace(' ', 'T')}Z`;
  }

  const ms = Date.parse(toParse);
  return Number.isFinite(ms) ? ms : null;
}

// URL canonicalization for news-article dedup.
//
// Codex review CR-4 (2026-04-28) flagged that the dual-source commodity
// dedup keyed on raw article URL, so the same wire story republished
// under http://, with a trailing slash, with utm_* tracking, or with a
// fragment would NOT dedupe. This helper normalises those variations.

const TRACKING_PARAM_PREFIXES = ['utm_'];
const TRACKING_PARAM_NAMES = ['fbclid', 'gclid', 'mc_cid', 'mc_eid', 'igshid', 'msclkid'];

/**
 * Returns a canonical form of `input` suitable for use as a dedup key.
 * Operations:
 *   - lowercase scheme and host
 *   - strip URL fragment (#...)
 *   - strip utm_* and a small set of common analytics tracking params
 *   - strip trailing slash on non-root paths
 *
 * Returns '' for null/undefined and the input verbatim for unparseable URLs.
 * Note: http and https remain distinct after canonicalisation — same article
 * mirrored under both schemes will not dedupe (rare in practice).
 */
export function canonicalizeUrl(input: string | null | undefined): string {
  if (typeof input !== 'string' || input.length === 0) return '';

  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return input;
  }

  u.protocol = u.protocol.toLowerCase();
  u.hostname = u.hostname.toLowerCase();
  u.hash = '';

  const params = u.searchParams;
  const toDelete: string[] = [];
  params.forEach((_, key) => {
    const lower = key.toLowerCase();
    if (TRACKING_PARAM_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
      toDelete.push(key);
      return;
    }
    if (TRACKING_PARAM_NAMES.includes(lower)) {
      toDelete.push(key);
    }
  });
  for (const key of toDelete) params.delete(key);

  // searchParams.toString() preserves insertion order; assigning back keeps
  // url consistent. Empty string clears the '?'.
  u.search = params.toString();

  let canonical = u.toString();

  // Strip trailing slash on non-root paths.
  // u.pathname includes the path; if it's exactly '/', we leave the URL alone
  // (root with trailing slash is canonical). Otherwise drop the trailing /.
  if (u.pathname !== '/' && canonical.endsWith('/')) {
    canonical = canonical.slice(0, -1);
  }

  return canonical;
}

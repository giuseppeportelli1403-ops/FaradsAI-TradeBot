// Jina Reader integration (W4, 2026-04-28).
//
// Vibe-Trading uses https://r.jina.ai/{url} as a free, no-key article-to-
// Markdown service. Hit it with a target URL; receive clean Markdown with
// boilerplate stripped. Used by the impact classifier when MarketAux's
// 163-char snippet isn't enough context to score Cat A correctly.
//
// Free tier characteristics (observed):
//   - No API key required
//   - 1-3s typical latency
//   - Works on most public news pages
//   - Returns 4xx if the target URL itself is unreachable
//
// Caching: 30 min per URL, matching our news-cache TTL. Failed fetches are
// NOT cached — they may be transient and we don't want to lock in a bad
// classification because of one flaky request.
import axios from 'axios';

const JINA_BASE = 'https://r.jina.ai';
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_LENGTH = 8_000;
const CACHE_TTL_MS = 30 * 60_000;

interface CacheEntry {
  fetchedAt: number;
  value: string;
}

const cache = new Map<string, CacheEntry>();

/** Exposed for tests — clear the in-memory body cache. */
export function _resetJinaReaderCache(): void {
  cache.clear();
}

export interface FetchArticleBodyOptions {
  timeoutMs?: number;
  maxLength?: number;
}

/**
 * Fetches the article at `url` through Jina Reader and returns the body as
 * Markdown, truncated to `maxLength` (default 8000) chars. Returns null on
 * timeout, network error, non-200 status, empty body, or invalid URL.
 *
 * Use when the impact classifier wants more context than MarketAux's snippet
 * provides — typically when the snippet is < 200 chars or the headline keyword
 * match wants verification.
 */
export async function fetchArticleBody(
  url: string | null | undefined,
  opts: FetchArticleBodyOptions = {},
): Promise<string | null> {
  if (typeof url !== 'string' || url.length === 0) return null;

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxLength = opts.maxLength ?? DEFAULT_MAX_LENGTH;

  // Cache check
  const cached = cache.get(url);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.value.slice(0, maxLength);
  }

  const jinaUrl = `${JINA_BASE}/${encodeURIComponent(url)}`;

  let response: { status: number; data: unknown };
  try {
    response = await axios.get(jinaUrl, { timeout: timeoutMs });
  } catch {
    return null;
  }

  if (response.status !== 200) return null;

  const body = typeof response.data === 'string' ? response.data : '';
  if (body.length === 0) return null;

  cache.set(url, { fetchedAt: Date.now(), value: body });
  return body.slice(0, maxLength);
}

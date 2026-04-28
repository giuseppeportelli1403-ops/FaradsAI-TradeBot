// Tests for fetchArticleBody — W4 (2026-04-28). Vibe-Trading-inspired
// pattern: when MarketAux returns only a 163-char snippet, hit Jina Reader
// (https://r.jina.ai/{url}) to get the full article body in clean Markdown.
// Free, no API key, ~1-3s per fetch with 30s upper bound.
//
// Why it matters: the impact-keyword classifier sometimes fires on a
// headline that doesn't carry the catalyst in the body, or misses Cat A
// keywords that ARE in the body but not the headline. Body-aware scoring
// is more accurate.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import { fetchArticleBody, _resetJinaReaderCache } from '../src/news/jina-reader.js';

describe('fetchArticleBody', () => {
  beforeEach(() => {
    _resetJinaReaderCache();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    _resetJinaReaderCache();
    vi.restoreAllMocks();
  });

  it('returns the body string on a successful Jina response', async () => {
    vi.spyOn(axios, 'get').mockResolvedValue({
      status: 200,
      data: 'Title: Fed Holds Rates\n\nThe Federal Reserve held rates steady at 5.25%-5.50%...',
    });

    const body = await fetchArticleBody('https://example.com/article');
    expect(body).toContain('Federal Reserve');
    expect(body).toContain('5.25%');
  });

  it('uses Jina Reader as the fetch URL prefix', async () => {
    const getSpy = vi.spyOn(axios, 'get').mockResolvedValue({
      status: 200,
      data: 'body',
    });

    await fetchArticleBody('https://example.com/article');

    expect(getSpy).toHaveBeenCalledTimes(1);
    const calledUrl = getSpy.mock.calls[0][0];
    expect(calledUrl).toMatch(/^https:\/\/r\.jina\.ai\//);
    expect(calledUrl).toContain('https%3A%2F%2Fexample.com%2Farticle');
  });

  it('returns null on network error', async () => {
    vi.spyOn(axios, 'get').mockRejectedValue(new Error('ECONNRESET'));
    const body = await fetchArticleBody('https://example.com/article');
    expect(body).toBeNull();
  });

  it('returns null on non-200 response', async () => {
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 404, data: '' });
    const body = await fetchArticleBody('https://example.com/article');
    expect(body).toBeNull();
  });

  it('returns null on empty response body', async () => {
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: '' });
    const body = await fetchArticleBody('https://example.com/article');
    expect(body).toBeNull();
  });

  it('truncates body to default 8000 chars', async () => {
    const longBody = 'x'.repeat(10_000);
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: longBody });

    const body = await fetchArticleBody('https://example.com/article');
    expect(body).not.toBeNull();
    expect(body!.length).toBe(8000);
  });

  it('respects custom maxLength override', async () => {
    const longBody = 'x'.repeat(5000);
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: longBody });

    const body = await fetchArticleBody('https://example.com/article', { maxLength: 1000 });
    expect(body).not.toBeNull();
    expect(body!.length).toBe(1000);
  });

  it('caches successful fetches by URL — second call hits cache, not axios', async () => {
    const getSpy = vi.spyOn(axios, 'get').mockResolvedValue({
      status: 200,
      data: 'body content',
    });

    await fetchArticleBody('https://example.com/cached');
    await fetchArticleBody('https://example.com/cached');
    await fetchArticleBody('https://example.com/cached');

    expect(getSpy).toHaveBeenCalledTimes(1);
  });

  it('does NOT cache failed fetches (so they can retry)', async () => {
    const getSpy = vi.spyOn(axios, 'get').mockRejectedValue(new Error('flaky'));

    await fetchArticleBody('https://example.com/fail');
    await fetchArticleBody('https://example.com/fail');

    expect(getSpy).toHaveBeenCalledTimes(2);
  });

  it('returns null on empty/null URL', async () => {
    expect(await fetchArticleBody('')).toBeNull();
    expect(await fetchArticleBody(null as unknown as string)).toBeNull();
    expect(await fetchArticleBody(undefined as unknown as string)).toBeNull();
  });

  it('passes a timeout to axios via the second-arg config', async () => {
    const getSpy = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: 'body' });
    await fetchArticleBody('https://example.com/article', { timeoutMs: 3000 });
    const config = getSpy.mock.calls[0][1] as { timeout?: number };
    expect(config?.timeout).toBe(3000);
  });
});

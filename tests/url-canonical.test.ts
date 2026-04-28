// Tests for canonicalizeUrl — CR-5/CR-8 (2026-04-28). Codex re-review CR-4
// flagged that the dual-source dedup keyed on raw `item.url`, so http vs
// https / trailing slash / utm_* / fragments would never dedupe. This
// canonicalizer normalises those variations so the dedup folds correctly.
import { describe, it, expect } from 'vitest';
import { canonicalizeUrl } from '../src/news/url-canonical.js';

describe('canonicalizeUrl', () => {
  it('lowercases scheme and host', () => {
    expect(canonicalizeUrl('HTTPS://Example.com/article')).toBe('https://example.com/article');
  });

  it('strips trailing slash from non-root paths', () => {
    expect(canonicalizeUrl('https://example.com/article/')).toBe('https://example.com/article');
  });

  it('preserves root slash', () => {
    expect(canonicalizeUrl('https://example.com/')).toBe('https://example.com/');
  });

  it('strips URL fragment', () => {
    expect(canonicalizeUrl('https://example.com/article#section-2')).toBe('https://example.com/article');
  });

  it('strips utm_* tracking params', () => {
    expect(
      canonicalizeUrl('https://example.com/article?utm_source=twitter&utm_medium=social&utm_campaign=launch'),
    ).toBe('https://example.com/article');
  });

  it('strips other common tracking params (fbclid, gclid, mc_cid, mc_eid)', () => {
    expect(
      canonicalizeUrl('https://example.com/article?fbclid=abc&gclid=def&mc_cid=ghi&mc_eid=jkl'),
    ).toBe('https://example.com/article');
  });

  it('preserves non-tracking query parameters', () => {
    expect(canonicalizeUrl('https://example.com/search?q=fomc&page=2')).toBe(
      'https://example.com/search?q=fomc&page=2',
    );
  });

  it('mixes preservation of legit params with removal of tracking', () => {
    expect(
      canonicalizeUrl('https://example.com/search?q=fomc&utm_source=tw&page=2&fbclid=x'),
    ).toBe('https://example.com/search?q=fomc&page=2');
  });

  it('treats http and https as different (different schemes)', () => {
    // Codex CR-4 mentioned http vs https as a dedup gap, but they're
    // genuinely different URLs. The canonicalizer normalises CASE only —
    // two URLs that differ only by scheme remain distinct after
    // canonicalisation. (If an upstream is mirroring under both, the
    // article shows up twice; that's a separate problem.)
    expect(canonicalizeUrl('http://example.com/article')).not.toBe(
      canonicalizeUrl('https://example.com/article'),
    );
  });

  it('two equivalent URLs canonicalise to the same string', () => {
    const a = canonicalizeUrl('HTTPS://Example.COM/article/?utm_source=tw#top');
    const b = canonicalizeUrl('https://example.com/article');
    expect(a).toBe(b);
  });

  it('returns the input verbatim on unparseable URL', () => {
    expect(canonicalizeUrl('not a url')).toBe('not a url');
    expect(canonicalizeUrl('')).toBe('');
  });

  it('handles undefined / null gracefully', () => {
    expect(canonicalizeUrl(undefined as unknown as string)).toBe('');
    expect(canonicalizeUrl(null as unknown as string)).toBe('');
  });
});

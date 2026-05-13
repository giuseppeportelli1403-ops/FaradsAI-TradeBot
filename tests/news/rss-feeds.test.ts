import { describe, it, expect } from 'vitest';
import { RSS_FEEDS } from '../../src/news/rss-feeds.js';

describe('RSS_FEEDS after news-pruning', () => {
  const EXPECTED_NAMES = [
    'Federal Reserve press releases',
    'ECB press releases',
    'Bank of England news',
    'ActionForex',
    'ForexLive',
    'Investing.com Forex Opinion',
  ] as const;

  it('exports exactly 6 feeds', () => {
    expect(RSS_FEEDS).toHaveLength(6);
  });

  it('all feeds are tier 1', () => {
    for (const feed of RSS_FEEDS) {
      expect(feed.tier).toBe(1);
    }
  });

  it('contains exactly the 6 expected feed names (order-insensitive)', () => {
    const actual = RSS_FEEDS.map((f) => f.name).sort();
    const expected = [...EXPECTED_NAMES].sort();
    expect(actual).toEqual(expected);
  });

  it('no dropped feeds remain', () => {
    const droppedNames = [
      'BBC Business',
      'CNBC Top News',
      'OilPrice.com',
      'Investing.com news',
      'Yahoo Finance Top Stories',
      'MarketWatch Top Stories',
      'Calculated Risk',
      'Wolf Street',
      'ZeroHedge',
    ];
    const names = RSS_FEEDS.map((f) => f.name);
    for (const dropped of droppedNames) {
      expect(names).not.toContain(dropped);
    }
  });
});

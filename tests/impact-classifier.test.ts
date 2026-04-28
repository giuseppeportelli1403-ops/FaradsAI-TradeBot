// Tests for matchesHighImpactKeyword — the keyword-whitelist Cat A classifier.
//
// Replaces the prior sentiment-magnitude-only behaviour where any article with
// |sentiment_score| >= 0.35 was treated as Cat A (= "Major catalyst — strong
// directional impact (e.g. FOMC, earnings beat/miss)" per the prompt). That
// classifier was firing on emotionally-loaded puff pieces; FOMC announcements
// without strong wording got Cat B or worse. This whitelist forces real
// macro events to Cat A regardless of sentiment intensity.
import { describe, it, expect } from 'vitest';
import { matchesHighImpactKeyword } from '../src/news/impact-classifier.js';

describe('matchesHighImpactKeyword', () => {
  describe('central-bank / rate decisions', () => {
    it.each([
      'FOMC announces 25bp rate cut',
      'Federal Reserve holds rates steady',
      'Fed rate decision due Wednesday',
      'ECB raises rates to 4.5%',
      'European Central Bank in focus',
      'BoE keeps rates at 5.25%',
      'Bank of England minutes hawkish',
      'BoJ surprises markets',
      'Bank of Japan ends YCC',
      'RBA holds cash rate steady',
      'Reserve Bank of Australia decision',
      'Hawkish tone from Powell',
      'Dovish pivot signalled',
      // CR-2 additions
      'BoC holds overnight rate at 4.75%',
      'Bank of Canada delivers 25bp cut',
      'SNB unexpectedly cuts to 1.50%',
      'Swiss National Bank policy meeting',
      'RBNZ on hold',
      'Reserve Bank of New Zealand surprises',
      'OCR held steady at 5.25%',
      'Monetary policy statement released',
      'Monetary policy decision on Wednesday',
      'Monetary policy report unveiled',
    ])('matches "%s" as high-impact', (title) => {
      expect(matchesHighImpactKeyword(title, '')).toBe(true);
    });
  });

  describe('CR-2: named central bankers', () => {
    it.each([
      'Powell: economy resilient',
      'Lagarde signals patience',
      'Bailey: pace of cuts gradual',
      'Ueda hints at policy normalisation',
      'Macklem on Canada outlook',
      'Jordan: SNB ready to act',
      'Orr: NZ inflation persistent',
    ])('matches "%s" as high-impact', (title) => {
      expect(matchesHighImpactKeyword(title, '')).toBe(true);
    });
  });

  describe('CR-2: trade / sanctions / geopolitical events', () => {
    it.each([
      'New tariffs imposed on China imports',
      'Tariff hike announced',
      'Trade war escalates',
      'US imposes sanctions on Russian oil',
      'Sanctions lifted as deal reached',
    ])('matches "%s" as high-impact', (title) => {
      expect(matchesHighImpactKeyword(title, '')).toBe(true);
    });
  });

  describe('macro prints', () => {
    it.each([
      'NFP comes in at 250k',
      'Non-farm payrolls beat expectations',
      'Nonfarm payrolls miss',
      'Payrolls report shows softness',
      'Jobs report disappoints',
      'CPI rises 0.4%',
      'Core CPI hotter than expected',
      'Inflation data due Thursday',
      'PPI prints +0.3%',
      'Q3 GDP revised higher',
      'Gross domestic product slows',
      'PCE inflation steady',
      'ISM manufacturing PMI weakens',
      'ISM services beat',
      'Retail sales jump 0.7%',
      'Unemployment rate drops to 3.8%',
      'Jobless claims fall',
    ])('matches "%s" as high-impact', (title) => {
      expect(matchesHighImpactKeyword(title, '')).toBe(true);
    });
  });

  describe('commodity-specific events', () => {
    it.each([
      'OPEC announces production cut',
      'OPEC+ extends quotas',
      'Crude oil inventories rise',
      'Crude stocks tick lower',
      'Oil inventory build surprises',
    ])('matches "%s" as high-impact', (title) => {
      expect(matchesHighImpactKeyword(title, '')).toBe(true);
    });
  });

  describe('non-impact noise (must NOT match)', () => {
    it.each([
      'Tesla launches new model',
      'Apple beats earnings',
      'Gold rallies on weak dollar',
      'EUR/USD hits weekly high',
      'Analyst upgrades JPM to overweight',
      'Stocks rise as risk-on returns',
      'Crypto market mixed today',
    ])('does NOT match "%s"', (title) => {
      expect(matchesHighImpactKeyword(title, '')).toBe(false);
    });
  });

  it('matches keywords in summary when title is unrelated', () => {
    expect(
      matchesHighImpactKeyword('Markets digest the latest moves', 'In focus today: the FOMC decision at 18:00 GMT'),
    ).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(matchesHighImpactKeyword('fomc minutes released', '')).toBe(true);
    expect(matchesHighImpactKeyword('Bank Of England Vote 7-2', '')).toBe(true);
    expect(matchesHighImpactKeyword('NFP MISS', '')).toBe(true);
  });

  it('returns false for empty or undefined input', () => {
    expect(matchesHighImpactKeyword('', '')).toBe(false);
    expect(matchesHighImpactKeyword(undefined as unknown as string, undefined as unknown as string)).toBe(false);
  });

  it('does not false-positive on common substrings (e.g. "GDP" inside another word)', () => {
    // SGD-pegged is not GDP; LGDP is not GDP — boundary check
    expect(matchesHighImpactKeyword('SGD-pegged moves', '')).toBe(false);
    expect(matchesHighImpactKeyword('LGDP framework adopted', '')).toBe(false);
  });

  it('does not false-positive on "PCE" inside other words', () => {
    expect(matchesHighImpactKeyword('SPCE jumps 5%', '')).toBe(false);
  });

  it('does not false-positive on banker names inside other words', () => {
    // We want exact-token matches, not partial. "Powerful" must not match Powell.
    expect(matchesHighImpactKeyword('Powerful rally in tech', '')).toBe(false);
    // "Bailout" must not match Bailey.
    expect(matchesHighImpactKeyword('Bailout package agreed', '')).toBe(false);
  });
});

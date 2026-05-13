import { describe, it, expect } from 'vitest';
import * as marketData from '../../src/mcp-server/market-data.js';

describe('Calendar source after news-pruning', () => {
  it('does not export fetchEconomicCalendar (Finnhub helper removed)', () => {
    expect('fetchEconomicCalendar' in marketData).toBe(false);
  });
});

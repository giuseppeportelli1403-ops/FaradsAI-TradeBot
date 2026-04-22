// MCP Tools — Market Data (Capital.com candles + external APIs)
// Tools: get_prices, get_news_context, get_economic_calendar, get_correlation_matrix,
//        get_sector_strength, get_vix, get_dxy, get_yield_curve, get_client_sentiment,
//        write_research_brief
// Uses registerTool (modern API) with annotations.
// get_prices prefers Capital.com OHLC candles for tradeable epics; falls back
// to Twelve Data for macro instruments (VIX, DXY, yield curve).

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CapitalClient } from '../capital-client.js';
import { wrapTool } from '../logger.js';
import {
  fetchCandles, fetchVix, fetchDxy, fetchYieldCurve,
  fetchEconomicCalendar, fetchSectorStrength, fetchNewsContext,
  computeCorrelation,
} from '../market-data.js';
import { saveResearchBrief } from '../../database/index.js';
import type { Timeframe, Resolution } from '../../types.js';

const capital = new CapitalClient({
  apiKey: process.env.CAPITAL_API_KEY || '',
  identifier: process.env.CAPITAL_IDENTIFIER || '',
  password: process.env.CAPITAL_API_KEY_PASSWORD || '',
  baseURL: process.env.CAPITAL_API_URL || 'https://demo-api-capital.backend-capital.com',
});

// Instruments Capital.com does not serve — always fall back to Twelve Data.
// Keep this list conservative; anything not listed attempts Capital first.
const MACRO_ONLY = new Set<string>(['VIX', 'DXY', 'US2Y', 'US10Y', 'US30Y']);

function timeframeToResolution(tf: Timeframe): Resolution {
  switch (tf) {
    case '15m': return 'MINUTE_15';
    case '1h': return 'HOUR';
    case '4h': return 'HOUR_4';
    case '1d': return 'DAY';
    case '1w': return 'WEEK';
    default: {
      // Exhaustiveness guard; Timeframe should cover all cases above.
      const _exhaustive: never = tf;
      return 'HOUR' as Resolution;
    }
  }
}

export function registerMarketDataTools(server: McpServer): void {

  server.registerTool(
    'get_prices',
    {
      title: 'Get Price Candles',
      description: 'Fetch OHLCV candle data. Prefers Capital.com for tradeable instruments (by epic) and falls back to Twelve Data for macro symbols (VIX, DXY, yield curve) or anything Capital does not serve. Supports 15m, 1h, 4h, 1d, 1w timeframes.',
      inputSchema: {
        instrument: z.string().describe('Instrument ticker / Capital.com epic (e.g. GOLD, US100, AAPL, EURUSD, VIX)'),
        timeframe: z.enum(['15m', '1h', '4h', '1d', '1w']).describe('Candle timeframe'),
        count: z.number().optional().default(100).describe('Number of candles to fetch (max 5000)'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    wrapTool('get_prices', async ({ instrument, timeframe, count }) => {
      const tf = timeframe as Timeframe;
      const size = count ?? 100;

      // Macro instruments always go to Twelve Data.
      if (MACRO_ONLY.has(instrument.toUpperCase())) {
        const candles = await fetchCandles(instrument, tf, size);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ source: 'twelve_data', candles }),
          }],
        };
      }

      // Try Capital.com first; fall back to Twelve Data on error.
      try {
        const resolution = timeframeToResolution(tf);
        const candles = await capital.getCandles(instrument, resolution, size);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ source: 'capital', candles }),
          }],
        };
      } catch (capitalErr) {
        const candles = await fetchCandles(instrument, tf, size);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              source: 'twelve_data_fallback',
              fallback_reason: capitalErr instanceof Error ? capitalErr.message : 'capital_request_failed',
              candles,
            }),
          }],
        };
      }
    })
  );

  server.registerTool(
    'get_news_context',
    {
      title: 'Get News Context',
      description: 'Get scored news items with sentiment analysis for an instrument from Alpha Vantage. Returns Cat A/B/C categorisation.',
      inputSchema: { instrument: z.string().describe('Instrument ticker') },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    wrapTool('get_news_context', async ({ instrument }) => {
      const news = await fetchNewsContext(instrument);
      return { content: [{ type: 'text' as const, text: JSON.stringify(news) }] };
    })
  );

  server.registerTool(
    'get_economic_calendar',
    {
      title: 'Get Economic Calendar',
      description: 'Get upcoming macro economic events (FOMC, NFP, CPI, central bank decisions) from Finnhub for the next N days.',
      inputSchema: { days_ahead: z.number().optional().default(5).describe('Number of days ahead to check') },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    wrapTool('get_economic_calendar', async ({ days_ahead }) => {
      const events = await fetchEconomicCalendar(days_ahead);
      return { content: [{ type: 'text' as const, text: JSON.stringify(events) }] };
    })
  );

  server.registerTool(
    'get_correlation_matrix',
    {
      title: 'Get Correlation Matrix',
      description: 'Compute 30-day Pearson correlation between an instrument and major assets (DXY, SPX, NAS100, XAUUSD, USOIL, EURUSD).',
      inputSchema: {
        instrument: z.string().describe('Primary instrument to check correlations for'),
        compare_with: z.array(z.string()).optional().describe('Instruments to compare against. Defaults to major assets.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    wrapTool('get_correlation_matrix', async ({ instrument, compare_with }) => {
      // DXY / SPX / NAS100 are TWELVE_DATA_UNAVAILABLE on the current tier —
      // the correlation call for each would return neutral (0). USDJPY is a
      // workable USD-strength proxy that IS available on Grow, so swap it in
      // for DXY's macro slot. SPX/NAS100 have no clean substitute at this
      // tier, so we drop them rather than burn cycles on known-zero results.
      const defaults = ['USDJPY', 'XAUUSD', 'USOIL', 'EURUSD'];
      const comparisons = compare_with || defaults.filter(d => d !== instrument);
      const correlations = await Promise.all(
        comparisons.map(other => computeCorrelation(instrument, other))
      );
      return { content: [{ type: 'text' as const, text: JSON.stringify(correlations) }] };
    })
  );

  server.registerTool(
    'get_sector_strength',
    {
      title: 'Get Sector Strength',
      description: 'Get relative performance of equity sectors (tech, energy, healthcare, etc.) from Financial Modeling Prep.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    wrapTool('get_sector_strength', async () => {
      const sectors = await fetchSectorStrength();
      return { content: [{ type: 'text' as const, text: JSON.stringify(sectors) }] };
    })
  );

  server.registerTool(
    'get_vix',
    {
      title: 'Get VIX Level',
      description: 'Get current VIX value, 30-day average, and regime classification (low/normal/elevated/crisis) from Twelve Data.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    wrapTool('get_vix', async () => {
      const vixData = await fetchVix();
      let regime: string;
      if (vixData.vix < 15) regime = 'low';
      else if (vixData.vix < 20) regime = 'normal';
      else if (vixData.vix < 30) regime = 'elevated';
      else regime = 'crisis';
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ...vixData, regime }) }] };
    })
  );

  server.registerTool(
    'get_dxy',
    {
      title: 'Get Dollar Index',
      description: 'Get current DXY level and 5-day direction (rising/falling/flat) from Twelve Data.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    wrapTool('get_dxy', async () => {
      const dxyData = await fetchDxy();
      return { content: [{ type: 'text' as const, text: JSON.stringify(dxyData) }] };
    })
  );

  server.registerTool(
    'get_yield_curve',
    {
      title: 'Get Treasury Yield Curve',
      description: 'Get 2y, 10y, 30y US Treasury yields and 2y-10y spread from FRED. Indicates whether yield curve is inverted.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    wrapTool('get_yield_curve', async () => {
      const yields = await fetchYieldCurve();
      const spread_2y_10y = Math.round((yields.us10y - yields.us2y) * 100) / 100;
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ...yields, spread_2y_10y, inverted: spread_2y_10y < 0 }) }] };
    })
  );

  server.registerTool(
    'get_client_sentiment',
    {
      title: 'Get Client Sentiment',
      description: 'Fetch Capital.com retail client sentiment (long vs short percentage) for one or more market IDs. Useful as a contrarian indicator.',
      inputSchema: {
        market_ids: z.array(z.string()).min(1).describe('Capital.com market IDs / epics to fetch sentiment for'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    wrapTool('get_client_sentiment', async ({ market_ids }) => {
      const sentiment = await capital.getClientSentiment(market_ids);
      return { content: [{ type: 'text' as const, text: JSON.stringify(sentiment) }] };
    })
  );

  server.registerTool(
    'write_research_brief',
    {
      title: 'Save Research Brief',
      description: 'Save a structured research brief (regime, themes, shortlists, warnings) to the database. Read by trading agents at cycle start.',
      inputSchema: { content: z.string().describe('JSON string of full ResearchBrief object') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    wrapTool('write_research_brief', async ({ content }) => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(content);
      } catch {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Invalid JSON in brief content' }) }] };
      }
      saveResearchBrief(parsed as unknown as Parameters<typeof saveResearchBrief>[0]);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'saved', brief_id: parsed.brief_id }) }] };
    })
  );
}

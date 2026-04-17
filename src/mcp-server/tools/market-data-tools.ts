// MCP Tools — Market Data (external APIs)
// Tools: get_prices, get_news_context, get_economic_calendar, get_correlation_matrix,
//        get_sector_strength, get_vix, get_dxy, get_yield_curve, write_research_brief

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { wrapTool } from '../logger.js';
import {
  fetchCandles, fetchVix, fetchDxy, fetchYieldCurve,
  fetchEconomicCalendar, fetchSectorStrength, fetchNewsContext,
  computeCorrelation,
} from '../market-data.js';
import { saveResearchBrief } from '../../database/index.js';
import type { Timeframe } from '../../types.js';

export function registerMarketDataTools(server: McpServer): void {

  // get_prices
  server.tool(
    'get_prices',
    {
      instrument: z.string().describe('Instrument ticker (e.g. XAUUSD, NAS100, AAPL)'),
      timeframe: z.enum(['15m', '1h', '4h', '1d', '1w']).describe('Candle timeframe'),
      count: z.number().optional().default(100).describe('Number of candles'),
    },
    wrapTool('get_prices', async ({ instrument, timeframe, count }) => {
      const candles = await fetchCandles(instrument, timeframe as Timeframe, count);
      return { content: [{ type: 'text' as const, text: JSON.stringify(candles) }] };
    })
  );

  // get_news_context
  server.tool(
    'get_news_context',
    { instrument: z.string().describe('Instrument ticker') },
    wrapTool('get_news_context', async ({ instrument }) => {
      const news = await fetchNewsContext(instrument);
      return { content: [{ type: 'text' as const, text: JSON.stringify(news) }] };
    })
  );

  // get_economic_calendar
  server.tool(
    'get_economic_calendar',
    { days_ahead: z.number().optional().default(5).describe('Days ahead to check') },
    wrapTool('get_economic_calendar', async ({ days_ahead }) => {
      const events = await fetchEconomicCalendar(days_ahead);
      return { content: [{ type: 'text' as const, text: JSON.stringify(events) }] };
    })
  );

  // get_correlation_matrix
  server.tool(
    'get_correlation_matrix',
    {
      instrument: z.string().describe('Primary instrument'),
      compare_with: z.array(z.string()).optional().describe('Instruments to compare against'),
    },
    wrapTool('get_correlation_matrix', async ({ instrument, compare_with }) => {
      const defaults = ['DXY', 'SPX', 'NAS100', 'XAUUSD', 'USOIL', 'EURUSD'];
      const comparisons = compare_with || defaults.filter(d => d !== instrument);
      const correlations = await Promise.all(
        comparisons.map(other => computeCorrelation(instrument, other))
      );
      return { content: [{ type: 'text' as const, text: JSON.stringify(correlations) }] };
    })
  );

  // get_sector_strength
  server.tool(
    'get_sector_strength',
    {},
    wrapTool('get_sector_strength', async () => {
      const sectors = await fetchSectorStrength();
      return { content: [{ type: 'text' as const, text: JSON.stringify(sectors) }] };
    })
  );

  // get_vix
  server.tool(
    'get_vix',
    {},
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

  // get_dxy
  server.tool(
    'get_dxy',
    {},
    wrapTool('get_dxy', async () => {
      const dxyData = await fetchDxy();
      return { content: [{ type: 'text' as const, text: JSON.stringify(dxyData) }] };
    })
  );

  // get_yield_curve
  server.tool(
    'get_yield_curve',
    {},
    wrapTool('get_yield_curve', async () => {
      const yields = await fetchYieldCurve();
      const spread_2y_10y = Math.round((yields.us10y - yields.us2y) * 100) / 100;
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ...yields, spread_2y_10y, inverted: spread_2y_10y < 0 }) }] };
    })
  );

  // write_research_brief
  server.tool(
    'write_research_brief',
    { content: z.string().describe('JSON string of research brief') },
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

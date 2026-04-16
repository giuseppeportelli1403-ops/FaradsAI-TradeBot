// MCP Server — BetterOpsAI Trading Bot
// Exposes 21 tools for the 6 AI trading agents via Model Context Protocol
//
// 14 Trading/DB tools + 7 Market Data tools
// Transport: stdio (for Claude Code / agent integration)

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { T212Client } from './t212-client.js';
import {
  fetchCandles, fetchVix, fetchDxy, fetchYieldCurve,
  fetchEconomicCalendar, fetchSectorStrength, fetchNewsContext,
  computeCorrelation,
} from './market-data.js';
import type { Timeframe, StrategyTag } from '../types.js';
import {
  initDatabaseAsync,
  insertTrade, updateTradeStatus, getTradeById, getTradeHistory,
  getLessons, getLessonWinRate, getOpenTrades, countOpenPositions,
  createSlTpOrder, updateSlPrice, setTrailingStop as dbSetTrailingStop,
  saveResearchBrief, getLatestBrief,
  getDailyPnl, upsertDailyPnl,
} from '../database/index.js';

// ==================== INIT ====================

const t212 = new T212Client(
  process.env.T212_API_KEY || '',
  (process.env.T212_MODE as 'demo' | 'live') || 'demo'
);

const server = new McpServer({
  name: 'betterops-trading-bot',
  version: '0.1.0',
});

// ==================== TOOL 1: get_prices ====================
// Source: Twelve Data (T212 has no OHLC endpoint)

server.tool(
  'get_prices',
  {
    instrument: z.string().describe('Instrument ticker (e.g. XAUUSD, NAS100, AAPL)'),
    timeframe: z.enum(['15m', '1h', '4h', '1d', '1w']).describe('Candle timeframe'),
    count: z.number().optional().default(100).describe('Number of candles to fetch'),
  },
  async ({ instrument, timeframe, count }) => {
    const candles = await fetchCandles(instrument, timeframe as Timeframe, count);
    return { content: [{ type: 'text' as const, text: JSON.stringify(candles) }] };
  }
);

// ==================== TOOL 2: get_portfolio ====================
// Source: T212 API

server.tool(
  'get_portfolio',
  {},
  async () => {
    const positions = await t212.getPortfolio();
    return { content: [{ type: 'text' as const, text: JSON.stringify(positions) }] };
  }
);

// ==================== TOOL 3: get_balance ====================
// Source: T212 API

server.tool(
  'get_balance',
  {},
  async () => {
    const balance = await t212.getBalance();
    return { content: [{ type: 'text' as const, text: JSON.stringify(balance) }] };
  }
);

// ==================== TOOL 4: place_order ====================
// Source: T212 API (market order)
// NOTE: T212 does NOT support SL/TP/label on orders. We track them in local DB.
// The agent must call log_trade after placing both legs to record SL/TP/labels.

server.tool(
  'place_order',
  {
    instrument: z.string().describe('Instrument ticker'),
    direction: z.enum(['long', 'short']).describe('Trade direction'),
    size: z.number().describe('Position size in units'),
    sl: z.number().describe('Stop loss price (tracked locally, not sent to T212)'),
    tp: z.number().describe('Take profit price (tracked locally, not sent to T212)'),
    label: z.string().describe('Position label e.g. XAUUSD-A-1713300000 (tracked locally)'),
  },
  async ({ instrument, direction, size, sl, tp, label }) => {
    // T212 uses positive qty for buy, negative for sell
    const quantity = direction === 'long' ? size : -size;
    const result = await t212.placeMarketOrder(instrument, quantity);

    // Return order result + the local tracking data the agent needs to log
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          t212_result: result,
          local_tracking: { instrument, direction, size, sl, tp, label },
          note: 'SL/TP are NOT set on T212. Scheduler must monitor price and execute SL/TP logic.',
        }),
      }],
    };
  }
);

// ==================== TOOL 5: partial_close ====================
// Source: T212 API (opposite order for partial qty)

server.tool(
  'partial_close',
  {
    instrument: z.string().describe('Instrument ticker'),
    units: z.number().describe('Number of units to close'),
  },
  async ({ instrument, units }) => {
    const result = await t212.partialClose(instrument, units);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  }
);

// ==================== TOOL 6: close_position ====================
// Source: T212 API (opposite order for full qty)

server.tool(
  'close_position',
  {
    instrument: z.string().describe('Instrument ticker'),
    quantity: z.number().describe('Full position quantity to close'),
  },
  async ({ instrument, quantity }) => {
    const result = await t212.closePosition(instrument, quantity);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  }
);

// ==================== TOOL 7: set_trailing_stop ====================
// Source: LOCAL (T212 has no trailing stop API)
// Saves trailing stop config to DB. Scheduler monitors price and triggers close.

server.tool(
  'set_trailing_stop',
  {
    trade_id: z.string().describe('Internal trade ID from our DB'),
    distance: z.number().describe('Trailing stop distance in price terms'),
  },
  async ({ trade_id, distance }) => {
    dbSetTrailingStop(trade_id, 'B', distance);
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          trade_id,
          trailing_stop_distance: distance,
          status: 'set',
          note: 'Trailing stop saved to DB. Scheduler will monitor price and execute.',
        }),
      }],
    };
  }
);

// ==================== TOOL 8: update_sl ====================
// Source: LOCAL (T212 has no modify position API)
// Updates SL in DB. Scheduler monitors and places close order if price hits SL.

server.tool(
  'update_sl',
  {
    trade_id: z.string().describe('Internal trade ID from our DB'),
    new_sl: z.number().describe('New stop loss price'),
  },
  async ({ trade_id, new_sl }) => {
    updateSlPrice(trade_id, 'A', new_sl);
    updateSlPrice(trade_id, 'B', new_sl);
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          trade_id,
          new_sl,
          status: 'updated',
          note: 'SL updated in DB for both legs. Scheduler will monitor price and execute.',
        }),
      }],
    };
  }
);

// ==================== TOOL 9: log_trade ====================
// Source: LOCAL DB

server.tool(
  'log_trade',
  {
    trade_data: z.string().describe('JSON string of full trade record (see TradeRecord type)'),
  },
  async ({ trade_data }) => {
    const parsed = JSON.parse(trade_data);
    insertTrade(parsed);

    // Create SL/TP monitoring entries for both legs
    createSlTpOrder({
      trade_id: parsed.id,
      leg: 'A',
      instrument: parsed.instrument,
      direction: parsed.direction,
      quantity: parsed.size_a,
      sl_price: parsed.sl,
      tp_price: parsed.tp1,
    });
    createSlTpOrder({
      trade_id: parsed.id,
      leg: 'B',
      instrument: parsed.instrument,
      direction: parsed.direction,
      quantity: parsed.size_b,
      sl_price: parsed.sl,
      tp_price: parsed.tp2,
    });

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ status: 'logged', trade_id: parsed.id }),
      }],
    };
  }
);

// ==================== TOOL 10: get_lessons ====================
// Source: LOCAL DB

server.tool(
  'get_lessons',
  {
    setup_type: z.string().optional().describe('Filter by setup type (e.g. OB retest, daily pullback)'),
    instrument_category: z.string().optional().describe('Filter by instrument category'),
    kill_zone: z.string().optional().describe('Filter by kill zone'),
    strategy_tag: z.enum(['ICT_INTRADAY', 'SWING']).optional().describe('Filter by strategy'),
    limit: z.number().optional().default(20).describe('Max lessons to return'),
  },
  async ({ setup_type, instrument_category, kill_zone, strategy_tag, limit }) => {
    const lessons = getLessons({ setup_type, instrument_category, kill_zone, strategy_tag, limit });
    const winRate = getLessonWinRate({ setup_type, instrument_category, kill_zone, strategy_tag });
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          lessons,
          count: lessons.length,
          win_rate: winRate,
          filters: { setup_type, instrument_category, kill_zone, strategy_tag },
        }),
      }],
    };
  }
);

// ==================== TOOL 11: get_ranked_instruments ====================
// Source: Universe Scanner module (Step 5)

server.tool(
  'get_ranked_instruments',
  {
    limit: z.number().optional().default(20).describe('Number of top instruments to return'),
  },
  async ({ limit }) => {
    // TODO: Call scanner module (Step 5)
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          instruments: [],
          count: 0,
          note: 'Scanner not yet implemented (Step 5)',
        }),
      }],
    };
  }
);

// ==================== TOOL 12: get_news_context ====================
// Source: Alpha Vantage News Sentiment API

server.tool(
  'get_news_context',
  {
    instrument: z.string().describe('Instrument ticker to get news for'),
  },
  async ({ instrument }) => {
    const news = await fetchNewsContext(instrument);
    return { content: [{ type: 'text' as const, text: JSON.stringify(news) }] };
  }
);

// ==================== TOOL 13: get_daily_pnl ====================
// Source: LOCAL DB + T212 portfolio

server.tool(
  'get_daily_pnl',
  {},
  async () => {
    const balance = await t212.getBalance();
    const today = new Date().toISOString().split('T')[0];
    const dailyRecord = getDailyPnl(today);

    const unrealised = balance.ppl;
    const realised = dailyRecord?.realised_pnl ?? 0;
    const total = unrealised + realised;
    const pct = balance.total ? (total / balance.total) * 100 : 0;
    const killSwitch = pct <= -4;

    // Update daily P&L snapshot
    upsertDailyPnl(today, realised, unrealised, balance.total);

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          unrealised_pnl: unrealised,
          realised_pnl_today: realised,
          total_daily_pnl: total,
          equity: balance.total,
          daily_pnl_pct: Math.round(pct * 100) / 100,
          kill_switch_active: killSwitch,
          open_positions: countOpenPositions(),
        }),
      }],
    };
  }
);

// ==================== TOOL 14: get_trade_history ====================
// Source: LOCAL DB

server.tool(
  'get_trade_history',
  {
    limit: z.number().optional().default(50).describe('Number of recent trades to return'),
    strategy_tag: z.enum(['ICT_INTRADAY', 'SWING']).optional().describe('Filter by strategy'),
  },
  async ({ limit, strategy_tag }) => {
    const trades = getTradeHistory(limit, strategy_tag as StrategyTag | undefined);
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          trades,
          count: trades.length,
          filters: { strategy_tag },
        }),
      }],
    };
  }
);

// ==================== TOOL 15: get_economic_calendar ====================
// Source: Finnhub

server.tool(
  'get_economic_calendar',
  {
    days_ahead: z.number().optional().default(5).describe('Number of days ahead to check'),
  },
  async ({ days_ahead }) => {
    const events = await fetchEconomicCalendar(days_ahead);
    return { content: [{ type: 'text' as const, text: JSON.stringify(events) }] };
  }
);

// ==================== TOOL 16: get_correlation_matrix ====================
// Source: Computed from Twelve Data daily prices

server.tool(
  'get_correlation_matrix',
  {
    instrument: z.string().describe('Primary instrument to check correlations for'),
    compare_with: z.array(z.string()).optional().describe('Instruments to compare against. Defaults to major assets.'),
  },
  async ({ instrument, compare_with }) => {
    const defaults = ['DXY', 'SPX', 'NAS100', 'XAUUSD', 'USOIL', 'EURUSD'];
    const comparisons = compare_with || defaults.filter(d => d !== instrument);

    const correlations = await Promise.all(
      comparisons.map(other => computeCorrelation(instrument, other))
    );

    return { content: [{ type: 'text' as const, text: JSON.stringify(correlations) }] };
  }
);

// ==================== TOOL 17: get_sector_strength ====================
// Source: FMP

server.tool(
  'get_sector_strength',
  {},
  async () => {
    const sectors = await fetchSectorStrength();
    return { content: [{ type: 'text' as const, text: JSON.stringify(sectors) }] };
  }
);

// ==================== TOOL 18: get_vix ====================
// Source: Twelve Data

server.tool(
  'get_vix',
  {},
  async () => {
    const vixData = await fetchVix();
    let regime: string;
    if (vixData.vix < 15) regime = 'low';
    else if (vixData.vix < 20) regime = 'normal';
    else if (vixData.vix < 30) regime = 'elevated';
    else regime = 'crisis';

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ ...vixData, regime }),
      }],
    };
  }
);

// ==================== TOOL 19: get_dxy ====================
// Source: Twelve Data

server.tool(
  'get_dxy',
  {},
  async () => {
    const dxyData = await fetchDxy();
    return { content: [{ type: 'text' as const, text: JSON.stringify(dxyData) }] };
  }
);

// ==================== TOOL 20: get_yield_curve ====================
// Source: FRED

server.tool(
  'get_yield_curve',
  {},
  async () => {
    const yields = await fetchYieldCurve();
    const spread_2y_10y = Math.round((yields.us10y - yields.us2y) * 100) / 100;
    const inverted = spread_2y_10y < 0;

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ ...yields, spread_2y_10y, inverted }),
      }],
    };
  }
);

// ==================== TOOL 21: write_research_brief ====================
// Source: LOCAL DB/file

server.tool(
  'write_research_brief',
  {
    content: z.string().describe('JSON string of full research brief (see ResearchBrief type)'),
  },
  async ({ content }) => {
    const parsed = JSON.parse(content);
    saveResearchBrief(parsed);
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          status: 'saved',
          brief_id: parsed.brief_id,
          note: 'Research brief saved to DB. Trading agents will read this at cycle start.',
        }),
      }],
    };
  }
);

// ==================== START SERVER ====================

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('BetterOpsAI MCP Server running on stdio');
}

main().catch((error) => {
  console.error('MCP Server fatal error:', error);
  process.exit(1);
});

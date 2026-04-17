// MCP Tools — Database & Portfolio queries
// Tools: get_portfolio, get_balance, get_daily_pnl, get_trade_history,
//        get_lessons, get_ranked_instruments

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { T212Client } from '../t212-client.js';
import { wrapTool } from '../logger.js';
import {
  getTradeHistory, getLessons, getLessonWinRate, countOpenPositions,
  getDailyPnl, upsertDailyPnl,
} from '../../database/index.js';
import { getRankedInstruments } from '../../scanner/index.js';
import type { StrategyTag } from '../../types.js';

const t212 = new T212Client(
  process.env.T212_API_KEY || '',
  (process.env.T212_MODE as 'demo' | 'live') || 'demo'
);

export function registerDbTools(server: McpServer): void {

  // get_portfolio
  server.tool(
    'get_portfolio',
    {},
    wrapTool('get_portfolio', async () => {
      const positions = await t212.getPortfolio();
      return { content: [{ type: 'text' as const, text: JSON.stringify(positions) }] };
    })
  );

  // get_balance
  server.tool(
    'get_balance',
    {},
    wrapTool('get_balance', async () => {
      const balance = await t212.getBalance();
      return { content: [{ type: 'text' as const, text: JSON.stringify(balance) }] };
    })
  );

  // get_daily_pnl
  server.tool(
    'get_daily_pnl',
    {},
    wrapTool('get_daily_pnl', async () => {
      const balance = await t212.getBalance();
      const today = new Date().toISOString().split('T')[0];
      const dailyRecord = getDailyPnl(today);

      const unrealised = balance.ppl;
      const realised = dailyRecord?.realised_pnl ?? 0;
      const total = unrealised + realised;
      const pct = balance.total ? (total / balance.total) * 100 : 0;
      const killSwitch = pct <= -4;

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
    })
  );

  // get_trade_history
  server.tool(
    'get_trade_history',
    {
      limit: z.number().optional().default(50).describe('Recent trades to return'),
      strategy_tag: z.enum(['ICT_INTRADAY', 'SWING']).optional().describe('Filter by strategy'),
    },
    wrapTool('get_trade_history', async ({ limit, strategy_tag }) => {
      const trades = getTradeHistory(limit, strategy_tag as StrategyTag | undefined);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ trades, count: trades.length }) }] };
    })
  );

  // get_lessons
  server.tool(
    'get_lessons',
    {
      setup_type: z.string().optional().describe('Filter by setup type'),
      instrument_category: z.string().optional().describe('Filter by instrument category'),
      kill_zone: z.string().optional().describe('Filter by kill zone'),
      strategy_tag: z.enum(['ICT_INTRADAY', 'SWING']).optional().describe('Filter by strategy'),
      limit: z.number().optional().default(20).describe('Max lessons'),
    },
    wrapTool('get_lessons', async ({ setup_type, instrument_category, kill_zone, strategy_tag, limit }) => {
      const lessons = getLessons({ setup_type, instrument_category, kill_zone, strategy_tag, limit });
      const winRate = getLessonWinRate({ setup_type, instrument_category, kill_zone, strategy_tag });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ lessons, count: lessons.length, win_rate: winRate }),
        }],
      };
    })
  );

  // get_ranked_instruments
  server.tool(
    'get_ranked_instruments',
    { limit: z.number().optional().default(20).describe('Top N instruments') },
    wrapTool('get_ranked_instruments', async ({ limit }) => {
      const instruments = await getRankedInstruments(limit);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ instruments, count: instruments.length, timestamp: new Date().toISOString() }),
        }],
      };
    })
  );
}

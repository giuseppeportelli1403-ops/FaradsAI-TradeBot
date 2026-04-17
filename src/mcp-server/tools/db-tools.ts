// MCP Tools — Database & Portfolio queries
// Tools: get_portfolio, get_balance, get_daily_pnl, get_trade_history,
//        get_lessons, get_ranked_instruments
// Uses registerTool (modern API) with annotations

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

  server.registerTool(
    'get_portfolio',
    {
      title: 'Get Open Positions',
      description: 'Get all currently open positions from Trading 212 portfolio.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    wrapTool('get_portfolio', async () => {
      const positions = await t212.getPortfolio();
      return { content: [{ type: 'text' as const, text: JSON.stringify(positions) }] };
    })
  );

  server.registerTool(
    'get_balance',
    {
      title: 'Get Account Balance',
      description: 'Get account cash, equity, invested amount, and unrealised P&L from Trading 212.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    wrapTool('get_balance', async () => {
      const balance = await t212.getBalance();
      return { content: [{ type: 'text' as const, text: JSON.stringify(balance) }] };
    })
  );

  server.registerTool(
    'get_daily_pnl',
    {
      title: 'Get Daily P&L',
      description: 'Get today\'s running P&L (realised + unrealised), equity, daily loss percentage, kill switch status, and open position count.',
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
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

  server.registerTool(
    'get_trade_history',
    {
      title: 'Get Trade History',
      description: 'Fetch recent closed trades from the database, optionally filtered by strategy (ICT_INTRADAY or SWING).',
      inputSchema: {
        limit: z.number().optional().default(50).describe('Number of recent trades to return'),
        strategy_tag: z.enum(['ICT_INTRADAY', 'SWING']).optional().describe('Filter by strategy'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    wrapTool('get_trade_history', async ({ limit, strategy_tag }) => {
      const trades = getTradeHistory(limit, strategy_tag as StrategyTag | undefined);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ trades, count: trades.length }) }] };
    })
  );

  server.registerTool(
    'get_lessons',
    {
      title: 'Get Past Lessons',
      description: 'Retrieve structured lessons from the Reflection Agent, filtered by setup type, instrument category, kill zone, and/or strategy. Includes win rate statistics.',
      inputSchema: {
        setup_type: z.string().optional().describe('Filter by setup type (e.g. OB retest, daily pullback)'),
        instrument_category: z.string().optional().describe('Filter by instrument category (e.g. commodity, fx, index)'),
        kill_zone: z.string().optional().describe('Filter by kill zone (e.g. London Open, NY Open)'),
        strategy_tag: z.enum(['ICT_INTRADAY', 'SWING']).optional().describe('Filter by strategy'),
        limit: z.number().optional().default(20).describe('Max lessons to return'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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

  server.registerTool(
    'get_ranked_instruments',
    {
      title: 'Get Ranked Instruments',
      description: 'Get instruments ranked by preliminary composite score from the universe scanner. Includes bias direction, score, and tier classification.',
      inputSchema: { limit: z.number().optional().default(20).describe('Number of top instruments to return') },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
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

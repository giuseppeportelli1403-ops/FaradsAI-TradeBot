// MCP Tools — Trading (T212 API + DB)
// Tools: place_order, partial_close, close_position, set_trailing_stop, update_sl, log_trade

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { T212Client } from '../t212-client.js';
import { wrapTool } from '../logger.js';
import {
  insertTrade, createSlTpOrder, updateSlPrice,
  setTrailingStop as dbSetTrailingStop,
} from '../../database/index.js';

const t212 = new T212Client(
  process.env.T212_API_KEY || '',
  (process.env.T212_MODE as 'demo' | 'live') || 'demo'
);

export function registerTradingTools(server: McpServer): void {

  // place_order
  server.tool(
    'place_order',
    {
      instrument: z.string().describe('Instrument ticker'),
      direction: z.enum(['long', 'short']).describe('Trade direction'),
      size: z.number().positive().describe('Position size in units'),
      sl: z.number().describe('Stop loss price (tracked locally)'),
      tp: z.number().describe('Take profit price (tracked locally)'),
      label: z.string().describe('Position label e.g. XAUUSD-A-1713300000'),
    },
    wrapTool('place_order', async ({ instrument, direction, size, sl, tp, label }) => {
      const quantity = direction === 'long' ? size : -size;
      const result = await t212.placeMarketOrder(instrument, quantity);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            t212_result: result,
            local_tracking: { instrument, direction, size, sl, tp, label },
            note: 'SL/TP tracked locally. Scheduler monitors and executes.',
          }),
        }],
      };
    })
  );

  // partial_close
  server.tool(
    'partial_close',
    {
      instrument: z.string().describe('Instrument ticker'),
      units: z.number().positive().describe('Number of units to close'),
    },
    wrapTool('partial_close', async ({ instrument, units }) => {
      const result = await t212.partialClose(instrument, units);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    })
  );

  // close_position
  server.tool(
    'close_position',
    {
      instrument: z.string().describe('Instrument ticker'),
      quantity: z.number().positive().describe('Full position quantity to close'),
    },
    wrapTool('close_position', async ({ instrument, quantity }) => {
      const result = await t212.closePosition(instrument, quantity);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    })
  );

  // set_trailing_stop
  server.tool(
    'set_trailing_stop',
    {
      trade_id: z.string().min(1).describe('Internal trade ID'),
      distance: z.number().positive().describe('Trailing stop distance in price terms'),
    },
    wrapTool('set_trailing_stop', async ({ trade_id, distance }) => {
      dbSetTrailingStop(trade_id, 'B', distance);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ trade_id, trailing_stop_distance: distance, status: 'set' }),
        }],
      };
    })
  );

  // update_sl
  server.tool(
    'update_sl',
    {
      trade_id: z.string().min(1).describe('Internal trade ID'),
      new_sl: z.number().describe('New stop loss price'),
    },
    wrapTool('update_sl', async ({ trade_id, new_sl }) => {
      updateSlPrice(trade_id, 'A', new_sl);
      updateSlPrice(trade_id, 'B', new_sl);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ trade_id, new_sl, status: 'updated' }),
        }],
      };
    })
  );

  // log_trade — with input validation
  server.tool(
    'log_trade',
    {
      trade_data: z.string().describe('JSON string of full trade record'),
    },
    wrapTool('log_trade', async ({ trade_data }) => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(trade_data);
      } catch {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Invalid JSON in trade_data' }) }],
          isError: true,
        } as { content: Array<{ type: 'text'; text: string }> };
      }

      if (!parsed.id || !parsed.instrument || !parsed.direction) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Missing required fields: id, instrument, direction' }) }],
        };
      }

      insertTrade(parsed as Parameters<typeof insertTrade>[0]);
      createSlTpOrder({ trade_id: parsed.id as string, leg: 'A', instrument: parsed.instrument as string, direction: parsed.direction as 'long' | 'short', quantity: parsed.size_a as number, sl_price: parsed.sl as number, tp_price: parsed.tp1 as number });
      createSlTpOrder({ trade_id: parsed.id as string, leg: 'B', instrument: parsed.instrument as string, direction: parsed.direction as 'long' | 'short', quantity: parsed.size_b as number, sl_price: parsed.sl as number, tp_price: parsed.tp2 as number });

      return { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'logged', trade_id: parsed.id }) }] };
    })
  );
}

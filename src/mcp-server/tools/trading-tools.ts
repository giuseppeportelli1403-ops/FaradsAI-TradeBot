// MCP Tools — Trading (T212 API + DB)
// Tools: place_order, partial_close, close_position, set_trailing_stop, update_sl, log_trade
// Uses registerTool (modern API) with annotations

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

  server.registerTool(
    'place_order',
    {
      title: 'Place Market Order',
      description: 'Place a market order on Trading 212. Opens a single leg — call twice for split-position method. SL/TP are tracked locally, not on T212.',
      inputSchema: {
        instrument: z.string().describe('Instrument ticker (e.g. XAUUSD, NAS100)'),
        direction: z.enum(['long', 'short']).describe('Trade direction'),
        size: z.number().positive().describe('Position size in units'),
        sl: z.number().describe('Stop loss price (tracked locally, not sent to T212)'),
        tp: z.number().describe('Take profit price (tracked locally, not sent to T212)'),
        label: z.string().describe('Position label e.g. XAUUSD-A-1713300000'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
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

  server.registerTool(
    'partial_close',
    {
      title: 'Partial Close Position',
      description: 'Close a specified number of units on an open position by placing an opposite market order.',
      inputSchema: {
        instrument: z.string().describe('Instrument ticker'),
        units: z.number().positive().describe('Number of units to close'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    wrapTool('partial_close', async ({ instrument, units }) => {
      const result = await t212.partialClose(instrument, units);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    })
  );

  server.registerTool(
    'close_position',
    {
      title: 'Close Full Position',
      description: 'Fully close an open position by placing an opposite market order for the full quantity.',
      inputSchema: {
        instrument: z.string().describe('Instrument ticker'),
        quantity: z.number().positive().describe('Full position quantity to close'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    wrapTool('close_position', async ({ instrument, quantity }) => {
      const result = await t212.closePosition(instrument, quantity);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    })
  );

  server.registerTool(
    'set_trailing_stop',
    {
      title: 'Set Trailing Stop',
      description: 'Set a trailing stop distance on Position B of a trade. Stored locally — scheduler monitors price and executes.',
      inputSchema: {
        trade_id: z.string().min(1).describe('Internal trade ID from our DB'),
        distance: z.number().positive().describe('Trailing stop distance in price terms'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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

  server.registerTool(
    'update_sl',
    {
      title: 'Update Stop Loss',
      description: 'Update the stop loss price for both legs of a trade in the local DB. Scheduler monitors and executes when price hits SL.',
      inputSchema: {
        trade_id: z.string().min(1).describe('Internal trade ID'),
        new_sl: z.number().describe('New stop loss price'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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

  server.registerTool(
    'log_trade',
    {
      title: 'Log Trade to Database',
      description: 'Save a complete trade record (both legs) to the database and create SL/TP monitoring entries for the scheduler.',
      inputSchema: {
        trade_data: z.string().describe('JSON string of full trade record with id, instrument, direction, size_a, size_b, sl, tp1, tp2'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
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

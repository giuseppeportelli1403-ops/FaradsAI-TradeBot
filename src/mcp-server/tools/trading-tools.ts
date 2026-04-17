// MCP Tools — Trading (Capital.com API + DB)
// Tools: place_order, partial_close, close_position, set_trailing_stop, update_sl, log_trade
// Uses registerTool (modern API) with annotations.
// Capital.com handles SL/TP and trailing stops server-side; DB is audit-only.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CapitalClient } from '../capital-client.js';
import { wrapTool } from '../logger.js';
import {
  insertTrade, createSlTpOrder, updateSlPrice,
  setTrailingStop as dbSetTrailingStop,
} from '../../database/index.js';

const capital = new CapitalClient({
  apiKey: process.env.CAPITAL_API_KEY || '',
  identifier: process.env.CAPITAL_IDENTIFIER || '',
  password: process.env.CAPITAL_API_KEY_PASSWORD || '',
  baseURL: process.env.CAPITAL_API_URL || 'https://demo-api-capital.backend-capital.com',
});

export function registerTradingTools(server: McpServer): void {

  server.registerTool(
    'place_order',
    {
      title: 'Place Market Order',
      description: 'Place a market order on Capital.com. Opens a single leg — call twice for split-position method. SL/TP are sent server-side to Capital.com (authoritative). Returns the dealId to use as position_a_deal_id / position_b_deal_id in log_trade.',
      inputSchema: {
        epic: z.string().describe('Capital.com epic (e.g. GOLD, US100, EURUSD)'),
        direction: z.enum(['long', 'short']).describe('Trade direction'),
        size: z.number().positive().describe('Position size in units'),
        sl: z.number().describe('Stop loss price (sent to Capital.com as stopLevel)'),
        tp: z.number().describe('Take profit price (sent to Capital.com as profitLevel)'),
        label: z.string().describe('Position label e.g. XAUUSD-A-1713300000 (local audit only)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    wrapTool('place_order', async ({ epic, direction, size, sl, tp, label }) => {
      const capitalDirection = direction === 'long' ? 'BUY' : 'SELL';
      const confirmation = await capital.openPosition({
        direction: capitalDirection,
        epic,
        size,
        stopLevel: sl,
        profitLevel: tp,
      });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            dealId: confirmation.dealId,
            dealReference: confirmation.dealReference,
            dealStatus: confirmation.dealStatus,
            status: confirmation.status,
            direction: confirmation.direction,
            epic: confirmation.epic,
            size: confirmation.size,
            level: confirmation.level,
            stopLevel: confirmation.stopLevel,
            profitLevel: confirmation.profitLevel,
            local_tracking: { epic, direction, size, sl, tp, label },
          }),
        }],
      };
    })
  );

  server.registerTool(
    'partial_close',
    {
      title: 'Partial Close Position',
      description: 'Close a specified size on an open position via Capital.com. If Capital rejects the partial DELETE, the client falls back to close + reopen with the remaining size.',
      inputSchema: {
        dealId: z.string().min(1).describe('Capital.com dealId of the open position'),
        size: z.number().positive().describe('Number of units to close'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    wrapTool('partial_close', async ({ dealId, size }) => {
      const result = await capital.partialClosePosition(dealId, size);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    })
  );

  server.registerTool(
    'close_position',
    {
      title: 'Close Full Position',
      description: 'Fully close an open position on Capital.com by its dealId.',
      inputSchema: {
        dealId: z.string().min(1).describe('Capital.com dealId of the open position'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    wrapTool('close_position', async ({ dealId }) => {
      const result = await capital.closePosition(dealId);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    })
  );

  server.registerTool(
    'set_trailing_stop',
    {
      title: 'Set Trailing Stop',
      description: 'Attach a server-side trailing stop to an open position on Capital.com. Distance is in price terms. Also records the trailing stop on Position B in the local DB for audit.',
      inputSchema: {
        dealId: z.string().min(1).describe('Capital.com dealId (typically Position B)'),
        distance: z.number().positive().describe('Trailing stop distance in price terms'),
        trade_id: z.string().optional().describe('Optional internal trade ID for DB audit'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    wrapTool('set_trailing_stop', async ({ dealId, distance, trade_id }) => {
      const confirmation = await capital.updatePosition(dealId, {
        trailingStop: true,
        stopDistance: distance,
      });
      if (trade_id) {
        // DB audit — Position B carries the trailing stop in the split-position method.
        dbSetTrailingStop(trade_id, 'B', distance);
      }
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            dealId,
            trailing_stop_distance: distance,
            dealStatus: confirmation.dealStatus,
            status: confirmation.status,
            audit_db_updated: Boolean(trade_id),
          }),
        }],
      };
    })
  );

  server.registerTool(
    'update_sl',
    {
      title: 'Update Stop Loss',
      description: 'Update the stop loss on an open position on Capital.com. If trade_id is provided, also updates the local DB audit trail for both legs.',
      inputSchema: {
        dealId: z.string().min(1).describe('Capital.com dealId of the open position'),
        new_sl: z.number().describe('New stop loss price (sent to Capital.com as stopLevel)'),
        trade_id: z.string().optional().describe('Optional internal trade ID for DB audit'),
        leg: z.enum(['A', 'B']).optional().describe('Optional leg (A or B) to update in DB; defaults to both'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    wrapTool('update_sl', async ({ dealId, new_sl, trade_id, leg }) => {
      const confirmation = await capital.updatePosition(dealId, { stopLevel: new_sl });
      if (trade_id) {
        if (leg) {
          updateSlPrice(trade_id, leg, new_sl);
        } else {
          updateSlPrice(trade_id, 'A', new_sl);
          updateSlPrice(trade_id, 'B', new_sl);
        }
      }
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            dealId,
            new_sl,
            dealStatus: confirmation.dealStatus,
            status: confirmation.status,
            audit_db_updated: Boolean(trade_id),
          }),
        }],
      };
    })
  );

  server.registerTool(
    'log_trade',
    {
      title: 'Log Trade to Database',
      description: 'Save a complete trade record (both legs) to the database and create SL/TP monitoring entries for the scheduler. Accepts Capital.com dealIds for audit linkage.',
      inputSchema: {
        trade_data: z.string().describe('JSON string of full trade record with id, instrument, direction, size_a, size_b, sl, tp1, tp2'),
        position_a_deal_id: z.string().optional().describe('Capital.com dealId of Position A (from place_order confirmation)'),
        position_b_deal_id: z.string().optional().describe('Capital.com dealId of Position B (from place_order confirmation)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    wrapTool('log_trade', async ({ trade_data, position_a_deal_id, position_b_deal_id }) => {
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
      createSlTpOrder({
        trade_id: parsed.id as string,
        leg: 'A',
        instrument: parsed.instrument as string,
        direction: parsed.direction as 'long' | 'short',
        quantity: parsed.size_a as number,
        sl_price: parsed.sl as number,
        tp_price: parsed.tp1 as number,
        deal_id: position_a_deal_id,
      } as Parameters<typeof createSlTpOrder>[0]);
      createSlTpOrder({
        trade_id: parsed.id as string,
        leg: 'B',
        instrument: parsed.instrument as string,
        direction: parsed.direction as 'long' | 'short',
        quantity: parsed.size_b as number,
        sl_price: parsed.sl as number,
        tp_price: parsed.tp2 as number,
        deal_id: position_b_deal_id,
      } as Parameters<typeof createSlTpOrder>[0]);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            status: 'logged',
            trade_id: parsed.id,
            position_a_deal_id: position_a_deal_id ?? null,
            position_b_deal_id: position_b_deal_id ?? null,
          }),
        }],
      };
    })
  );
}

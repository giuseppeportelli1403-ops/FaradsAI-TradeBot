// MCP Tools — Trading (Capital.com API + DB)
// Tools: place_order, partial_close, close_position, set_trailing_stop, update_sl, log_trade
// Uses registerTool (modern API) with annotations.
// Capital.com handles SL/TP and trailing stops server-side; DB is audit-only.

import { randomUUID } from 'crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CapitalClient } from '../capital-client.js';
import { wrapTool } from '../logger.js';
import {
  insertTrade, createSlTpOrder, updateSlPrice,
  setTrailingStop as dbSetTrailingStop,
} from '../../database/index.js';

// Canonical TradeStatus values enforced by the DB CHECK constraint. Kept in
// sync with TradeStatus in src/types.ts and the schema in src/database/index.ts.
// Any agent-supplied `status` outside this set is normalised to 'closed_early'
// with the original value preserved in `closure_reason` (see normaliseTradePayload).
const CANONICAL_TRADE_STATUSES = new Set([
  'open', 'tp1_hit', 'tp2_hit', 'complete', 'sl_hit', 'closed_early',
]);

const CANONICAL_STRATEGY_TAGS = new Set(['ICT_INTRADAY', 'SWING']);

/**
 * Bridges the agent's log_trade JSON payload to the insertTrade schema. Added
 * 2026-04-23 after three insertTrade failures on 2026-04-22 14:21 UTC where the
 * ICT agent tried to log a USDJPY short that was closed pre-TP due to fill
 * slippage: (a) payload had `strategy` not `strategy_tag`; (b) no `id`;
 * (c) `status: 'closed_rr_violation'` violated the CHECK enum. The trade
 * executed correctly on Capital.com but the audit-trail row never persisted.
 *
 * Fixes applied here (not in insertTrade, which is a pure DB-bind layer):
 *   - id           → randomUUID() if absent
 *   - strategy_tag ← strategy when the former is missing
 *   - entry        ← actual_entry || intended_entry when plain `entry` absent
 *                    (the 3-leg ICT prompt renders split-entries, not a single
 *                    `entry` number)
 *   - status       → 'closed_early' if outside canonical set, with original
 *                    value prepended to closure_reason for audit
 */
function normaliseTradePayload(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };

  if (!out.id) out.id = randomUUID();

  if (!out.strategy_tag && typeof out.strategy === 'string' && CANONICAL_STRATEGY_TAGS.has(out.strategy)) {
    out.strategy_tag = out.strategy;
  }

  if ((out.entry === undefined || out.entry === null) && typeof out.actual_entry === 'number') {
    out.entry = out.actual_entry;
  } else if ((out.entry === undefined || out.entry === null) && typeof out.intended_entry === 'number') {
    out.entry = out.intended_entry;
  }

  if (typeof out.status === 'string' && !CANONICAL_TRADE_STATUSES.has(out.status)) {
    const originalStatus = out.status;
    out.status = 'closed_early';
    const existingReason = typeof out.closure_reason === 'string' ? out.closure_reason : '';
    out.closure_reason = existingReason
      ? `${originalStatus}: ${existingReason}`
      : originalStatus;
  }

  return out;
}

// Exported for tests only.
export const _normaliseTradePayload = normaliseTradePayload;

// ==================== P1 — place_order LIMIT handler ====================
//
// Extracted as a pure function (takes the Capital client as an argument)
// so tests can mock the client without booting the full MCP server.
// The in-tool registration at `registerTradingTools` below dispatches to
// this function — one code path, tested once, running once in prod.

export const _placeOrderInputSchema = z.object({
  epic: z.string(),
  direction: z.enum(['long', 'short']),
  size: z.number().positive(),
  entry_price: z.number().positive(),
  sl: z.number(),
  tp: z.number(),
  label: z.string(),
});

interface PlaceOrderInput {
  epic: string;
  direction: 'long' | 'short';
  size: number;
  entry_price: number;
  sl: number;
  tp: number;
  label: string;
}

interface PlaceOrderCapital {
  createWorkingOrder: (
    params: Parameters<CapitalClient['createWorkingOrder']>[0],
  ) => Promise<Awaited<ReturnType<CapitalClient['createWorkingOrder']>>>;
}

export async function _placeOrderHandler(
  capitalClient: PlaceOrderCapital,
  input: PlaceOrderInput,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const capitalDirection = input.direction === 'long' ? 'BUY' : 'SELL';
  // 15-minute auto-expiry. Capital expects ISO-8601 seconds (no ms,
  // no Z suffix) in goodTillDate. Per Capital docs: "datetime in the
  // format yyyy-MM-dd'T'HH:mm:ss" treated as UTC.
  const goodTillDate = new Date(Date.now() + 15 * 60 * 1000)
    .toISOString()
    .slice(0, 19);

  const confirmation = await capitalClient.createWorkingOrder({
    direction: capitalDirection,
    epic: input.epic,
    size: input.size,
    level: input.entry_price,
    type: 'LIMIT',
    stopLevel: input.sl,
    profitLevel: input.tp,
    timeInForce: 'GOOD_TILL_DATE',
    goodTillDate,
    guaranteedStop: false,
    label: input.label,
  });

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        workingOrderId: confirmation.dealId ?? null,
        dealReference: confirmation.dealReference,
        dealStatus: confirmation.dealStatus,
        status: confirmation.status,
        orderType: 'LIMIT',
        entry_price: input.entry_price,
        expires_at: goodTillDate,
        note: 'Limit order placed. Will auto-cancel if not filled by expires_at.',
      }),
    }],
  };
}

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
      title: 'Place Limit Order',
      description: 'Place a LIMIT order leg at entry_price (typically the OB/FVG midpoint). Auto-cancels via goodTillDate after 15 minutes if not filled. Call twice for split-position method (both legs share the same entry_price + goodTillDate). Returns the workingOrderId (NOT a dealId) — a position + dealId only exist once the limit actually fills.',
      inputSchema: {
        epic: z.string().describe('Capital.com epic (e.g. GOLD, EURUSD)'),
        direction: z.enum(['long', 'short']).describe('Trade direction'),
        size: z.number().positive().describe('Position size in units'),
        entry_price: z.number().positive().describe(
          'Limit price — typically the OB/FVG zone midpoint. REQUIRED. ' +
          'The order auto-cancels via goodTillDate if not filled within 15 min.',
        ),
        sl: z.number().describe('Stop loss price (stopLevel on the working order)'),
        tp: z.number().describe('Take profit price (profitLevel on the working order)'),
        label: z.string().describe('Position label (local audit only)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    wrapTool('place_order', async ({ epic, direction, size, entry_price, sl, tp, label }) =>
      _placeOrderHandler(capital, { epic, direction, size, entry_price, sl, tp, label }),
    )
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
      description: 'Save a complete trade record (3 legs A/B/C targeting TP1/TP2/TP3) to the database and create SL/TP monitoring entries for the scheduler. Accepts Capital.com dealIds for audit linkage. Legacy 2-leg trades still work — omit size_c/tp3/position_c_deal_id and only A+B rows are created.',
      inputSchema: {
        trade_data: z.string().describe('JSON string of full trade record: id, instrument, direction, size_a, size_b, size_c?, sl, tp1, tp2, tp3?, position_a_id, position_b_id, position_c_id?, composite_score, kill_zone, setup_type'),
        position_a_deal_id: z.string().optional().describe('Capital.com dealId of Position A (Leg A, targets TP1, from place_order confirmation)'),
        position_b_deal_id: z.string().optional().describe('Capital.com dealId of Position B (Leg B, targets TP2)'),
        position_c_deal_id: z.string().optional().describe('Capital.com dealId of Position C (Leg C, targets TP3). Omit on legacy 2-leg trades.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    wrapTool('log_trade', async ({ trade_data, position_a_deal_id, position_b_deal_id, position_c_deal_id }) => {
      let rawParsed: Record<string, unknown>;
      try {
        rawParsed = JSON.parse(trade_data);
      } catch {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Invalid JSON in trade_data' }) }],
          isError: true,
        } as { content: Array<{ type: 'text'; text: string }> };
      }

      // Bridge agent payload quirks (strategy vs strategy_tag, missing id,
      // actual_entry vs entry, non-enum close statuses) before DB bind.
      const parsed = normaliseTradePayload(rawParsed);

      if (!parsed.instrument || !parsed.direction) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Missing required fields: instrument, direction' }) }],
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

      // Leg C (3-leg trades only) — create if size_c + tp3 are both provided.
      // Omitting either keeps this a legacy 2-leg record.
      const hasLegC =
        parsed.size_c !== undefined && parsed.size_c !== null &&
        parsed.tp3 !== undefined && parsed.tp3 !== null;
      if (hasLegC) {
        createSlTpOrder({
          trade_id: parsed.id as string,
          leg: 'C',
          instrument: parsed.instrument as string,
          direction: parsed.direction as 'long' | 'short',
          quantity: parsed.size_c as number,
          sl_price: parsed.sl as number,
          tp_price: parsed.tp3 as number,
          deal_id: position_c_deal_id,
        } as Parameters<typeof createSlTpOrder>[0]);
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            status: 'logged',
            trade_id: parsed.id,
            position_a_deal_id: position_a_deal_id ?? null,
            position_b_deal_id: position_b_deal_id ?? null,
            position_c_deal_id: hasLegC ? (position_c_deal_id ?? null) : null,
            legs_registered: hasLegC ? 3 : 2,
          }),
        }],
      };
    })
  );
}

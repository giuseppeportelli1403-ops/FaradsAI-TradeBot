// Trade-id generation helper.
//
// Background: the Claude trading agent's log_trade payload may omit the `id`
// field. insertTrade in src/database/index.ts requires id (it's the trades
// table primary key) and throws "insertTrade: required field(s) missing: id"
// when missing. On 2026-04-24 09:27 UTC this orphaned a SILVER trade record
// — the trade was placed on Capital.com and immediately voided, but the local
// DB never recorded it, so the Reflection agent could not learn from the loss.
//
// This helper guarantees an id is present without mutating the input. Use at
// the executeTool('log_trade') call site BEFORE calling insertTrade.
import { randomUUID } from 'crypto';

export function ensureTradeId<T extends { id?: string | null }>(
  trade: T,
): T & { id: string } {
  if (typeof trade.id === 'string' && trade.id.length > 0) {
    return trade as T & { id: string };
  }
  return { ...trade, id: `trade-${randomUUID()}` };
}

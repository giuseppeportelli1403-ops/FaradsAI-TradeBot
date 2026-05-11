// recordRejection() — single entry point for every silent or visible
// rejection across the four pipeline layers (scanner, analyst, executor,
// post_approval). Writes to either trade_rejections or analyst_log
// depending on the layer.
//
// Designed to be import-light: only depends on the database helpers and
// the categories enum. No transitive deps on agents/* or scanner/* —
// those are the callers.

import {
  insertRejection,
  updateAnalystLogCategory,
  getLastInsertedAnalystLogId,
} from '../database/index.js';
import {
  type RejectionCategory,
  type RejectionLayer,
  isFailClosed,
} from './categories.js';

export interface RecordRejectionInput {
  instrument: string;
  layer: RejectionLayer;
  category: RejectionCategory;
  reason_text: string;
  subcategory?: string;
  proposed_score?: number;
  proposed_tier?: number;
  request_id?: string;
  /**
   * For analyst-layer rejections, the id of the analyst_log row to update.
   * If omitted, falls back to last_insert_rowid() (works when called
   * immediately after logAnalystDecision in the same call stack).
   */
  analyst_log_id?: number;
}

/**
 * Record a rejection. Layer determines storage:
 *   - scanner / executor / post_approval → INSERT into trade_rejections
 *   - analyst                            → UPDATE analyst_log columns
 *                                          (set category, is_fail_closed,
 *                                          subcategory on the existing row)
 *
 * Throws on enum drift — passing an unknown category at runtime is a bug
 * worth surfacing immediately, not silently writing 'OTHER'.
 */
export function recordRejection(input: RecordRejectionInput): void {
  if (input.layer === 'analyst') {
    const id = input.analyst_log_id ?? getLastInsertedAnalystLogId();
    if (id === null) {
      // Fail-loud: an analyst rejection without an analyst_log row to attach to
      // means the caller skipped logAnalystDecision(). Better to throw than to
      // silently lose the category metadata.
      throw new Error(
        `recordRejection: analyst layer requires analyst_log_id (or a recent ` +
          `logAnalystDecision call). Got category=${input.category}, ` +
          `instrument=${input.instrument}.`
      );
    }
    updateAnalystLogCategory(
      id,
      input.category,
      isFailClosed(input.category),
      input.subcategory ?? null
    );
    return;
  }

  insertRejection({
    instrument: input.instrument,
    layer: input.layer,
    category: input.category,
    subcategory: input.subcategory ?? null,
    reason_text: input.reason_text,
    proposed_score: input.proposed_score ?? null,
    proposed_tier: input.proposed_tier ?? null,
    request_id: input.request_id ?? null,
  });
}

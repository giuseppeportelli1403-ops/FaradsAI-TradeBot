// src/scheduler/pnl-capture.ts
// P&L capture: pulls realised broker P&L from Capital.com's
// /history/transactions after a trade closes locally and persists it
// into the trades table. See 2026-05-11-trade-pnl-capture-plan.md.

/**
 * Capital.com returns `profitAndLoss` as a free-form string. Live demo
 * accounts have been observed emitting plain numerics ("12.50",
 * "-3.21"); live accounts sometimes prefix the account currency
 * symbol. This parser is conservative: strip whitespace, strip leading
 * currency symbol if present, strip thousand-separator commas, then
 * parseFloat. Returns null if the result is not a finite number — the
 * caller treats null as "no P&L data" and falls back accordingly.
 */
export function parsePnlString(raw: string | undefined): number | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.toUpperCase() === 'N/A') return null;
  // Strip a single leading currency symbol if present.
  const stripped = trimmed.replace(/^[€$£¥]/, '');
  // Drop thousand separators.
  const normalised = stripped.replace(/,/g, '');
  const n = parseFloat(normalised);
  return Number.isFinite(n) ? n : null;
}

import type { Transaction, TradeRecord } from '../types.js';

export interface MatchResult {
  /** Realised P&L attributed to leg A, or null if unmatched. */
  pnlA: number | null;
  /** Realised P&L attributed to leg B, or null if unmatched. */
  pnlB: number | null;
  /** Sum of all matched P&L lines (may include legs we couldn't attribute). */
  pnlTotal: number;
  /** Count of transactions that contributed to pnlTotal. */
  matched: number;
  /** Count of transactions skipped (wrong currency / null pnl / not a match). */
  unmatched: number;
  /** Free-form note for the audit log. */
  note: string;
}

/**
 * Match a list of Capital.com transactions against a trade record's
 * known legs. Capital's Transaction type lacks dealId / instrument, so
 * we match by `size` against the trade's recorded leg sizes. When leg
 * sizes are equal (ambiguous), we fall back to a total-only attribution
 * — pnl_total gets the sum, pnl_a / pnl_b stay null. This is "incomplete
 * but correct" — preferable to guessing which side got which.
 */
export function matchTransactionsToLegs(
  txs: Transaction[],
  trade: TradeRecord,
  accountCurrency: string,
): MatchResult {
  let pnlA: number | null = null;
  let pnlB: number | null = null;
  let pnlTotal = 0;
  let matched = 0;
  let unmatched = 0;
  const notes: string[] = [];

  const sizeA = trade.size_a;
  const sizeB = trade.size_b;
  const ambiguousSizes = Number.isFinite(sizeA) && Number.isFinite(sizeB) && sizeA === sizeB;

  for (const tx of txs) {
    if (tx.currency !== accountCurrency) {
      unmatched += 1;
      continue;
    }
    const pnl = parsePnlString(tx.profitAndLoss);
    if (pnl === null) {
      unmatched += 1;
      continue;
    }
    pnlTotal += pnl;
    matched += 1;

    if (ambiguousSizes) {
      continue; // can't attribute to a specific leg — pnlTotal still updated
    }
    if (Number.isFinite(sizeA) && tx.size === sizeA && pnlA === null) {
      pnlA = pnl;
    } else if (Number.isFinite(sizeB) && tx.size === sizeB && pnlB === null) {
      pnlB = pnl;
    }
  }

  if (ambiguousSizes && matched > 0) {
    notes.push('ambiguous leg sizes — pnl_total only');
  }

  return {
    pnlA,
    pnlB,
    pnlTotal,
    matched,
    unmatched,
    note: notes.join('; '),
  };
}

export interface PnlCaptureDeps {
  trade: TradeRecord;
  capital: { getTransactionHistory: (from?: string, to?: string) => Promise<Transaction[]> };
  accountCurrency: string;
  /**
   * `terminal` — query [opened_at, now+5min]. Used by TP2 and the
   *   terminal SL branch — wants to catch every leg-close that
   *   happened during the trade's lifetime.
   * `partial` — query [now−1min, now+5min]. Used by TP1 leg-A close
   *   and agent-initiated partial leg close — isolates the single
   *   transaction that just landed.
   * Default: 'terminal'.
   */
  windowMode?: 'terminal' | 'partial';
  now?: () => Date;
}

export interface PnlCaptureResult extends MatchResult {
  /** Whether anything was found at all — drives whether the caller writes to DB. */
  found: boolean;
}

/**
 * Orchestrator: query Capital transactions in a window around the
 * trade's open + close, match to legs, return the result. Never
 * throws — broker errors are caught and surfaced via note. Caller
 * decides what to do with a zero-match result.
 *
 * Window:
 *   terminal: from = trade.opened_at (truncated to Capital's strict
 *             YYYY-MM-DDTHH:mm:ss format), to = now + 5min
 *   partial:  from = now - 1min, to = now + 5min
 */
export async function capturePnlForTrade(deps: PnlCaptureDeps): Promise<PnlCaptureResult> {
  const { trade, capital, accountCurrency } = deps;
  const now = deps.now ? deps.now() : new Date();

  // Capital's /history/transactions rejects ISO with milliseconds or Z
  // suffix (`error.invalid.from`). The Monitor uses the same strip
  // pattern at scheduler/index.ts:299-301; replicated here.
  const toCapitalDateFmt = (iso: string): string =>
    iso.replace(/\.\d{3}Z$/, '').replace(/Z$/, '');

  const windowMode = deps.windowMode ?? 'terminal';
  const from =
    windowMode === 'terminal'
      ? toCapitalDateFmt(trade.opened_at)
      : toCapitalDateFmt(new Date(now.getTime() - 60_000).toISOString());
  const toDate = new Date(now.getTime() + 5 * 60_000);
  const to = toCapitalDateFmt(toDate.toISOString());

  let txs: Transaction[] = [];
  try {
    txs = await capital.getTransactionHistory(from, to);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      pnlA: null,
      pnlB: null,
      pnlTotal: 0,
      matched: 0,
      unmatched: 0,
      note: `capital error: ${msg}`,
      found: false,
    };
  }

  const match = matchTransactionsToLegs(txs, trade, accountCurrency);
  return { ...match, found: match.matched > 0 };
}

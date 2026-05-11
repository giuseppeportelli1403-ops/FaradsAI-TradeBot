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

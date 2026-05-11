// Scheduler — Candle Close Detection + Split-Position Monitoring + Agent Triggers
// The central nervous system that triggers all 6 agents at the right times.
//
// Capital.com executes SL/TP server-side, so the local monitoring loop is
// ONLY responsible for our custom 2-leg split-position logic:
//   Leg A hits TP1 → move Leg B SL to break-even (entry)
//   Leg B hits TP2 → trade complete, trigger reflection
//   Any leg hits SL → update status, finalise if both legs are closed
//
// (History: upgraded from 2-leg to 3-leg on 2026-04-21, then reverted to
// 2-leg on 2026-05-09 by Phase 2 migration — position_c_id / tp3 / size_c /
// pnl_c columns were dropped from the trades table. handleTp1Hit now only
// touches Leg B; there is no Leg C path.)
//
// Every 8 minutes we ping the Capital.com session to keep it warm (their
// tokens idle out around 10 minutes).

import cron from 'node-cron';
import { spawn } from 'child_process';
import { runTradingAgent } from '../agents/trading-agent.js';
// Swing Agent removed 2026-04-23 — the subsystem used too many Claude API
// tokens relative to its profit contribution. Historical SWING-tagged trades
// in the DB remain queryable (the StrategyTag enum and CHECK constraint still
// allow 'SWING' for backward compat), but no new Swing trades will be
// generated. Researcher no longer emits a swing_shortlist.
import { runResearcherAgent } from '../agents/researcher-agent.js';
import { runReflectionAgent } from '../agents/reflection-agent.js';
import { runWeeklyReviewAgent } from '../agents/review-agent.js';
import { runEodJournalAgent } from '../agents/eod-journal-agent.js';
import { pollAllFeeds } from '../news/rss-aggregator.js';
import {
  getActiveSlTpOrders as realGetActiveSlTpOrders,
  deactivateSlTpOrder as realDeactivateSlTpOrder,
  updateTradeStatus as realUpdateTradeStatus,
  getTradeById as realGetTradeById,
} from '../database/index.js';
import { getCurrentKillZone } from '../scanner/index.js';
import { CapitalClient } from '../mcp-server/capital-client.js';
import {
  alertTp1Hit as realAlertTp1Hit,
  alertTp2Hit as realAlertTp2Hit,
  alertSlHit as realAlertSlHit,
  alertSystemWarning as realAlertSystemWarning,
} from '../notifications/telegram.js';
import type { CapitalPosition, Activity, TradeRecord, TradeStatus } from '../types.js';
import { summarizeError } from './error-summary.js';
import { typicalSpread } from '../backtest/realism.js';
import { capturePnlForTrade, captureAndPersistPnl, type PnlCaptureResult } from './pnl-capture.js';
import {
  setTradePnl as realSetTradePnl,
  aggregateAndUpsertDailyPnl,
  getDailyPnl,
  getTradesWithMissingPnl,
} from '../database/index.js';

const capital = new CapitalClient({
  apiKey: process.env.CAPITAL_API_KEY || '',
  identifier: process.env.CAPITAL_IDENTIFIER || '',
  password: process.env.CAPITAL_API_KEY_PASSWORD || '',
  baseURL: process.env.CAPITAL_API_URL || 'https://demo-api-capital.backend-capital.com',
});

// ==================== DEPENDENCY-INJECTION SURFACE ====================
// monitorSplitPositions() is called in production from the cron loop with no
// arguments — it then uses the real Capital client, real DB, real Telegram.
// For unit tests we inject mocks via the optional `deps` parameter so the
// orchestration logic (if/else tree across TP/SL/OTHER + leg-B second pass)
// can be exercised without touching the network or the sqlite file.
// Production behaviour is unchanged when `deps` is undefined.

export interface MonitorDeps {
  // 2026-04-29 audit-3 r6: added 'getMarketDetails' for price-proximity
  // close-reason classification.
  capital: Pick<
    CapitalClient,
    'getOpenPositions' | 'getActivityHistory' | 'updatePosition' | 'safelyAmendPosition' | 'getMarketDetails'
  >;
  getActiveSlTpOrders: typeof realGetActiveSlTpOrders;
  getTradeById: typeof realGetTradeById;
  deactivateSlTpOrder: typeof realDeactivateSlTpOrder;
  updateTradeStatus: typeof realUpdateTradeStatus;
  alertTp1Hit?: typeof realAlertTp1Hit;
  alertTp2Hit?: typeof realAlertTp2Hit;
  alertSlHit?: typeof realAlertSlHit;
  /** Optional: called after a leg closes to retrieve realised P&L from the
   *  broker. Best-effort — if absent or throws, status update is unaffected. */
  capturePnl?: (trade: TradeRecord, windowMode?: 'terminal' | 'partial') => Promise<PnlCaptureResult>;
  /** Optional: injected so tests can stub it without touching the real DB. */
  setTradePnl?: typeof realSetTradePnl;
}

// 2026-04-29 audit-3 r6: price-proximity helper. Fetches current market
// price for a trade's epic and returns the mid (bid+offer)/2 for use in
// classifyCloseReason's Tier-2 distance check. Returns null on any
// failure — caller falls back to 'OTHER' in that case (existing behavior
// for unclassifiable closes is to deactivate-without-status, which is
// safer than guessing).
async function fetchClosePriceForTrade(
  trade: TradeRecord,
  capital: Pick<CapitalClient, 'getMarketDetails'>,
): Promise<number | null> {
  try {
    // The Capital `epic` is what the bot recorded on placement. We need
    // the same value for getMarketDetails. For our 7-instrument universe
    // epic == ticker (per the scanner invariant test), so trade.instrument
    // works as the epic too. If a future universe addition uses different
    // epic ↔ ticker mapping we'll need a lookup helper.
    const md = await capital.getMarketDetails(trade.instrument);
    const bid = md?.snapshot?.bid;
    const offer = md?.snapshot?.offer;
    if (typeof bid === 'number' && typeof offer === 'number' && Number.isFinite(bid) && Number.isFinite(offer)) {
      return (bid + offer) / 2;
    }
    return null;
  } catch (err) {
    console.warn(`[Monitor] fetchClosePriceForTrade failed for ${trade.instrument}: ${summarizeError(err)}`);
    return null;
  }
}

// Track last processed candle timestamps to detect new closes
let last15mCandle = '';
let last1hCandle = '';

// ==================== CANDLE CLOSE DETECTION ====================

/** Build a padded ISO-style candle key. Exported for testing. */
export function makeCandleKey(date: Date, timeframe: '15m' | '1h'): string {
  const y = date.getUTCFullYear();
  const mo = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const h = String(date.getUTCHours()).padStart(2, '0');

  if (timeframe === '1h') {
    return `${y}-${mo}-${d}T${h}:00`;
  }

  const candleMinute = Math.floor(date.getUTCMinutes() / 15) * 15;
  const m = String(candleMinute).padStart(2, '0');
  return `${y}-${mo}-${d}T${h}:${m}`;
}

async function check15mCandleClose(): Promise<boolean> {
  const now = new Date();
  const candleKey = makeCandleKey(now, '15m');

  if (candleKey !== last15mCandle && now.getUTCMinutes() % 15 < 5) {
    last15mCandle = candleKey;
    return true;
  }
  return false;
}

async function check1hCandleClose(): Promise<boolean> {
  const now = new Date();
  const candleKey = makeCandleKey(now, '1h');

  if (candleKey !== last1hCandle && now.getUTCMinutes() < 5) {
    last1hCandle = candleKey;
    return true;
  }
  return false;
}

// ==================== SPLIT-POSITION MONITORING ====================
// Capital.com handles SL/TP/trailing server-side. All we need to detect is:
//   Position A (the TP1 leg) closed by Capital → if it was a TP hit, move
//   Position B's SL to break-even (our custom split-position rule).

/** Classify why a Capital position closed.
 *
 * 2026-04-29 audit-3 r6 P0: previously this read `a.activity` against
 * Capital's response, but live probing showed Capital uses `type` (not
 * `activity`) and the `status` field is just `"ACCEPTED"` / `"EXECUTED"` —
 * never `"PROFIT_HIT"` / `"STOP_HIT"`. Result: every close classified as
 * `'OTHER'` in production. Unit tests passed only because their fixture
 * status strings (PROFIT_HIT etc.) don't reflect Capital's real shape.
 *
 * Two-tier classifier:
 *
 *   Tier 1 — activity-string match (legacy / future-proof). Reads BOTH
 *   `a.type` and `a.activity` (back-compat) and BOTH `a.status` for any
 *   keyword fingerprint of TP vs SL. In real Capital data this never
 *   hits today, but if Capital ever adds explicit lifecycle-event status
 *   strings we get it for free.
 *
 *   Tier 2 — price proximity (load-bearing). When Tier 1 returns 'OTHER',
 *   we look up the trade's recorded SL + TP1/TP2/TP3 and compare the
 *   leg's TP target against the SL using the supplied `closePrice` (from
 *   getMarketDetails snapshot, queried by the caller right when the
 *   close was detected). Whichever level the price is closer to is the
 *   level that was hit. Robust to spread/wick because typical SL-to-TP
 *   distances are >> typical wick errors.
 *
 * Returns 'OTHER' only when (a) Tier 1 misses AND (b) Tier 2 inputs are
 * unavailable (no trade record, no closePrice). Caller can then decide
 * to fall back to deactivate-without-status or fetch a fresh price.
 */
export function classifyCloseReason(
  activities: Activity[],
  dealId: string,
  // Optional price-proximity inputs. When supplied and Tier 1 misses,
  // we use the trade's recorded levels + closePrice to decide.
  trade?: TradeRecord,
  leg?: 'A' | 'B',
  closePrice?: number,
): 'TP' | 'SL' | 'OTHER' {
  const relevant = activities.filter((a) => a.dealId === dealId);

  // ----- Tier 0: Capital's `source` field -----
  // 2026-05-07 live incident: SILVER Leg B closed via TP2 limit fill, but
  // classifyCloseReason returned 'SL'. The activity history contained
  // three preceding EDIT_STOP_AND_LIMIT events (SL→BE move on TP1 hit +
  // a manual recovery PUT). Tier 1's blob match found 'STOP' inside
  // 'EDIT_STOP_AND_LIMIT' → returned 'SL' before ever reading the actual
  // close activity, which Capital tagged with source='TP'. Bot routed
  // the close to handleSlOnLeg (early-return branch), Leg C's SL was
  // never trailed to TP1, manual fix required.
  //
  // Capital sets `source` to 'TP' / 'SL' on close events triggered by a
  // limit/stop fill, and to 'USER' / 'DEALER' / 'SYSTEM' / 'CLOSE_OUT'
  // on edits, opens, manual closes, and admin actions. Reading it
  // directly sidesteps both this bug and the STOP_LIMIT BUG-S2 case
  // (STOP_LIMIT fills still surface source='SL').
  //
  // Defensive guard: ignore EDIT_* activity types even if `source` is
  // 'TP'/'SL'. Today's live sample shows edits carry source='USER', but
  // if Capital ever tags an amend with source='SL' (e.g. trailing-stop
  // edit annotation), we must not promote that to a close classification.
  // Only POSITION/WORKING_ORDER activities can represent a close.
  // Coverage gap (deferred): trailing-stop fills, guaranteed-stop fills,
  // and forced liquidation (source='CLOSE_OUT') are unverified — they
  // fall through to Tier 1/2 same as before this patch.
  const sourceMatch = relevant.find(
    (a) =>
      (a.source === 'TP' || a.source === 'SL') &&
      !(a.type ?? '').toUpperCase().startsWith('EDIT'),
  );
  if (sourceMatch) return sourceMatch.source as 'TP' | 'SL';

  // ----- Tier 1: activity-string match (back-compat for old fixtures
  // and any close where Capital omits `source`) -----
  for (const a of relevant) {
    // 2026-04-29: include `a.type` (real Capital field) AND `a.activity`
    // (legacy / test-fixture field) so this works on both real data and
    // existing tests. STOP/SL_ takes priority over PROFIT/LIMIT/TP_ to
    // prevent the BUG-S2 STOP_LIMIT misclassification.
    //
    // 2026-05-07 NB: this tier is now reached only when no activity
    // for the dealId carries source='TP'|'SL'. Tier 0 catches the
    // EDIT_STOP_AND_LIMIT-preceded-by-TP-close case structurally.
    const blob = `${a.type ?? ''} ${a.activity ?? ''} ${a.status}`.toUpperCase();
    if (blob.includes('STOP') || blob.includes('SL_')) return 'SL';
    if (blob.includes('PROFIT') || blob.includes('LIMIT') || blob.includes('TP_')) return 'TP';
  }

  // ----- Tier 2: price proximity -----
  if (trade && leg && typeof closePrice === 'number' && Number.isFinite(closePrice)) {
    const slLevel = trade.sl;
    const tpLevel = leg === 'A' ? trade.tp1 : trade.tp2;
    if (Number.isFinite(slLevel) && Number.isFinite(tpLevel)) {
      const slDist = Math.abs(closePrice - slLevel);
      const tpDist = Math.abs(closePrice - tpLevel);
      // If SL and TP are equidistant (extremely unlikely), prefer SL —
      // safer to flag as a stop-out than to mark a loss as a win.
      return slDist <= tpDist ? 'SL' : 'TP';
    }
  }

  return 'OTHER';
}

/** Build the default production dependency set — the real Capital client, the
 *  real sqlite-backed DB functions, and the real Telegram alerters. Kept as a
 *  factory so we only capture the module-level `capital` singleton lazily. */
function defaultMonitorDeps(): MonitorDeps {
  return {
    capital,
    getActiveSlTpOrders: realGetActiveSlTpOrders,
    getTradeById: realGetTradeById,
    deactivateSlTpOrder: realDeactivateSlTpOrder,
    updateTradeStatus: realUpdateTradeStatus,
    alertTp1Hit: realAlertTp1Hit,
    alertTp2Hit: realAlertTp2Hit,
    alertSlHit: realAlertSlHit,
    capturePnl: (trade: TradeRecord, windowMode: 'terminal' | 'partial' = 'terminal') =>
      capturePnlForTrade({
        trade,
        capital,
        accountCurrency: process.env.CAPITAL_ACCOUNT_CURRENCY ?? 'EUR',
        windowMode,
      }),
    setTradePnl: realSetTradePnl,
  };
}

export async function monitorSplitPositions(deps?: MonitorDeps): Promise<void> {
  const d = deps ?? defaultMonitorDeps();

  const activeOrders = d.getActiveSlTpOrders();
  if (activeOrders.length === 0) return;

  // Fetch open positions + activity history once per tick to avoid hammering the API.
  // 2026-04-29 audit-3 fix (scheduler-audit BUG-S3): pass explicit `from`
  // (24h ago) instead of relying on Capital's undocumented default lookback.
  // Pre-fix: a leg closed > Capital's default window (sometimes a few hours)
  // returned no activity → classifyCloseReason='OTHER' → Leg-A 'OTHER'
  // branch only deactivates the row WITHOUT updating trade status, leaving
  // the trade permanently stuck at 'open' in DB and distorting kill-switch
  // exposure math. 24h is comfortably wider than any realistic monitor
  // gap (cron is */5; even multi-hour outages stay inside this window).
  //
  // 2026-04-29 hotfix (audit-3-r5): Capital.com's /history/activity rejects
  // ISO with milliseconds or trailing Z (`error.invalid.from`). Required
  // format is `YYYY-MM-DDTHH:mm:ss` — no ms, no zone suffix, treated by the
  // API as broker-local time. Strip both off the toISOString output.
  let openPositions: CapitalPosition[];
  let activities: Activity[];
  const activityFrom = new Date(Date.now() - 24 * 60 * 60_000)
    .toISOString()
    .replace(/\.\d{3}Z$/, '');
  try {
    [openPositions, activities] = await Promise.all([
      d.capital.getOpenPositions(),
      d.capital.getActivityHistory(activityFrom),
    ]);
  } catch (error) {
    // Don't pass the raw error as a second arg — util.inspect on an
    // AxiosError leaks live auth headers (CST / X-SECURITY-TOKEN /
    // X-CAP-API-KEY) into pm2-err.log. summarizeError keeps the HTTP
    // signal but drops headers and the ClientRequest chain.
    console.error(`[Monitor] Failed to fetch Capital state this tick: ${summarizeError(error)}`);
    return;
  }

  const openDealIds = new Set(openPositions.map((p) => p.position.dealId));

  // 3-leg monitor: split the already-fetched activeOrders by leg and iterate
  // each in its own pass. Each handler (handleTp1Hit / handleTp2Hit / etc.)
  // deactivates the closed row internally, so we don't need to re-query
  // between passes. handleSlOnLeg queries fresh to check cross-leg state
  // when deciding whether the trade is fully closed.
  //
  // Legacy 2-leg trades have no Leg C row in sl_tp_orders, so the third
  // pass is naturally a no-op for them.
  const legAOrders = activeOrders.filter((o) => o.leg === 'A');
  const legBOrders = activeOrders.filter((o) => o.leg === 'B');

  // 2026-04-29 audit-3 fix (P0-5/P0-6 + scheduler-audit BUG-S1): single
  // reflection trigger gated on actual finalisation. Pre-fix gaps:
  //   1. Pass 2 legacy 2-leg `handleTp2Hit` finalised the trade to 'complete'
  //      but Reflection was NEVER queued — silent learning loss on every
  //      legacy 2-leg trade.
  //   2. Pass 1 / Pass 2 `handleSlOnLeg` finalising path (when other legs
  //      were already deactivated and this leg's SL hit) also never queued
  //      Reflection — silent loss on partial-leg trades that finalised on
  //      Leg A or B rather than Leg C.
  //   3. Pass 3 `handleSlOnLeg` queued Reflection UNCONDITIONALLY, even when
  //      other legs were still active. Reflection then ran on a still-open
  //      trade with `closed_at = null`, polluting the lessons table.
  //
  // 2026-05-05 (Phase 2 / Round 3 / item 3.2): added optional `postHandlerStatus`
  // parameter so callers that already know the post-handler status (e.g. the
  // Pass 3 path after handleTp3Hit, which always sets 'complete') can skip
  // the DB re-query entirely. When omitted, falls back to the original
  // re-query path. SQL.js is synchronous + in-memory so the re-query path is
  // still reliable today, but the explicit-status path is forward-defensive
  // against any future async-DB migration AND more testable.
  //
  // Skips when `deps` is injected (test path) so test runs don't kick off
  // real LLM calls.
  const queueReflectionIfFinalised = (
    tradeId: string,
    postHandlerStatus?: TradeStatus,
  ): void => {
    if (deps) return; // test path — never fire real Reflection
    decideReflectionQueue(tradeId, postHandlerStatus, {
      getTradeById: d.getTradeById,
      runReflection: runReflectionAgent,
      schedule: (fn, ms) => { setTimeout(fn, ms); },
    });
  };

  // ---------- Pass 1: Leg A ----------
  for (const order of legAOrders) {
    if (!order.deal_id) continue;
    try {
      if (openDealIds.has(order.deal_id)) continue;

      const trade = d.getTradeById(order.trade_id);
      if (!trade) {
        console.warn(`[Monitor] Trade ${order.trade_id} not found for closed Leg A`);
        d.deactivateSlTpOrder(order.trade_id, 'A');
        continue;
      }
      // Tier-2 price-proximity input. Fetched per-leg-close, not per-tick,
      // to avoid wasting Capital quota when nothing closed.
      const closePrice = await fetchClosePriceForTrade(trade, d.capital);
      const reason = classifyCloseReason(activities, order.deal_id, trade, 'A', closePrice ?? undefined);

      if (reason === 'TP') {
        await handleTp1Hit(trade, order.trade_id, d);
      } else if (reason === 'SL') {
        await handleSlOnLeg(trade, order.trade_id, 'A', d);
      } else {
        console.warn(
          `[Monitor] Leg A for trade ${order.trade_id} (deal ${order.deal_id}) ` +
            `closed but reason could not be classified (closePrice=${closePrice ?? 'unavailable'}). Deactivating Leg A only.`,
        );
        d.deactivateSlTpOrder(order.trade_id, 'A');
      }
      queueReflectionIfFinalised(order.trade_id);
    } catch (error) {
      // summarizeError — see error-summary.ts. Prevents credential leaks
      // when the error originates from a Capital.com axios call.
      console.error(`[Monitor] Error processing Leg A for trade ${order.trade_id}: ${summarizeError(error)}`);
    }
  }

  // ---------- Pass 2: Leg B ----------
  for (const order of legBOrders) {
    if (!order.deal_id) continue;
    try {
      if (openDealIds.has(order.deal_id)) continue;

      const trade = d.getTradeById(order.trade_id);
      if (!trade) {
        d.deactivateSlTpOrder(order.trade_id, 'B');
        continue;
      }
      const closePrice = await fetchClosePriceForTrade(trade, d.capital);
      const reason = classifyCloseReason(activities, order.deal_id, trade, 'B', closePrice ?? undefined);

      if (reason === 'TP') {
        await handleTp2Hit(trade, order.trade_id, d);
      } else {
        // SL or OTHER: B exited at its SL (entry after TP1, or original SL if A hit SL first).
        await handleSlOnLeg(trade, order.trade_id, 'B', d);
      }
      queueReflectionIfFinalised(order.trade_id);
    } catch (error) {
      console.error(`[Monitor] Error processing Leg B for trade ${order.trade_id}: ${summarizeError(error)}`);
    }
  }

}

/**
 * Computes the SL value to amend a runner leg to on TP1 fill.
 * Returns entry ± max(0.1R, 2 × typicalSpread(instrument)), signed by direction.
 * The spread floor guards against the SL landing inside the bid-ask on
 * unusually small-R FX trades (e.g. EURUSD with a 5-pip stop). Falls back to
 * exact entry with a warning if R is zero (data integrity guard).
 */
export function computeBeStop(args: {
  direction: 'long' | 'short';
  entry: number;
  sl: number;
  instrument: string;
}): number {
  const { direction, entry, sl, instrument } = args;
  const r = Math.abs(entry - sl);
  if (r === 0) {
    console.warn(
      `[computeBeStop] ${instrument} has zero R (entry=sl=${entry}); falling back to exact entry`,
    );
    return entry;
  }
  const spreadFloor = 2 * typicalSpread(instrument);
  const offset = Math.max(0.1 * r, spreadFloor);
  const sign = direction === 'long' ? +1 : -1;
  return entry + sign * offset;
}

/** Leg A closed at TP1 → partial profit taken, move B+C SL to break-even
 *  (entry price) so the remaining profit legs are risk-free. */
export async function handleTp1Hit(
  trade: TradeRecord,
  tradeId: string,
  deps?: MonitorDeps,
): Promise<void> {
  const d = deps ?? defaultMonitorDeps();
  d.updateTradeStatus(tradeId, 'tp1_hit');
  d.deactivateSlTpOrder(tradeId, 'A');

  // Move Position B's (and Position C's, on 3-leg trades) SL just past
  // break-even by max(0.1R, 2×spread). safelyAmendPosition round-trips
  // broker-side stopLevel/profitLevel/trailingStop so the SL change doesn't
  // strip the existing TP. Observed live 2026-05-07 on a SILVER 3-leg trade:
  // a partial-body amend ({ stopLevel: x }) had nulled both runners' TPs
  // server-side, leaving them uncapped on the upside.
  //
  // The offset (vs. exact entry) protects the runners from getting wicked-out
  // by normal bid-ask oscillation around the entry price right after TP1
  // fills. The spread floor is the real safety net — on tight-stop FX where
  // 0.1R can be smaller than the typical bid-ask, exact-entry SLs would close
  // immediately on the next tick.
  const beStop = computeBeStop({
    direction: trade.direction,
    entry: trade.entry,
    sl: trade.sl,
    instrument: trade.instrument,
  });

  const moveLegSlToBe = async (leg: 'B', dealId: string) => {
    try {
      const result = await d.capital.safelyAmendPosition(dealId, { stopLevel: beStop });
      // applied===false explicitly means race-skip; undefined falls through as
      // "applied" (defensive default — covers any future code path that forgets
      // to tag the response).
      if (result?.applied === false) {
        console.log(
          `[TP1] ${trade.instrument} — Position ${leg} SL→${beStop.toFixed(5)} skipped (race against fast TP fill)`,
        );
      } else {
        console.log(
          `[TP1] ${trade.instrument} — Position ${leg} SL→${beStop.toFixed(5)} applied`,
        );
      }
    } catch (error) {
      console.error(
        `[TP1] Failed to move Position ${leg} SL for ${tradeId}: ${summarizeError(error)}`,
      );
    }
  };

  if (trade.position_b_id) await moveLegSlToBe('B', trade.position_b_id);

  // Capture leg-A realised P&L. Partial windowMode: tight [now-1min, now+5min]
  // window isolates only the just-landed leg-A close transaction. Leg B stays
  // open — don't write pnlB here.
  if (d.capturePnl) {
    await captureAndPersistPnl({
      trade,
      capture: () => d.capturePnl!(trade, 'partial'),
      persist: d.setTradePnl ?? realSetTradePnl,
      logTag: '[pnl-capture:tp1]',
      legHint: 'A',
    });
  }

  try {
    if (d.alertTp1Hit) await d.alertTp1Hit(trade);
  } catch (e) {
    console.error(`[Monitor] Telegram TP1 alert failed: ${summarizeError(e)}`);
  }
}

/** Leg B closed at TP2 → Position A + B both done at profit.
 *  Terminal: 2-leg trade is fully complete on TP2 fill. Deactivate Leg B,
 *  mark trade complete, fire alertTp2Hit. */
export async function handleTp2Hit(
  trade: TradeRecord,
  tradeId: string,
  deps?: MonitorDeps,
): Promise<void> {
  const d = deps ?? defaultMonitorDeps();
  d.deactivateSlTpOrder(tradeId, 'B');
  d.updateTradeStatus(tradeId, 'complete');

  // Capture realised broker P&L. Best-effort: if it fails the status update
  // has already landed; the daily aggregator's self-healing retry will
  // re-attempt on the next run.
  if (d.capturePnl) {
    await captureAndPersistPnl({
      trade,
      capture: () => d.capturePnl!(trade, 'terminal'),
      persist: d.setTradePnl ?? realSetTradePnl,
      logTag: '[pnl-capture:tp2]',
    });
  }

  try {
    if (d.alertTp2Hit) await d.alertTp2Hit(trade);
  } catch (e) {
    console.error(`[Monitor] Telegram TP2 alert failed: ${summarizeError(e)}`);
  }
}

/** A leg hit its SL. The meaning varies by leg:
 *   Leg A SL = trade stopped out before any TP hit (worst case — full loss).
 *   Leg B SL = B stopped at BE after A hit TP1 (partial profit realised on A, 0 on B).
 *   Leg C SL = C stopped at TP1 trailing after A+B TPs (partial profit on C too).
 *
 *  We deactivate the closed leg, update pnl status, and finalise the trade
 *  to 'complete' or 'sl_hit' based on whether any TP was reached earlier.
 *  The alert variant we fire depends on the trade.status before this SL event. */
export async function handleSlOnLeg(
  trade: TradeRecord,
  tradeId: string,
  leg: 'A' | 'B',
  deps?: MonitorDeps,
): Promise<void> {
  const d = deps ?? defaultMonitorDeps();
  d.deactivateSlTpOrder(tradeId, leg);

  // If any other legs are still active, don't finalise the trade yet —
  // later passes (this tick or future ticks) will detect them closing.
  const stillActive = d.getActiveSlTpOrders().filter((o) => o.trade_id === tradeId);
  if (stillActive.length > 0) {
    // Interim SL — trade not fully closed yet. Don't alert yet.
    console.log(
      `[SL] Leg ${leg} for trade ${tradeId} hit SL; ${stillActive.length} leg(s) still active, waiting.`,
    );
    return;
  }

  // All legs closed. Final status: 'complete' if any TP was reached, 'sl_hit' if pure loss.
  const anyTpHit = trade.status === 'tp1_hit';
  const finalStatus: TradeStatus = anyTpHit ? 'complete' : 'sl_hit';
  d.updateTradeStatus(tradeId, finalStatus);

  // Capture realised broker P&L for the fully-closed trade. Terminal window:
  // [opened_at, now+5min] to catch all legs that closed during the trade's lifetime.
  if (d.capturePnl) {
    await captureAndPersistPnl({
      trade,
      capture: () => d.capturePnl!(trade, 'terminal'),
      persist: d.setTradePnl ?? realSetTradePnl,
      logTag: '[pnl-capture:sl]',
    });
  }

  try {
    if (finalStatus === 'sl_hit') {
      if (d.alertSlHit) await d.alertSlHit(trade);
    } else {
      // Partial-win close — use alertTp2Hit which already describes a
      // completed trade with P&L.
      if (d.alertTp2Hit) await d.alertTp2Hit(trade);
    }
  } catch (e) {
    console.error(`[Monitor] Telegram SL-close alert failed: ${summarizeError(e)}`);
  }
}

// ==================== KEEP-ALIVE ====================

export interface PingDeps {
  capital: Pick<CapitalClient, 'ping'>;
  alertSystemWarning: (message: string) => Promise<void>;
}

// 2026-05-08 (post-demo cleanup item 8): suppress Telegram noise from
// transient Capital.com ping failures. Pre-fix, every single ECONNABORTED
// (typically 1-3 per day, all self-healing on the next 8-min cron tick)
// fired a Telegram alert — Giuseppe got woken at odd hours for a problem
// that had already resolved by the time he read the message. The keep-alive
// path is self-healing by design (next tick re-establishes the session)
// so a single failure is operationally meaningless.
//
// Now: Telegram fires once when the failure streak first reaches
// PING_ALERT_THRESHOLD (3 consecutive failures = ~24 min of dead session
// at the */8 cron cadence). Subsequent failures stay quiet via the
// `pingAlertedThisOutage` flag — one alert per outage, not per cron.
// A successful ping resets both streak and flag.
//
// pingInFlight guards against overlap: node-cron does not await the
// callback, so if a tick takes longer than the 8-min cadence (e.g. a
// hung TCP socket on a dead session) the next tick could fire while the
// previous one is still awaiting capital.ping(). Concurrent
// read-modify-write on `pingFailureStreak` could double-count failures
// or miss the threshold-crossing alert. The guard makes overlapping
// invocations a no-op.
//
// Threshold gate uses `>=` (not `===`) plus the alerted flag so a
// race-overshoot streak (e.g. 2→4 instead of 2→3→…) still triggers
// the alert exactly once.
//
// Note: NO retry/backoff added — that would be a stateful behavioural
// change. The cron itself IS the retry; we just stop alerting on the noise.
const PING_ALERT_THRESHOLD = 3;
let pingFailureStreak = 0;
let pingAlertedThisOutage = false;
let pingInFlight = false;

/** Test-only: reset the keep-alive failure streak + alert flag + in-flight guard. */
export function _resetPingFailureStreak(): void {
  pingFailureStreak = 0;
  pingAlertedThisOutage = false;
  pingInFlight = false;
}

/** Test-only: read the keep-alive failure streak. */
export function _getPingFailureStreak(): number {
  return pingFailureStreak;
}

/**
 * Blocker-6 keep-alive. Fires capital.ping() and surfaces sustained failures
 * through Telegram so Giuseppe learns about a dead session without having to
 * watch logs. Swallows the thrown error so cron doesn't crash the scheduler
 * on a transient Capital outage.
 *
 * Alerts are suppressed for the first PING_ALERT_THRESHOLD - 1 consecutive
 * failures (transient noise). The threshold-crossing alert fires once; further
 * consecutive failures stay quiet until a success resets the streak. This
 * gives one alert per outage, not one per cron tick.
 *
 * Exported + dependency-injected so the alert path can be unit-tested.
 */
export async function pingKeepAlive(deps?: PingDeps): Promise<void> {
  if (pingInFlight) return;
  pingInFlight = true;
  try {
    const d: PingDeps = deps ?? {
      capital: capital,
      alertSystemWarning: realAlertSystemWarning,
    };
    try {
      await d.capital.ping();
      pingFailureStreak = 0;
      pingAlertedThisOutage = false;
    } catch (error) {
      const summary = summarizeError(error);
      pingFailureStreak += 1;
      console.error(
        `[Scheduler] Capital ping failed (streak ${pingFailureStreak}): ${summary}`,
      );
      if (pingFailureStreak < PING_ALERT_THRESHOLD || pingAlertedThisOutage) return;
      pingAlertedThisOutage = true;
      try {
        await d.alertSystemWarning(
          `Capital.com ping failed ${pingFailureStreak} consecutive times (~${pingFailureStreak * 8} min): ${summary}`,
        );
      } catch (alertError) {
        console.error(`[Scheduler] Telegram alert for ping failure also failed: ${summarizeError(alertError)}`);
      }
    }
  } finally {
    pingInFlight = false;
  }
}

// ==================== AGENT RUNNERS WITH ERROR HANDLING ====================

async function safeRun(name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    console.log(`[Scheduler] Triggering ${name}...`);
    await fn();
    console.log(`[Scheduler] ${name} complete.`);
  } catch (error) {
    console.error(`[Scheduler] ${name} failed: ${summarizeError(error)}`);
  }
}

// ==================== START SCHEDULER ====================

// CR-9 (2026-04-28): Codex flagged that node-cron schedules in the host's
// LOCAL timezone unless explicit. The bot is documented as running on UTC
// throughout (kill zones, daily reset, EOD journal "after US close"); on a
// VPS in any non-UTC zone the EOD cron would fire at 21:30 LOCAL, NOT UTC.
// Hetzner Nuremberg is currently UTC+1 (winter) / UTC+2 (summer), so the
// daily Researcher would have run at 04:30 UTC and the EOD Journal at
// 19:30 UTC. Pass {timezone: 'UTC'} on every cron.schedule below to lock
// the contract.
const CRON_UTC = { timezone: 'UTC' as const };

// 2026-05-05 audit (Phase 2 / Round 3 / item 3.3): initial-RSS-poll retry.
// Pre-fix the boot-time `pollAllFeeds().catch(...)` swallowed all errors
// silently. On a network blip / DNS lag at boot, the first 3-4 trading
// cycles operated with zero RSS news context — bot trades blind to news
// flow until the next */10 cron tick.
//
// Post-fix: 3-attempt retry chain (1s, 5s, 15s backoff). On final failure
// emit a Telegram [BOOT] alert and continue (do not block boot — ICT can
// still run with empty news, just with degraded context).
//
// Pure helper so tests can inject the poller and alerter (and override
// delays for fast tests).
export async function pollWithRetry(
  poll: () => Promise<void>,
  alert: (msg: string) => Promise<void>,
  delaysMs: number[] = [1_000, 5_000, 15_000],
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  let lastError: string = '';
  for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
    try {
      await poll();
      if (attempt > 0) {
        console.log(`[Scheduler] Initial RSS poll succeeded on attempt ${attempt + 1}.`);
      }
      return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt < delaysMs.length) {
        console.warn(
          `[Scheduler] Initial RSS poll attempt ${attempt + 1} failed: ${lastError}. ` +
            `Retrying in ${Math.round(delaysMs[attempt] / 1000)}s.`,
        );
        await sleep(delaysMs[attempt]);
      }
    }
  }
  console.error(
    `[Scheduler] Initial RSS poll FAILED after ${delaysMs.length + 1} attempts. Last error: ${lastError}. ` +
      `First trading cycles will operate with empty news context until the next */10 RSS cron tick.`,
  );
  await alert(
    `[BOOT] Initial RSS poll failed after ${delaysMs.length + 1} attempts. Last error: ${lastError}.`,
  ).catch(() => {
    /* alert failure is non-blocking — boot continues regardless */
  });
}

// 2026-05-05 audit (Phase 2 / Round 3 / item 3.2): pure reflection-queue
// decision function. Extracted from the closure in monitorSplitPositions so
// the post-handler-status logic is testable in isolation. Returns true iff
// Reflection was scheduled. Pure — schedule() lets tests inject a synchronous
// stub instead of setTimeout.
export interface ReflectionQueueDeps {
  getTradeById: (id: string) => TradeRecord | null;
  runReflection: (id: string) => Promise<void>;
  schedule: (fn: () => void, ms: number) => void;
}

export function decideReflectionQueue(
  tradeId: string,
  postHandlerStatus: TradeStatus | undefined,
  deps: ReflectionQueueDeps,
): boolean {
  const status = postHandlerStatus ?? deps.getTradeById(tradeId)?.status;
  if (!status) return false;
  if (status !== 'complete' && status !== 'sl_hit' && status !== 'closed_early') {
    return false;
  }
  deps.schedule(
    () => deps.runReflection(tradeId).catch(
      (e) => console.error(`[Reflection] runReflectionAgent failed: ${summarizeError(e)}`),
    ),
    1000,
  );
  return true;
}

// 2026-05-05 audit (Phase 2 / Round 3 / item 3.1): single-slot overlap queue.
// Pre-fix: a 15m candle close arriving while ICT was in-flight was silently
// dropped — entire 15-minute setup window skipped. Post-fix: queue the most
// recent close (single-slot — older queued closes are stale by definition),
// drain after the in-flight cycle finishes if still inside the kill zone
// and the queued entry is younger than the maxAge bound (default 15 min).

export interface OverlapQueueState {
  pending: { reason: string; queuedAt: number } | null;
}

export function makeOverlapQueueState(): OverlapQueueState {
  return { pending: null };
}

export function queueOverlap(state: OverlapQueueState, reason: string, now: number): void {
  state.pending = { reason, queuedAt: now };
}

/**
 * Drain the queue. Returns the queued entry if present AND younger than
 * maxAgeMs; null otherwise. ALWAYS clears the slot, even on stale skip,
 * so a follow-up queueOverlap call works correctly.
 */
export function drainOverlap(
  state: OverlapQueueState,
  now: number,
  maxAgeMs: number,
): { reason: string; queuedAt: number } | null {
  if (!state.pending) return null;
  const drained = state.pending;
  state.pending = null;
  if (now - drained.queuedAt > maxAgeMs) return null;
  return drained;
}

export function startScheduler(): void {
  console.log('Starting scheduler...');

  // Every 5 minutes: split-position monitor + candle-close detection.
  // Codex P1 #11 (2026-04-28): added separate mutexes for the monitor
  // and the ICT cycle so a slow ICT decision doesn't block position
  // monitoring (the monitor handles TP1→BE moves and is load-bearing).
  // Each mutex resets in `finally` so a thrown error doesn't leave the
  // flag stuck-on.
  let monitorRunning = false;
  let ictRunning = false;
  // Phase 2 / Round 3 / item 3.1: single-slot queue for overlap recovery.
  const ictOverlapQueue = makeOverlapQueueState();
  cron.schedule('*/1 * * * *', async () => {
    if (!monitorRunning) {
      monitorRunning = true;
      try {
        await monitorSplitPositions();
      } finally {
        monitorRunning = false;
      }
    } else {
      console.warn('[Scheduler] Skipping monitorSplitPositions — previous run still in flight.');
    }

    const new15m = await check15mCandleClose();
    const new1h = await check1hCandleClose();

    if (new15m || new1h) {
      const kz = getCurrentKillZone();
      if (!kz.inKillZone) {
        console.log(
          `[Scheduler] Candle close at ${new Date().toISOString()} — ` +
            `skipping ICT cycle (outside kill zone: ${kz.zone})`,
        );
        return;
      }
      const reason = new15m && new1h ? '15m+1h candle close' : new15m ? 'new 15m candle close' : 'new 1h candle close';
      if (ictRunning) {
        // 2026-05-05 (Phase 2 / Round 3 / item 3.1): queue instead of drop.
        // Pre-fix the new candle close was silently dropped, missing the
        // entire next-quarter-hour setup window. Post-fix: queue the most
        // recent close; the in-flight cycle's `finally` drains it if still
        // fresh (< 15 min) and still inside a kill zone.
        queueOverlap(ictOverlapQueue, reason, Date.now());
        console.warn(`[Scheduler] ICT cycle in-flight — queueing follow-up (${reason}).`);
        realAlertSystemWarning(`ICT cycle queued (${reason}) — previous cycle still running.`).catch(() => {});
        return;
      }
      ictRunning = true;
      try {
        await safeRun('ICT Trading Agent', runTradingAgent);
      } finally {
        ictRunning = false;
      }
      // Drain any candle close that arrived during the cycle. Single follow-up
      // only — if multiple candles passed, only the most recent matters.
      const drained = drainOverlap(ictOverlapQueue, Date.now(), 15 * 60_000);
      if (drained) {
        const drainKz = getCurrentKillZone();
        if (drainKz.inKillZone) {
          console.log(
            `[Scheduler] Draining queued ICT cycle (${drained.reason}, queued ${Math.floor((Date.now() - drained.queuedAt) / 1000)}s ago).`,
          );
          ictRunning = true;
          try {
            await safeRun('ICT Trading Agent (follow-up)', runTradingAgent);
          } finally {
            ictRunning = false;
          }
        } else {
          console.log(`[Scheduler] Queued ICT cycle skipped — no longer in kill zone (${drainKz.zone}).`);
        }
      }
    }
  }, CRON_UTC);

  // Every 8 minutes: Capital.com session keep-alive.
  cron.schedule('*/8 * * * *', () => pingKeepAlive(), CRON_UTC);

  // Daily at 05:30 UTC: Market Researcher (before London open)
  cron.schedule('30 5 * * *', async () => {
    await safeRun('Market Researcher (daily)', runResearcherAgent);
  }, CRON_UTC);

  // Sunday at 22:00 UTC: Market Researcher (weekly outlook)
  cron.schedule('0 22 * * 0', async () => {
    await safeRun('Market Researcher (weekly)', runResearcherAgent);
  }, CRON_UTC);

  // (4H ICT cron removed 2026-04-21 — redundant with the */5 min + candle-close
  // detection, which already fires at the 4H boundaries. Cost cut, no behavior
  // regression — every hour the 4H cron covered is also a 1H boundary the */5
  // cron detects and acts on.)

  // Swing Agent crons removed 2026-04-23 (see import comment). The three
  // schedules that previously fired here — `30 21 * * 1-5` (daily post-US-close),
  // `0 6 * * 1` (Monday weekly outlook), and `0 8,13,17 * * 1-5` (session-
  // boundary management at London Open / NY Open / London Close) — no longer
  // dispatch any agent. Weekly Review still runs; it continues to report on
  // historical SWING-tagged rows.

  // Sunday at 00:00 UTC: Weekly Review Agent
  cron.schedule('0 0 * * 0', async () => {
    await safeRun('Weekly Review Agent', runWeeklyReviewAgent);
  }, CRON_UTC);

  // Mon-Fri at 21:30 UTC: EOD Journal Agent (W3, 2026-04-28).
  // Runs after the US close, before Asia open. Writes a short Markdown
  // reflection to journal/YYYY-MM-DD.md that the next morning's ICT
  // Researcher cycle reads as preamble. Haiku 4.5 — informational, low-stakes.
  cron.schedule('30 21 * * 1-5', async () => {
    await safeRun('EOD Journal Agent', () => runEodJournalAgent());
  }, CRON_UTC);

  // Every 10 minutes: poll all 18 RSS feeds (B3, 2026-04-28).
  // Tiered FX/commodity-specialist news pipeline — see src/news/rss-feeds.ts.
  // Failures isolated per feed; one dead source doesn't take down the rest.
  cron.schedule('*/10 * * * *', async () => {
    await safeRun('RSS news poll', () => pollAllFeeds());
  }, CRON_UTC);

  // Initial RSS poll on startup so the first agent cycles have data
  // immediately rather than waiting up to 10 min for the first cron tick.
  // 2026-05-05 (Phase 2 / Round 3 / item 3.3): retry-with-backoff. Pre-fix
  // a network blip at boot left the first 3-4 cycles with empty news; now
  // we retry up to 3 times then alert via Telegram.
  void pollWithRetry(() => pollAllFeeds(), realAlertSystemWarning);

  // Daily at 00:05 UTC: dump previous day's reject metrics.
  // Added 2026-04-23 (P4). Spawned as a detached process so the scheduler
  // event loop isn't blocked by the ~10s log scrape. Failures swallowed
  // via stdio:'ignore' + on('error') — observability must NEVER take
  // down the live trading loop.
  cron.schedule('5 0 * * *', () => {
    const proc = spawn('npx', ['tsx', 'scripts/dump-reject-metrics.ts'], {
      cwd: process.cwd(),
      detached: true,
      stdio: 'ignore',
    });
    proc.unref();
    proc.on('error', (err: Error) => {
      console.error(`[Scheduler] Reject-metrics dump failed to spawn: ${err.message}`);
    });
  }, CRON_UTC);

  // 2026-05-11: Daily realised-P&L roll-up + self-healing retry. Runs at
  // 00:05 UTC (same minute as the reject-metrics dump, different async path).
  // Step A retries P&L capture for any terminal trades from the past 7 days
  // whose pnl_total is still NULL/0 — this is the dead-letter recovery loop.
  // The trade row itself is the dead-letter queue; no extra table needed.
  // Step B then aggregates yesterday's realised P&L into daily_pnl_log.
  cron.schedule('5 0 * * *', async () => {
    // ---- Step A: self-healing retry on missing P&L (past 7 days) ----
    // Wrap the DB scan in try/catch so a sql.js / file-lock failure doesn't
    // escape the cron handler unlogged. The per-iteration try/catch inside
    // the for-loop handles broker-side capture failures separately.
    let stragglers: TradeRecord[] = [];
    try {
      stragglers = getTradesWithMissingPnl(7);
    } catch (err) {
      console.error(`[DailyPnl] Failed to scan for missing P&L: ${summarizeError(err)}`);
    }
    if (stragglers.length > 0) {
      console.log(`[DailyPnl] Retrying P&L capture for ${stragglers.length} trade(s) with missing pnl_total`);
    }
    for (const trade of stragglers) {
      await captureAndPersistPnl({
        trade,
        capture: () => capturePnlForTrade({
          trade,
          capital,
          accountCurrency: process.env.CAPITAL_ACCOUNT_CURRENCY ?? 'EUR',
          windowMode: 'terminal',
        }),
        persist: realSetTradePnl,
        logTag: '[pnl-capture:retry]',
      });
    }

    // ---- Step B: aggregate yesterday ----
    const yesterday = new Date(Date.now() - 24 * 60 * 60_000)
      .toISOString()
      .substring(0, 10); // YYYY-MM-DD UTC
    let equity = 0;
    try {
      const accounts = await capital.getAccounts();
      equity = accounts[0]?.balance?.balance ?? 0;
    } catch (err) {
      console.warn(`[DailyPnl] Could not fetch live equity for ${yesterday}: ${summarizeError(err)}`);
      const last = getDailyPnl(yesterday);
      equity = last?.equity ?? 0;
    }
    try {
      aggregateAndUpsertDailyPnl(yesterday, equity);
      console.log(`[DailyPnl] Aggregated realised P&L for ${yesterday} (equity=${equity})`);
    } catch (err) {
      console.error(`[DailyPnl] Aggregation failed for ${yesterday}: ${summarizeError(err)}`);
    }
  }, CRON_UTC);

  console.log('Scheduler started. Cron jobs active:');
  console.log('  */1 * * * *           — Split-position monitor (every minute) + 15m/1h candle detection → ICT Agent');
  console.log('  */8 * * * *           — Capital.com session keep-alive ping');
  console.log('  30 5 * * *            — Market Researcher (daily pre-London)');
  console.log('  0 22 * * 0            — Market Researcher (weekly)');
  console.log('  0 0 * * 0             — Weekly Review Agent');
  console.log('  30 21 * * 1-5         — EOD Journal Agent (Mon-Fri after US close)');
  console.log('  */10 * * * *          — RSS news poll (18 feeds, Tier 1/2/3)');
  console.log('  5 0 * * *             — Reject metrics dump (previous UTC day) + Daily P&L aggregator (self-healing retry + roll-up)');
}

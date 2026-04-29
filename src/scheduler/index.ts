// Scheduler — Candle Close Detection + Split-Position Monitoring + Agent Triggers
// The central nervous system that triggers all 6 agents at the right times.
//
// Capital.com executes SL/TP server-side, so the local monitoring loop is
// ONLY responsible for our custom 3-leg split-position logic:
//   Leg A hits TP1 → move Leg B + Leg C SL to break-even (entry)
//   Leg B hits TP2 → move Leg C SL to TP1 level (trailing lock-in)
//   Leg C hits TP3 → trade complete, trigger reflection
//   Any leg hits SL → update status, finalise if all legs are closed
//
// (Upgraded from 2-leg to 3-leg on 2026-04-21. Legacy 2-leg trades without
// position_c_id are still supported — handleTp1Hit and downstream handlers
// null-check position_c_id before attempting to move it.)
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
  alertTp3Hit as realAlertTp3Hit,
  alertSlHit as realAlertSlHit,
  alertSystemWarning as realAlertSystemWarning,
} from '../notifications/telegram.js';
import type { CapitalPosition, Activity, TradeRecord, TradeStatus } from '../types.js';
import { summarizeError } from './error-summary.js';

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
  capital: Pick<CapitalClient, 'getOpenPositions' | 'getActivityHistory' | 'updatePosition'>;
  getActiveSlTpOrders: typeof realGetActiveSlTpOrders;
  getTradeById: typeof realGetTradeById;
  deactivateSlTpOrder: typeof realDeactivateSlTpOrder;
  updateTradeStatus: typeof realUpdateTradeStatus;
  alertTp1Hit?: typeof realAlertTp1Hit;
  alertTp2Hit?: typeof realAlertTp2Hit;
  alertTp3Hit?: typeof realAlertTp3Hit;   // NEW (3-leg): fired on Leg C TP
  alertSlHit?: typeof realAlertSlHit;
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

/** Classify why a Capital position closed. Looks up the most recent activity
 *  record for `dealId` and returns 'TP', 'SL', or 'OTHER' based on the
 *  activity/status fields. Exported for testing. */
export function classifyCloseReason(
  activities: Activity[],
  dealId: string,
): 'TP' | 'SL' | 'OTHER' {
  const relevant = activities.filter((a) => a.dealId === dealId);
  if (relevant.length === 0) return 'OTHER';

  // Capital.com activity statuses include strings like 'PROFIT' or 'STOP'/'LIMIT'.
  // We match on substring for robustness against casing / field naming.
  //
  // 2026-04-29 audit-3 fix (scheduler-audit BUG-S2): check STOP/SL BEFORE
  // PROFIT/LIMIT/TP. Pre-fix the order let `STOP_LIMIT_*` activity strings
  // match LIMIT first and silently flip a real stop-out into a fake TP,
  // cascading handleTp1Hit (move B/C SL to BE) on a losing trade and
  // permanently corrupting status + P&L tracking. STOP-prefixed wording is
  // the more dangerous misclassification (loss → fake win), so it wins
  // priority on ambiguous strings.
  for (const a of relevant) {
    const blob = `${a.activity} ${a.status}`.toUpperCase();
    if (blob.includes('STOP') || blob.includes('SL_')) {
      return 'SL';
    }
    if (blob.includes('PROFIT') || blob.includes('LIMIT') || blob.includes('TP_')) {
      return 'TP';
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
    alertTp3Hit: realAlertTp3Hit,
    alertSlHit: realAlertSlHit,
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
  let openPositions: CapitalPosition[];
  let activities: Activity[];
  const activityFrom = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
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
  const legCOrders = activeOrders.filter((o) => o.leg === 'C');

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
  //      other legs were still active (e.g. out-of-order Leg C close while
  //      A or B were still open). Reflection then ran on a still-open trade
  //      with `closed_at = null`, polluting the lessons table.
  //
  // The new helper re-reads the trade's status from DB AFTER the handler
  // has run; only queues Reflection when status is in a finalised state
  // (`'complete'` | `'sl_hit'` | `'closed_early'`). Skips when `deps` is
  // injected (test path) so test runs don't kick off real LLM calls.
  const queueReflectionIfFinalised = (tradeId: string): void => {
    if (deps) return; // test path — never fire real Reflection
    const finalised = d.getTradeById(tradeId);
    if (!finalised) return;
    if (
      finalised.status !== 'complete' &&
      finalised.status !== 'sl_hit' &&
      finalised.status !== 'closed_early'
    ) {
      return;
    }
    setTimeout(
      () => runReflectionAgent(tradeId).catch(
        (e) => console.error(`[Reflection] runReflectionAgent failed: ${summarizeError(e)}`),
      ),
      1000,
    );
  };

  // ---------- Pass 1: Leg A ----------
  for (const order of legAOrders) {
    if (!order.deal_id) continue;
    try {
      if (openDealIds.has(order.deal_id)) continue;

      const reason = classifyCloseReason(activities, order.deal_id);
      const trade = d.getTradeById(order.trade_id);
      if (!trade) {
        console.warn(`[Monitor] Trade ${order.trade_id} not found for closed Leg A`);
        d.deactivateSlTpOrder(order.trade_id, 'A');
        continue;
      }

      if (reason === 'TP') {
        await handleTp1Hit(trade, order.trade_id, d);
      } else if (reason === 'SL') {
        await handleSlOnLeg(trade, order.trade_id, 'A', d);
      } else {
        console.warn(
          `[Monitor] Leg A for trade ${order.trade_id} (deal ${order.deal_id}) ` +
            `closed but reason could not be classified. Deactivating Leg A only.`,
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

      const reason = classifyCloseReason(activities, order.deal_id);
      const trade = d.getTradeById(order.trade_id);
      if (!trade) {
        d.deactivateSlTpOrder(order.trade_id, 'B');
        continue;
      }

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

  // ---------- Pass 3: Leg C ----------
  for (const order of legCOrders) {
    if (!order.deal_id) continue;
    try {
      if (openDealIds.has(order.deal_id)) continue;

      const reason = classifyCloseReason(activities, order.deal_id);
      const trade = d.getTradeById(order.trade_id);
      if (!trade) {
        d.deactivateSlTpOrder(order.trade_id, 'C');
        continue;
      }

      if (reason === 'TP') {
        await handleTp3Hit(trade, order.trade_id, d);
      } else {
        // SL or OTHER on Leg C: trailing SL at TP1 triggered, or just a normal SL.
        await handleSlOnLeg(trade, order.trade_id, 'C', d);
      }
      queueReflectionIfFinalised(order.trade_id);
    } catch (error) {
      console.error(`[Monitor] Error processing Leg C for trade ${order.trade_id}: ${summarizeError(error)}`);
    }
  }
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

  // Move Position B's SL to break-even (the entry price).
  if (trade.position_b_id) {
    try {
      await d.capital.updatePosition(trade.position_b_id, { stopLevel: trade.entry });
      console.log(`[TP1] ${trade.instrument} — Position B SL moved to BE (${trade.entry})`);
    } catch (error) {
      console.error(`[TP1] Failed to move Position B SL to BE for ${tradeId}: ${summarizeError(error)}`);
    }
  }

  // Move Position C's SL to break-even too (3-leg). Legacy 2-leg trades
  // without position_c_id skip this step silently.
  if (trade.position_c_id) {
    try {
      await d.capital.updatePosition(trade.position_c_id, { stopLevel: trade.entry });
      console.log(`[TP1] ${trade.instrument} — Position C SL moved to BE (${trade.entry})`);
    } catch (error) {
      console.error(`[TP1] Failed to move Position C SL to BE for ${tradeId}: ${summarizeError(error)}`);
    }
  }

  try {
    if (d.alertTp1Hit) await d.alertTp1Hit(trade);
  } catch (e) {
    console.error(`[Monitor] Telegram TP1 alert failed: ${summarizeError(e)}`);
  }
}

/** Leg B closed at TP2 → Position A + B both done at profit.
 *  3-leg trades: move Position C's SL to TP1 level (trailing lock-in) and
 *  leave status at 'tp2_hit' while C runs.
 *  Legacy 2-leg trades (no position_c_id): finalise the trade to 'complete'
 *  since there's no Leg C to wait on. The Telegram alert message adapts via
 *  its `trade.closed_at` check. */
export async function handleTp2Hit(
  trade: TradeRecord,
  tradeId: string,
  deps?: MonitorDeps,
): Promise<void> {
  const d = deps ?? defaultMonitorDeps();
  d.deactivateSlTpOrder(tradeId, 'B');

  // Legacy 2-leg path — no Leg C, trade is fully done.
  if (!trade.position_c_id) {
    d.updateTradeStatus(tradeId, 'complete');
    try {
      if (d.alertTp2Hit) await d.alertTp2Hit(trade);
    } catch (e) {
      console.error(`[Monitor] Telegram TP2 (legacy 2-leg) alert failed: ${summarizeError(e)}`);
    }
    return;
  }

  // 3-leg path — intermediate milestone. C still running with trailing SL.
  d.updateTradeStatus(tradeId, 'tp2_hit');
  try {
    await d.capital.updatePosition(trade.position_c_id, { stopLevel: trade.tp1 });
    console.log(
      `[TP2] ${trade.instrument} — Position C SL moved to TP1 trailing level (${trade.tp1})`,
    );
  } catch (error) {
    console.error(`[TP2] Failed to trail Position C SL to TP1 for ${tradeId}: ${summarizeError(error)}`);
  }

  try {
    if (d.alertTp2Hit) await d.alertTp2Hit(trade);
  } catch (e) {
    console.error(`[Monitor] Telegram TP2 alert failed: ${summarizeError(e)}`);
  }
}

/** Leg C closed at TP3 → full trade completion at maximum gain.
 *  Mark trade complete and fire the TP3 alert. Reflection triggers in the
 *  calling pass. */
export async function handleTp3Hit(
  trade: TradeRecord,
  tradeId: string,
  deps?: MonitorDeps,
): Promise<void> {
  const d = deps ?? defaultMonitorDeps();
  d.updateTradeStatus(tradeId, 'complete');
  d.deactivateSlTpOrder(tradeId, 'C');

  try {
    if (d.alertTp3Hit) await d.alertTp3Hit(trade);
    else if (d.alertTp2Hit) await d.alertTp2Hit(trade); // fallback if alertTp3Hit not wired
  } catch (e) {
    console.error(`[Monitor] Telegram TP3 alert failed: ${summarizeError(e)}`);
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
  leg: 'A' | 'B' | 'C',
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
  const anyTpHit = trade.status === 'tp1_hit' || trade.status === 'tp2_hit';
  const finalStatus: TradeStatus = anyTpHit ? 'complete' : 'sl_hit';
  d.updateTradeStatus(tradeId, finalStatus);

  try {
    if (finalStatus === 'sl_hit') {
      if (d.alertSlHit) await d.alertSlHit(trade);
    } else {
      // Partial-win close — use alertTp2Hit which already describes a
      // completed trade with P&L. (alertTp3Hit is reserved for full TP3 wins.)
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

/**
 * Blocker-6 keep-alive. Fires capital.ping() and surfaces any failure through
 * Telegram so Giuseppe learns about a dead session without having to watch
 * logs. Swallows the thrown error so cron doesn't crash the scheduler on a
 * transient Capital outage.
 *
 * Exported + dependency-injected so the alert path can be unit-tested.
 */
export async function pingKeepAlive(deps?: PingDeps): Promise<void> {
  const d: PingDeps = deps ?? {
    capital: capital,
    alertSystemWarning: realAlertSystemWarning,
  };
  try {
    await d.capital.ping();
  } catch (error) {
    const summary = summarizeError(error);
    console.error(`[Scheduler] Capital ping failed: ${summary}`);
    try {
      await d.alertSystemWarning(`Capital.com ping failed: ${summary}`);
    } catch (alertError) {
      console.error(`[Scheduler] Telegram alert for ping failure also failed: ${summarizeError(alertError)}`);
    }
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
  cron.schedule('*/5 * * * *', async () => {
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
      // Cost gate (2026-04-21): ICT strategy only produces setups inside
      // kill zones. Outside those windows the agent reliably decides
      // NO TRADE ("outside kill zone" / "sub-threshold scores") after
      // burning a full Claude cycle. Skip at the scheduler level to save
      // ~20 cycles/day × ~$1 each.
      const kz = getCurrentKillZone();
      if (!kz.inKillZone) {
        console.log(
          `[Scheduler] Candle close at ${new Date().toISOString()} — ` +
            `skipping ICT cycle (outside kill zone: ${kz.zone})`,
        );
        return;
      }
      if (ictRunning) {
        console.warn('[Scheduler] Skipping ICT cycle — previous cycle still in flight (likely an 8-iteration tool churn). Will retry next 5-min tick.');
        return;
      }
      ictRunning = true;
      try {
        await safeRun('ICT Trading Agent', runTradingAgent);
      } finally {
        ictRunning = false;
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
  pollAllFeeds().catch((err) => {
    console.warn(`[Scheduler] Initial RSS poll failed: ${(err as Error).message}`);
  });

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

  console.log('Scheduler started. Cron jobs active:');
  console.log('  */5 * * * *           — Split-position monitor + candle detection → ICT Agent');
  console.log('  */8 * * * *           — Capital.com session keep-alive ping');
  console.log('  30 5 * * *            — Market Researcher (daily pre-London)');
  console.log('  0 22 * * 0            — Market Researcher (weekly)');
  console.log('  0 0 * * 0             — Weekly Review Agent');
  console.log('  30 21 * * 1-5         — EOD Journal Agent (Mon-Fri after US close)');
  console.log('  */10 * * * *          — RSS news poll (18 feeds, Tier 1/2/3)');
  console.log('  5 0 * * *             — Reject metrics dump (previous UTC day)');
}

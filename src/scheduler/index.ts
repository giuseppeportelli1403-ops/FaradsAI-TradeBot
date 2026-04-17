// Scheduler — Candle Close Detection + Split-Position Monitoring + Agent Triggers
// The central nervous system that triggers all 6 agents at the right times.
//
// Capital.com executes SL/TP and trailing stops server-side, so the local
// monitoring loop is ONLY responsible for our custom split-position logic:
//   "When Position A hits TP1, move Position B's SL to break-even."
//
// Every 8 minutes we ping the Capital.com session to keep it warm (their
// tokens idle out around 10 minutes).

import cron from 'node-cron';
import { runTradingAgent } from '../agents/trading-agent.js';
import { runSwingAgent } from '../agents/swing-agent.js';
import { runResearcherAgent } from '../agents/researcher-agent.js';
import { runReflectionAgent } from '../agents/reflection-agent.js';
import { runWeeklyReviewAgent } from '../agents/review-agent.js';
import {
  getActiveSlTpOrders as realGetActiveSlTpOrders,
  deactivateSlTpOrder as realDeactivateSlTpOrder,
  updateTradeStatus as realUpdateTradeStatus,
  getTradeById as realGetTradeById,
} from '../database/index.js';
import { CapitalClient } from '../mcp-server/capital-client.js';
import {
  alertTp1Hit as realAlertTp1Hit,
  alertTp2Hit as realAlertTp2Hit,
  alertSlHit as realAlertSlHit,
} from '../notifications/telegram.js';
import type { CapitalPosition, Activity, TradeRecord } from '../types.js';

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
  for (const a of relevant) {
    const blob = `${a.activity} ${a.status}`.toUpperCase();
    if (blob.includes('PROFIT') || blob.includes('LIMIT') || blob.includes('TP')) {
      return 'TP';
    }
    if (blob.includes('STOP') || blob.includes('SL')) {
      return 'SL';
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
  };
}

export async function monitorSplitPositions(deps?: MonitorDeps): Promise<void> {
  const d = deps ?? defaultMonitorDeps();

  const activeOrders = d.getActiveSlTpOrders();
  // We only act on leg A — leg B's SL is managed by Capital after we move it to BE.
  const legAOrders = activeOrders.filter((o) => o.leg === 'A');
  if (legAOrders.length === 0) return;

  // Fetch open positions + activity history once per tick to avoid hammering the API.
  let openPositions: CapitalPosition[];
  let activities: Activity[];
  try {
    [openPositions, activities] = await Promise.all([
      d.capital.getOpenPositions(),
      d.capital.getActivityHistory(),
    ]);
  } catch (error) {
    console.error('[Monitor] Failed to fetch Capital state this tick:', error);
    return;
  }

  const openDealIds = new Set(openPositions.map((p) => p.position.dealId));

  for (const order of legAOrders) {
    if (!order.deal_id) {
      // Legacy or malformed row — nothing we can do without a dealId.
      continue;
    }

    try {
      if (openDealIds.has(order.deal_id)) {
        // Position A still open; nothing to do.
        continue;
      }

      // Position A is no longer open — Capital closed it (SL or TP hit).
      const reason = classifyCloseReason(activities, order.deal_id);
      const trade = d.getTradeById(order.trade_id);
      if (!trade) {
        console.warn(`[Monitor] Trade ${order.trade_id} not found for closed leg A`);
        d.deactivateSlTpOrder(order.trade_id, 'A');
        continue;
      }

      if (reason === 'TP') {
        await handleTp1Hit(trade, order.trade_id, d);
      } else if (reason === 'SL') {
        await handleLegAClosed(trade, order.trade_id, 'sl_hit', d);
      } else {
        // Unknown close reason — still mark leg A inactive so we don't loop on it.
        // Do NOT touch trade status; a human/later tick can investigate.
        console.warn(
          `[Monitor] Leg A for trade ${order.trade_id} (deal ${order.deal_id}) ` +
            `closed but reason could not be classified. Deactivating leg A only.`,
        );
        d.deactivateSlTpOrder(order.trade_id, 'A');
      }
    } catch (error) {
      console.error(`[Monitor] Error processing leg A for trade ${order.trade_id}:`, error);
    }
  }

  // Second pass: if leg B is still marked active in our DB but is no longer
  // open on Capital, the trade is fully closed — promote to 'complete'.
  const legBOrders = d.getActiveSlTpOrders().filter((o) => o.leg === 'B');
  for (const order of legBOrders) {
    if (!order.deal_id) continue;
    if (openDealIds.has(order.deal_id)) continue;

    const trade = d.getTradeById(order.trade_id);
    if (!trade) {
      d.deactivateSlTpOrder(order.trade_id, 'B');
      continue;
    }

    const reason = classifyCloseReason(activities, order.deal_id);
    const status = reason === 'TP' ? 'complete' : reason === 'SL' ? 'sl_hit' : 'complete';
    d.updateTradeStatus(order.trade_id, status);
    d.deactivateSlTpOrder(order.trade_id, 'B');

    try {
      if (status === 'complete') {
        if (d.alertTp2Hit) await d.alertTp2Hit(trade);
      } else {
        if (d.alertSlHit) await d.alertSlHit(trade);
      }
    } catch (e) {
      console.error('[Monitor] Telegram alert for leg B close failed:', e);
    }

    // Trigger reflection once both legs are closed. Skip when deps were
    // injected (tests don't want side effects from the agent runner).
    if (!deps) {
      setTimeout(() => runReflectionAgent(order.trade_id).catch(console.error), 1000);
    }
  }
}

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
      console.log(
        `[TP1] ${trade.instrument} — Position B SL moved to break-even (${trade.entry})`,
      );
    } catch (error) {
      console.error(`[TP1] Failed to move Position B SL to BE for ${tradeId}:`, error);
    }
  }

  try {
    if (d.alertTp1Hit) await d.alertTp1Hit(trade);
  } catch (e) {
    console.error('[Monitor] Telegram TP1 alert failed:', e);
  }
}

export async function handleLegAClosed(
  trade: TradeRecord,
  tradeId: string,
  status: 'sl_hit',
  deps?: MonitorDeps,
): Promise<void> {
  const d = deps ?? defaultMonitorDeps();
  // Leg A SL-hit before TP1. Capital already closed it; we just record the state.
  d.updateTradeStatus(tradeId, status);
  d.deactivateSlTpOrder(tradeId, 'A');

  try {
    if (d.alertSlHit) await d.alertSlHit(trade);
  } catch (e) {
    console.error('[Monitor] Telegram SL alert failed:', e);
  }

  // If Position B is also gone from open positions, reflection fires in the
  // second pass above — nothing else to do here.
}

// ==================== AGENT RUNNERS WITH ERROR HANDLING ====================

async function safeRun(name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    console.log(`[Scheduler] Triggering ${name}...`);
    await fn();
    console.log(`[Scheduler] ${name} complete.`);
  } catch (error) {
    console.error(`[Scheduler] ${name} failed:`, error);
  }
}

// ==================== START SCHEDULER ====================

export function startScheduler(): void {
  console.log('Starting scheduler...');

  // Every 5 minutes: split-position monitor + candle-close detection.
  cron.schedule('*/5 * * * *', async () => {
    await monitorSplitPositions();

    const new15m = await check15mCandleClose();
    const new1h = await check1hCandleClose();

    if (new15m || new1h) {
      await safeRun('ICT Trading Agent', runTradingAgent);
    }
  });

  // Every 8 minutes: Capital.com session keep-alive.
  cron.schedule('*/8 * * * *', async () => {
    try {
      await capital.ping();
    } catch (error) {
      console.error('[Scheduler] Capital ping failed:', error);
    }
  });

  // Daily at 05:30 UTC: Market Researcher (before London open)
  cron.schedule('30 5 * * *', async () => {
    await safeRun('Market Researcher (daily)', runResearcherAgent);
  });

  // Sunday at 22:00 UTC: Market Researcher (weekly outlook)
  cron.schedule('0 22 * * 0', async () => {
    await safeRun('Market Researcher (weekly)', runResearcherAgent);
  });

  // Daily at 21:30 UTC: Swing Agent (after US close)
  cron.schedule('30 21 * * 1-5', async () => {
    await safeRun('Swing Trading Agent (daily)', runSwingAgent);
  });

  // Monday at 06:00 UTC: Swing Agent (weekly outlook)
  cron.schedule('0 6 * * 1', async () => {
    await safeRun('Swing Trading Agent (weekly outlook)', runSwingAgent);
  });

  // Every 4 hours during London/NY sessions (08:00, 12:00, 16:00 UTC) Mon-Fri: Swing management
  cron.schedule('0 8,12,16 * * 1-5', async () => {
    await safeRun('Swing Trading Agent (management)', runSwingAgent);
  });

  // Sunday at 00:00 UTC: Weekly Review Agent
  cron.schedule('0 0 * * 0', async () => {
    await safeRun('Weekly Review Agent', runWeeklyReviewAgent);
  });

  console.log('Scheduler started. Cron jobs active:');
  console.log('  */5 * * * *     — Split-position monitor + candle detection → ICT Agent');
  console.log('  */8 * * * *     — Capital.com session keep-alive ping');
  console.log('  30 5 * * *      — Market Researcher (daily)');
  console.log('  0 22 * * 0      — Market Researcher (weekly)');
  console.log('  30 21 * * 1-5   — Swing Agent (daily)');
  console.log('  0 6 * * 1       — Swing Agent (weekly outlook)');
  console.log('  0 8,12,16 * * 1-5 — Swing Agent (management)');
  console.log('  0 0 * * 0       — Weekly Review Agent');
}

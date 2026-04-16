// Scheduler — Candle Close Detection + Position Monitoring + Agent Triggers
// The central nervous system that triggers all 6 agents at the right times

import cron from 'node-cron';
import { runTradingAgent } from '../agents/trading-agent.js';
import { runSwingAgent } from '../agents/swing-agent.js';
import { runResearcherAgent } from '../agents/researcher-agent.js';
import { runReflectionAgent } from '../agents/reflection-agent.js';
import { runWeeklyReviewAgent } from '../agents/review-agent.js';
import { getActiveSlTpOrders, deactivateSlTpOrder, updateTradeStatus, getTradeById } from '../database/index.js';
import { fetchCandles } from '../mcp-server/market-data.js';
import { T212Client } from '../mcp-server/t212-client.js';

const t212 = new T212Client(
  process.env.T212_API_KEY || '',
  (process.env.T212_MODE as 'demo' | 'live') || 'demo'
);

// Track last processed candle timestamps to detect new closes
let last15mCandle = '';
let last1hCandle = '';

// ==================== CANDLE CLOSE DETECTION ====================

async function check15mCandleClose(): Promise<boolean> {
  const now = new Date();
  const minutes = now.getUTCMinutes();
  // 15M candles close at :00, :15, :30, :45
  const candleMinute = Math.floor(minutes / 15) * 15;
  const candleKey = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}-${now.getUTCHours()}-${candleMinute}`;

  if (candleKey !== last15mCandle && minutes % 15 < 5) {
    // New candle closed within the last 5 minutes
    last15mCandle = candleKey;
    return true;
  }
  return false;
}

async function check1hCandleClose(): Promise<boolean> {
  const now = new Date();
  const candleKey = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}-${now.getUTCHours()}`;

  if (candleKey !== last1hCandle && now.getUTCMinutes() < 5) {
    last1hCandle = candleKey;
    return true;
  }
  return false;
}

// ==================== SL/TP MONITORING ====================
// Since T212 doesn't support native SL/TP, we monitor and execute ourselves

async function monitorSlTpOrders(): Promise<void> {
  const activeOrders = getActiveSlTpOrders();
  if (activeOrders.length === 0) return;

  for (const order of activeOrders) {
    try {
      // Get current price
      const candles = await fetchCandles(order.instrument, '15m', 1);
      if (!candles[0]) continue;

      const currentPrice = candles[0].close;
      const isLong = order.direction === 'long';

      // Check trailing stop first (dynamic SL)
      if (order.trailing_stop_distance) {
        const trailingSl = isLong
          ? currentPrice - order.trailing_stop_distance
          : currentPrice + order.trailing_stop_distance;

        // Update SL if trailing stop moves in our favour
        if (order.sl_price) {
          if (isLong && trailingSl > order.sl_price) {
            // Trailing stop moved up — update
            const { updateSlPrice } = await import('../database/index.js');
            updateSlPrice(order.trade_id, order.leg, trailingSl);
          } else if (!isLong && trailingSl < order.sl_price) {
            const { updateSlPrice } = await import('../database/index.js');
            updateSlPrice(order.trade_id, order.leg, trailingSl);
          }
        }
      }

      // Check SL hit
      if (order.sl_price) {
        const slHit = isLong
          ? currentPrice <= order.sl_price
          : currentPrice >= order.sl_price;

        if (slHit) {
          console.log(`[SL HIT] ${order.instrument} leg ${order.leg} — closing at ${currentPrice}`);
          await t212.partialClose(order.instrument, order.quantity);
          deactivateSlTpOrder(order.trade_id, order.leg);

          // Check if both legs are now closed
          const trade = getTradeById(order.trade_id);
          if (trade) {
            updateTradeStatus(order.trade_id, 'sl_hit');
            // Trigger reflection agent
            setTimeout(() => runReflectionAgent(order.trade_id).catch(console.error), 1000);
          }
          continue;
        }
      }

      // Check TP hit
      if (order.tp_price) {
        const tpHit = isLong
          ? currentPrice >= order.tp_price
          : currentPrice <= order.tp_price;

        if (tpHit) {
          console.log(`[TP HIT] ${order.instrument} leg ${order.leg} — closing at ${currentPrice}`);
          await t212.partialClose(order.instrument, order.quantity);
          deactivateSlTpOrder(order.trade_id, order.leg);

          const trade = getTradeById(order.trade_id);
          if (trade) {
            if (order.leg === 'A') {
              // TP1 hit — move Position B SL to break even
              updateTradeStatus(order.trade_id, 'tp1_hit');
              const { updateSlPrice } = await import('../database/index.js');
              updateSlPrice(order.trade_id, 'B', trade.entry);
              console.log(`[TP1] ${order.instrument} — Position B SL moved to break even (${trade.entry})`);
            } else {
              // TP2 hit — trade complete
              updateTradeStatus(order.trade_id, 'complete');
              console.log(`[TP2] ${order.instrument} — Trade complete`);
              setTimeout(() => runReflectionAgent(order.trade_id).catch(console.error), 1000);
            }
          }
          continue;
        }
      }
    } catch (error) {
      console.error(`[Monitor] Error checking ${order.instrument} leg ${order.leg}:`, error);
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
    console.error(`[Scheduler] ${name} failed:`, error);
  }
}

// ==================== START SCHEDULER ====================

export function startScheduler(): void {
  console.log('Starting scheduler...');

  // Every 5 minutes: check candle closes + monitor SL/TP
  cron.schedule('*/5 * * * *', async () => {
    // Monitor SL/TP orders (most critical — runs every cycle)
    await monitorSlTpOrders();

    // Check for new candle closes
    const new15m = await check15mCandleClose();
    const new1h = await check1hCandleClose();

    if (new15m || new1h) {
      await safeRun('ICT Trading Agent', runTradingAgent);
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
  console.log('  */5 * * * *     — SL/TP monitor + candle detection → ICT Agent');
  console.log('  30 5 * * *      — Market Researcher (daily)');
  console.log('  0 22 * * 0      — Market Researcher (weekly)');
  console.log('  30 21 * * 1-5   — Swing Agent (daily)');
  console.log('  0 6 * * 1       — Swing Agent (weekly outlook)');
  console.log('  0 8,12,16 * * 1-5 — Swing Agent (management)');
  console.log('  0 0 * * 0       — Weekly Review Agent');
}

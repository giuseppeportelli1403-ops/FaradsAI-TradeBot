// Telegram Alert System — All notification types
// Uses Telegraf to send structured alerts to Giuseppe's Telegram
//
// Alert types:
//   1. Trade placed (both legs, entry, SL, TP1, TP2, R:R)
//   2. TP1 hit (Position A closed, Position B SL moved to BE)
//   3. TP2 hit / full trade complete (final P&L in R)
//   4. SL hit
//   5. Kill switch activated (daily 4% or weekly 8%)
//   6. Weekly performance report
//   7. System alerts (researcher warnings, system review)

import { Telegraf } from 'telegraf';
import type { TradeRecord } from '../types.js';

let bot: Telegraf | null = null;
let chatId: string = '';

export function initTelegram(): void {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  chatId = process.env.TELEGRAM_CHAT_ID || '';

  if (!token || !chatId) {
    console.warn('[Telegram] Bot token or chat ID not set. Alerts disabled.');
    return;
  }

  bot = new Telegraf(token);
  console.log('[Telegram] Bot initialised.');
}

async function send(message: string): Promise<void> {
  if (!bot || !chatId) return;
  try {
    await bot.telegram.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('[Telegram] Failed to send:', error);
  }
}

// ==================== ALERT FUNCTIONS ====================

export async function alertTradePlaced(trade: TradeRecord): Promise<void> {
  const emoji = trade.direction === 'long' ? '🟢' : '🔴';
  const strategy = trade.strategy_tag === 'SWING' ? '📊 SWING' : '⚡ ICT';
  const rrTp2 = trade.sl !== trade.entry
    ? Math.abs((trade.tp2 - trade.entry) / (trade.entry - trade.sl)).toFixed(1)
    : 'N/A';

  await send(`${emoji} *NEW TRADE — ${strategy}*

*${trade.instrument}* ${trade.direction.toUpperCase()}
Score: ${trade.composite_score}/100
Entry: ${trade.entry}
SL: ${trade.sl}
TP1: ${trade.tp1} | TP2: ${trade.tp2}
Leg A: ${trade.size_a} units | Leg B: ${trade.size_b} units
R:R to TP2: ${rrTp2}:1
Setup: ${trade.setup_type}
Kill Zone: ${trade.kill_zone}`);
}

export async function alertTp1Hit(trade: TradeRecord): Promise<void> {
  await send(`🎯 *TP1 HIT — ${trade.instrument}*

Position A closed at TP1 (${trade.tp1})
Position B SL moved to break even (${trade.entry})
Position B running toward TP2 (${trade.tp2})
Strategy: ${trade.strategy_tag}`);
}

export async function alertTp2Hit(trade: TradeRecord): Promise<void> {
  const pnl = trade.pnl_total?.toFixed(2) || 'pending';
  await send(`🏆 *TRADE COMPLETE — ${trade.instrument}*

Full trade closed. Both legs done.
P&L: ${pnl}R
Strategy: ${trade.strategy_tag}
Duration: ${trade.opened_at} → ${trade.closed_at}`);
}

export async function alertSlHit(trade: TradeRecord): Promise<void> {
  const pnl = trade.pnl_total?.toFixed(2) || 'pending';
  await send(`🛑 *SL HIT — ${trade.instrument}*

Trade stopped out.
P&L: ${pnl}R
Strategy: ${trade.strategy_tag}
Setup: ${trade.setup_type} | Score: ${trade.composite_score}`);
}

export async function alertKillSwitch(type: 'daily' | 'weekly', pnlPct: number): Promise<void> {
  const limit = type === 'daily' ? '6%' : '8%';
  await send(`🚨 *KILL SWITCH ACTIVATED — ${type.toUpperCase()}*

${type === 'daily' ? 'Daily' : 'Weekly'} loss limit (${limit}) reached.
Current P&L: ${pnlPct.toFixed(2)}%
No new positions will be opened.
Existing positions managed only.`);
}

export async function alertWeeklyReport(report: string): Promise<void> {
  // Telegram has a 4096 char limit — truncate if needed
  const truncated = report.length > 4000 ? report.substring(0, 4000) + '\n...(truncated)' : report;
  await send(`📈 *WEEKLY PERFORMANCE REPORT*\n\n${truncated}`);
}

export async function alertSystemWarning(message: string): Promise<void> {
  await send(`⚠️ *SYSTEM ALERT*\n\n${message}`);
}

export async function alertResearchBrief(warnings: string[]): Promise<void> {
  if (warnings.length === 0) return;
  await send(`📋 *RESEARCH BRIEF WARNINGS*\n\n${warnings.map(w => `• ${w}`).join('\n')}`);
}

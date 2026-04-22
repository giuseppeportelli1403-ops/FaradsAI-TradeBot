// Telegram Alert System — All notification types
// Uses Telegraf to send structured alerts to Giuseppe's Telegram
//
// Alert types:
//   1. Trade placed (both legs, entry, SL, TP1, TP2, R:R)
//   2. TP1 hit (Position A closed, Position B SL moved to BE)
//   3. TP2 hit / full trade complete (final P&L in R)
//   4. SL hit
//   5. Kill switch activated (daily 6% or weekly 10%)
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
  const riskDist = Math.abs(trade.entry - trade.sl);
  const rrTp2 = riskDist > 0
    ? Math.abs((trade.tp2 - trade.entry) / riskDist).toFixed(1)
    : 'N/A';
  // 3-leg alert format — show all 3 TPs + all 3 leg sizes. Legacy 2-leg
  // trades (no tp3 / position_c_id / size_c) render a compact 2-leg block.
  const isThreeLeg = trade.tp3 !== null && trade.tp3 !== undefined && trade.position_c_id;
  const rrTp3 = isThreeLeg && riskDist > 0
    ? Math.abs(((trade.tp3 as number) - trade.entry) / riskDist).toFixed(1)
    : null;

  const tpsLine = isThreeLeg
    ? `TP1: ${trade.tp1} | TP2: ${trade.tp2} | TP3: ${trade.tp3}`
    : `TP1: ${trade.tp1} | TP2: ${trade.tp2}`;
  const legsLine = isThreeLeg
    ? `Leg A: ${trade.size_a} | Leg B: ${trade.size_b} | Leg C: ${trade.size_c}`
    : `Leg A: ${trade.size_a} units | Leg B: ${trade.size_b} units`;
  const rrLine = isThreeLeg
    ? `R:R to TP2: ${rrTp2}:1  ·  R:R to TP3: ${rrTp3}:1`
    : `R:R to TP2: ${rrTp2}:1`;

  await send(`${emoji} *NEW TRADE — ${strategy}*

*${trade.instrument}* ${trade.direction.toUpperCase()}
Score: ${trade.composite_score}/100
Entry: ${trade.entry}
SL: ${trade.sl}
${tpsLine}
${legsLine}
${rrLine}
Setup: ${trade.setup_type}
Kill Zone: ${trade.kill_zone}`);
}

export async function alertTp1Hit(trade: TradeRecord): Promise<void> {
  // Leg A closed at TP1 — partial profit locked in, Legs B+C now risk-free
  // at break-even. Trade still running.
  const legCLine = trade.position_c_id
    ? `Position C SL → BE (${trade.entry}), heading for TP3 (${trade.tp3})`
    : ''; // Legacy 2-leg trade — no Leg C to report
  await send(`🎯 *TP1 HIT — ${trade.instrument}*

Position A closed at TP1 (${trade.tp1})
Position B SL → BE (${trade.entry}), heading for TP2 (${trade.tp2})
${legCLine}
Strategy: ${trade.strategy_tag}`);
}

export async function alertTp2Hit(trade: TradeRecord): Promise<void> {
  // In 3-leg mode this is the MIDDLE milestone (Leg B hit TP2, Leg C trails).
  // In 2-leg legacy mode OR a partial-win close (Leg B SL'd at BE after Leg A
  // TP'd), this can also be the FINAL milestone. We pick the message based on
  // whether the trade already has a closed_at timestamp.
  const pnl = trade.pnl_total?.toFixed(2) || 'pending';
  const isFinal = trade.closed_at !== null;

  if (trade.position_c_id && !isFinal) {
    // 3-leg interim: B closed at TP2, C still running with SL trailing to TP1.
    await send(`🎯 *TP2 HIT — ${trade.instrument}*

Position B closed at TP2 (${trade.tp2})
Position C SL trailing to TP1 level (${trade.tp1}), heading for TP3 (${trade.tp3})
Realised so far: ${pnl}R
Strategy: ${trade.strategy_tag}`);
  } else {
    // Final close — either legacy 2-leg full close, or a partial-win finale
    // (some leg SL'd after TPs).
    await send(`🏆 *TRADE COMPLETE — ${trade.instrument}*

All legs closed.
P&L: ${pnl}R
Strategy: ${trade.strategy_tag}
Duration: ${trade.opened_at} → ${trade.closed_at ?? 'now'}`);
  }
}

// NEW 2026-04-21: fired when Leg C closes at TP3 (full trade complete at max R).
export async function alertTp3Hit(trade: TradeRecord): Promise<void> {
  const pnl = trade.pnl_total?.toFixed(2) || 'pending';
  await send(`🏆🏆 *TP3 HIT — FULL TRADE COMPLETE AT MAX — ${trade.instrument}*

All 3 legs closed at TP — the full A/B/C chain ran to max R.
TP1: ${trade.tp1} | TP2: ${trade.tp2} | TP3: ${trade.tp3}
P&L: ${pnl}R (maximum target achieved)
Strategy: ${trade.strategy_tag}
Duration: ${trade.opened_at} → ${trade.closed_at ?? 'now'}`);
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
  const limit = type === 'daily' ? '6%' : '10%';
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

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
  const token = (process.env.TELEGRAM_BOT_TOKEN ?? '').trim();
  // 2026-04-29 audit-3 r3 fix (scanner+misc P1-5): trim the chat ID. Pre-fix,
  // a copy-pasted env value with trailing whitespace, newlines, or surrounding
  // quotes would silently fail with Telegram 400 "chat not found" on every
  // send — alerts were lost forever, and the only signal was a console.error
  // per send. Trim once at init.
  chatId = (process.env.TELEGRAM_CHAT_ID ?? '').trim();

  if (!token || !chatId) {
    console.warn('[Telegram] Bot token or chat ID not set. Alerts disabled.');
    return;
  }

  bot = new Telegraf(token);
  console.log('[Telegram] Bot initialised.');
}

// Telegram hard cap is 4096 chars per message. Anything longer returns 400
// "MESSAGE_TOO_LONG" and the alert is silently dropped (audit-3 P1-7).
const TELEGRAM_MAX_MESSAGE_BYTES = 4000;

/**
 * Escape user/LLM-supplied content for legacy Telegram Markdown.
 * Pre-fix (audit-3 scanner+misc P1-6): instrument names like `OIL_CRUDE`
 * contained underscores that the Markdown parser interpreted as italic
 * delimiters, returning HTTP 400 "can't parse entities" and silently
 * dropping the alert. Same risk on `setup_type`, `news_category`,
 * `analyst_decision`, `closure_reason`, `reasoning`, free-text strings
 * from the LLM. Now: every interpolated value flows through mdEsc().
 *
 * Escapes the 5 legacy-Markdown chars (`_`, `*`, `` ` ``, `[`, `]`).
 * The static format scaffolding (e.g. `*NEW TRADE*`) is hand-written and
 * does NOT need escaping.
 */
export function mdEsc(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[_*`\[\]]/g, '\\$&');
}

function truncateForTelegram(message: string): string {
  if (message.length <= TELEGRAM_MAX_MESSAGE_BYTES) return message;
  return message.substring(0, TELEGRAM_MAX_MESSAGE_BYTES) + '\n…(truncated)';
}

async function send(message: string): Promise<void> {
  if (!bot || !chatId) return;
  try {
    await bot.telegram.sendMessage(chatId, truncateForTelegram(message), {
      parse_mode: 'Markdown',
    });
  } catch (error) {
    // 2026-04-29 audit-3: if Markdown parse fails (e.g. unbalanced backtick
    // sneaks through escaping), retry once as PLAIN TEXT so the alert is
    // not silently dropped. Better an ugly text message than no message.
    console.error('[Telegram] Markdown send failed, retrying as plain text:', error);
    try {
      await bot.telegram.sendMessage(chatId.toString().trim(), truncateForTelegram(message));
    } catch (plainErr) {
      console.error('[Telegram] Plain-text retry also failed:', plainErr);
    }
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
  // Leg A closed at TP1 — partial profit locked in, Leg B now risk-free
  // at break-even. Trade still running.
  await send(`🎯 *TP1 HIT — ${trade.instrument}*

Position A closed at TP1 (${trade.tp1})
Position B SL → BE (${trade.entry}), heading for TP2 (${trade.tp2})
Strategy: ${trade.strategy_tag}`);
}

export async function alertTp2Hit(trade: TradeRecord): Promise<void> {
  // 2-leg full close: Leg A already TP'd, Leg B now closed at TP2.
  // Or a partial-win finale (Leg B SL'd at BE after Leg A TP'd).
  const pnl = trade.pnl_total?.toFixed(2) || 'pending';

  await send(`🏆 *TRADE COMPLETE — ${trade.instrument}*

All legs closed.
P&L: ${pnl}R
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

/**
 * 2026-05-10 Phase-2 migration-drift cleanup, Task P3.1.
 *
 * Fired ONLY from the DB_LOG_FAILED_AFTER_PLACEMENT branch in
 * `place_split_trade` — i.e. when both Capital legs filled but the
 * subsequent DB write (`insertTrade` + `createSlTpOrder × 2`) threw.
 * In this state the positions are LIVE on Capital with no DB row, the
 * scheduler can't manage them, and silent failure means orphan risk
 * compounds every cycle.
 *
 * Decision (locked): alert + log only — NO auto-close. A transient DB
 * write timeout that auto-closed a real trade would lose more money
 * than the manual-reconcile cost. The Telegram message gives Giuseppe
 * both deal IDs so he can decide: close via Capital app, or insert
 * the trade row by hand and let the scheduler take over.
 *
 * Markdown rules: deal IDs are wrapped in inline-code backticks for
 * easy copy-paste; instrument and error string flow through mdEsc()
 * because both can contain underscores or other Markdown metachars
 * that would otherwise return Telegram 400 "can't parse entities" and
 * silently drop the alert (audit-3 P1-6 lesson).
 */
export async function alertOrphanPositions(opts: {
  instrument: string;
  direction: 'BUY' | 'SELL';
  legA: { dealId: string; size: number };
  legB: { dealId: string; size: number };
  errorMessage: string;
}): Promise<void> {
  const text = [
    '🚨 *CRITICAL — ORPHAN POSITIONS*',
    '',
    'Trade row write failed AFTER both legs were placed on Capital.com.',
    'Manual reconciliation required.',
    '',
    `Instrument: ${mdEsc(opts.instrument)}`,
    `Direction: ${opts.direction}`,
    `Leg A dealId: \`${mdEsc(opts.legA.dealId)}\` (size ${opts.legA.size})`,
    `Leg B dealId: \`${mdEsc(opts.legB.dealId)}\` (size ${opts.legB.size})`,
    `Error: ${mdEsc(opts.errorMessage)}`,
    '',
    'These positions are LIVE on Capital but NOT tracked by the bot.',
    'Decide: close manually via Capital app, or insert trade row by hand.',
  ].join('\n');
  await send(text);
}

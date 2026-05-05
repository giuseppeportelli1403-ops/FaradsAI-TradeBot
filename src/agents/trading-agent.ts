// ICT Intraday Trading Agent — 5-Step Decision Cycle
// Called every time a new 15M or 1H candle closes
// Uses Claude Sonnet to analyse ICT structure and make trade decisions
//
// The agent receives market data via MCP tools and uses the system prompt
// from AGENT_SYSTEM_PROMPTS_V3 Section 1 to guide its reasoning.

import Anthropic from '@anthropic-ai/sdk';
import { createHash, randomUUID } from 'node:crypto';
import { loadPrompt, loadPromptWithDemoContext, loadStrategy } from './load-prompt.js';
import { ensureTradeId } from './trade-id.js';
import { loadRecentJournal } from './eod-journal-agent.js';
import { withTimeout } from './llm-output.js';
import { runAnalystAgent, type TradeProposal } from './analyst-agent.js';
import { instrumentToCurrencies, shouldVetoOrderForCalendar } from '../news/calendar-veto.js';
import { fetchForexFactoryCalendar } from '../news/forex-factory-calendar.js';
import { getLatestBrief, countOpenPositions, getOpenTradesByInstrument, getRealisedPnlSince } from '../database/index.js';
import { alertTradePlaced } from '../notifications/telegram.js';

const anthropic = new Anthropic();

// ==================== ANALYST APPROVAL TRACKING ====================
// Codex-recommended pattern (2026-04-28): the agent must call
// request_analyst_review BEFORE place_split_trade, and place_split_trade
// requires the analyst_token to match a same-cycle approval whose
// proposal-hash matches the actual order being placed. This prevents
// the LLM from getting an Analyst APPROVE on a clean-looking proposal
// and then mutating size/SL/TP before placement.
//
// Approval entries TTL after 10 min — same-cycle matching only.

interface ApprovalEntry {
  approvedAt: number;
  proposal: TradeProposal;
}

const APPROVAL_TTL_MS = 10 * 60_000;
const approvedProposals = new Map<string, ApprovalEntry>();

/** Exposed for tests — clear the approval map. */
export function _resetAnalystApprovals(): void {
  approvedProposals.clear();
}

/**
 * Compute a deterministic hash of the canonicalised proposal. Used as the
 * analyst_token. The agent cannot mutate proposal fields between approval
 * and placement: place_split_trade re-hashes the supplied proposal and
 * verifies it matches the analyst_token.
 *
 * 2026-04-29 audit fix (P0-TA2): expanded the canonical projection to
 * include `instrument`, `instrument_category`, and `kill_zone`. Pre-fix
 * the hash was anchored on `epic` only — usually identical to instrument
 * but if they ever diverged the coordination lock + DB persistence used
 * `instrument` while the hash anchored on `epic`. Including all three
 * eliminates any opportunity for the LLM to swap them between approval
 * and placement. instrument_category and kill_zone affect tier sizing
 * downstream and were similarly omitted.
 */
export function proposalHash(proposal: Omit<TradeProposal, 'trade_id'>): string {
  // Canonicalise: explicit field order, fixed precision on numbers, lower-
  // case strings where applicable. Drop fields that don't affect the trade
  // identity (trade_id is generated FROM this hash; reasoning is free-text).
  const canonical = {
    instrument: proposal.instrument.toUpperCase(),
    instrument_category: proposal.instrument_category.toLowerCase(),
    epic: proposal.epic.toUpperCase(),
    direction: proposal.direction,
    entry: Number(proposal.entry.toFixed(5)),
    sl: Number(proposal.sl.toFixed(5)),
    tp1: Number(proposal.tp1.toFixed(5)),
    tp2: Number(proposal.tp2.toFixed(5)),
    tp3: Number(proposal.tp3.toFixed(5)),
    size_a: Number(proposal.size_a.toFixed(6)),
    size_b: Number(proposal.size_b.toFixed(6)),
    size_c: Number(proposal.size_c.toFixed(6)),
    composite_score: Math.round(proposal.composite_score),
    tier: proposal.tier,
    total_risk_pct: Number(proposal.total_risk_pct.toFixed(4)),
    setup_type: proposal.setup_type.toLowerCase(),
    kill_zone: proposal.kill_zone.toLowerCase(),
    strategy_tag: proposal.strategy_tag,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 16);
}

function pruneStaleApprovals(): void {
  const cutoff = Date.now() - APPROVAL_TTL_MS;
  for (const [key, entry] of approvedProposals) {
    if (entry.approvedAt < cutoff) approvedProposals.delete(key);
  }
}

// ==================== R:R FLOOR VALIDATION ====================
// 2026-05-04 (Phase A1, audit Finding #2): pre-fix the place_split_trade
// validation chain only checked order-side (sl<entry<tp1<tp2<tp3 for longs,
// opposite for shorts). There was NO check that TP magnitudes respected
// strategy.md Section 7.3 R:R minimums. A hallucinated proposal with TP1
// 1 pip past entry could pass every code gate. The Analyst's 6-check
// sanity step also doesn't verify R:R floors — only "TP1 closer to entry
// than TP2".
//
// Strategy.md Section 7.3 (authoritative):
//   Trend-mode (triggers 1-4):
//     TP1 ≥ 1:1 (de-risk leg, 1.2:1 acceptable)
//     TP2 ≥ 2:1 for Tier 1 & 2; ≥ 1.5:1 for Tier 3 on tight-spread only
//     TP3 ≥ 3:1
//   Range-mode (trigger 5):
//     TP1 ≥ 1:1, TP2 ≥ 1.5:1, TP3 ≥ 2:1
//
// Tight-spread instruments (memory/strategy.md Section 4):
//   EURUSD, GBPUSD, USDJPY, AUDUSD, GOLD
// Medium-spread (no T3 tight-spread carve-out):
//   SILVER, OIL_CRUDE
//
// The classifier itself lives in ./spread to break a cycle with the
// scanner (which also needs it for the Tier 3 score floor). Re-exported
// here so existing tests/imports keep working.
import { isTightSpreadTicker, tier3FloorFor } from './spread.js';
export { isTightSpreadTicker, tier3FloorFor };

export interface RRValidationInput {
  direction: 'long' | 'short';
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  tp3: number;
  tier: 1 | 2 | 3;
  ticker: string;
  isRangeMode: boolean;
}

export type RRValidationResult =
  | { ok: true }
  | { ok: false; error: 'INVALID_RISK' | 'RR_FLOOR_VIOLATION'; reason: string };

/**
 * Validate that the proposal's TPs respect the strategy R:R floors.
 *
 * Pure function: no side effects, no async, no DB. The caller (place_split_trade
 * executor) invokes this AFTER the order-side validation so we know
 * sl/entry/tps are on the correct sides — this lets us use abs(price - entry)
 * for the R:R math regardless of long/short.
 *
 * Returns { ok: true } on pass, { ok: false, error, reason } with a specific
 * machine-readable error code on fail. The reason mentions which TP leg
 * violated and the actual ratio so the LLM can fix and retry.
 */
export function validateRRFloor(input: RRValidationInput): RRValidationResult {
  const { entry, sl, tp1, tp2, tp3, tier, ticker, isRangeMode } = input;
  const risk = Math.abs(entry - sl);
  if (risk === 0 || !Number.isFinite(risk)) {
    return {
      ok: false,
      error: 'INVALID_RISK',
      reason: `Cannot compute R:R: entry (${entry}) equals SL (${sl}) or risk is non-finite.`,
    };
  }

  const rr = (tp: number) => Math.abs(tp - entry) / risk;
  const rr1 = rr(tp1);
  const rr2 = rr(tp2);
  const rr3 = rr(tp3);

  // Floors per strategy.md Section 7.3.
  let tp1Floor: number;
  let tp2Floor: number;
  let tp3Floor: number;
  let mode: string;

  if (isRangeMode) {
    tp1Floor = 1.0;
    tp2Floor = 1.5;
    tp3Floor = 2.0;
    mode = 'range-mode';
  } else {
    tp1Floor = 1.0;
    tp3Floor = 3.0;
    if (tier === 3 && isTightSpreadTicker(ticker)) {
      tp2Floor = 1.5;  // T3 tight-spread carve-out
      mode = 'trend-mode T3 tight-spread';
    } else {
      tp2Floor = 2.0;
      mode = `trend-mode T${tier}`;
    }
  }

  // Tolerance: allow tiny floating-point overshoot (0.001 R) so e.g. an
  // exactly-at-floor proposal isn't rejected on rounding.
  const tol = 0.001;
  if (rr1 + tol < tp1Floor) {
    return {
      ok: false,
      error: 'RR_FLOOR_VIOLATION',
      reason: `TP1 R:R is ${rr1.toFixed(2)}, below ${mode} floor of ${tp1Floor}. ` +
              `Re-compute: entry=${entry}, sl=${sl}, tp1=${tp1}.`,
    };
  }
  if (rr2 + tol < tp2Floor) {
    return {
      ok: false,
      error: 'RR_FLOOR_VIOLATION',
      reason: `TP2 R:R is ${rr2.toFixed(2)}, below ${mode} floor of ${tp2Floor}. ` +
              `Re-compute: entry=${entry}, sl=${sl}, tp2=${tp2}.`,
    };
  }
  if (rr3 + tol < tp3Floor) {
    return {
      ok: false,
      error: 'RR_FLOOR_VIOLATION',
      reason: `TP3 R:R is ${rr3.toFixed(2)}, below ${mode} floor of ${tp3Floor}. ` +
              `Re-compute: entry=${entry}, sl=${sl}, tp3=${tp3}.`,
    };
  }

  return { ok: true };
}

// ==================== RISK-PCT TOLERANCE ====================
// 2026-05-05 audit (Phase 2 / Round 5+ / item A1): the existing inline
// check `Math.abs(riskPct - expectedRiskPct) > 0.05` allowed ±0.05 absolute
// tolerance, which is 20% overage on Tier 3 range-mode (expected 0.25%, so
// 0.20-0.30% accepted). At 0.30%, range-mode trade takes 1.2× intended
// risk; multiplied across 3 legs the daily kill-switch (-6%) becomes
// 6.67% loss before tripping. Tightened to ±0.005% absolute — small
// enough to catch the over-sizing class, large enough to absorb any
// floating-point precision artefacts (0.5/2 = 0.25 cleanly in IEEE 754
// but defensive math like (0.1 + 0.15) wouldn't be).

export interface RiskPctValidationInput {
  riskPct: number;
  expectedRiskPct: number;
}

export type RiskPctValidationResult =
  | { ok: true }
  | { ok: false; reason: string };

const RISK_PCT_TOLERANCE = 0.005;

export function validateRiskPct(input: RiskPctValidationInput): RiskPctValidationResult {
  const { riskPct, expectedRiskPct } = input;
  if (!Number.isFinite(riskPct) || !Number.isFinite(expectedRiskPct)) {
    return { ok: false, reason: `Non-finite risk values: riskPct=${riskPct}, expectedRiskPct=${expectedRiskPct}` };
  }
  if (Math.abs(riskPct - expectedRiskPct) > RISK_PCT_TOLERANCE) {
    return {
      ok: false,
      reason: `Risk ${riskPct}% diverges from expected ${expectedRiskPct}% by more than ±${RISK_PCT_TOLERANCE}%`,
    };
  }
  return { ok: true };
}

// ==================== ORDER-SIDE PRE-CHECK ====================
// 2026-05-05 audit. Pre-existing place_split_trade had per-leg side checks
// but the cheap path (request_analyst_review, called BEFORE any LLM cost)
// did not. The 2026-05-04 08:31 UTC live failure was a GOLD SHORT proposal
// with SL=4575 < entry=4576.29 and TPs above entry. The analyst correctly
// detected the inversion but its long rejection prose truncated the JSON
// output, dropping analyst parse rate to 0/6 over 6 days. This validator
// is the cheap gate that catches the problem before the analyst is paid.

export interface OrderSideInput {
  direction: 'long' | 'short';
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  tp3: number;
}

export type OrderSideResult = { ok: true } | { ok: false; reason: string };

/**
 * Geometric sanity for the proposal. Pure, side-effect-free, no DB or
 * network. Cheap pre-check called BEFORE the analyst LLM call, mirroring
 * the same defense in place_split_trade.
 *
 * Long invariant:  sl < entry < tp1 < tp2 < tp3
 * Short invariant: tp3 < tp2 < tp1 < entry < sl
 */
export function validateOrderSide(input: OrderSideInput): OrderSideResult {
  const { direction, entry, sl, tp1, tp2, tp3 } = input;

  for (const [k, v] of Object.entries({ entry, sl, tp1, tp2, tp3 })) {
    if (!Number.isFinite(v)) {
      return { ok: false, reason: `Order-side rejected: ${k}=${v} is not a finite number.` };
    }
  }

  if (direction === 'long') {
    if (!(sl < entry && entry < tp1 && tp1 < tp2 && tp2 < tp3)) {
      return {
        ok: false,
        reason: `Long order-side invariant violated: need sl<entry<tp1<tp2<tp3, got sl=${sl}, entry=${entry}, tp1=${tp1}, tp2=${tp2}, tp3=${tp3}.`,
      };
    }
  } else {
    if (!(tp3 < tp2 && tp2 < tp1 && tp1 < entry && entry < sl)) {
      return {
        ok: false,
        reason: `Short order-side invariant violated: need tp3<tp2<tp1<entry<sl, got sl=${sl}, entry=${entry}, tp1=${tp1}, tp2=${tp2}, tp3=${tp3}.`,
      };
    }
  }
  return { ok: true };
}

// ==================== WEEKLY KILL SWITCH ====================
// 2026-05-04 (Phase A3, audit Finding #6): pre-fix, strategy.md Section 7.2
// said "Weekly loss limit: 10% of account equity. Non-negotiable. When
// triggered: No new positions opened (code-enforced in executeTool paths)"
// — but no caller invoked getWeeklyPnl anywhere in the trading path. A 10%
// weekly drawdown would not stop the bot. Daily 6% catches the worst day,
// but four bad days in a week could clear 10% with the bot still trading.
//
// Strategy doc convention: weekly resets Sunday 00:00 UTC (matches the
// weekly-review cron at `0 0 * * 0`). Current week runs from the most
// recent Sunday 00:00 UTC to next Sunday 00:00 UTC.

const WEEKLY_KILL_SWITCH_PCT = -10;

/**
 * Compute the YYYY-MM-DD UTC date of the most recent Sunday at 00:00 UTC.
 *
 * Sunday is day 0 in JavaScript's getUTCDay(). If today is Sunday, returns
 * today's date. Otherwise subtracts (dayOfWeek) days to roll back to Sunday.
 * Always returns a date in UTC — never local time.
 */
export function computeWeekStartUTC(now: Date = new Date()): string {
  const dow = now.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const sunday = new Date(now);
  sunday.setUTCDate(now.getUTCDate() - dow);
  sunday.setUTCHours(0, 0, 0, 0);
  return sunday.toISOString().split('T')[0];
}

export interface WeeklyKillSwitchInput {
  weeklyPnl: number;   // realised P&L this week (Sun → now) + current unrealised
  equity: number;      // current account equity
}

export type WeeklyKillSwitchResult =
  | { ok: true }
  | { ok: false; error: 'WEEKLY_KILL_SWITCH_ACTIVE'; reason: string; currentPct: number; thresholdPct: number };

/**
 * Block trades when weekly P&L percentage is at or beyond -10%.
 *
 * Pure function: no side effects, no async, no DB. The caller computes
 * weeklyPnl by summing realised_pnl from this week's Sunday + balance's
 * current unrealised. equity is the account balance.
 *
 * Fail-open at equity=0 — a zero-equity account can't take any position
 * anyway, and a divide-by-zero check on the kill switch would mask the
 * downstream rejection in a misleading way.
 */
export function validateWeeklyKillSwitch(input: WeeklyKillSwitchInput): WeeklyKillSwitchResult {
  const { weeklyPnl, equity } = input;
  if (equity <= 0) return { ok: true };
  const currentPct = (weeklyPnl / equity) * 100;
  if (currentPct <= WEEKLY_KILL_SWITCH_PCT) {
    return {
      ok: false,
      error: 'WEEKLY_KILL_SWITCH_ACTIVE',
      reason: `Weekly P&L is ${currentPct.toFixed(2)}% — at or beyond the ${WEEKLY_KILL_SWITCH_PCT}% kill-switch threshold. No new positions until next Sunday 00:00 UTC.`,
      currentPct,
      thresholdPct: WEEKLY_KILL_SWITCH_PCT,
    };
  }
  return { ok: true };
}

// ==================== MCP TOOL DEFINITIONS ====================
// These are passed to Claude as tool schemas so it can call them

const MCP_TOOLS: Anthropic.Messages.Tool[] = [
  {
    name: 'get_daily_pnl',
    description: 'Get today\'s running P&L, equity, and kill switch status',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'get_portfolio',
    description: 'Get current open positions from Capital.com',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'get_ranked_instruments',
    description: 'Get top instruments ranked by preliminary composite score',
    input_schema: {
      type: 'object' as const,
      properties: { limit: { type: 'number', description: 'Number of instruments to return' } },
      required: [],
    },
  },
  {
    name: 'get_prices',
    description: 'Fetch OHLC candle data for an instrument',
    input_schema: {
      type: 'object' as const,
      properties: {
        instrument: { type: 'string', description: 'Ticker symbol' },
        timeframe: { type: 'string', enum: ['15m', '1h', '4h', '1d', '1w'] },
        count: { type: 'number', description: 'Number of candles' },
      },
      required: ['instrument', 'timeframe'],
    },
  },
  {
    name: 'get_news_context',
    description: 'Get scored news items for an instrument',
    input_schema: {
      type: 'object' as const,
      properties: { instrument: { type: 'string' } },
      required: ['instrument'],
    },
  },
  {
    name: 'get_economic_calendar',
    description:
      'Return upcoming high/medium/low-impact macro events (FOMC, NFP, CPI, ECB, BoE, BoJ, central-bank rate decisions, GDP, Core PCE, AHE, Unemployment Rate, Retail Sales, ISM PMI, payrolls). YOU MUST CALL THIS before any request_analyst_review/place_split_trade — trading into a high-impact print on the trade currency is a hard rule violation. place_split_trade is code-level vetoed when a high-impact event for any currency in the trade pair falls inside the per-event veto window: generic high-impact events use −5/+30 min (5 before / 30 after); Tier-1 events (FOMC/NFP/CPI/central-bank rate decisions/Core PCE/GDP/ISM PMI/AHE/Unemployment Rate/Retail Sales/central-bank press conferences) use the wider −60/+30 min window.',
    input_schema: {
      type: 'object' as const,
      properties: {
        days_ahead: { type: 'number', description: 'Lookahead window in days. Default 1.' },
      },
      required: [],
    },
  },
  {
    name: 'get_lessons',
    description: 'Retrieve past lessons filtered by setup type, category, kill zone',
    input_schema: {
      type: 'object' as const,
      properties: {
        setup_type: { type: 'string' },
        instrument_category: { type: 'string' },
        kill_zone: { type: 'string' },
        strategy_tag: { type: 'string', enum: ['ICT_INTRADAY'] },
      },
      required: [],
    },
  },
  // 2026-04-28 audit refactor: replaced bare place_order + log_trade with
  // the unified place_split_trade tool. The new tool atomically validates
  // (composite_score / tier-risk / coordination lock / analyst approval /
  // calendar veto / order side), places all 3 legs, persists the DB
  // record, and compensates on partial failure. The agent MUST call
  // request_analyst_review FIRST to get an analyst_token, then pass that
  // token to place_split_trade.
  {
    name: 'request_analyst_review',
    description:
      'MANDATORY before place_split_trade. Submits the full 3-leg trade proposal to the Trade Analyst Agent. Returns { decision: APPROVE|REJECT|MODIFY, reason, analyst_token, proposal_hash }. The analyst_token is a hash of the canonicalised proposal — place_split_trade rejects unless the supplied token matches a same-cycle approval AND the proposal hash matches. You CANNOT mutate size/SL/TP/score between approval and placement.',
    input_schema: {
      type: 'object' as const,
      properties: {
        instrument: { type: 'string' },
        epic: { type: 'string' },
        instrument_category: { type: 'string', description: "e.g. 'fx' or 'commodity'" },
        direction: { type: 'string', enum: ['long', 'short'] },
        entry: { type: 'number' },
        sl: { type: 'number' },
        tp1: { type: 'number' },
        tp2: { type: 'number' },
        tp3: { type: 'number' },
        size_a: { type: 'number', description: 'Leg A size (~34% of total)' },
        size_b: { type: 'number', description: 'Leg B size (~33% of total)' },
        size_c: { type: 'number', description: 'Leg C size (~33% of total)' },
        composite_score: { type: 'number' },
        tier: { type: 'number', enum: [1, 2, 3] },
        total_risk_pct: { type: 'number', description: '1.5 / 1.0 / 0.5 per tier' },
        setup_type: { type: 'string' },
        kill_zone: { type: 'string' },
        reasoning: { type: 'string' },
      },
      required: ['instrument', 'epic', 'direction', 'entry', 'sl', 'tp1', 'tp2', 'tp3', 'size_a', 'size_b', 'size_c', 'composite_score', 'tier', 'total_risk_pct', 'setup_type', 'kill_zone'],
    },
  },
  {
    name: 'place_split_trade',
    description:
      'Atomically place a 3-leg split-position ICT trade after analyst approval. Validates score/tier/risk/coordination/calendar, places legs A→B→C, persists to DB, compensates on partial failure. REQUIRES analyst_token from request_analyst_review whose proposal_hash matches THIS proposal exactly. Returns dealIds + trade_id on success, or a structured error otherwise.',
    input_schema: {
      type: 'object' as const,
      properties: {
        analyst_token: { type: 'string', description: 'Token returned by request_analyst_review' },
        instrument: { type: 'string' },
        epic: { type: 'string' },
        instrument_category: { type: 'string' },
        direction: { type: 'string', enum: ['long', 'short'] },
        entry: { type: 'number' },
        sl: { type: 'number' },
        tp1: { type: 'number' },
        tp2: { type: 'number' },
        tp3: { type: 'number' },
        size_a: { type: 'number' },
        size_b: { type: 'number' },
        size_c: { type: 'number' },
        composite_score: { type: 'number' },
        tier: { type: 'number', enum: [1, 2, 3] },
        total_risk_pct: { type: 'number' },
        setup_type: { type: 'string' },
        kill_zone: { type: 'string' },
        reasoning: { type: 'string' },
      },
      required: ['analyst_token', 'instrument', 'epic', 'direction', 'entry', 'sl', 'tp1', 'tp2', 'tp3', 'size_a', 'size_b', 'size_c', 'composite_score', 'tier', 'total_risk_pct', 'setup_type', 'kill_zone'],
    },
  },
  {
    name: 'update_sl',
    description: 'Update stop loss for a trade in the database',
    input_schema: {
      type: 'object' as const,
      properties: { trade_id: { type: 'string' }, new_sl: { type: 'number' } },
      required: ['trade_id', 'new_sl'],
    },
  },
  {
    name: 'close_position',
    description: 'Close a position on Capital.com',
    input_schema: {
      type: 'object' as const,
      properties: { dealId: { type: 'string' } },
      required: ['dealId'],
    },
  },
];

// ==================== TOOL EXECUTOR ====================
// Routes tool calls from Claude to the actual MCP tool implementations

import {
  fetchCandles, fetchNewsContext as fetchNewsRaw, fetchEconomicCalendar,
} from '../mcp-server/market-data.js';
import { getRankedInstruments } from '../scanner/index.js';
import {
  insertTrade, getTradeHistory, getLessons, getLessonWinRate,
  createSlTpOrder, updateSlPrice, getDailyPnl, upsertDailyPnl,
  getActiveSlTpOrdersByTradeId, getTradeByDealId, markTradeClosedEarly,
  deactivateSlTpOrder,
} from '../database/index.js';
import { CapitalClient } from '../mcp-server/capital-client.js';

const capital = new CapitalClient({
  apiKey: process.env.CAPITAL_API_KEY || '',
  identifier: process.env.CAPITAL_IDENTIFIER || '',
  password: process.env.CAPITAL_API_KEY_PASSWORD || '',
  baseURL: process.env.CAPITAL_API_URL || 'https://demo-api-capital.backend-capital.com',
});

async function getPreferredAccountBalance(): Promise<{ balance: number; deposit: number; profitLoss: number; available: number }> {
  const accounts = await capital.getAccounts();
  const preferred = accounts.find((a) => a.preferred) ?? accounts[0];
  if (!preferred) {
    throw new Error('No Capital.com account available');
  }
  return preferred.balance;
}

async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'get_daily_pnl': {
      const balance = await getPreferredAccountBalance();
      const today = new Date().toISOString().split('T')[0];
      const daily = getDailyPnl(today);
      const pnl = balance.profitLoss + (daily?.realised_pnl ?? 0);
      const equity = balance.balance;
      const pct = equity ? (pnl / equity) * 100 : 0;
      return JSON.stringify({
        total_daily_pnl: pnl, equity,
        daily_pnl_pct: Math.round(pct * 100) / 100,
        kill_switch_active: pct <= -6,
        open_positions: countOpenPositions(),
      });
    }
    case 'get_portfolio':
      return JSON.stringify(await capital.getOpenPositions());
    case 'get_ranked_instruments':
      return JSON.stringify(await getRankedInstruments(Number(input.limit) || 20));
    case 'get_prices':
      return JSON.stringify(await fetchCandles(
        input.instrument as string,
        input.timeframe as '15m' | '1h' | '4h' | '1d' | '1w',
        Number(input.count) || 100
      ));
    case 'get_news_context':
      return JSON.stringify(await fetchNewsRaw(input.instrument as string));
    case 'get_economic_calendar': {
      const daysAhead = Number(input.days_ahead) > 0 ? Number(input.days_ahead) : 1;
      return JSON.stringify(await fetchEconomicCalendar(daysAhead));
    }
    case 'get_lessons': {
      const filters = {
        setup_type: input.setup_type as string | undefined,
        instrument_category: input.instrument_category as string | undefined,
        kill_zone: input.kill_zone as string | undefined,
        strategy_tag: 'ICT_INTRADAY' as const,
      };
      const lessons = getLessons(filters);
      // Codex P1 #13 (2026-04-28): pass the SAME filters to the win-rate
      // calculation. Previously this was passed only strategy_tag, so the
      // setup-specific penalty in the agent prompt ("if win rate <50% on
      // 5+ trades on this exact setup × kill zone, -10 points") was being
      // applied based on the GLOBAL ICT win rate across all setups —
      // unrelated history poisoning the score.
      const wr = getLessonWinRate(filters);
      return JSON.stringify({ lessons, win_rate: wr });
    }
    case 'request_analyst_review': {
      // 2026-04-29 audit fix (P0-AN1): trade_id chain. Pre-fix this case
      // generated trade-{8hex} for the analyst_log row, and place_split_trade
      // separately generated trade-{12hex} for trades.id — different hashes,
      // different lengths, no possible JOIN. Every analyst_log row was
      // ORPHANED and Weekly Review's calibration calc was permanently broken.
      //
      // Fix: derive trade_id deterministically from the proposal hash. The
      // hash is content-addressed and stable; place_split_trade re-hashes
      // and uses the SAME `trade-${hash}` as trades.id, so analyst_log.trade_id
      // joins to trades.id by construction.
      pruneStaleApprovals();
      const proposalDraft = {
        // trade_id placeholder — overwritten below with a unique id.
        trade_id: '',
        strategy_tag: 'ICT_INTRADAY' as const,
        instrument: String(input.instrument),
        epic: String(input.epic ?? input.instrument),
        instrument_category: String(input.instrument_category ?? 'unknown'),
        direction: input.direction as 'long' | 'short',
        entry: Number(input.entry),
        sl: Number(input.sl),
        tp1: Number(input.tp1),
        tp2: Number(input.tp2),
        tp3: Number(input.tp3),
        size_a: Number(input.size_a),
        size_b: Number(input.size_b),
        size_c: Number(input.size_c),
        total_risk_pct: Number(input.total_risk_pct),
        composite_score: Number(input.composite_score),
        tier: input.tier as 1 | 2 | 3,
        setup_type: String(input.setup_type),
        kill_zone: String(input.kill_zone),
        reasoning: String(input.reasoning ?? ''),
      };
      const hash = proposalHash(proposalDraft);
      // Codex P1 (final review, 2026-04-29): unique trade_id, NOT
      // `trade-${hash}` directly. The hash is content-addressed and
      // identical for identical proposals; if the same setup recurs
      // (e.g. EURUSD long at 1.0850 SL 1.0830 — common pattern), the
      // second trade would collide on trades.id PRIMARY KEY at the
      // DB write step in place_split_trade. Use `trade-${hash}-${uuid}`
      // for uniqueness; the hash is still part of the id for
      // log-grepping and is still in the analyst_token for verification.
      const tradeId = `trade-${hash}-${randomUUID().slice(0, 8)}`;
      const proposal: TradeProposal = { ...proposalDraft, trade_id: tradeId };

      // Phase A6 (2026-05-04, codex 2nd-pass review of Phase A-D): R:R floor
      // pre-check BEFORE the analyst LLM call. Pre-fix the R:R check only
      // ran inside place_split_trade Step 3.3 AFTER the analyst token had
      // been consumed — wasting a Sonnet 4.6 + adaptive-thinking analyst
      // call (~30-45s, $0.10-0.50) on proposals destined to be rejected on
      // geometry alone. The check is duplicated in place_split_trade as
      // defense-in-depth (in case future call paths bypass this handler).
      // Limited to R:R for now per "one change at a time"; other proposal-
      // internal checks (score/tier/risk consistency, finite numerics,
      // order-side) follow the same pattern and are candidates for the
      // same pre-check refactor in a future commit.
      const isRangeModeProposal = /^range_/.test(
        proposal.setup_type.trim().toLowerCase().replace(/[\s_]+/g, '_'),
      );
      const rrPreCheck = validateRRFloor({
        direction: proposal.direction,
        entry: proposal.entry,
        sl: proposal.sl,
        tp1: proposal.tp1,
        tp2: proposal.tp2,
        tp3: proposal.tp3,
        tier: proposal.tier,
        ticker: proposal.instrument,
        isRangeMode: isRangeModeProposal,
      });
      if (!rrPreCheck.ok) {
        console.log(`[Analyst Pre-Check] ${proposal.instrument} ${proposal.direction}: ${rrPreCheck.error} — skipping analyst call.`);
        return JSON.stringify({
          decision: 'REJECT',
          reason: `Pre-analyst R:R floor violation: ${rrPreCheck.reason}`,
          analyst_token: '',  // empty — cannot authorize place_split_trade
          proposal_hash: hash,
          trade_id: proposal.trade_id,
          confidence: 0,
          modifications: {},
        });
      }

      // Phase B (2026-05-05 audit): order-side pre-check. Catches inverted
      // SL/TPs (e.g. SHORT with SL below entry — observed live 2026-05-04
      // 08:31 on GOLD) before the analyst LLM call. Without this gate the
      // analyst's verbose markdown rejection of malformed proposals was the
      // dominant truncation trigger (0/6 parseable decisions over 6 days).
      const orderSidePreCheck = validateOrderSide({
        direction: proposal.direction,
        entry: proposal.entry,
        sl: proposal.sl,
        tp1: proposal.tp1,
        tp2: proposal.tp2,
        tp3: proposal.tp3,
      });
      if (!orderSidePreCheck.ok) {
        console.log(`[Analyst Pre-Check] ${proposal.instrument} ${proposal.direction}: ${orderSidePreCheck.reason} — skipping analyst call.`);
        return JSON.stringify({
          decision: 'REJECT',
          reason: `Pre-analyst order-side violation: ${orderSidePreCheck.reason}`,
          analyst_token: '',
          proposal_hash: hash,
          trade_id: proposal.trade_id,
          confidence: 0,
          modifications: {},
        });
      }

      const decision = await runAnalystAgent(proposal);
      if (decision.decision === 'APPROVE') {
        approvedProposals.set(hash, { approvedAt: Date.now(), proposal });
      } else {
        // 2026-04-29 audit-3 fix (P0-3): invalidate any prior APPROVE on a
        // REJECT/MODIFY for the same proposal hash. Pre-fix scenario: the
        // agent calls request_analyst_review twice in the same cycle (e.g.
        // re-asking after a fresh news fetch); first call APPROVEs and
        // stores the token, second call REJECTs but the OLD APPROVE token
        // remains live in approvedProposals for the 10-min TTL. The agent
        // could then call place_split_trade with the original token and
        // the order would go through despite the most recent analyst
        // verdict being REJECT. Fix: any non-APPROVE verdict on a hash
        // explicitly invalidates any prior approval for that same hash.
        approvedProposals.delete(hash);
      }
      return JSON.stringify({
        decision: decision.decision,
        reason: decision.reason,
        analyst_token: hash,
        proposal_hash: hash,
        trade_id: proposal.trade_id,
        confidence: decision.confidence,
        modifications: decision.modifications,
      });
    }

    case 'place_split_trade': {
      // Unified atomic 3-leg placement with full validation cascade.
      // Replaces bare place_order + log_trade. Codex P0+P1 fixes
      // (2026-04-28): #1 (analyst gate), #2 (atomic order+log), #8 (score
      // contract), #9 (coordination lock), plus order-side, finite, and
      // calendar checks.
      const epic = String(input.epic);
      const direction = input.direction as 'long' | 'short';

      // === Step 1: rebuild proposal from input + verify hash matches token
      pruneStaleApprovals();
      const proposalForVerify: TradeProposal = {
        trade_id: '<placeholder — not part of hash>',
        strategy_tag: 'ICT_INTRADAY',
        instrument: String(input.instrument),
        epic,
        instrument_category: String(input.instrument_category ?? 'unknown'),
        direction,
        entry: Number(input.entry),
        sl: Number(input.sl),
        tp1: Number(input.tp1),
        tp2: Number(input.tp2),
        tp3: Number(input.tp3),
        size_a: Number(input.size_a),
        size_b: Number(input.size_b),
        size_c: Number(input.size_c),
        total_risk_pct: Number(input.total_risk_pct),
        composite_score: Number(input.composite_score),
        tier: input.tier as 1 | 2 | 3,
        setup_type: String(input.setup_type),
        kill_zone: String(input.kill_zone),
        reasoning: String(input.reasoning ?? ''),
      };
      const hash = proposalHash(proposalForVerify);
      const tokenStr = String(input.analyst_token ?? '');
      // 2026-04-29 codex-review fix (Finding 3): atomic verify-and-consume.
      // Pre-fix the token was verified at Step 1 but only consumed at
      // Step 5.5 (after balance / min-size / live-position / calendar
      // awaits). Two concurrent place_split_trade calls with the same
      // approved token could BOTH pass verification across those awaits
      // and both attempt placement — duplicate trade. JS is single-threaded
      // within a synchronous block, so doing get + delete with NO await
      // between them is atomic across concurrent callers (the second one
      // sees `undefined` from .get() because the first one's .delete()
      // already ran). Move consume here, before any await in the validation
      // cascade. If a later step fails, the token is gone and the agent
      // re-requests review on the next cycle — small extra Sonnet call,
      // eliminates the race.
      const approval = approvedProposals.get(tokenStr);
      if (!approval) {
        return JSON.stringify({
          error: 'ANALYST_NOT_APPROVED',
          reason: 'No analyst approval found for the supplied analyst_token. Call request_analyst_review first.',
        });
      }
      if (tokenStr !== hash) {
        return JSON.stringify({
          error: 'PROPOSAL_HASH_MISMATCH',
          reason: 'analyst_token was issued for a different proposal. The trade params must match exactly what was approved (size, SL, TP, score, tier). Re-request analyst_review with the current proposal.',
          expected_hash: hash,
          provided_token: input.analyst_token,
        });
      }
      approvedProposals.delete(tokenStr);

      // === Step 2: composite_score / tier / risk-pct internal consistency
      const score = Number(input.composite_score);
      const tier = Number(input.tier);
      const riskPct = Number(input.total_risk_pct);
      const setupType = String(input.setup_type ?? '');
      // 2026-04-29 range-mode addition: setup_type indicating range-mode
      // signals 0.25% total risk (vs standard 0.5% Tier 3). The match is
      // intentionally lenient — Haiku may emit "Range_Sweep_Reversal"
      // (canonical), "Range Sweep Reversal" (with spaces), or
      // "range_sweep_reversal" (lowercase). Codex review of 7b6db35
      // flagged that the strict /^Range_/i regex would reject
      // space-separated variants → correct 0.25% proposal gets a
      // RISK_PCT_TIER_MISMATCH error. Match any setup_type whose first
      // word (after trimming whitespace/underscores) is "range".
      const setupTypeNorm = setupType.trim().toLowerCase().replace(/[\s_]+/g, '_');
      const isRangeMode = /^range_/.test(setupTypeNorm);
      const tier3Floor = tier3FloorFor(proposalForVerify.instrument);
      if (!Number.isFinite(score) || score < tier3Floor) {
        return JSON.stringify({
          error: 'SCORE_BELOW_TIER_MIN',
          reason: `composite_score ${score} is below Tier 3 floor ${tier3Floor} for ${proposalForVerify.instrument}. No trade.`,
        });
      }
      const expectedTier = score >= 80 ? 1 : score >= 60 ? 2 : 3;
      if (tier !== expectedTier) {
        return JSON.stringify({
          error: 'TIER_SCORE_MISMATCH',
          reason: `composite_score ${score} maps to Tier ${expectedTier}, but proposal claims Tier ${tier}.`,
        });
      }
      // Range-mode is structurally Tier 3 only — reject T1/T2 proposals
      // that try to use a Range_* setup_type.
      if (isRangeMode && tier !== 3) {
        return JSON.stringify({
          error: 'RANGE_MODE_TIER_MISMATCH',
          reason: `setup_type "${setupType}" is range-mode and Tier 3 only. Proposal has Tier ${tier}.`,
        });
      }
      const expectedRiskPct = isRangeMode ? 0.25
        : expectedTier === 1 ? 1.5
        : expectedTier === 2 ? 1.0
        : 0.5;
      const riskPctCheck = validateRiskPct({ riskPct, expectedRiskPct });
      if (!riskPctCheck.ok) {
        return JSON.stringify({
          error: 'RISK_PCT_TIER_MISMATCH',
          reason: `${isRangeMode ? 'Range-mode' : `Tier ${expectedTier}`} requires risk ${expectedRiskPct}%. ${riskPctCheck.reason}.`,
        });
      }

      // === Step 3: order-side + finite-numbers
      const entry = Number(input.entry);
      const sl = Number(input.sl);
      const tp1 = Number(input.tp1);
      const tp2 = Number(input.tp2);
      const tp3 = Number(input.tp3);
      const sizeA = Number(input.size_a);
      const sizeB = Number(input.size_b);
      const sizeC = Number(input.size_c);
      const allFinite = [entry, sl, tp1, tp2, tp3, sizeA, sizeB, sizeC].every((n) => Number.isFinite(n));
      if (!allFinite) {
        return JSON.stringify({
          error: 'INVALID_NUMERICS',
          reason: `Non-finite numeric in proposal: entry=${entry}, sl=${sl}, tps=[${tp1},${tp2},${tp3}], sizes=[${sizeA},${sizeB},${sizeC}]`,
        });
      }
      if (sizeA <= 0 || sizeB <= 0 || sizeC <= 0) {
        return JSON.stringify({
          error: 'INVALID_SIZES',
          reason: `All leg sizes must be > 0. Got A=${sizeA} B=${sizeB} C=${sizeC}.`,
        });
      }
      const sideOk = direction === 'long'
        ? sl < entry && entry < tp1 && tp1 < tp2 && tp2 < tp3
        : sl > entry && entry > tp1 && tp1 > tp2 && tp2 > tp3;
      if (!sideOk) {
        return JSON.stringify({
          error: 'INVALID_ORDER_SIDE',
          reason: `For direction='${direction}', expected ${direction === 'long' ? 'SL<entry<TP1<TP2<TP3' : 'SL>entry>TP1>TP2>TP3'}. Got SL=${sl} entry=${entry} TP1=${tp1} TP2=${tp2} TP3=${tp3}.`,
        });
      }

      // === Step 3.3: R:R floor validation (Phase A1, 2026-05-04, audit Finding #2)
      // strategy.md Section 7.3 specifies trend-mode TP1≥1, TP2≥2 (or 1.5 for
      // T3 tight-spread), TP3≥3; range-mode TP1≥1, TP2≥1.5, TP3≥2. Pre-fix
      // there was NO magnitude check — only ordering. A hallucinated proposal
      // with TP1 1 pip past entry could pass every gate. See validateRRFloor
      // above for the full rationale.
      const rrCheck = validateRRFloor({
        direction,
        entry,
        sl,
        tp1,
        tp2,
        tp3,
        tier: expectedTier,
        ticker: String(input.instrument ?? '').toUpperCase(),
        isRangeMode,
      });
      if (!rrCheck.ok) {
        return JSON.stringify({
          error: rrCheck.error,
          reason: rrCheck.reason,
        });
      }

      // === Step 3.5: code-enforced 6% daily + 10% weekly kill switches
      // Daily 6%: Codex P0-TA1 (2026-04-29). strategy.md Section 7.2 says
      // daily 6% loss is non-negotiable. Pre-fix this was only visible to
      // the LLM via get_daily_pnl as a FLAG — no code-level gate.
      // Weekly 10%: Phase A3 (2026-05-04, audit Finding #6). strategy.md
      // Section 7.2 also says "Weekly loss limit: 10% of account equity.
      // Non-negotiable. When triggered: No new positions opened
      // (code-enforced in executeTool paths)" — but pre-fix no caller
      // invoked getWeeklyPnl. Daily caught the worst day; four bad days
      // could still clear 10% with the bot trading. Now enforced.
      try {
        const balance = await getPreferredAccountBalance();
        const today = new Date().toISOString().split('T')[0];
        const daily = getDailyPnl(today);
        const equity = balance.balance;

        // Daily check (unchanged behaviour)
        const pnl = balance.profitLoss + (daily?.realised_pnl ?? 0);
        const pct = equity ? (pnl / equity) * 100 : 0;
        if (pct <= -6) {
          console.error(`[ICT Agent] DAILY KILL SWITCH ACTIVE: ${pct.toFixed(2)}% — refusing place_split_trade for ${input.instrument}.`);
          return JSON.stringify({
            error: 'DAILY_KILL_SWITCH_ACTIVE',
            reason: `Daily P&L is ${pct.toFixed(2)}% — at or beyond the -6% kill-switch threshold. No new positions until UTC midnight.`,
            current_pct: pct,
            threshold_pct: -6,
          });
        }

        // Weekly check (new). Realised P&L from this week's Sunday onward
        // (includes today's realised if the daily log has been updated this
        // tick) plus current unrealised. Avoids double-counting today's
        // unrealised by using realised-only sum + balance.profitLoss.
        const weekStart = computeWeekStartUTC(new Date());
        const weeklyRealised = getRealisedPnlSince(weekStart);
        const weeklyPnl = weeklyRealised + balance.profitLoss;
        const weeklyCheck = validateWeeklyKillSwitch({ weeklyPnl, equity });
        if (!weeklyCheck.ok) {
          console.error(`[ICT Agent] WEEKLY KILL SWITCH ACTIVE: ${weeklyCheck.currentPct.toFixed(2)}% — refusing place_split_trade for ${input.instrument}.`);
          return JSON.stringify({
            error: weeklyCheck.error,
            reason: weeklyCheck.reason,
            current_pct: weeklyCheck.currentPct,
            threshold_pct: weeklyCheck.thresholdPct,
            week_start: weekStart,
          });
        }
      } catch (err) {
        // Fail-CLOSED on inability to read balance/PnL. A risk gate cannot
        // be allowed to silently bypass on data-source failure.
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[ICT Agent] DAILY/WEEKLY P&L FETCH FAILED: ${msg}. Refusing place_split_trade — cannot verify kill switch.`);
        return JSON.stringify({
          error: 'DAILY_PNL_FETCH_FAILED',
          reason: `Cannot verify daily/weekly kill switch: ${msg}. Refusing order — risk gate fails closed.`,
        });
      }

      // === Step 3.7: minimum-size guardrail (2026-04-29 structural fix #7)
      // Capital.com instruments have per-instrument minimum deal sizes
      // exposed via getMarketDetails().dealingRules.minDealSize. On a
      // small demo account (e.g. $500), Tier 3 sizing
      // ((500 * 0.005 / 3) / 0.0020 = 416 contracts) can fall BELOW the
      // FX major minimum of typically 1000 contracts. Pre-fix the order
      // would reach Capital, get rejected with a min-size error, and
      // the executor would silently compensation-rollback — wasting the
      // full validation cascade. Now we fail fast with a structured
      // error the agent can act on (skip the trade or restructure to
      // larger size on the next cycle).
      try {
        const md = await capital.getMarketDetails(epic);
        const minRule = md?.dealingRules?.minDealSize;
        const minSize = typeof minRule?.value === 'number' && Number.isFinite(minRule.value)
          ? minRule.value
          : null;
        if (minSize !== null) {
          const undersized: Array<{ leg: 'A' | 'B' | 'C'; size: number }> = [];
          if (sizeA < minSize) undersized.push({ leg: 'A', size: sizeA });
          if (sizeB < minSize) undersized.push({ leg: 'B', size: sizeB });
          if (sizeC < minSize) undersized.push({ leg: 'C', size: sizeC });
          if (undersized.length > 0) {
            return JSON.stringify({
              error: 'BELOW_MIN_SIZE',
              // 2026-04-29 codex-review fix: corrected the guidance — sizing
              // formula is `size = (risk / 3) / (entry - SL)` so a WIDER SL
              // produces SMALLER sizes (larger denominator), not larger.
              // Real ways to lift size above the floor: upgrade the tier
              // (raises total_risk_pct → numerator), TIGHTEN the SL (shrinks
              // denominator), or skip until account balance grows.
              reason: `Capital.com minimum deal size for ${epic} is ${minSize} ${minRule?.unit ?? ''}. Legs ${undersized.map((u) => `${u.leg}=${u.size}`).join(', ')} are below the floor. Either upgrade the tier (raises total_risk_pct → larger sizes), tighten the SL (smaller (entry−SL) → larger sizes), or skip this instrument until account balance grows.`,
              min_deal_size: minSize,
              undersized_legs: undersized,
            });
          }
        }
        // If minDealSize is missing/non-numeric on the market details
        // response, we deliberately allow the trade — Capital itself will
        // reject below-min orders with a clear error, and the executor's
        // existing compensation-rollback path handles it. The guardrail
        // is best-effort signal, not load-bearing.
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Don't fail-closed on getMarketDetails failure — that would gate
        // every trade on a Capital read. Log and continue; if Capital is
        // genuinely down, the placement will fail anyway and rollback.
        console.warn(`[ICT Agent] min-size check skipped for ${epic} (getMarketDetails failed: ${msg}). Continuing — Capital will reject below-min orders.`);
      }

      // === Step 4: code-enforced coordination lock
      // 2026-04-29 audit fix (P0-TA3): check BOTH the local DB AND the
      // live Capital state. Pre-fix the lock checked only the DB, so a
      // restart with empty DB while Capital had open positions would let
      // the LLM open a duplicate. Now we union the two.
      const existing = getOpenTradesByInstrument(String(input.instrument));
      if (existing.length > 0) {
        return JSON.stringify({
          error: 'COORDINATION_LOCK',
          reason: `An open ${input.instrument} position already exists in DB (trade_id=${existing[0].id}, status=${existing[0].status}). Coordination lock prevents duplicate-instrument entries.`,
        });
      }
      try {
        const livePositions = await capital.getOpenPositions();
        const sameEpic = livePositions.filter(
          (p) => String(p.market?.epic ?? '').toUpperCase() === epic.toUpperCase(),
        );
        if (sameEpic.length > 0) {
          return JSON.stringify({
            error: 'COORDINATION_LOCK_LIVE',
            reason: `Capital.com has ${sameEpic.length} live position(s) on ${epic} that are NOT in the local DB. Possible orphan from a prior session — manual reconciliation required before opening more.`,
            live_deal_ids: sameEpic.map((p) => p.position?.dealId).filter(Boolean),
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[ICT Agent] LIVE POSITION CHECK FAILED for ${epic}: ${msg}. Refusing place_split_trade — coordination gate fails closed.`);
        return JSON.stringify({
          error: 'LIVE_POSITION_CHECK_FAILED',
          reason: `Cannot verify Capital.com live state for coordination lock: ${msg}. Refusing order — fails closed.`,
        });
      }

      // === Step 5: calendar veto (fail-closed on fetch error)
      // 2026-04-29 audit-3 fix (P0-4): drop the `.catch(() => [])` on
      // fetchForexFactoryCalendar. Pre-fix, an FF outage silently swallowed
      // the error and returned [] — the calendar veto then ran on Finnhub
      // alone, leaving FX-calibrated tier-1 events that Finnhub doesn't
      // carry (or carries late) invisible. The outer try/catch already
      // fails closed on Promise.all rejection; let FF rejection propagate.
      const tradeCurrencies = instrumentToCurrencies(epic);
      if (tradeCurrencies.length > 0) {
        try {
          const [finnhubCalendar, ffCalendar] = await Promise.all([
            fetchEconomicCalendar(1),
            fetchForexFactoryCalendar(),
          ]);
          const calendar = [...finnhubCalendar, ...ffCalendar];
          const veto = shouldVetoOrderForCalendar(tradeCurrencies, calendar, Date.now());
          if (veto.veto) {
            return JSON.stringify({
              error: 'CALENDAR_VETO',
              reason: veto.reason,
              event: veto.event,
            });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[ICT Agent] CALENDAR FETCH FAILED for ${epic}: ${msg}. Refusing — fail closed.`);
          return JSON.stringify({
            error: 'CALENDAR_FETCH_FAILED',
            reason: `Calendar fetch failed (${msg}). Refusing order — risk gate fails closed.`,
          });
        }
      }

      // (Step 5.5 — token consumption — has moved to immediately after
      // verification at Step 1 to eliminate the cross-await race condition
      // codex flagged on 2026-04-29. The token was already consumed before
      // any of Steps 3.5/3.7/4/5 ran.)

      // === Step 6: place legs sequentially with compensation
      const tsCompact = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
      const labelBase = `ICT-${input.instrument}-${tsCompact}`;
      const placedDeals: Array<{ leg: 'A' | 'B' | 'C'; dealId: string }> = [];
      const capDirection: 'BUY' | 'SELL' = direction === 'long' ? 'BUY' : 'SELL';

      const placeLeg = async (leg: 'A' | 'B' | 'C', size: number, tp: number): Promise<string> => {
        const conf = await capital.openPosition({
          direction: capDirection,
          epic,
          size,
          stopLevel: sl,
          profitLevel: tp,
        });
        if (!conf.dealId) {
          throw new Error(`Capital returned no dealId for leg ${leg}: ${JSON.stringify(conf)}`);
        }
        return conf.dealId;
      };

      try {
        const dealA = await placeLeg('A', sizeA, tp1);
        placedDeals.push({ leg: 'A', dealId: dealA });
        const dealB = await placeLeg('B', sizeB, tp2);
        placedDeals.push({ leg: 'B', dealId: dealB });
        const dealC = await placeLeg('C', sizeC, tp3);
        placedDeals.push({ leg: 'C', dealId: dealC });
      } catch (err) {
        // === Compensation: close any successfully-placed legs
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[ICT Agent] place_split_trade partial failure: ${errMsg}. Rolling back ${placedDeals.length} placed legs.`);
        const rollbackErrors: string[] = [];
        for (const p of placedDeals) {
          try {
            await capital.closePosition(p.dealId);
          } catch (closeErr) {
            const closeMsg = closeErr instanceof Error ? closeErr.message : String(closeErr);
            rollbackErrors.push(`Leg ${p.leg} (deal ${p.dealId}): ${closeMsg}`);
          }
        }
        return JSON.stringify({
          error: 'PLACE_SPLIT_PARTIAL_FAILURE',
          reason: `Placement of leg ${placedDeals.length === 0 ? 'A' : placedDeals.length === 1 ? 'B' : 'C'} failed: ${errMsg}.`,
          placed_legs: placedDeals,
          rollback_errors: rollbackErrors,
          guidance: rollbackErrors.length === 0
            ? 'All placed legs successfully closed. Account is flat. Retry on next cycle.'
            : '⚠️ ROLLBACK INCOMPLETE — some legs may still be open on Capital. Inspect manually + reconcile.',
        });
      }

      // === Step 7: persist trade record + SL/TP rows + Telegram alert
      // 2026-04-29 audit fix (P0-AN1): use the trade_id from the approved
      // proposal — the ONE generated in request_analyst_review and stored
      // in the approval map. analyst_log.trade_id row was written with this
      // exact id when the Analyst returned APPROVE, so trades.id JOINs
      // cleanly. Codex final-review fix: this id includes a UUID suffix to
      // prevent collision when the same setup recurs across time.
      const tradeId = approval.proposal.trade_id;
      // The tradeRow shape is the agent's payload that insertTrade
      // normalises defensively. We use `as any` here because Parameters<
      // typeof insertTrade>[0] resolves to a strict type that TS struggles
      // to infer compatibility for given the optional/null fields. The
      // runtime shape is verified by insertTrade's own field-by-field
      // normalization in src/database/index.ts.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tradeRow: any = {
        id: tradeId,
        strategy_tag: 'ICT_INTRADAY',
        instrument: String(input.instrument),
        instrument_category: String(input.instrument_category ?? 'unknown'),
        direction,
        setup_type: String(input.setup_type),
        entry,
        sl,
        tp1,
        tp2,
        tp3,
        position_a_id: placedDeals[0].dealId,
        position_b_id: placedDeals[1].dealId,
        position_c_id: placedDeals[2].dealId,
        size_a: sizeA,
        size_b: sizeB,
        size_c: sizeC,
        status: 'open',
        composite_score: score,
        kill_zone: String(input.kill_zone),
        analyst_decision: 'APPROVE',
        reasoning: String(input.reasoning ?? ''),
      };
      try {
        insertTrade(tradeRow);
        createSlTpOrder({ trade_id: tradeId, leg: 'A', instrument: tradeRow.instrument, direction, quantity: sizeA, sl_price: sl, tp_price: tp1, deal_id: placedDeals[0].dealId });
        createSlTpOrder({ trade_id: tradeId, leg: 'B', instrument: tradeRow.instrument, direction, quantity: sizeB, sl_price: sl, tp_price: tp2, deal_id: placedDeals[1].dealId });
        createSlTpOrder({ trade_id: tradeId, leg: 'C', instrument: tradeRow.instrument, direction, quantity: sizeC, sl_price: sl, tp_price: tp3, deal_id: placedDeals[2].dealId });
      } catch (err) {
        // DB write failed AFTER successful Capital placement. This is the
        // exact orphan-position scenario CR-9 was meant to prevent —
        // positions exist on Capital but no DB record means scheduler
        // can't manage them. Don't roll back the live positions (closing
        // them costs spread+slippage); instead, alert LOUDLY and log all
        // dealIds so ops can manually reconcile.
        const dbErr = err instanceof Error ? err.message : String(err);
        console.error(
          `[ICT Agent] CRITICAL: Capital legs placed but DB log_trade FAILED — ${dbErr}\n` +
            `Orphan dealIds: ${placedDeals.map((p) => `${p.leg}=${p.dealId}`).join(', ')}\n` +
            `MANUAL RECONCILE REQUIRED.`,
        );
        return JSON.stringify({
          error: 'DB_LOG_FAILED_AFTER_PLACEMENT',
          reason: `Capital placement succeeded for all 3 legs, but DB persistence failed: ${dbErr}.`,
          orphan_deals: placedDeals,
          guidance: 'Live positions exist on Capital with no DB record. Manual reconciliation required. Do NOT retry — that would double-place.',
        });
      }

      // Approval was consumed at step 5.5 (before placement) so we don't
      // re-delete here. (Comment kept as breadcrumb for the next reader.)

      await alertTradePlaced(tradeRow);
      console.log(`[ICT Agent] Trade placed: ${tradeId} ${input.instrument} ${direction} ${score}/T${tier} (3 legs)`);
      return JSON.stringify({
        status: 'placed',
        trade_id: tradeId,
        deals: placedDeals,
        total_risk_pct: riskPct,
        composite_score: score,
        tier,
      });
    }
    case 'update_sl': {
      // 2026-04-29 audit-3 fix (Researcher P0-1): pre-fix this tool wrote
      // ONLY to the local DB sl_tp_orders.sl_price and never reached
      // Capital.com. The system prompt told the LLM "use update_sl to
      // tighten SL on a structural change" and the response was
      // {status:'updated'} — but the broker's stopLevel was unchanged.
      // Every "tighten SL" action the LLM thought it executed was fake.
      //
      // Fix: discover all active legs for this trade_id, push the new
      // stopLevel to Capital.com via updatePosition for each, AND update
      // the DB to keep them in sync. Failures are reported per-leg so
      // the agent sees which legs succeeded.
      const tradeId = String(input.trade_id);
      const newSl = Number(input.new_sl);
      if (!Number.isFinite(newSl)) {
        return JSON.stringify({ error: 'INVALID_SL', reason: `new_sl must be finite. Got ${input.new_sl}` });
      }
      const activeOrders = getActiveSlTpOrdersByTradeId(tradeId);
      if (activeOrders.length === 0) {
        return JSON.stringify({
          error: 'NO_ACTIVE_LEGS',
          reason: `No active sl_tp_orders rows for trade_id=${tradeId}. Either the trade is already closed or the trade_id is wrong.`,
        });
      }
      const results: Array<{ leg: string; deal_id: string | null; ok: boolean; error?: string }> = [];
      for (const order of activeOrders) {
        if (!order.deal_id) {
          results.push({ leg: order.leg, deal_id: null, ok: false, error: 'No deal_id on this leg row.' });
          continue;
        }
        try {
          await capital.updatePosition(order.deal_id, { stopLevel: newSl });
          updateSlPrice(tradeId, order.leg, newSl);
          results.push({ leg: order.leg, deal_id: order.deal_id, ok: true });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[ICT Agent] update_sl failed for trade=${tradeId} leg=${order.leg} deal=${order.deal_id}: ${msg}`);
          results.push({ leg: order.leg, deal_id: order.deal_id, ok: false, error: msg });
        }
      }
      const allOk = results.every((r) => r.ok);
      return JSON.stringify({
        status: allOk ? 'updated' : 'partial_failure',
        new_sl: newSl,
        per_leg: results,
        guidance: allOk
          ? `All ${results.length} active legs updated on Capital + DB.`
          : 'One or more legs failed to update on Capital — broker truth is now divergent across legs. Review per_leg results and consider close_position on the failing legs.',
      });
    }
    case 'close_position': {
      // 2026-04-29 audit-3 fix (Researcher P0-2): pre-fix this tool only
      // called Capital.closePosition; the local DB was untouched. The next
      // monitorSplitPositions tick saw the closed position with no PROFIT/
      // STOP activity match → classifyCloseReason returned 'OTHER' →
      // handleSlOnLeg eventually finalised the trade as `sl_hit`. Every
      // agent-initiated early close was misrecorded as a stop-out, polluting
      // Weekly Review win-rate calc and the Reflection lesson.
      //
      // Fix: after Capital close succeeds, locate the trade record by
      // deal_id, mark it `closed_early` with a closure_reason, deactivate
      // the leg's sl_tp_orders row. The `closed_early` enum value was
      // already in the schema, just dead code.
      const dealId = String(input.dealId);
      const reasonText = typeof input.reason === 'string' ? input.reason : 'agent-initiated early close';
      let capitalResult: unknown;
      try {
        capitalResult = await capital.closePosition(dealId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return JSON.stringify({ error: 'CAPITAL_CLOSE_FAILED', reason: msg, dealId });
      }
      // Locate the owning trade and update DB.
      const trade = getTradeByDealId(dealId);
      if (!trade) {
        // Could happen if the deal_id is wrong, or for a position that
        // was placed outside the bot. Don't fail — return success with
        // a warning.
        return JSON.stringify({
          status: 'closed_on_capital',
          warning: 'No DB trade record found for this deal_id — Capital position closed but no DB row updated. Verify the dealId.',
          capital_result: capitalResult,
        });
      }
      // Find which leg this deal_id belongs to and deactivate just that row
      // (NOT the entire trade — other legs may still be running).
      const allLegs = getActiveSlTpOrdersByTradeId(trade.id);
      const matchedLeg = allLegs.find((l) => l.deal_id === dealId);
      if (matchedLeg) {
        deactivateSlTpOrder(trade.id, matchedLeg.leg);
      }
      // Mark trade closed_early ONLY if no other legs remain active
      // (i.e. this close finishes off the trade). Otherwise the trade
      // is still partially live.
      const remainingActive = getActiveSlTpOrdersByTradeId(trade.id);
      if (remainingActive.length === 0) {
        markTradeClosedEarly(trade.id, `${reasonText} (deal=${dealId}, leg=${matchedLeg?.leg ?? '?'})`);
      }
      return JSON.stringify({
        status: 'closed',
        trade_id: trade.id,
        leg_closed: matchedLeg?.leg ?? null,
        remaining_legs: remainingActive.length,
        trade_status: remainingActive.length === 0 ? 'closed_early' : trade.status,
        capital_result: capitalResult,
      });
    }
    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

// ==================== MAIN AGENT LOOP ====================

export async function runTradingAgent(): Promise<void> {
  console.log('ICT Trading Agent starting decision cycle...');

  const systemPrompt = loadPromptWithDemoContext('ict-agent.md');
  const strategy = loadStrategy('strategy.md');
  const brief = getLatestBrief();
  // B (2026-04-28): preload yesterday's EOD journal so the ICT cycle
  // starts with "yesterday I learned X" preamble. Walks back up to 3 days
  // (CR-9 narrowed from 5) to handle weekend gaps without injecting stale
  // ancient journals during extended downtime.
  // CR-9 also caps the journal markdown at 4000 chars before injection so
  // a verbose entry can't blow out the ICT context budget.
  const JOURNAL_PREAMBLE_MAX_CHARS = 4000;
  const journal = loadRecentJournal();
  const journalMarkdown = journal
    ? (journal.markdown.length > JOURNAL_PREAMBLE_MAX_CHARS
        ? `${journal.markdown.slice(0, JOURNAL_PREAMBLE_MAX_CHARS)}\n\n[…truncated for context budget]`
        : journal.markdown)
    : null;

  const contextMessage = `Current UTC time: ${new Date().toISOString()}

${journal && journalMarkdown ? `YESTERDAY'S JOURNAL (${journal.date}) — read this before deciding, it captures patterns from the most recent trading day:

${journalMarkdown}

---

` : ''}STRATEGY FILE:
${strategy}

${brief ? `LATEST RESEARCH BRIEF:
${JSON.stringify(brief, null, 2)}` : 'No research brief available yet.'}

Begin your 5-step decision cycle now. Start with Step 1 (check daily risk status).`;

  // Agentic loop: Claude calls tools, we execute, feed results back
  let messages: Anthropic.Messages.MessageParam[] = [
    { role: 'user', content: contextMessage },
  ];

  // Iteration cap reduced 15 → 8 on 2026-04-21. Typical decision cycle
  // completes in 5-8 iterations; runs that hit 15 were usually stuck in
  // a research loop that never converges. 8 forces a decision with the
  // data the agent has gathered so far — occasional quality dip on
  // borderline cases, significant tail-cost saving.
  const maxIterations = 8;

  // 2026-04-29 audit (continued bug hunt): the ICT main loop had no per-
  // iteration timeout. With 8 iterations and the SDK's 600s default, a
  // wedged Anthropic call could hold the cycle for 80 minutes. Now each
  // iteration has a 90s budget — long enough for typical thinking +
  // tool-routing, short enough that 8 wedged iterations is "only" 12 min
  // (still bad, but bounded). A wedged iteration throws, the loop's
  // outer scheduler catches it via safeRun.
  const iterationTimeoutMs = 90_000;
  // Track whether the loop exited via `break` (clean end_turn) or by
  // exhausting maxIterations. Codex final-review P2: pre-fix the
  // "CYCLE TIMED OUT" log fired even on a clean break.
  let cleanlyCompleted = false;

  for (let i = 0; i < maxIterations; i++) {
    const response = await withTimeout(anthropic.messages.create({
      // Cost optimisation (2026-04-29): downgraded Sonnet → Haiku 4.5 per
      // user direction. ICT runs ~70× per kill-zone-active day, so it's
      // the single biggest Claude-API line-item. Trade-off: Haiku is a
      // smaller model, so quantitative reasoning (R:R math, order-block
      // structure detection) may regress versus Sonnet. If decision
      // quality demonstrably drops (more bad-trigger trades / fewer
      // legitimate setups taken) revert the `model` field to
      // 'claude-sonnet-4-6'. Trade-Analyst stays on Sonnet — ALL trade
      // approvals still run through analyst review, so Haiku ICT errors
      // are caught at the analyst gate before any Capital order.
      model: 'claude-haiku-4-5-20251001',
      // max_tokens 16000 → 12000 (2026-04-21): caps the output each
      // iteration can generate. Typical response is 2-5k, so 12k is
      // still generous headroom. Rare verbose responses now truncate
      // earlier — saves worst-case output cost without affecting the
      // 95th percentile.
      max_tokens: 12000,
      // 2026-04-29: removed `thinking: { type: 'adaptive' }` and
      // `output_config: { effort }` when the model was downgraded to
      // Haiku 4.5. Both params are Sonnet/Opus-only — Haiku 4.5 returns
      // HTTP 400 "adaptive thinking is not supported on this model".
      // Caught live in production at the first cycle after downgrade
      // (08:30 UTC). If we re-upgrade to Sonnet, restore both lines.
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      tools: MCP_TOOLS,
      messages,
    }), iterationTimeoutMs, `ICT iter ${i + 1}/${maxIterations}`);

    // Collect text and thinking output
    for (const block of response.content) {
      if (block.type === 'thinking') {
        console.log('[ICT Agent Thinking]', block.thinking.substring(0, 200));
      } else if (block.type === 'text' && block.text.trim()) {
        console.log('[ICT Agent]', block.text);
      }
    }

    // If stop_reason is end_turn, the agent is done
    if (response.stop_reason === 'end_turn') {
      console.log('ICT Trading Agent decision cycle complete.');
      cleanlyCompleted = true;
      break;
    }

    // If there are tool calls, execute them
    if (response.stop_reason === 'tool_use') {
      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];

      for (const block of response.content) {
        if (block.type === 'tool_use') {
          console.log(`[ICT Agent] Calling tool: ${block.name}`);
          let result: string;
          try {
            result = await executeTool(block.name, block.input as Record<string, unknown>);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.warn(`[ICT Agent] Tool ${block.name} failed: ${message}`);
            result = JSON.stringify({ error: message, tool: block.name });
          }
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: result,
          });
        }
      }

      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });
    }
  }

  // Codex P2 #18 (2026-04-28): if the loop exhausted maxIterations
  // without an end_turn, the agent ran out of room mid-reasoning. Loud
  // alert via console.error so ops can review pm2-err.log; the cycle
  // already completed (placed orders persist), but it's worth knowing
  // the agent was still mid-thought when the hammer dropped.
  // No Telegram alert here to avoid noise; pm2 log review covers it.
  // Codex final-review P2 (2026-04-29): only log the warning when the
  // loop exhausted iterations — pre-fix it fired on every clean
  // end_turn break too, polluting pm2-err.log.
  if (!cleanlyCompleted) {
    console.error(
      `[ICT Agent] CYCLE TIMED OUT after ${maxIterations} iterations without end_turn. ` +
        `Decision may be incomplete. If this happens repeatedly, raise the cap or audit ` +
        `which tool the agent is looping on.`,
    );
  }
}

// ICT Intraday Trading Agent — 5-Step Decision Cycle
// Called every time a new 15M or 1H candle closes
// Uses Claude Sonnet to analyse ICT structure and make trade decisions
//
// The agent receives market data via MCP tools and uses the system prompt
// from AGENT_SYSTEM_PROMPTS_V3 Section 1 to guide its reasoning.

import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';
import { loadPrompt, loadPromptWithDemoContext, loadStrategy } from './load-prompt.js';
import { ensureTradeId } from './trade-id.js';
import { loadRecentJournal } from './eod-journal-agent.js';
import { runAnalystAgent, type TradeProposal } from './analyst-agent.js';
import { instrumentToCurrencies, shouldVetoOrderForCalendar } from '../news/calendar-veto.js';
import { fetchForexFactoryCalendar } from '../news/forex-factory-calendar.js';
import { getLatestBrief, countOpenPositions, getOpenTradesByInstrument } from '../database/index.js';
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
 */
export function proposalHash(proposal: TradeProposal): string {
  // Canonicalise: explicit field order, fixed precision on numbers, lower-
  // case strings where applicable. Drop fields that don't affect the trade
  // identity (trade_id is generated post-approval; reasoning is free-text).
  const canonical = {
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
      'Return upcoming high/medium/low-impact macro events (FOMC, NFP, CPI, ECB, BoE, BoJ, central-bank rate decisions, GDP, payrolls). YOU MUST CALL THIS before any place_order — trading into a high-impact print on the trade currency is a hard rule violation. The place_order tool is code-level vetoed when a high-impact event is within −5/+30 minutes for any currency in the trade pair.',
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
      const lessons = getLessons({
        setup_type: input.setup_type as string | undefined,
        instrument_category: input.instrument_category as string | undefined,
        kill_zone: input.kill_zone as string | undefined,
        strategy_tag: 'ICT_INTRADAY',
      });
      const wr = getLessonWinRate({ strategy_tag: 'ICT_INTRADAY' });
      return JSON.stringify({ lessons, win_rate: wr });
    }
    case 'request_analyst_review': {
      // Codex P0 #1 fix (2026-04-28): wire the Analyst Agent into the actual
      // decision path. The agent calls this BEFORE place_split_trade.
      // Returns analyst_token = proposalHash(proposal) on APPROVE.
      pruneStaleApprovals();
      const proposal: TradeProposal = {
        trade_id: `trade-${createHash('sha256').update(`${Date.now()}-${input.instrument}-${input.direction}`).digest('hex').slice(0, 8)}`,
        strategy_tag: 'ICT_INTRADAY',
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
      const decision = await runAnalystAgent(proposal);
      const hash = proposalHash(proposal);
      if (decision.decision === 'APPROVE') {
        approvedProposals.set(hash, { approvedAt: Date.now(), proposal });
      }
      return JSON.stringify({
        decision: decision.decision,
        reason: decision.reason,
        analyst_token: hash,
        proposal_hash: hash,
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
      const approval = approvedProposals.get(String(input.analyst_token ?? ''));
      if (!approval) {
        return JSON.stringify({
          error: 'ANALYST_NOT_APPROVED',
          reason: 'No analyst approval found for the supplied analyst_token. Call request_analyst_review first.',
        });
      }
      if (String(input.analyst_token) !== hash) {
        return JSON.stringify({
          error: 'PROPOSAL_HASH_MISMATCH',
          reason: 'analyst_token was issued for a different proposal. The trade params must match exactly what was approved (size, SL, TP, score, tier). Re-request analyst_review with the current proposal.',
          expected_hash: hash,
          provided_token: input.analyst_token,
        });
      }

      // === Step 2: composite_score / tier / risk-pct internal consistency
      const score = Number(input.composite_score);
      const tier = Number(input.tier);
      const riskPct = Number(input.total_risk_pct);
      if (!Number.isFinite(score) || score < 45) {
        return JSON.stringify({
          error: 'SCORE_BELOW_TIER_MIN',
          reason: `composite_score ${score} is below Tier 3 minimum 45. No trade.`,
        });
      }
      const expectedTier = score >= 80 ? 1 : score >= 60 ? 2 : 3;
      if (tier !== expectedTier) {
        return JSON.stringify({
          error: 'TIER_SCORE_MISMATCH',
          reason: `composite_score ${score} maps to Tier ${expectedTier}, but proposal claims Tier ${tier}.`,
        });
      }
      const expectedRiskPct = expectedTier === 1 ? 1.5 : expectedTier === 2 ? 1.0 : 0.5;
      if (Math.abs(riskPct - expectedRiskPct) > 0.05) {
        return JSON.stringify({
          error: 'RISK_PCT_TIER_MISMATCH',
          reason: `Tier ${expectedTier} requires risk ${expectedRiskPct}% (±0.05). Proposal has ${riskPct}%.`,
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

      // === Step 4: code-enforced coordination lock
      const existing = getOpenTradesByInstrument(String(input.instrument));
      if (existing.length > 0) {
        return JSON.stringify({
          error: 'COORDINATION_LOCK',
          reason: `An open ${input.instrument} position already exists (trade_id=${existing[0].id}, status=${existing[0].status}). Coordination lock prevents duplicate-instrument entries.`,
        });
      }

      // === Step 5: calendar veto (fail-closed on fetch error)
      const tradeCurrencies = instrumentToCurrencies(epic);
      if (tradeCurrencies.length > 0) {
        try {
          const [finnhubCalendar, ffCalendar] = await Promise.all([
            fetchEconomicCalendar(1),
            fetchForexFactoryCalendar().catch(() => []),
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
      const tradeId = `trade-${createHash('sha256').update(`${Date.now()}-${input.instrument}-${direction}-${labelBase}`).digest('hex').slice(0, 12)}`;
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

      // Mark approval consumed so the same token can't be reused
      approvedProposals.delete(hash);

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
    case 'update_sl':
      // Update all legs present. updateSlPrice matches on (trade_id, leg,
      // is_active=1), so legs that don't exist (e.g. Leg C on a legacy
      // 2-leg trade, or Leg A/B after they've been deactivated by TP close)
      // are silent no-ops. Cheap to call all three defensively.
      updateSlPrice(input.trade_id as string, 'A', Number(input.new_sl));
      updateSlPrice(input.trade_id as string, 'B', Number(input.new_sl));
      updateSlPrice(input.trade_id as string, 'C', Number(input.new_sl));
      return JSON.stringify({ status: 'updated' });
    case 'close_position':
      return JSON.stringify(await capital.closePosition(input.dealId as string));
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

  for (let i = 0; i < maxIterations; i++) {
    const response = await anthropic.messages.create({
      // Cost optimisation (2026-04-21): ICT reasoning is quantitative
      // (order blocks, FVGs, structure detection, R:R math). Sonnet 4.6
      // handles this well at roughly 1/3 the token cost of Opus. The ICT
      // agent fires up to ~70× per day across kill zones — Opus on this
      // cadence was the single biggest Claude-API burn line-item. If
      // decision quality regresses noticeably vs the Opus run, revert
      // the `model` field to `claude-opus-4-6`.
      model: 'claude-sonnet-4-6',
      // max_tokens 16000 → 12000 (2026-04-21): caps the output each
      // iteration can generate. Typical response is 2-5k, so 12k is
      // still generous headroom. Rare verbose responses now truncate
      // earlier — saves worst-case output cost without affecting the
      // 95th percentile.
      max_tokens: 12000,
      thinking: { type: 'adaptive' },
      // effort: 'medium' trades a small amount of thinking trace depth
      // for ~25% output-token savings. ICT decisions don't need max-depth
      // reasoning once the scoring + kill-zone rules have already
      // filtered the universe.
      output_config: { effort: 'medium' },
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      tools: MCP_TOOLS,
      messages,
    });

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
}

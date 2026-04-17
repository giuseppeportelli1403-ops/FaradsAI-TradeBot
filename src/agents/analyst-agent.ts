// Trade Analyst Agent — Pre-Trade Approval Gate
// Called by ICT/Swing agents before every trade execution.
// Must respond APPROVE, REJECT, or MODIFY within 15 seconds.
//
// 6-Check Approval Sequence:
//   1. Sanity (SL side, TP order, SL distance, size)
//   2. Context (vs researcher brief, macro events, correlations)
//   3. Historical pattern match (banned patterns, recent loss clusters)
//   4. Risk concentration (total deployed risk, correlated risk < 3%)
//   5. Timing (candle closed, price distance, market hours)
//   6. Sizing math (recompute independently, reject if >5% discrepancy)

import Anthropic from '@anthropic-ai/sdk';
import { loadPrompt, loadStrategy } from './load-prompt.js';
import { getLatestBrief, getOpenTrades, getLessons, logAnalystDecision } from '../database/index.js';
import type { AnalystDecision, StrategyTag } from '../types.js';

const anthropic = new Anthropic();

export function parseAnalystResponse(text: string): AnalystDecision {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]);
    }
    return { decision: 'REJECT', reason: 'Could not parse response, defaulting to reject', modifications: {}, confidence: 0.5 };
  } catch {
    return { decision: 'REJECT', reason: 'JSON parse error, defaulting to reject', modifications: {}, confidence: 0.5 };
  }
}

interface TradeProposal {
  trade_id: string;
  strategy_tag: StrategyTag;
  instrument: string;
  instrument_category: string;
  direction: 'long' | 'short';
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  size_per_leg: number;
  total_risk_pct: number;
  composite_score: number;
  setup_type: string;
  kill_zone: string;
  reasoning: string;
}

export async function runAnalystAgent(proposal: TradeProposal): Promise<AnalystDecision> {
  console.log(`Trade Analyst reviewing: ${proposal.instrument} ${proposal.direction} (${proposal.strategy_tag})`);

  const systemPrompt = loadPrompt('analyst-agent.md');
  const strategyFile = proposal.strategy_tag === 'SWING' ? 'swing_strategy.md' : 'strategy.md';
  const strategy = loadStrategy(strategyFile);
  const brief = getLatestBrief();
  const openTrades = getOpenTrades();
  const recentLessons = getLessons({
    setup_type: proposal.setup_type,
    strategy_tag: proposal.strategy_tag,
    limit: 10,
  });

  const contextMessage = `TRADE PROPOSAL:
${JSON.stringify(proposal, null, 2)}

CURRENT OPEN TRADES (${openTrades.length}):
${JSON.stringify(openTrades.map(t => ({ instrument: t.instrument, direction: t.direction, strategy: t.strategy_tag, status: t.status })), null, 2)}

RECENT LESSONS FOR THIS SETUP TYPE (${recentLessons.length}):
${JSON.stringify(recentLessons.map(l => ({ instrument: l.instrument, pnl_r: l.pnl_total_r, outcome: l.position_b_outcome })), null, 2)}

${brief ? `RESEARCHER BRIEF:\n${JSON.stringify({ regime: brief.regime, themes: brief.themes, warnings: brief.warnings }, null, 2)}` : 'No brief available.'}

STRATEGY BANNED PATTERNS SECTION:
${strategy.split('## Section 6')[1]?.split('## Section 7')[0] || 'No banned patterns yet.'}

Run your 6-check sequence and respond with your decision JSON.`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 500,
    system: systemPrompt,
    messages: [{ role: 'user', content: contextMessage }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  console.log('[Analyst Agent]', text);

  // Parse the decision JSON (defaults to REJECT on failure — fail-closed)
  const decision = parseAnalystResponse(text);

  // Log the decision
  logAnalystDecision(proposal.trade_id, proposal.strategy_tag, decision);

  console.log(`[Analyst] Decision: ${decision.decision} — ${decision.reason}`);
  return decision;
}

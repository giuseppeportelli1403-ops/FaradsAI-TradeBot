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
import { loadPrompt, loadPromptWithDemoContext, loadStrategy } from './load-prompt.js';
import { parseLastJsonObject, withTimeout } from './llm-output.js';
import { getLatestBrief, getOpenTrades, getLessons, logAnalystDecision } from '../database/index.js';
import type { AnalystDecision, StrategyTag } from '../types.js';

const anthropic = new Anthropic();

/**
 * Parse the Analyst's free-form response into a structured AnalystDecision.
 * Audit fixes 2026-04-29:
 *   - Use parseLastJsonObject (balanced-brace, last-object-wins) — the prior
 *     greedy regex /\{[\s\S]*\}/ spliced trailing prose into the parse target
 *     and could match a prose example object before the real decision.
 *   - VALIDATE the parsed shape rather than blindly trusting whatever the
 *     LLM emitted. `decision` must be one of the three string literals
 *     (case-insensitive, normalised to uppercase). `confidence` must be a
 *     finite number in [0,1] — coerced from string-number if needed,
 *     defaulted to 0 on any other shape. `modifications` must be a plain
 *     object — defaulted to {}. `reason` must be a string — defaulted to ''.
 *   - Fail-closed default uses confidence 0.0 (not 0.5) — pre-fix the 0.5
 *     polluted Weekly Review calibration metrics by anchoring parse-failure
 *     events to the middle of the confidence distribution. 0.0 is honest:
 *     "we don't know."
 */
export function parseAnalystResponse(text: string): AnalystDecision {
  const failClosed = (reason: string): AnalystDecision => ({
    decision: 'REJECT',
    reason,
    modifications: {},
    confidence: 0,
  });

  const raw = parseLastJsonObject<Record<string, unknown>>(text);
  if (raw === null) {
    return failClosed('Could not parse JSON from analyst response — fail-closed REJECT.');
  }

  const decisionRaw = String(raw.decision ?? '').toUpperCase();
  if (decisionRaw !== 'APPROVE' && decisionRaw !== 'REJECT' && decisionRaw !== 'MODIFY') {
    return failClosed(`Invalid decision value '${raw.decision}' — expected APPROVE/REJECT/MODIFY.`);
  }

  const confRaw = Number(raw.confidence);
  const confidence = Number.isFinite(confRaw) ? Math.max(0, Math.min(1, confRaw)) : 0;

  const modifications = (raw.modifications && typeof raw.modifications === 'object' && !Array.isArray(raw.modifications))
    ? (raw.modifications as Record<string, unknown>)
    : {};

  const reason = typeof raw.reason === 'string' ? raw.reason : '';

  return {
    decision: decisionRaw as 'APPROVE' | 'REJECT' | 'MODIFY',
    reason,
    modifications,
    confidence,
  };
}

/**
 * Read the analyst's decision from a forced `submit_decision` tool_use
 * block. Replaces parseAnalystResponse for live calls — the SDK enforces
 * input_schema shape, but we still defensively validate semantics
 * (decision enum, finite confidence) here. Fail-closed (REJECT, conf 0)
 * on any shape or value problem.
 *
 * Why this exists (2026-05-05): the prior path had the analyst emit
 * free-form prose ending in JSON, which lost the JSON to max_tokens
 * truncation when adaptive thinking + verbose markdown analysis exceeded
 * 8k tokens. 0/6 analyst calls produced parseable output between
 * 2026-04-29 and 2026-05-04. Tool calling decouples the structured
 * decision from the prose entirely.
 */
export function extractAnalystDecisionFromTool(content: unknown[]): AnalystDecision {
  const failClosed = (reason: string): AnalystDecision => ({
    decision: 'REJECT',
    reason,
    modifications: {},
    confidence: 0,
  });

  if (!Array.isArray(content) || content.length === 0) {
    return failClosed('Analyst response had no content blocks.');
  }

  for (const block of content) {
    if (
      block &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'tool_use' &&
      (block as { name?: unknown }).name === 'submit_decision'
    ) {
      const rawInput = (block as { input?: unknown }).input;
      if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
        return failClosed('submit_decision tool_use had no object input.');
      }
      const raw = rawInput as Record<string, unknown>;

      const decisionRaw = String(raw.decision ?? '').toUpperCase();
      if (decisionRaw !== 'APPROVE' && decisionRaw !== 'REJECT' && decisionRaw !== 'MODIFY') {
        return failClosed(`Invalid decision in tool input: '${raw.decision}'.`);
      }

      const confRaw = Number(raw.confidence);
      const confidence = Number.isFinite(confRaw) ? Math.max(0, Math.min(1, confRaw)) : 0;

      const modifications =
        raw.modifications && typeof raw.modifications === 'object' && !Array.isArray(raw.modifications)
          ? (raw.modifications as Record<string, unknown>)
          : {};

      const reason = typeof raw.reason === 'string' ? raw.reason : '';

      return {
        decision: decisionRaw as 'APPROVE' | 'REJECT' | 'MODIFY',
        reason,
        modifications,
        confidence,
      };
    }
  }
  return failClosed('Analyst response had no submit_decision tool call.');
}

export interface TradeProposal {
  trade_id: string;
  strategy_tag: StrategyTag;
  instrument: string;
  epic: string;
  instrument_category: string;
  direction: 'long' | 'short';
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  // Added 2026-04-28: 3-leg split-position. tp3 is required for new
  // ICT trades since the 3-leg upgrade on 2026-04-21.
  tp3: number;
  size_a: number;
  size_b: number;
  size_c: number;
  total_risk_pct: number;
  composite_score: number;
  tier: 1 | 2 | 3;
  setup_type: string;
  kill_zone: string;
  reasoning: string;
}

export async function runAnalystAgent(proposal: TradeProposal): Promise<AnalystDecision> {
  console.log(`Trade Analyst reviewing: ${proposal.instrument} ${proposal.direction} (${proposal.strategy_tag})`);

  const systemPrompt = loadPromptWithDemoContext('analyst-agent.md');
  const strategyFile = proposal.strategy_tag === 'SWING' ? 'swing_strategy.md' : 'strategy.md';
  const strategy = loadStrategy(strategyFile);
  const brief = getLatestBrief();
  const openTrades = getOpenTrades();
  const recentLessons = getLessons({
    setup_type: proposal.setup_type,
    strategy_tag: proposal.strategy_tag,
    limit: 10,
  });

  // 2026-04-29 audit fix (P0-AN5, P1-AN8): pass FULL projections so the
  // Analyst can actually compute Check 4 (Risk Concentration) and Check 3
  // (Historical pattern match). Pre-fix only {instrument,direction,strategy,
  // status} were sent for open trades — Check 4 needed sizes/entry/SL/risk
  // to compute "total risk deployed" but had nothing. Same for lessons,
  // where setup_type was the filter but invisible in the projection.
  const openTradesProjection = openTrades.map((t) => ({
    trade_id: t.id,
    instrument: t.instrument,
    direction: t.direction,
    status: t.status,
    entry: t.entry,
    sl: t.sl,
    tp1: t.tp1,
    tp2: t.tp2,
    composite_score: t.composite_score,
    kill_zone: t.kill_zone,
    size_a: t.size_a,
    size_b: t.size_b,
    size_c: t.size_c,
    opened_at: t.opened_at,
  }));
  const recentLessonsProjection = recentLessons.map((l) => ({
    instrument: l.instrument,
    setup_type: l.setup_type,
    kill_zone: l.kill_zone,
    composite_score: l.composite_score,
    pnl_total_r: l.pnl_total_r,
    leg_a: l.position_a_outcome,
    leg_b: l.position_b_outcome,
    leg_c: l.position_c_outcome,
  }));

  // 2026-04-29 audit fix (P0-AN6): use a robust section parser. Pre-fix
  // `strategy.split('## Section 6')[1]?.split('## Section 7')[0]` returned
  // garbage HTML comments (the placeholder Section 6 contents). It also
  // breaks if any future strategy edit reorders sections or adds
  // sub-sections like "## Section 6.1". Anchored regex: \n## Section N: ...
  // Until \n## Section M: (end-of-file fallback).
  function getStrategySection(strategyText: string, sectionN: number): string {
    const startRe = new RegExp(`\\n## Section ${sectionN}\\b[^\\n]*\\n`);
    const startMatch = strategyText.match(startRe);
    if (!startMatch || startMatch.index === undefined) return '';
    const after = strategyText.slice(startMatch.index + startMatch[0].length);
    const endRe = /\n## Section \d+\b/;
    const endMatch = after.match(endRe);
    return endMatch && endMatch.index !== undefined ? after.slice(0, endMatch.index) : after;
  }
  const bannedPatternsSection = getStrategySection(strategy, 6) || 'No banned patterns yet.';

  const contextMessage = `TRADE PROPOSAL:
${JSON.stringify(proposal, null, 2)}

CURRENT OPEN TRADES (${openTrades.length}):
${JSON.stringify(openTradesProjection, null, 2)}

RECENT LESSONS FOR THIS SETUP TYPE (${recentLessons.length}):
${JSON.stringify(recentLessonsProjection, null, 2)}

${brief ? `RESEARCHER BRIEF:\n${JSON.stringify({ regime: brief.regime, themes: brief.themes, warnings: brief.warnings }, null, 2)}` : 'No brief available.'}

STRATEGY BANNED PATTERNS (Section 6):
${bannedPatternsSection}

Run your 6-check sequence and respond with your decision JSON.`;

  // 2026-05-05: forced submit_decision tool call. Replaces prior shape
  // (free-form prose ending in JSON) which was losing the JSON to
  // max_tokens truncation — between 2026-04-29 and 2026-05-04 0/6 analyst
  // calls produced parseable output. Tool calling forces a schema-validated
  // input object regardless of how much prose precedes it; the analyst's
  // analysis goes in the `reason` field where length doesn't compete with
  // a separate JSON block at the end of the response.
  const submitDecisionTool = {
    name: 'submit_decision',
    description:
      'Submit your final approval decision for the proposed trade after running the 6-check sequence. ' +
      'Call this tool exactly once. Your full prose analysis goes in the `reason` field — do not write a ' +
      'separate text block; everything you want logged for the trade record should be in `reason`.',
    input_schema: {
      type: 'object' as const,
      properties: {
        decision: {
          type: 'string',
          enum: ['APPROVE', 'REJECT', 'MODIFY'],
          description: 'The verdict on the proposal.',
        },
        reason: {
          type: 'string',
          description:
            'Full analysis text. Cite specific check numbers (1-6) and quote relevant evidence (price levels, news headlines, lessons).',
        },
        confidence: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description:
            'How confident you are in this decision, 0-1. Use 0 only on fail-closed; reserve >0.9 for unambiguous cases.',
        },
        modifications: {
          type: 'object',
          description:
            'Required only when decision=MODIFY. Keys: sl, tp1, tp2, tp3, total_risk_pct (numeric overrides). Empty object {} otherwise.',
          additionalProperties: true,
        },
      },
      required: ['decision', 'reason', 'confidence', 'modifications'],
    },
  };

  // Hard timeout via Promise.race. SDK default is 10 minutes — far too long
  // for a per-trade gate. 60s headroom for Sonnet 4.6 + adaptive thinking +
  // cold cache + variable Anthropic backend latency.
  const timeoutMs = 60_000;
  let response: Awaited<ReturnType<typeof anthropic.messages.create>>;
  try {
    response = await withTimeout(
      anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 8000,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium' },
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: contextMessage }],
        tools: [submitDecisionTool],
        tool_choice: { type: 'tool', name: 'submit_decision' },
      } as Parameters<typeof anthropic.messages.create>[0]),
      timeoutMs,
      'Analyst',
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Analyst] API call failed: ${msg}. Defaulting to REJECT (confidence 0).`);
    const failClosed: AnalystDecision = {
      decision: 'REJECT',
      reason: `Analyst API failure — ${msg}. Fail-closed REJECT.`,
      modifications: {},
      confidence: 0,
    };
    logAnalystDecision(proposal.trade_id, proposal.strategy_tag, failClosed);
    return failClosed;
  }

  // Surface stop_reason so we can diagnose mid-tool-call truncation if it
  // ever happens (would manifest as `extractAnalystDecisionFromTool`
  // returning REJECT with reason "no submit_decision tool call"). Narrow
  // off the Stream branch of messages.create's overload — we never request
  // streaming for the analyst.
  const msg = response as Anthropic.Messages.Message;
  console.log(`[Analyst] stop_reason=${msg.stop_reason} content_blocks=${msg.content.length}`);

  const decision = extractAnalystDecisionFromTool(msg.content as unknown[]);

  // Log the decision (always — even on extractor failure, the REJECT row is
  // important audit data).
  logAnalystDecision(proposal.trade_id, proposal.strategy_tag, decision);

  const reasonPreview =
    decision.reason.length > 500
      ? decision.reason.slice(0, 500) + '…[truncated]'
      : decision.reason;
  console.log(
    `[Analyst] Decision: ${decision.decision} (confidence ${decision.confidence}) — ${reasonPreview}`,
  );
  return decision;
}

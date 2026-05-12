// Trade Analyst Agent — Pre-Trade Approval Gate
// Called by ICT/Swing agents before every trade execution.
// Must respond APPROVE or REJECT within 15 seconds.
//
// 2026-05-12 (Spec 002 / MODIFY removal): contract is BINARY. The
// historical MODIFY verdict was removed after 4 prior fixes failed to
// stop the model from emitting `decision='MODIFY', modifications={}`
// while prose said "Returning APPROVE." Both parser paths now coerce
// any rogue MODIFY input to fail-closed REJECT and emit
// `[analyst-coercion]` warnings for monitoring.
//
// 6-Check Approval Sequence:
//   1. Sanity (SL side, TP order, SL distance, size)
//   2. Context (vs researcher brief, macro events, correlations)
//   3. Historical pattern match (banned patterns, recent loss clusters)
//   4. Risk concentration (total deployed risk, correlated risk < 3%)
//   5. Timing (candle closed, price distance, market hours)
//   6. Sizing math (recompute independently, reject if >5% discrepancy)

/**
 * Build the forced submit_decision tool spec. Extracted as an exported
 * factory so the regression test at tests/analyst-prompt.test.ts can
 * read the schema without invoking the live API call.
 *
 * Binary as of 2026-05-12: enum is ['APPROVE','REJECT'] only. The
 * `modifications` field is intentionally absent — neither in
 * properties nor required.
 */
export function getSubmitDecisionTool() {
  return {
    name: 'submit_decision',
    description:
      'Submit your final approval decision for the proposed trade after running the 6-check sequence. ' +
      'Call this tool exactly once. Your full prose analysis goes in the `reason` field — do not write a ' +
      'separate text block; everything you want logged for the trade record should be in `reason`. ' +
      'The contract is BINARY: emit APPROVE to authorise, REJECT to defer/decline. ' +
      'There is no MODIFY verdict — if changes are needed, REJECT with a reason describing what to change.',
    input_schema: {
      type: 'object' as const,
      properties: {
        decision: {
          type: 'string',
          enum: ['APPROVE', 'REJECT'],
          description: 'The verdict on the proposal. Only APPROVE or REJECT.',
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
      },
      required: ['decision', 'reason', 'confidence'],
    },
  };
}

import Anthropic from '@anthropic-ai/sdk';
import { loadPrompt, loadPromptWithDemoContext, loadStrategy } from './load-prompt.js';
import { parseLastJsonObject, withTimeout } from './llm-output.js';
import { getLatestBrief, getOpenTrades, getLessons, logAnalystDecision } from '../database/index.js';
import { recordRejection } from '../rejection-log/record.js';
import type { AnalystDecision, StrategyTag } from '../types.js';

const anthropic = new Anthropic();

/**
 * Coercion message + log emitted whenever a legacy MODIFY value reaches
 * either parser. Tested by tests/analyst-prompt.test.ts to lock the
 * exact wording — daily VPS log grep relies on it
 * (`grep -c '[analyst-coercion]' ~/trading-bot/data/pm2-out.log`).
 */
const LEGACY_MODIFY_REASON = 'Legacy MODIFY rejected — analyst contract is binary as of 2026-05-11';

/**
 * Parse the Analyst's free-form response into a structured AnalystDecision.
 * Binary contract as of 2026-05-12: only APPROVE and REJECT are valid.
 * Any rogue MODIFY input is coerced to fail-closed REJECT (with
 * console.warn `[analyst-coercion]` for monitoring).
 *
 * Audit fixes 2026-04-29 (still applicable):
 *   - Use parseLastJsonObject (balanced-brace, last-object-wins).
 *   - Fail-closed confidence 0.0 (honest "we don't know").
 */
export function parseAnalystResponse(text: string): AnalystDecision {
  const failClosed = (reason: string): AnalystDecision => ({
    decision: 'REJECT',
    reason,
    confidence: 0,
  });

  const raw = parseLastJsonObject<Record<string, unknown>>(text);
  if (raw === null) {
    return failClosed('Could not parse JSON from analyst response — fail-closed REJECT.');
  }

  const decisionRaw = String(raw.decision ?? '').toUpperCase();
  if (decisionRaw === 'MODIFY') {
    console.warn(`[analyst-coercion] legacy MODIFY -> REJECT (parseAnalystResponse) raw=${JSON.stringify(raw).slice(0, 200)}`);
    return failClosed(LEGACY_MODIFY_REASON);
  }
  if (decisionRaw !== 'APPROVE' && decisionRaw !== 'REJECT') {
    return failClosed(`Invalid decision value '${raw.decision}' — expected APPROVE/REJECT.`);
  }

  const confRaw = Number(raw.confidence);
  const confidence = Number.isFinite(confRaw) ? Math.max(0, Math.min(1, confRaw)) : 0;

  const reason = typeof raw.reason === 'string' ? raw.reason : '';

  return {
    decision: decisionRaw as 'APPROVE' | 'REJECT',
    reason,
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
      if (decisionRaw === 'MODIFY') {
        // Defense-in-depth: even though the tool schema enum no longer
        // lists MODIFY, log + coerce in case a future schema regression
        // or a model bypass slips through.
        console.warn(`[analyst-coercion] legacy MODIFY -> REJECT (extractAnalystDecisionFromTool) raw=${JSON.stringify(raw).slice(0, 200)}`);
        return failClosed(LEGACY_MODIFY_REASON);
      }
      if (decisionRaw !== 'APPROVE' && decisionRaw !== 'REJECT') {
        return failClosed(`Invalid decision in tool input: '${raw.decision}'.`);
      }

      const confRaw = Number(raw.confidence);
      const confidence = Number.isFinite(confRaw) ? Math.max(0, Math.min(1, confRaw)) : 0;

      const reason = typeof raw.reason === 'string' ? raw.reason : '';

      return {
        decision: decisionRaw as 'APPROVE' | 'REJECT',
        reason,
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
  // 2026-05-08 — 3-leg removal Phase 1, Task 6: tp3 and size_c dropped from
  // the LLM-facing TradeProposal type. The 2-TP restructure (2026-05-07,
  // Phase 2) already collapsed the ladder to 2 legs, leaving the fields
  // nullable on the type for legacy back-compat. Phase 1 finishes the job by
  // removing them from the LLM's structured output schema entirely. The MCP
  // place_split_trade runtime guard (Task 2) rejects any non-null tp3/size_c
  // anyway, and TradeRecord (DB) keeps the nullable columns.
  size_a: number;
  size_b: number;
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
  const submitDecisionTool = getSubmitDecisionTool();

  // Hard timeout via Promise.race. SDK default is 10 minutes — far too long
  // for a per-trade gate. 60s headroom for Sonnet 4.6 + cold cache +
  // variable Anthropic backend latency.
  //
  // 2026-05-05 (Codex pre-deploy review of 82a4996): adaptive thinking and
  // output_config:effort REMOVED from this call. Anthropic's API rejects
  // requests that combine extended/adaptive thinking with a specific
  // tool_choice — the two features are mutually exclusive. The whole
  // point of this fix is to force submit_decision via tool_choice; that
  // wins over adaptive thinking. Standard Sonnet 4.6 still runs the
  // 6-check sequence reliably, and the analyst was making 0 successful
  // decisions per day with thinking enabled (truncation bug), so the
  // tradeoff is a clear win. If thinking is needed for some future
  // hardness, switch tool_choice to 'auto' and re-add fail-closed for
  // missing tool blocks — but only after the bot has shown live edge
  // without it.
  const timeoutMs = 60_000;
  let response: Awaited<ReturnType<typeof anthropic.messages.create>>;
  try {
    response = await withTimeout(
      anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 8000,
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
      confidence: 0,
    };
    logAnalystDecision(proposal.trade_id, proposal.strategy_tag, failClosed);
    // T036 (US-2): tag the analyst_log row with category metadata so the
    // daily digest can distinguish fail-closed REJECTs from cause-REJECTs.
    // Try/catch — a categoriser failure must not mask the original error.
    try {
      recordRejection({
        instrument: proposal.instrument,
        layer: 'analyst',
        category: 'ANALYST_FAIL_CLOSED_API_ERROR',
        reason_text: `API failure: ${msg}`,
        subcategory: err instanceof Error ? err.constructor.name : 'unknown',
      });
    } catch (recErr) {
      console.warn(`[Analyst] recordRejection(API_ERROR) failed: ${recErr instanceof Error ? recErr.message : String(recErr)}`);
    }
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

  // T036 (US-2): tag the analyst_log row with category metadata. Maps the
  // free-form decision + reason to a machine-parseable REJECTION_CATEGORY
  // so the daily digest can distinguish (a) fail-closed REJECTs from
  // tool-extraction failures (no submit_decision call) vs (b) cause-REJECTs
  // from the analyst's actual 6-check sequence. APPROVE/MODIFY get the
  // happy-path categories so every analyst_log row has a non-null category.
  try {
    let cat: 'ANALYST_FAIL_CLOSED_NO_TOOL_CALL' | 'ANALYST_FAIL_CLOSED_PARSE'
      | 'ANALYST_REJECT_NEWS_WINDOW' | 'ANALYST_REJECT_BANNED_PATTERN'
      | 'ANALYST_REJECT_CORRELATION' | 'ANALYST_REJECT_COOLDOWN'
      | null = null;
    const reasonLc = decision.reason.toLowerCase();
    if (decision.decision === 'REJECT') {
      if (reasonLc.includes('no submit_decision') || reasonLc.includes('no content blocks')) {
        cat = 'ANALYST_FAIL_CLOSED_NO_TOOL_CALL';
      } else if (reasonLc.includes('could not parse') || reasonLc.includes('invalid decision')) {
        cat = 'ANALYST_FAIL_CLOSED_PARSE';
      } else if (reasonLc.includes('news') || reasonLc.includes('event') || reasonLc.includes('cpi') || reasonLc.includes('fomc')) {
        cat = 'ANALYST_REJECT_NEWS_WINDOW';
      } else if (reasonLc.includes('banned')) {
        cat = 'ANALYST_REJECT_BANNED_PATTERN';
      } else if (reasonLc.includes('correlat') || reasonLc.includes('exposure')) {
        cat = 'ANALYST_REJECT_CORRELATION';
      } else if (reasonLc.includes('cooldown') || reasonLc.includes('losses in a row') || reasonLc.includes('consecutive loss')) {
        cat = 'ANALYST_REJECT_COOLDOWN';
      }
    }
    if (cat !== null) {
      recordRejection({
        instrument: proposal.instrument,
        layer: 'analyst',
        category: cat,
        reason_text: decision.reason.slice(0, 500),
      });
    }
  } catch (recErr) {
    console.warn(`[Analyst] recordRejection (verdict tagging) failed: ${recErr instanceof Error ? recErr.message : String(recErr)}`);
  }

  const reasonPreview =
    decision.reason.length > 500
      ? decision.reason.slice(0, 500) + '…[truncated]'
      : decision.reason;
  console.log(
    `[Analyst] Decision: ${decision.decision} (confidence ${decision.confidence}) — ${reasonPreview}`,
  );
  return decision;
}

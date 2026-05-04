# Analyst Tool-Calling + ICT Pre-Analyst Order-Side Gate

**Date:** 2026-05-05
**Author:** Claude (with Giuseppe / BetterOps AI)
**Status:** Approved (verbal — Giuseppe directed execution without explicit gate)

## TL;DR

The Farad bot has logged **1 trade in 3 weeks**. The analyst's approval rate is **0/6 since 2026-04-29** — every call has fail-closed REJECTed with "Could not parse JSON from analyst response" or a 30s timeout. The morning fix (`1a9f838` max_tokens 2000→8000) reduced but did not eliminate the failure mode. Two compounding root causes:

1. **Analyst response truncation** — `claude-sonnet-4-6` with `thinking: adaptive` consumes 4-7k tokens on hard cases, plus the analyst writes a 1000-2000-token markdown rejection table, and the JSON decision block at the end gets cut off when the combined output exceeds `max_tokens: 8000`.
2. **ICT agent submits malformed proposals** — the 2026-05-04 08:31 GOLD short example has SL below entry and TPs above (inverted for a short). The analyst correctly detects this, but its long, accurate criticism is exactly what triggers truncation. Order-side validation exists in `place_split_trade` but not at `request_analyst_review`.

The two bugs amplify each other: malformed proposals → most analyst prose → highest truncation chance → fail-closed REJECT with parse error → bot logs "no trade" → Giuseppe sees 3 weeks of zero progress.

## Evidence

### DB query (live VPS, 2026-05-05)

```
trades: 1            (AUDUSD long, 2026-04-23, sl_hit, $0)
analyst_log: 6       (0 approved, 6 rejected)

Rejection reasons:
  5× "Could not parse JSON from analyst response — fail-closed REJECT."
  1× "Analyst API failure — Analyst timed out after 30000ms."
```

### Log evidence (data/pm2-out.log)

Five of the six rejections show `[Analyst Agent] ` (empty string) — the model emitted zero text blocks. Sixth rejection (today, 08:31 UTC) shows partial markdown analysis cut off mid-sentence at "...invert" before the JSON decision could be emitted.

### Source-of-truth docs

- `src/agents/analyst-agent.ts:194-208` — model is `claude-sonnet-4-6`, `thinking: { type: 'adaptive' }`, `output_config: { effort: 'medium' }`, `max_tokens: 8000`.
- `src/agents/llm-output.ts` — parser is robust (skips thinking blocks, brace-aware, handles markdown fences). Not the bug.
- `src/agents/trading-agent.ts:716-721` — `place_split_trade` validates score floor; `place_split_trade` also has order-side checks earlier in the same handler. The `request_analyst_review` tool handler does NOT call those validators.

## Design

### Fix A — Analyst uses structured tool calling for its decision

Replace "free-form prose ending in JSON" with a forced tool call.

**Tool definition (added to `runAnalystAgent`):**

```ts
const submitDecisionTool: Anthropic.Tool = {
  name: 'submit_decision',
  description:
    'Submit your final approval decision for the proposed trade. ' +
    'You MUST call this tool exactly once after completing the 6-check sequence. ' +
    'Your prose analysis goes in the `reason` field — there is no token limit on the reason.',
  input_schema: {
    type: 'object',
    properties: {
      decision: { type: 'string', enum: ['APPROVE', 'REJECT', 'MODIFY'] },
      reason: { type: 'string', description: 'Full analysis text. As long as needed.' },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      modifications: {
        type: 'object',
        description: 'Only populated when decision=MODIFY. Keys: sl, tp1, tp2, tp3, total_risk_pct.',
        additionalProperties: true,
      },
    },
    required: ['decision', 'reason', 'confidence'],
  },
};
```

**Call site change:**

```ts
response = await anthropic.messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: 8000,
  thinking: { type: 'adaptive' },
  output_config: { effort: 'medium' },
  system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
  messages: [{ role: 'user', content: contextMessage }],
  tools: [submitDecisionTool],
  tool_choice: { type: 'tool', name: 'submit_decision' },
});
```

**Decision extraction (replaces `parseAnalystResponse`):**

```ts
function extractAnalystDecisionFromTool(
  content: Anthropic.ContentBlock[],
): AnalystDecision {
  for (const block of content) {
    if (block.type === 'tool_use' && block.name === 'submit_decision') {
      const input = block.input as Record<string, unknown>;
      // Same validation as parseAnalystResponse — defensive even with schema enforcement.
      const decisionRaw = String(input.decision ?? '').toUpperCase();
      if (!['APPROVE', 'REJECT', 'MODIFY'].includes(decisionRaw)) {
        return failClosed(`Invalid decision in tool input: '${input.decision}'.`);
      }
      const confRaw = Number(input.confidence);
      const confidence = Number.isFinite(confRaw) ? Math.max(0, Math.min(1, confRaw)) : 0;
      const modifications = (input.modifications && typeof input.modifications === 'object' && !Array.isArray(input.modifications))
        ? (input.modifications as Record<string, unknown>) : {};
      const reason = typeof input.reason === 'string' ? input.reason : '';
      return { decision: decisionRaw as 'APPROVE' | 'REJECT' | 'MODIFY', reason, modifications, confidence };
    }
  }
  return failClosed('Analyst response had no submit_decision tool call.');
}
```

**Why this fixes truncation:**

- The decision JSON is no longer at the end of free-form prose. It's the structure-enforced input to a tool call.
- If the analyst still hits max_tokens mid-way, the `stop_reason: max_tokens` is observable; we can log a different fail-closed reason ("analyst truncated mid-tool-call") and bump max_tokens or reduce thinking effort surgically.
- The analyst's prose analysis goes in the `reason` field — it can be long without competing with the decision for token budget on the wrapping text.
- `tool_choice: { type: 'tool', name: 'submit_decision' }` forces the model to call this exact tool. No prose-only outputs possible.

**Backward compatibility:** Keep `parseAnalystResponse` exported (used in `tests/analyst-parse.test.ts`) but it's no longer called from `runAnalystAgent`.

### Fix B — Pre-analyst order-side gate

The trading-agent's `request_analyst_review` tool handler already has the proposal in hand before paying for an analyst call. Add the same order-side validator that `place_split_trade` runs.

**Validator (extract / share):**

```ts
function validateOrderSide(p: {
  direction: 'long' | 'short';
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  tp3: number;
}): { ok: true } | { ok: false; reason: string } {
  if (p.direction === 'long') {
    if (!(p.sl < p.entry && p.entry < p.tp1 && p.tp1 < p.tp2 && p.tp2 < p.tp3)) {
      return { ok: false, reason: `Long order-side invariant violated: need sl<entry<tp1<tp2<tp3, got sl=${p.sl}, entry=${p.entry}, tp1=${p.tp1}, tp2=${p.tp2}, tp3=${p.tp3}.` };
    }
  } else {
    if (!(p.tp3 < p.tp2 && p.tp2 < p.tp1 && p.tp1 < p.entry && p.entry < p.sl)) {
      return { ok: false, reason: `Short order-side invariant violated: need tp3<tp2<tp1<entry<sl, got sl=${p.sl}, entry=${p.entry}, tp1=${p.tp1}, tp2=${p.tp2}, tp3=${p.tp3}.` };
    }
  }
  return { ok: true };
}
```

**Wired into `request_analyst_review` handler:** before any analyst call, run the validator. On fail, return a tool-result error JSON immediately. ICT sees the rejection, regenerates with corrected geometry, no analyst call is wasted.

## Success criteria

1. After deploy, the next 5 analyst calls produce a parseable decision (any decision: APPROVE / REJECT / MODIFY). Zero "Could not parse JSON" errors.
2. Any malformed proposal (inverted SL/TPs) is rejected by Fix B with `INVERTED_SL_TP` (or similar) before reaching the analyst.
3. New tests cover both bugs and would fail without the fix.
4. `npm run build` clean, `npm test` 100% pass.

## Risks

- **Adaptive thinking still bursts the budget on tool calls.** Mitigation: log `response.stop_reason` on every analyst call so we can see if/when this happens. If observed, reduce effort to 'low' or bump max_tokens to 16000.
- **Sonnet 4.6 + tool_choice 'tool' might still emit text in addition to the tool call.** That's fine — `extractAnalystDecisionFromTool` ignores text blocks and reads only the tool_use block.
- **Fix B might surface that the ICT agent has its OWN sign-flip bug** (the GOLD short example points to one). Out-of-scope for this spec, but the rejection messages will make it visible. Spec only commits to the validation gate; the ICT logic fix is a follow-up if it turns out to be needed.

## Out of scope (next sessions / Phase 2 audit)

- Why the ICT agent ever produced a GOLD short with inverted SL/TPs — diagnose separately.
- Whether the strategy's score floor / R:R rules / news rubric have edge — the analyst+ICT bugs blocked all evidence collection; can't evaluate strategy until the bot actually trades.
- Auditing the other 4 agent prompts (researcher, reflection, review, eod-journal) for similar "verbose response → truncated JSON" patterns.

## Plan terminus

This spec hands off to `superpowers:writing-plans` to produce the step-by-step implementation plan with TDD discipline.

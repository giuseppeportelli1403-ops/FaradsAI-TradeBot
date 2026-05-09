# L3b-2: Leg-B notional pre-flight check

**Date:** 2026-05-09
**Author:** Giuseppe + Claude (brainstorming session, post analyst-calibration ship)
**Status:** Spec — design approved, proceeding to writing-plans
**Base commit:** `9703929` (post analyst-calibration spec sync)
**Sibling specs (already shipped today):**
- Spec 1 (cap+L1+observability) — `2026-05-08-ict-iteration-cap-bump-design.md` — live
- Spec 3 / L3 (prompt batching + R:R 1.31R precision) — `2026-05-09-ict-prompt-batching-and-precision-design.md` — live
- 3-leg removal Phase 1+2 — live
- MODIFY-misread guard — live (commit `ed677fa`)
- Analyst APPROVE/MODIFY/REJECT calibration — live (commits `6580a44`/`b29c9ad`/`58f7f81`)

This is the deferred sibling lever from L3 (originally L3b-2), now its own spec.

## Problem

On a small account, many instrument × tier × SL-distance combinations cannot satisfy the broker's `min_deal_size` constraint, even though the structural setup is valid. The bot's 2-leg 70/30 split puts Leg B (the smaller, runner leg) at 30% of the total notional — and Leg B must be ≥ broker's `min_deal_size` or Capital rejects the order.

Concrete example from 2026-05-08 c0745 cycle:

```
Account:     $1012  (demo, pre-top-up)
Tier 2:      1.0% risk = $10.12 budget
SILVER:      entry 80.13, SL 79.35 → SL distance 0.78 points
total_size = $10.12 / $0.78 = 12.97 units
Leg B (30%) = 3.89 units
SILVER min_deal_size = 5 units  →  3.89 < 5  →  BELOW_MIN_SIZE
```

Today (2026-05-09 weekend), 2 of 13 cycles reached `request_analyst_review` and BOTH got pre-check REJECT for the same reason — the agent didn't know about `min_deal_size` at proposal-construction time, built infeasible proposals, and the existing pre-check at `trading-agent.ts:869` (which DOES fetch min_deal_size from `capital.getMarketDetails`) caught them.

Each wasted attempt costs:
- One iteration of the agent's loop (now bounded by Spec 1's cap=12)
- One synthetic-REJECT round-trip from `request_analyst_review` (no analyst LLM call, just pre-check overhead)
- Roughly 5-15 seconds of cycle wall-time

Not catastrophic on cap=12, but on a kill zone with multiple borderline candidates this can chew through 30-50% of the iteration budget before reaching anything that actually works.

Note: Giuseppe topped up the demo balance on 2026-05-09 after this spec's brainstorm started. With ~$5k+ balance, most instrument × tier × typical-SL combinations become feasible. **L3b-2 is now hygiene rather than blocker fix** — but it remains correct: it eliminates a known wasteful path, and small-account edge cases (range-mode 0.25% × Tier 3 × wide SL on SILVER/OIL_CRUDE) will still bite without it.

## Goal

Make `min_deal_size` available to the agent at proposal-construction time so it can compute Leg-B feasibility and skip infeasible candidates BEFORE submitting to `request_analyst_review`. Pure data-flow + prompt change. The existing pre-check at `request_analyst_review` stays as a defensive last gate.

Non-goals:
- No tier-bumping (the agent does NOT escalate Tier 2 → Tier 1 to make math work — that's gaming the risk system)
- No 2-leg → 1-leg fallback (the 70/30 split is core strategy)
- No instrument-universe filtering by account size (separate concern; L3b-2 is per-cycle, not init-time)
- No change to `computeServerSizing` (`trading-agent.ts:406+`) or analyst CHECK 6 (sizing math)

## Design

### Change 1 — `src/types.ts`: extend `RankedInstrument`

```diff
 export interface RankedInstrument {
   ticker: string;
   name: string;
   composite_score: number;
   bias: 'bullish' | 'bearish' | 'neutral';
   tier: 1 | 2 | 3 | null;
+  /**
+   * Broker minimum deal size for this instrument (e.g. SILVER=5, USDJPY=1000,
+   * GOLD=0.1). Fetched from capital.getMarketDetails() at scanner load time
+   * and cached. `null` if the fetch failed for this ticker — the agent then
+   * falls through to the existing pre-check at `request_analyst_review` for
+   * authoritative live-fetched validation.
+   */
+  min_deal_size: number | null;
 }
```

**Surface impact:** every consumer of `RankedInstrument` now sees the new field. TypeScript surfaces consumers via `tsc --noEmit`. Today's consumers (per `grep -rn "RankedInstrument" src tests`, verified by parallel-review subagents 2026-05-09):

- **`src/scanner/index.ts:384-389`** — the only literal construction site (`{ ticker, name, composite_score, bias, tier } satisfies RankedInstrument`). This site WILL fail tsc until `min_deal_size` is added. Change 2 below adds the field at this site.
- **`src/agents/trading-agent.ts`, `src/agents/researcher-agent.ts`, `src/mcp-server/tools/db-tools.ts`** — consume the shape but don't construct literals; non-breaking.
- **`tests/*`** — searched for `RankedInstrument` literals; none found. The `composite_score`-bearing fixtures across `tests/database.test.ts`, `tests/proposal-hash.test.ts`, `tests/rr-validation.test.ts`, `tests/scheduler.test.ts`, `tests/scheduler-tp1-be-offset.test.ts`, `tests/trading-tools.test.ts`, `tests/reflection.test.ts` are TradeRecord/proposal-shaped, NOT RankedInstrument-shaped. **No test fixtures need updating.**

### Change 2 — `src/scanner/index.ts`: fetch + cache + populate

**Prerequisite — capital client wiring:** the scanner currently does NOT import a `CapitalClient` instance. The singleton lives at `src/agents/trading-agent.ts` (around line 765-767, the `const capital = new CapitalClient({ ... })` declaration). To avoid a duplicate Capital session/login at scanner-init, the cleanest path is to **export the existing instance from `trading-agent.ts` and import it into the scanner**, OR move the singleton to a shared module. Recommendation: add `export` to the existing `const capital = ...` line in `trading-agent.ts`, then `import { capital } from '../agents/trading-agent.js'` at the top of `src/scanner/index.ts`. One-line surface change in trading-agent.ts; one-line import in scanner.

(Alternative — declined: construct a new `CapitalClient` inside scanner. Wastes a fresh auth handshake on every pm2 restart and creates a parallel session, which is wasteful and slightly riskier under Capital's session-keepalive ping cadence.)

Add module-level cache + helper near the existing `RANKING_TTL_MS` declaration (~line 240):

```ts
// 2026-05-09: min_deal_size lookup cache. Capital's broker minimums rarely
// change (typically stable for months), so we cache per-instrument values
// for the lifetime of the scanner module. PM2 restarts (deploy, daily cron)
// refresh the cache. The agent's L3b-2 feasibility check (prompts/ict-agent.md
// STEP 3 sub-step L0) reads min_deal_size to skip infeasible candidates
// upfront; the existing pre-check at trading-agent.ts:869 still does a fresh
// fetch on every request_analyst_review call as the defensive last gate, so
// stale cache entries result in at most one wasted analyst round-trip per
// drift event (caught and corrected by the live fetch).
//
// In-flight promise dedup: when two callers hit the same cold ticker
// concurrently (e.g. researcher-agent + scheduler ICT trigger overlapping
// at startup), we want exactly one Capital fetch per ticker. Storing the
// in-flight promise in the cache means subsequent callers await the same
// promise and resolve with the same value, no duplicate API calls.
let minDealSizeCache: Map<string, Promise<number | null>> | null = null;

async function getMinDealSizeFor(ticker: string): Promise<number | null> {
  if (!minDealSizeCache) {
    minDealSizeCache = new Map();
  }
  const cached = minDealSizeCache.get(ticker);
  if (cached !== undefined) {
    return cached;
  }
  // Store the IN-FLIGHT promise so concurrent callers dedupe to one fetch.
  const fetchPromise = (async (): Promise<number | null> => {
    try {
      const md = await capital.getMarketDetails(ticker);
      const v = md?.dealingRules?.minDealSize?.value;
      return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[Scanner] min_deal_size fetch failed for ${ticker}: ${msg} — caching null; agent will fall through to request_analyst_review pre-check.`,
      );
      return null;
    }
  })();
  minDealSizeCache.set(ticker, fetchPromise);
  return fetchPromise;
}

/** Test-only: clear the min_deal_size cache. Mirrors the _resetRankingCache pattern. */
export function _resetMinDealSizeCache(): void {
  minDealSizeCache = null;
}

/** Test-only: read current cache state for assertion. Returns the Map of in-flight or resolved Promises (test code can await each value to inspect resolved size). */
export function _getMinDealSizeCache(): Map<string, Promise<number | null>> | null {
  return minDealSizeCache;
}
```

Inside `getRankedInstruments` (around line 256), after the per-instrument scoring loop has assembled each `RankedInstrument` (around line 389 where `satisfies RankedInstrument` is invoked), wrap the result-build to also fetch `min_deal_size`. Use `Promise.all` so the 7-instrument universe fetches concurrently when the cache is cold:

```ts
// At the end of the existing per-instrument loop, AFTER the array is built:
const withMinDealSize = await Promise.all(
  results.map(async (r) => ({
    ...r,
    min_deal_size: await getMinDealSizeFor(r.ticker),
  })),
);
return withMinDealSize.slice(0, limit);
```

(Exact insertion site depends on existing structure — find the `results: RankedInstrument[] = []` declaration and the final `return results.slice(0, limit)` or equivalent.)

**Concurrency note:** the new fetch happens BEFORE returning to the agent. On cold cache (scanner just started), the 7-instrument universe means up to 7 parallel `capital.getMarketDetails` calls — Capital handles this fine; existing code makes similar parallel calls during sizing. On warm cache (subsequent cycles), `getMinDealSizeFor` returns instantly from the in-memory map.

### Change 3 — `prompts/ict-agent.md`: add L0 feasibility sub-step in STEP 3

Insert a new sub-step in STEP 3, BEFORE the existing **L. Final checklist** (around line 204). Position it as "L0" (logically at the end of the per-candidate analysis, just before final checklist + analyst submission):

```markdown
**L0. Sizing feasibility pre-flight (post-2026-05-09 L3b-2)** — before the final checklist below, verify the proposal can satisfy the broker's `min_deal_size` constraint:

```
leg_b_notional = (balance × tier_risk_pct / 100) × 0.30 / |entry − sl|
```

where `tier_risk_pct` is **1.5** for Tier 1, **1.0** for Tier 2, **0.5** for Tier 3 (trend-mode), and **0.25** for range-mode (setup_type starts with `Range_`). The `min_deal_size` for each candidate is in the `get_ranked_instruments` response (added 2026-05-09 via the L3b-2 spec — `RankedInstrument.min_deal_size`).

**If `leg_b_notional < min_deal_size`:** skip this candidate. The trade is mathematically too small to execute on the current account balance at this tier and SL distance. Move to the next candidate, or skip the cycle if no remaining candidates pass. Do NOT submit to `request_analyst_review` — the pre-check there will reject for the same reason after wasting one round-trip.

**If `min_deal_size` is null/missing** for this instrument (the scanner's getMarketDetails fetch failed or this is a freshly-added ticker): proceed to `request_analyst_review` anyway. The pre-check there does a fresh live fetch and will catch any infeasibility. The L0 check is an optimization, not a hard gate — null means "I don't know, let the live pre-check decide".

**Worked example (the case L3b-2 is designed to prevent):**
```
balance:           1012  (USD)
tier_risk_pct:     1.0   (Tier 2)
SILVER entry:      80.13
SL:                79.35
|entry − SL|:      0.78
leg_b_notional:    (1012 × 1.0 / 100) × 0.30 / 0.78
                 = 10.12 × 0.30 / 0.78
                 ≈ 3.89  ← Leg B units
SILVER min_deal_size: 5
3.89 < 5  →  SKIP this candidate (BELOW_MIN_SIZE rejection inevitable downstream)
```

After this check passes (or the candidate is skipped and you've moved to the next), proceed to step L below.
```

### Tests

**Test A — Scanner unit test** (extend `tests/scanner.test.ts` or new `tests/scanner-min-deal-size.test.ts`):

1. **Happy path**: mock `capital.getMarketDetails` to return varied `dealingRules.minDealSize.value` per ticker. Call `getRankedInstruments(20)`. Assert each returned `RankedInstrument` has `min_deal_size` populated correctly (e.g. `SILVER → 5`, `USDJPY → 1000`, `GOLD → 0.1`).

2. **Fetch failure path**: mock `capital.getMarketDetails` to throw for one specific ticker (e.g. SILVER). Assert that ticker's `min_deal_size` is `null` and other tickers are correctly populated. Assert a `console.warn` is emitted with `min_deal_size fetch failed for SILVER`.

3. **Cache reuse path**: call `getRankedInstruments` twice. Assert `capital.getMarketDetails` is called only once per ticker (across both calls). Use `_resetMinDealSizeCache()` between the two calls in a separate test to verify the reset works.

4. **Numeric guard**: mock `capital.getMarketDetails` to return `{ dealingRules: { minDealSize: { value: 0 } } }` for one ticker (broker returns 0 — pathological). Assert that ticker gets `min_deal_size: null` (the `v > 0` guard rejects zero/negative). Same for `NaN` and missing fields.

**Test B — Static prompt-content test** (extend `tests/ict-prompt.test.ts`, NOT `tests/analyst-prompt.test.ts`):

```ts
it('STEP 3 contains L0 feasibility pre-flight directive', () => {
  expect(promptText).toContain('L0. Sizing feasibility pre-flight');
  expect(promptText).toContain('leg_b_notional = (balance × tier_risk_pct / 100) × 0.30 / |entry − sl|');
  expect(promptText).toContain('skip this candidate');
  expect(promptText).toContain('do NOT submit to `request_analyst_review`');
});
```

**Real validation is production observation**: on the next weekday's London Open, watch for:
- `BELOW_MIN_SIZE` rejection count at `request_analyst_review` → should drop to near-zero (the agent skips upfront)
- Per-cycle iteration count on small-account days → should decrease (no wasted analyst round-trips on infeasible proposals)

### What's deliberately NOT in scope

- **No tier auto-bump** when feasibility fails. Skip-only. Strategy purity.
- **No 2-leg → 1-leg fallback**. The 70/30 split is core to the bot's de-risk-on-TP1 mechanism.
- **No instrument-universe filter by account size**. The scanner still ranks all 7 instruments; the agent makes the per-cycle feasibility call.
- **No `min_deal_size` TTL** (cache is module-lifetime). Broker changes are picked up on next pm2 restart. The existing `request_analyst_review` pre-check is the live-fetch safety net.
- **No update to `computeServerSizing`** (`trading-agent.ts:406+`) or analyst CHECK 6 (sizing math). Both stay as-is.

### Integration with sibling specs

| Component | Behavior | Affected by L3b-2? |
|---|---|---|
| `request_analyst_review` pre-check (`trading-agent.ts:869`) | Live `getMarketDetails` fetch + `computeServerSizing` | ✅ Stays as defensive last gate. Also picks up cache-staleness drift. |
| Scanner ranking cache (`RANKING_TTL_MS = 0` post Spec 1) | Per-cycle fresh ranking | ✅ Independent. min_deal_size cache is separate (module-lifetime). |
| Spec 1 cap+L1 (Promise.all parallel exec) | Loop's tool dispatch is concurrent | ✅ Compatible — L0 check is local arithmetic in agent prose, no new tool calls. |
| L3a STEP 3 batching directive | Agent batches reads into one tool_use response | ✅ Compatible — `get_ranked_instruments` is in STEP 1 batch (already shipped); min_deal_size is part of its payload. |
| L3b-1 R:R 1.31R precision | Agent sets TP2 ≥ 1.31R | ✅ Independent. L0 catches the small-account-balance case; L3b-1 catches boundary-rounding case. |
| Analyst calibration (today) | Strict APPROVE/MODIFY/REJECT bands | ✅ Fewer borderline-but-infeasible proposals reach the analyst → higher proportion of clean APPROVEs. |
| 3-leg removal Phase 2 | trades schema columns dropped | ✅ Independent. RankedInstrument has no 3-leg fields. |

### Risk

Low. Three risk vectors:

1. **Type drift**: any consumer of `RankedInstrument` that constructs literals will need `min_deal_size: null` in test fixtures. TypeScript's `tsc --noEmit` flags these at compile time. Mitigation: run typecheck as part of every task per existing plan pattern.

2. **Cache staleness**: if Capital changes a `min_deal_size` mid-day, the agent's L0 check uses stale data for ≤24h (until next pm2 restart). The existing live fetch at `request_analyst_review` catches this — worst case is one wasted analyst round-trip per stale instrument per session. Net improvement vs today (every infeasible proposal wastes one round-trip).

3. **Agent doesn't follow the L0 directive**: a model can ignore prompt instructions. The static prompt-content test guards against accidental deletion, but doesn't enforce behavior. Real validation is production observation: if BELOW_MIN_SIZE rejections at `request_analyst_review` don't drop after deploy, the directive isn't being followed → escalate by adding a code-level check at `trading-agent.ts` that intercepts `request_analyst_review` calls when `leg_b_notional < min_deal_size` and returns a synthetic skip-this-candidate response (bypassing the analyst pre-check entirely).

Rollback: revert the 3 commits. The prompt directive becomes a no-op without the type/scanner change; existing pre-check still catches infeasibility.

### Files touched

- **Modify:** `src/types.ts` — add `min_deal_size: number | null` to `RankedInstrument` (~5 lines including JSDoc)
- **Modify:** `src/scanner/index.ts` — add cache + helper + `_reset`/`_get` test helpers + populate in result loop (~50-60 lines)
- **Modify:** `prompts/ict-agent.md` — add STEP 3 L0 sub-step with formula, skip rule, and worked example (~25-30 lines)
- **Create or Modify:** `tests/scanner-min-deal-size.test.ts` (new ~80 lines, 4 tests) OR extend `tests/scanner.test.ts` if it exists with similar pattern
- **Modify:** `tests/ict-prompt.test.ts` — add Test 5 for L0 directive (~10 lines)

Total diff: ~150-180 lines added, no logic removed. No code logic changed in `trading-agent.ts` or `analyst-agent.ts`.

### Production observation plan

Three signals to track over the next 5 kill-zone days:

| Signal | Pre-L3b-2 baseline | Post-deploy target |
|---|---|---|
| `BELOW_MIN_SIZE` rejections at `request_analyst_review` | 2 of 13 cycles on 2026-05-09 (weekend); higher on weekdays with thin small-account margins | Near-zero — the agent skips upfront |
| Per-cycle iteration count on multi-candidate days | Already low post Spec 1 (cap=12) but spent ~10-15% of iters on infeasible-then-pre-check-rejected proposals | Drop on small-account days; no change on big-account days where most setups are feasible anyway |
| `min_deal_size fetch failed` console.warn count | 0 (today) | 0 expected; non-zero would indicate Capital API instability |

If BELOW_MIN_SIZE rejections persist at request_analyst_review after 5 weekdays of post-deploy data, the prompt directive isn't being followed → escalate per Risk #3 above.

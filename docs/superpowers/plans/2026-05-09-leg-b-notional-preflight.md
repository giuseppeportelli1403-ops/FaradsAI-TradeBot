# L3b-2: Leg-B Notional Pre-flight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make broker `min_deal_size` available to the ICT agent at proposal-construction time so it can skip infeasible instrument-tier-SL combinations BEFORE submitting to `request_analyst_review`.

**Architecture:** Augment `RankedInstrument` with `min_deal_size: number | null`. Scanner caches per-instrument min_deal_size (in-flight-promise-deduped). Agent uses it in a new STEP 3 sub-step L0 with the feasibility formula. The existing pre-check at `trading-agent.ts:869` stays as the defensive last gate; the agent's L0 is an optimization, not a hard gate.

**Tech Stack:** TypeScript, Node.js 22, vitest 4.1.4, Capital.com REST API (`getMarketDetails`).

**Spec:** `docs/superpowers/specs/2026-05-09-leg-b-notional-preflight-design.md` (commit `7264114`).

---

## File map

- **Modify:** `src/types.ts` — extend `RankedInstrument` with `min_deal_size: number | null` (~5 lines incl. JSDoc)
- **Modify:** `src/agents/trading-agent.ts` — add `export` keyword to existing `const capital = new CapitalClient(...)` declaration (~1 line; surface change only, no runtime change)
- **Modify:** `src/scanner/index.ts`
  - Add `import { capital } from '../agents/trading-agent.js'` near the top
  - Add module-level cache `Map<string, Promise<number | null>>` + `getMinDealSizeFor(ticker)` helper + `_resetMinDealSizeCache` / `_getMinDealSizeCache` test helpers (~50 lines)
  - Inside `getRankedInstruments`, populate `min_deal_size` on each result via `Promise.all` over the universe (~10 lines)
- **Modify:** `prompts/ict-agent.md` — add STEP 3 sub-step **L0. Sizing feasibility pre-flight** before existing **L. Final checklist** (~30 lines)
- **Create:** `tests/scanner-min-deal-size.test.ts` — 5 unit tests covering happy path, fetch failure, cache reuse, concurrent dedup, numeric guard (~120 lines)
- **Modify:** `tests/ict-prompt.test.ts` — append Test 4 for L0 directive (~10 lines)

---

## Task 1: Foundation — extend type, export capital, add scanner placeholder

This task makes the codebase compile after the type field is added. No behavior change yet; the placeholder `min_deal_size: null` lands at the literal-construction site so tsc stays clean.

**Files:**
- Modify: `src/types.ts:430-436`
- Modify: `src/agents/trading-agent.ts` (the `const capital = new CapitalClient({ ... })` declaration — locate by content, around line 765)
- Modify: `src/scanner/index.ts:384-389` (the `satisfies RankedInstrument` literal-construction site)

- [ ] **Step 1: Extend `RankedInstrument` in `src/types.ts`**

Locate the existing `RankedInstrument` interface (currently lines 430-436):

```ts
export interface RankedInstrument {
  ticker: string;
  name: string;
  composite_score: number;
  bias: 'bullish' | 'bearish' | 'neutral';
  tier: 1 | 2 | 3 | null;  // null if score < 40. Tier 3 = 40-59, Tier 2 = 60-79, Tier 1 = 80-100. Range-mode setups capped at 59 by scanner.
}
```

Replace with:

```ts
export interface RankedInstrument {
  ticker: string;
  name: string;
  composite_score: number;
  bias: 'bullish' | 'bearish' | 'neutral';
  tier: 1 | 2 | 3 | null;  // null if score < 40. Tier 3 = 40-59, Tier 2 = 60-79, Tier 1 = 80-100. Range-mode setups capped at 59 by scanner.
  /**
   * Broker minimum deal size for this instrument (e.g. SILVER=5, USDJPY=1000,
   * GOLD=0.1). Fetched from capital.getMarketDetails() at scanner load time
   * and cached. `null` if the fetch failed for this ticker — the agent then
   * falls through to the existing pre-check at `request_analyst_review` for
   * authoritative live-fetched validation. Added 2026-05-09 for L3b-2.
   */
  min_deal_size: number | null;
}
```

- [ ] **Step 2: Add `export` to capital singleton in `src/agents/trading-agent.ts`**

Locate the existing `const capital = new CapitalClient({ ... })` declaration (around line 765-767, search for `new CapitalClient`). The current line is:

```ts
const capital = new CapitalClient({
```

Change it to:

```ts
export const capital = new CapitalClient({
```

No other change. Existing usage stays the same (the file's own references to `capital` continue to work since `export const` doesn't break local access).

- [ ] **Step 3: Add `min_deal_size: null` placeholder at scanner literal site**

In `src/scanner/index.ts`, locate the literal construction (currently around lines 384-389, search for `satisfies RankedInstrument`). The current literal is:

```ts
results.push({
  ticker,
  name: ticker,
  composite_score: finalScore,
  bias,
  tier,
} satisfies RankedInstrument);
```

(Field names and exact shape may vary — find by `satisfies RankedInstrument`.)

Add `min_deal_size: null` to the literal:

```ts
results.push({
  ticker,
  name: ticker,
  composite_score: finalScore,
  bias,
  tier,
  min_deal_size: null,  // populated post-loop in Task 3
} satisfies RankedInstrument);
```

- [ ] **Step 4: Run tsc to verify clean compile**

Run: `npx tsc --noEmit`
Expected: zero errors. If errors appear, they'll be elsewhere consuming `RankedInstrument` (test fixtures or other production code) — fix by adding `min_deal_size: null` to those literals too.

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: all existing tests pass (no behavior change in this task; only the type extension and a placeholder field added).

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/agents/trading-agent.ts src/scanner/index.ts
git commit -m "feat(types): extend RankedInstrument with min_deal_size field; export capital singleton

Foundation for L3b-2 (Leg-B notional pre-flight). Adds
min_deal_size: number | null to RankedInstrument so the scanner can
populate it and the agent can read it in STEP 3. The existing
literal-construction site at src/scanner/index.ts is given a
placeholder null for the field; Task 3 wires it up to a real cache
fetch.

Adds export keyword to the existing capital = new CapitalClient(...)
declaration in src/agents/trading-agent.ts so the scanner can import
the same instance instead of creating a duplicate Capital session.

No runtime behavior change. Per spec
docs/superpowers/specs/2026-05-09-leg-b-notional-preflight-design.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Scanner `getMinDealSizeFor` helper with cache + dedup

This task adds the helper function and 5 tests in a single TDD-disciplined task. Each test is a separate red→green→commit cycle conceptually, but the tests share scaffolding so they're written together.

**Files:**
- Create: `tests/scanner-min-deal-size.test.ts`
- Modify: `src/scanner/index.ts` — add cache + helper + test exports

- [ ] **Step 1: Create `tests/scanner-min-deal-size.test.ts` with all 5 failing tests**

Create the file with this exact content:

```ts
// Unit tests for src/scanner/index.ts min_deal_size cache + helper.
// Tests cover the in-flight-promise-deduped cache pattern that prevents
// duplicate Capital API calls when concurrent callers hit the same cold
// ticker (e.g. researcher-agent + scheduler ICT trigger overlapping at
// startup). Per spec docs/superpowers/specs/2026-05-09-leg-b-notional-preflight-design.md.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock factory must reference vi.hoisted vars so they exist at hoist time.
const { mockGetMarketDetails } = vi.hoisted(() => ({
  mockGetMarketDetails: vi.fn(),
}));

// Mock the capital singleton — same module the scanner imports.
vi.mock('../src/mcp-server/capital-singleton.js', () => ({
  capital: {
    getMarketDetails: mockGetMarketDetails,
  },
}));

// Import after the mock is set up.
import {
  _resetMinDealSizeCache,
  _getMinDealSizeCache,
} from '../src/scanner/index.js';

// We import the helper indirectly via a test seam — see Step 3 of this task
// for the export. Until Step 3 lands, the import below errors at compile.
import { _getMinDealSizeFor as getMinDealSizeFor } from '../src/scanner/index.js';

describe('scanner getMinDealSizeFor', () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockGetMarketDetails.mockReset();
    _resetMinDealSizeCache();
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('happy path: returns the broker minDealSize value', async () => {
    mockGetMarketDetails.mockResolvedValueOnce({
      dealingRules: { minDealSize: { value: 5 } },
    });

    const size = await getMinDealSizeFor('SILVER');

    expect(size).toBe(5);
    expect(mockGetMarketDetails).toHaveBeenCalledTimes(1);
    expect(mockGetMarketDetails).toHaveBeenCalledWith('SILVER');
  });

  it('fetch failure: caches null and emits a console.warn', async () => {
    mockGetMarketDetails.mockRejectedValueOnce(new Error('Capital API down'));

    const size = await getMinDealSizeFor('SILVER');

    expect(size).toBeNull();
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('min_deal_size fetch failed for SILVER'),
    );
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Capital API down'),
    );
  });

  it('cache reuse: second call for same ticker does NOT re-fetch', async () => {
    mockGetMarketDetails.mockResolvedValueOnce({
      dealingRules: { minDealSize: { value: 1000 } },
    });

    const a = await getMinDealSizeFor('USDJPY');
    const b = await getMinDealSizeFor('USDJPY');

    expect(a).toBe(1000);
    expect(b).toBe(1000);
    expect(mockGetMarketDetails).toHaveBeenCalledTimes(1);
  });

  it('concurrent dedup: two parallel calls for the same cold ticker share one fetch', async () => {
    // Resolve only after both calls have entered the helper. We use a
    // deferred Promise so we can assert in-flight behavior.
    let resolve: (value: { dealingRules: { minDealSize: { value: number } } }) => void = () => {};
    const pending = new Promise<{ dealingRules: { minDealSize: { value: number } } }>((r) => {
      resolve = r;
    });
    mockGetMarketDetails.mockReturnValueOnce(pending);

    // Fire both calls before resolving the underlying mock.
    const callA = getMinDealSizeFor('GOLD');
    const callB = getMinDealSizeFor('GOLD');

    // Both calls have entered; the cache should hold one in-flight promise,
    // and getMarketDetails should have been invoked exactly once so far.
    await new Promise((r) => setImmediate(r));
    expect(mockGetMarketDetails).toHaveBeenCalledTimes(1);

    // Resolve the underlying fetch.
    resolve({ dealingRules: { minDealSize: { value: 0.1 } } });

    const [a, b] = await Promise.all([callA, callB]);

    expect(a).toBe(0.1);
    expect(b).toBe(0.1);
    // Still exactly one fetch — both callers shared the in-flight promise.
    expect(mockGetMarketDetails).toHaveBeenCalledTimes(1);
  });

  it('numeric guard: caches null for 0 / negative / NaN / missing minDealSize', async () => {
    // Test 4 cases: zero, negative, NaN, missing field.
    const cases: Array<[string, unknown]> = [
      ['ZERO_TICKER', { dealingRules: { minDealSize: { value: 0 } } }],
      ['NEG_TICKER', { dealingRules: { minDealSize: { value: -1 } } }],
      ['NAN_TICKER', { dealingRules: { minDealSize: { value: NaN } } }],
      ['MISSING_TICKER', { dealingRules: {} }],
    ];

    for (const [ticker, response] of cases) {
      _resetMinDealSizeCache();
      mockGetMarketDetails.mockReset();
      mockGetMarketDetails.mockResolvedValueOnce(response);
      const size = await getMinDealSizeFor(ticker);
      expect(size).toBeNull();
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they all fail (compile-time error is OK)**

Run: `npx vitest run tests/scanner-min-deal-size.test.ts`
Expected: FAIL — `_getMinDealSizeFor`, `_resetMinDealSizeCache`, `_getMinDealSizeCache` are not exported from `src/scanner/index.ts` yet. The test file may fail to load entirely with a "no exported member" error.

- [ ] **Step 3: Add the helper + cache + test exports in `src/scanner/index.ts`**

In `src/scanner/index.ts`, near the top of the file (with the existing imports), add:

```ts
import { capital } from '../mcp-server/capital-singleton.js';
```

Near the existing `RANKING_TTL_MS` declaration (around line 240), add the cache + helper:

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

/** Test-only export so tests/scanner-min-deal-size.test.ts can drive the helper directly. */
export async function _getMinDealSizeFor(ticker: string): Promise<number | null> {
  return getMinDealSizeFor(ticker);
}

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

- [ ] **Step 4: Run tests to verify all 5 pass**

Run: `npx vitest run tests/scanner-min-deal-size.test.ts`
Expected: 5 tests pass.

- [ ] **Step 5: Run full suite + tsc**

Run: `npx vitest run`
Expected: all tests pass. Test count grows by 5.

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/scanner/index.ts tests/scanner-min-deal-size.test.ts
git commit -m "feat(scanner): add min_deal_size cache + getMinDealSizeFor helper

Adds an in-flight-promise-deduped cache for broker min_deal_size
values, fetched from capital.getMarketDetails(). The cache is
module-level (refreshed on pm2 restart). Concurrent callers for the
same cold ticker share one Capital fetch via the in-flight promise
in the Map.

Numeric guard rejects 0, negative, NaN, and missing values — caches
null for those cases. The agent's L3b-2 feasibility check (Task 4
of this plan) treats null as 'I don't know, let the live pre-check
at request_analyst_review decide.'

5 unit tests in tests/scanner-min-deal-size.test.ts covering happy
path, fetch failure (with console.warn assertion), cache reuse,
concurrent dedup (deferred-promise pattern proves both callers share
the in-flight fetch), and the numeric guard's 4 edge cases (0, -1,
NaN, missing field).

Per spec docs/superpowers/specs/2026-05-09-leg-b-notional-preflight-design.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Wire `min_deal_size` into `getRankedInstruments` output

**Files:**
- Modify: `src/scanner/index.ts` — replace the placeholder `min_deal_size: null` with a real `Promise.all`-driven fetch
- Modify: `tests/scanner-min-deal-size.test.ts` — add Test 6 (integration)

- [ ] **Step 1: Append integration test to `tests/scanner-min-deal-size.test.ts`**

After the existing `describe` block, append:

```ts
describe('getRankedInstruments populates min_deal_size on each result', () => {
  beforeEach(() => {
    mockGetMarketDetails.mockReset();
    _resetMinDealSizeCache();
    // Existing scanner setup mocks (fetchCandles, getNewsScore, etc.) are
    // not mocked here. This test only asserts the min_deal_size pass-through;
    // it relies on the scanner's existing fixture / cache to skip the
    // candle-fetching path. If running this test fails because fetchCandles
    // is called and not mocked, see scanner.test.ts for the fixture pattern.
  });

  it('each RankedInstrument carries min_deal_size from the cache', async () => {
    // Set up min_deal_size for each universe ticker. Capital.com's
    // INSTRUMENT_UNIVERSE in the scanner is fixed (FX majors + GOLD +
    // SILVER + OIL_CRUDE = 7 tickers). Mock the fetch to return realistic
    // values keyed off the ticker arg.
    mockGetMarketDetails.mockImplementation(async (ticker: string) => {
      const map: Record<string, number> = {
        EURUSD: 1000,
        GBPUSD: 1000,
        USDJPY: 1000,
        AUDUSD: 1000,
        GOLD: 0.1,
        SILVER: 5,
        OIL_CRUDE: 25,
      };
      const value = map[ticker] ?? null;
      return value !== null
        ? { dealingRules: { minDealSize: { value } } }
        : { dealingRules: {} };
    });

    // Reset ranking cache too so getRankedInstruments fully runs the
    // result-build path. (Imported lazily via dynamic import to avoid
    // hoisting issues with the static mocks at the top of the file.)
    const { getRankedInstruments, _resetRankingCache } = await import(
      '../src/scanner/index.js'
    );
    _resetRankingCache();

    const ranked = await getRankedInstruments(20);

    // Every result has min_deal_size populated (number or null).
    for (const r of ranked) {
      expect(r).toHaveProperty('min_deal_size');
      expect(
        typeof r.min_deal_size === 'number' || r.min_deal_size === null,
      ).toBe(true);
    }

    // At least one of the universe tickers we mocked should appear with
    // its expected min_deal_size value (the test is robust against scanner
    // filtering some tickers below tier floor — we just need ANY mocked
    // value to flow through).
    const mockedTickers = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'GOLD', 'SILVER', 'OIL_CRUDE'];
    const expectedSizes: Record<string, number> = {
      EURUSD: 1000, GBPUSD: 1000, USDJPY: 1000, AUDUSD: 1000,
      GOLD: 0.1, SILVER: 5, OIL_CRUDE: 25,
    };
    for (const r of ranked) {
      if (mockedTickers.includes(r.ticker)) {
        expect(r.min_deal_size).toBe(expectedSizes[r.ticker]);
      }
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/scanner-min-deal-size.test.ts -t 'min_deal_size from the cache'`
Expected: FAIL — currently `min_deal_size` is hard-coded to `null` (Task 1's placeholder). The assertion `expect(r.min_deal_size).toBe(expectedSizes[r.ticker])` fails for every populated ticker.

- [ ] **Step 3: Replace the placeholder with a real Promise.all fetch in `src/scanner/index.ts`**

In `getRankedInstruments` (around line 256-389), the function currently builds `results: RankedInstrument[]` then returns `results.slice(0, limit)` (or similar). Locate the literal-construction site (Task 1's `min_deal_size: null` line) and the function's final `return` statement.

Remove `min_deal_size: null` from the literal at the construction site (it'll be filled in by the post-loop pass):

```ts
results.push({
  ticker,
  name: ticker,
  composite_score: finalScore,
  bias,
  tier,
  // min_deal_size populated post-loop via getMinDealSizeFor (L3b-2)
} as Omit<RankedInstrument, 'min_deal_size'> as RankedInstrument);
```

(The `as Omit<...>` cast is a temporary type bridge; the next step's Promise.all fills the field before the function returns.)

Replace the final `return results.slice(0, limit);` (or equivalent) with:

```ts
// 2026-05-09 (L3b-2): augment each result with min_deal_size from the
// module-level cache. Promise.all means the 7-instrument universe fetches
// concurrently on cold cache; subsequent cycles return instantly from
// the in-memory map.
const augmented: RankedInstrument[] = await Promise.all(
  results.map(async (r) => ({
    ...r,
    min_deal_size: await getMinDealSizeFor(r.ticker),
  })),
);
return augmented.slice(0, limit);
```

(If the function already had a `.slice(0, limit)` call, replace that single return; if it returned `results` directly, replace with the `augmented` form above.)

- [ ] **Step 4: Run the integration test to verify it passes**

Run: `npx vitest run tests/scanner-min-deal-size.test.ts -t 'min_deal_size from the cache'`
Expected: PASS — every result carries the mocked value (or `null` if not in the mock map).

- [ ] **Step 5: Run all 6 scanner-min-deal-size tests + full suite**

Run: `npx vitest run tests/scanner-min-deal-size.test.ts`
Expected: 6 tests pass.

Run: `npx vitest run`
Expected: full suite passes, test count +6 from baseline.

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/scanner/index.ts tests/scanner-min-deal-size.test.ts
git commit -m "feat(scanner): populate min_deal_size on every RankedInstrument result

Replaces Task 1's placeholder null with a real per-ticker fetch via
the cache. Promise.all over the result array means the 7-instrument
universe's first call fetches all min_deal_sizes concurrently;
subsequent cycles hit the in-memory cache instantly.

Adds integration test asserting that every getRankedInstruments
result carries the mocked min_deal_size for its ticker (with the
existing 7-ticker INSTRUMENT_UNIVERSE: EURUSD/GBPUSD/USDJPY/AUDUSD/
GOLD/SILVER/OIL_CRUDE).

The agent now sees min_deal_size in get_ranked_instruments output
in STEP 2; Task 4 adds the agent-side L0 feasibility check that
uses it.

Per spec docs/superpowers/specs/2026-05-09-leg-b-notional-preflight-design.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Prompt L0 sub-step + prompt-content test

**Files:**
- Modify: `prompts/ict-agent.md` — insert STEP 3 sub-step **L0** before existing **L. Final checklist**
- Modify: `tests/ict-prompt.test.ts` — append Test 5

- [ ] **Step 1: Append Test 5 to `tests/ict-prompt.test.ts`**

Inside the existing `describe('ict-agent.md L3 directives', ...)` block, append:

```ts
  it('STEP 3 contains L0 feasibility pre-flight directive', () => {
    expect(promptText).toContain('L0. Sizing feasibility pre-flight');
    expect(promptText).toContain('leg_b_notional = (balance × tier_risk_pct / 100) × 0.30 / |entry − sl|');
    expect(promptText).toContain('skip this candidate');
    expect(promptText).toContain('do NOT submit to `request_analyst_review`');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/ict-prompt.test.ts -t 'L0 feasibility'`
Expected: FAIL — `'L0. Sizing feasibility pre-flight'` and the formula don't exist in the prompt yet.

- [ ] **Step 3: Insert L0 sub-step in `prompts/ict-agent.md`**

Locate the existing `**L. Final checklist**` line (search for the literal text). IMMEDIATELY BEFORE that line, insert:

```markdown
**L0. Sizing feasibility pre-flight (post-2026-05-09 L3b-2)** — before the final checklist below, verify the proposal can satisfy the broker's `min_deal_size` constraint:

```
leg_b_notional = (balance × tier_risk_pct / 100) × 0.30 / |entry − sl|
```

where `tier_risk_pct` is **1.5** for Tier 1, **1.0** for Tier 2, **0.5** for Tier 3 (trend-mode), and **0.25** for range-mode (setup_type starts with `Range_`). The `min_deal_size` for each candidate is in the `get_ranked_instruments` response (added 2026-05-09 via the L3b-2 spec — `RankedInstrument.min_deal_size`).

**If `leg_b_notional < min_deal_size`:** skip this candidate. The trade is mathematically too small to execute on the current account balance at this tier and SL distance. Move to the next candidate, or skip the cycle if no remaining candidates pass. Do NOT submit to `request_analyst_review` — the pre-check there will reject for the same reason after wasting one round-trip.

**If `min_deal_size` is null/missing** for this instrument (the scanner's getMarketDetails fetch failed or this is a freshly-added ticker): proceed to `request_analyst_review` anyway. The pre-check there does a fresh live fetch and will catch any infeasibility. The L0 check is an optimization, not a hard gate — null means "I don't know, let the live pre-check decide".

**Worked example (the case L3b-2 is designed to prevent — pre-top-up demo on 2026-05-08):**
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

(Note: the closing triple-backtick of this block is part of the prompt content — it closes the worked-example fence. Make sure both fences are present in the inserted text.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/ict-prompt.test.ts -t 'L0 feasibility'`
Expected: PASS — all four `toContain` assertions match the new block.

- [ ] **Step 5: Run all ict-prompt tests + full suite**

Run: `npx vitest run tests/ict-prompt.test.ts`
Expected: 5 tests pass (4 from prior session + 1 new).

Run: `npx vitest run`
Expected: full suite passes, +1 vs Task 3's count.

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add prompts/ict-agent.md tests/ict-prompt.test.ts
git commit -m "feat(prompt): STEP 3 L0 sizing feasibility pre-flight (L3b-2)

Adds a new sub-step L0 in STEP 3 of prompts/ict-agent.md, immediately
before the existing 'L. Final checklist'. The agent now computes
leg_b_notional = (balance × tier_risk_pct / 100) × 0.30 / |entry − sl|
using min_deal_size from get_ranked_instruments (Tasks 1-3) and skips
the candidate if leg_b_notional < min_deal_size — preventing wasted
request_analyst_review round-trips on proposals that the existing
pre-check at trading-agent.ts:869 would reject anyway.

Worked example uses the 2026-05-08 c0745 SILVER case (3.89 < 5).
The example shows the pre-top-up demo balance of 1012 specifically;
post-top-up days will rarely trip this gate.

If min_deal_size is null (scanner fetch failed), the agent proceeds
to request_analyst_review and the live pre-check there decides —
L0 is an optimization, not a hard gate.

Per spec docs/superpowers/specs/2026-05-09-leg-b-notional-preflight-design.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Final verification + push + VPS deploy check

**Files:** none modified — verification only.

- [ ] **Step 1: Confirm clean working tree + 4 commits ahead of origin**

Run: `git status -s | grep -vE "^\?\?"`
Expected: empty (no tracked-file modifications outstanding).

Run: `git log --oneline origin/master..HEAD`
Expected: 4 commits — Task 1 (`feat(types): extend RankedInstrument...`), Task 2 (`feat(scanner): add min_deal_size cache...`), Task 3 (`feat(scanner): populate min_deal_size...`), Task 4 (`feat(prompt): STEP 3 L0 sizing feasibility pre-flight...`).

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: all tests pass. Test count should be ≥807 + 6 new (Task 2's 5 + Task 3's 1) + 1 new (Task 4's L0 directive) = ≥814.

- [ ] **Step 4: Concurrent-session safety pull**

Run: `git fetch origin && git log --oneline HEAD..origin/master`
Expected: empty. If non-empty, STOP and reconcile via `git pull --ff-only origin master` before pushing.

- [ ] **Step 5: Push to origin**

Run: `git push origin master`
Expected: push succeeds. GitHub Actions Build+Test runs, then triggers `/home/bot/deploy.sh` on the VPS (which sources nvm so the bot restarts under Node 22.22.2).

- [ ] **Step 6: Verify VPS state after deploy completes (~3 min)**

Run:
```bash
ssh bot@162.55.212.198 'cd /home/bot/trading-bot && git log --oneline -5 && export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use default >/dev/null 2>&1 && pm2 jlist | python3 -c "import sys,json; d=json.load(sys.stdin); p=d[0]; print(p[\"name\"], p[\"pm2_env\"][\"status\"], \"node:\", p[\"pm2_env\"].get(\"node_version\"), \"restarts:\", p[\"pm2_env\"][\"restart_time\"])"'
```

Expected:
- `git log` shows the 4 L3b-2 commits as the latest 4 (newest first).
- pm2 shows `trading-bot online` with `node: 22.22.2`.

- [ ] **Step 7: Smoke-check `min_deal_size` in production scanner output**

Once a kill zone is active (London Open 07:00-10:00 UTC, NY Open 12:00-15:00 UTC, or trigger via the next 15M candle), tail pm2-out.log and look for the agent's `[ICT Agent] **Ranked Candidates Summary:**` block. The agent should reference `min_deal_size` in its STEP 3 reasoning if it's actually using it, OR the scanner's first cold-cache run should produce 7 `[Scheduler]` log entries (no specific log line — `getMinDealSizeFor` only logs on FAILURE).

Negative-only signal: if any cold-start `[Scanner] min_deal_size fetch failed for <ticker>` lines appear in pm2-err.log post-deploy, investigate immediately — could indicate Capital API instability or auth failure on the shared singleton.

```bash
ssh bot@162.55.212.198 'tail -200 /home/bot/trading-bot/data/pm2-err.log | grep -E "min_deal_size fetch failed" | head -5'
```

Expected: empty (no fetch failures).

- [ ] **Step 8: Mark all tasks complete**

No commit (verification only). Update task tracker.

---

## Self-Review (skill-required)

**1. Spec coverage check:** every section of the spec maps to a task above:
- Spec Change 1 (RankedInstrument extension) → Task 1 ✓
- Spec Change 2's prerequisite (capital export from trading-agent.ts) → Task 1 ✓
- Spec Change 2 (cache + helper + populate) → Tasks 2 + 3 ✓
- Spec Change 3 (prompt L0 sub-step) → Task 4 ✓
- Spec Tests A 1-4 (scanner happy/fail/cache/concurrent/numeric) → Task 2 ✓ (5 tests in one file)
- Spec Test B (prompt-content for L0) → Task 4 ✓
- Spec Production observation plan → Task 5 Step 7 ✓
- Spec "What's deliberately NOT in scope" → respected (no tier-bumping, no 1-leg fallback, no universe filter, no TTL, no computeServerSizing change)

**2. Placeholder scan:** no TBD, no "implement appropriate", no "similar to Task N" without code. Every code step shows the exact diff or insert; every test step shows the full assertion code; every command shows the exact `npx vitest run …` invocation.

**3. Type consistency:** the cache type is `Map<string, Promise<number | null>>` consistently across the helper, the test reset/get exports, and the test file's mock setup. The `RankedInstrument.min_deal_size: number | null` matches between types.ts, the placeholder in Task 1, and the populated value in Task 3. The `getMinDealSizeFor(ticker)` signature is `(ticker: string) => Promise<number | null>` everywhere.

**4. Ordering check:** Task 1 makes the codebase compile with the new field (placeholder null). Task 2 adds the cache + helper but `getRankedInstruments` still returns `min_deal_size: null` (placeholder unchanged — Task 2's tests drive `getMinDealSizeFor` directly via the test export, not through `getRankedInstruments`). Task 3 wires `getMinDealSizeFor` into `getRankedInstruments`'s output, making the placeholder real. Task 4 adds the prompt directive that READS the populated field. Task 5 verifies + deploys. Order is correct: each task leaves the codebase tsc-clean and tests-green.

**5. Tools imported / scope:** `capital` is imported in scanner from `../agents/trading-agent.js` (Task 2 Step 3). `RankedInstrument` is consumed by `src/scanner/index.ts`, `src/agents/trading-agent.ts`, `src/agents/researcher-agent.ts`, `src/mcp-server/tools/db-tools.ts` (per Codex review). Task 1 only modifies `src/scanner/index.ts` because that's the only literal-construction site; the other consumers don't construct, they consume — non-breaking when adding a field.

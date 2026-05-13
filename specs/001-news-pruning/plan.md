# News Inputs Pruning — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce Farad's news inputs from 4 sources (+15 RSS feeds) down to 3 sources (+6 RSS feeds, all Tier 1) without changing scoring, scanner, or analyst behaviour.

**Architecture:** Pure config-and-deletion change. The 6 retained feeds are Fed + ECB + BoE + ActionForex + ForexLive + Investing.com Forex Opinion, all promoted to Tier 1. Finnhub economic calendar is removed entirely; Forex Factory becomes the sole calendar source. No new files, no new dependencies, no new tests of behaviour — only regression tests confirming the change is neutral on scoring.

**Tech Stack:** TypeScript / Node 20.20.2 / vitest 901-test suite at HEAD `3bc90ca`.

**Branch:** `spec/news-pruning` | **Spec:** [spec.md](./spec.md)

---

## Summary

Three sequential commits on `spec/news-pruning`:

1. **Commit 1 — RSS pruning + Tier 1 collapse.** Edit `src/news/rss-feeds.ts` to remove 9 feeds (BBC, CNBC, OilPrice, Investing.com general, Yahoo, MarketWatch, Calculated Risk, Wolf Street, ZeroHedge), promote 3 (ActionForex, ForexLive, Investing.com Forex Opinion) from Tier 2 to Tier 1, leaving 6 entries all `tier: 1`. Update the 2026-04-28 validation-pass comment to reflect the new state.
2. **Commit 2 — Finnhub calendar removal.** Drop the Finnhub branch of the calendar union in `src/agents/trading-agent.ts:1487-1491`, drop the `fetchEconomicCalendar` import at `:797`, replace the `get_economic_calendar` MCP tool body at `:850` to call `fetchForexFactoryCalendar()` directly, then delete the `fetchEconomicCalendar` function definition at `src/mcp-server/market-data.ts:500-580` (approx — confirm exact range before editing).
3. **Commit 3 — Test + docs.** Run the full vitest suite, run `scripts/audit-trigger-decisions.ts`, replay the last 7 days of scanner cycles if a replay harness exists, update `docs/architecture/SYSTEM-FLOWCHART.md` to reflect the new 3-source layout, mark `[[project_farad_news_pipeline]]` as superseded in memory.

**Rejected scope adjustments:**
- **FR-8 env-flag rollback rejected.** The 5-day false-positive measurement pattern from [[project_farad_dc_phase1_shipped]] already gives clean rollback via `git revert <merge_sha>` + pm2 deploy. An env flag would add code complexity for a noise-reduction change that has no behavioural risk on the live trading path.
- **No new tests of impact-classifier behaviour.** The classifier is feed-agnostic — adding feed-specific tests would test the wrong abstraction. The 901-test regression suite is sufficient.

## Technical Context

- **Language/Version**: TypeScript on Node 20.20.2 (VPS); local dev Node 24.13.0 also OK.
- **Test runner**: `vitest` — `npm test` runs all 901 tests.
- **Storage**: No DB changes. RSS cache is in-memory only.
- **Constraints**: 
  - VPS sudo unavailable ([[feedback_vps_sudo_unavailable]]) — no system-level config touched anyway.
  - Concurrent-session protocol ([[feedback_concurrent_session_protocol]]) — re-fetch origin/master before merging if user signals another session pushed.
  - PowerShell UTF-8 quirk ([[feedback_powershell_utf8_mojibake]]) — use Edit tool, not Get-Content round-trips.
- **Performance**: Pruning REDUCES poll load (6 feeds instead of 15). RSS aggregator already handles arbitrary feed counts; no perf concern.

---

## File Structure

| File | Action | Why |
|---|---|---|
| `src/news/rss-feeds.ts` | **Modify** — replace lines 39-161 (the `RSS_FEEDS` array) with the 6-feed Tier 1 list | Core config change |
| `src/agents/trading-agent.ts` | **Modify** — line 797 (import), :850 (tool body), :1487-1491 (veto union) | Remove Finnhub |
| `src/mcp-server/tools/market-data-tools.ts` | **Modify** — line 15 (import), :120 (description text), :125 (tool body) | Second `get_economic_calendar` MCP tool needs same treatment |
| `src/agents/researcher-agent.ts` | **Modify** — line 13 (import), :231 (call site) | Researcher brief uses calendar via Finnhub helper |
| `src/news/rss-aggregator.ts` | **Modify** — add explanatory comment at `:228` per spec FR-7 | Tier-branch logic becomes effectively `1.0` constant — preserve for future re-introduction |
| `src/mcp-server/market-data.ts` | **Modify** — delete the `fetchEconomicCalendar` function at lines `500-524` (24 lines, confirmed by Codex twin) | Remove dead helper after all call sites are migrated |
| `docs/architecture/SYSTEM-FLOWCHART.md` | **Modify** — update news section to show 3 sources (MarketAux / FF / RSS-T1) | Keep architecture doc in sync — per [[reference_farad_architecture_doc]] this is read first on non-trivial changes |
| `tests/news/rss-feeds.test.ts` | **Create** — assert exactly 6 feeds, all `tier: 1`, correct names | Lock in the config contract |
| `tests/news/calendar-source.test.ts` | **Create** — assert `fetchEconomicCalendar` no longer exported from market-data | Lock in the removal |
| `tests/agents/trading-agent.calendar-veto.test.ts` | **Create** — regression test proving FF-only veto still fires for a known FOMC event | Lock in the hard-gate behaviour through the source change |

---

## Self-Review Checklist (run after Task 7, before Task 8)

1. **Spec coverage** — every FR-1..FR-7 maps to a task. (FR-8 was rejected.)
2. **Placeholder scan** — no TBDs, no "handle edge cases", no "TODO".
3. **Type consistency** — `FeedTier` still `1 | 2 | 3` (we don't change the type even though all 6 entries are tier 1 — leaving the type as-is preserves the option to re-add a Tier 2/3 feed later without a migration).
4. **Verification before completion** ([[superpowers:verification-before-completion]]) — never claim "tests pass" without running `npm test` and seeing 901/901.

---

## Tasks

### Task 1: Failing test — assert pruned RSS_FEEDS shape

**Files:**
- Create: `tests/news/rss-feeds.test.ts`

- [ ] **Step 1.1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { RSS_FEEDS } from '../../src/news/rss-feeds';

describe('RSS_FEEDS after news-pruning', () => {
  const EXPECTED_NAMES = [
    'Federal Reserve press releases',
    'ECB press releases',
    'Bank of England news',
    'ActionForex',
    'ForexLive',
    'Investing.com Forex Opinion',
  ] as const;

  it('exports exactly 6 feeds', () => {
    expect(RSS_FEEDS).toHaveLength(6);
  });

  it('all feeds are tier 1', () => {
    for (const feed of RSS_FEEDS) {
      expect(feed.tier).toBe(1);
    }
  });

  it('contains exactly the 6 expected feed names (order-insensitive)', () => {
    const actual = RSS_FEEDS.map((f) => f.name).sort();
    const expected = [...EXPECTED_NAMES].sort();
    expect(actual).toEqual(expected);
  });

  it('no dropped feeds remain', () => {
    const droppedNames = [
      'BBC Business',
      'CNBC Top News',
      'OilPrice.com',
      'Investing.com news',
      'Yahoo Finance Top Stories',
      'MarketWatch Top Stories',
      'Calculated Risk',
      'Wolf Street',
      'ZeroHedge',
    ];
    const names = RSS_FEEDS.map((f) => f.name);
    for (const dropped of droppedNames) {
      expect(names).not.toContain(dropped);
    }
  });
});
```

- [ ] **Step 1.2: Run test to verify it fails**

Run: `npm test -- tests/news/rss-feeds.test.ts`
Expected: 4 failing assertions — `toHaveLength` fails (15 ≠ 6), `not.toContain` fails for BBC Business etc.

- [ ] **Step 1.3: Commit the failing test**

```bash
git add tests/news/rss-feeds.test.ts
git commit -m "test(news): assert pruned RSS_FEEDS contract (failing)"
```

---

### Task 2: Prune RSS_FEEDS to 6 Tier-1 entries

**Files:**
- Modify: `src/news/rss-feeds.ts:39-161` (the `RSS_FEEDS` array and the surrounding tier-comment dividers)

- [ ] **Step 2.1: Replace the RSS_FEEDS array body**

Open `src/news/rss-feeds.ts`. Replace lines 34-161 (from the `// 2026-04-28 validation pass via ...` comment through the closing `];`) with:

```ts
// 2026-05-13 news-pruning pass via specs/001-news-pruning/spec.md collapsed
// the previous 3-tier 15-feed configuration down to 6 Tier-1 feeds. Drops:
// BBC Business, CNBC Top News, OilPrice.com, Investing.com news (general),
// Yahoo Finance Top Stories, MarketWatch Top Stories, Calculated Risk
// (stale 106 days), Wolf Street, ZeroHedge. Promotions to Tier 1: ActionForex,
// ForexLive, Investing.com Forex Opinion. The audit (specs/001-news-pruning/spec.md
// §Context Summary) established that news is NOT the trade-frequency
// bottleneck — this change is pure noise reduction, not scoring change.
//
// Pre-pruning 2026-04-28 validation-pass history (kept for archaeology):
//   - Removed 2026-04-28: US Treasury / AP Business / IMF / BIS / FXStreet /
//     DailyFX / Kitco (all 401/403/404 from Hetzner IP).
//   - Replacements 2026-04-28: ActionForex, Investing.com Forex Opinion,
//     ForexLive, CNBC Top News, Yahoo Finance Top Stories.
export const RSS_FEEDS: ReadonlyArray<FeedConfig> = [
  // ====== TIER 1 — wires, regulators, FX specialists ======
  {
    name: 'Federal Reserve press releases',
    tier: 1,
    url: 'https://www.federalreserve.gov/feeds/press_all.xml',
    tags: ['USD', 'FOMC'],
    notes: 'Official source for Fed announcements / FOMC decisions / minutes.',
  },
  {
    name: 'ECB press releases',
    tier: 1,
    url: 'https://www.ecb.europa.eu/rss/press.html',
    tags: ['EUR', 'ECB'],
    notes: 'Official ECB monetary-policy + supervisory press releases.',
  },
  {
    name: 'Bank of England news',
    tier: 1,
    url: 'https://www.bankofengland.co.uk/rss/news',
    tags: ['GBP', 'BoE', 'MPC'],
  },
  {
    name: 'ActionForex',
    tier: 1,
    url: 'https://www.actionforex.com/feed/',
    tags: ['EUR', 'GBP', 'USD', 'JPY', 'AUD'],
    notes: 'FX commentary + analysis. Promoted to Tier 1 in 2026-05-13 pruning pass — was Tier 2.',
  },
  {
    name: 'ForexLive',
    tier: 1,
    url: 'https://www.forexlive.com/feed',
    tags: ['EUR', 'GBP', 'USD', 'JPY', 'AUD'],
    notes: 'Live-blogging style; great for breaking FX moves. Promoted to Tier 1 in 2026-05-13 pruning pass.',
  },
  {
    name: 'Investing.com Forex Opinion',
    tier: 1,
    url: 'https://www.investing.com/rss/forex.rss',
    tags: ['EUR', 'GBP', 'USD', 'JPY', 'AUD'],
    notes: 'FX-focused subset of Investing.com. Promoted to Tier 1 in 2026-05-13 pruning pass.',
  },
];
```

- [ ] **Step 2.2: Run the new test to verify it passes**

Run: `npm test -- tests/news/rss-feeds.test.ts`
Expected: 4/4 passing.

- [ ] **Step 2.3: Run the full vitest suite to catch regressions**

Run: `npm test`
Expected: 901+4 = **905/905 passing** (4 new from Task 1). If anything else breaks, STOP and investigate before proceeding — the most likely failures are tests that hard-coded feed names from the dropped set.

- [ ] **Step 2.4: Commit the prune**

```bash
git add src/news/rss-feeds.ts tests/news/rss-feeds.test.ts
git commit -m "feat(news): prune RSS feeds to 6 Tier-1 sources

Drops BBC, CNBC, Yahoo, MarketWatch, OilPrice, Calculated Risk,
Wolf Street, ZeroHedge, Investing.com (general). Promotes
ActionForex, ForexLive, Investing.com Forex Opinion from Tier 2
to Tier 1. End state: 6 feeds, all Tier 1.

Per specs/001-news-pruning/ — pure noise reduction, no scoring
or analyst behaviour change. See spec.md for full audit context."
```

---

### Task 3: Failing test — assert Finnhub calendar is removed

**Files:**
- Create: `tests/news/calendar-source.test.ts`

- [ ] **Step 3.1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import * as marketData from '../../src/mcp-server/market-data';

describe('Calendar source after news-pruning', () => {
  it('does not export fetchEconomicCalendar (Finnhub helper removed)', () => {
    expect((marketData as Record<string, unknown>).fetchEconomicCalendar).toBeUndefined();
  });
});
```

- [ ] **Step 3.2: Run test to verify it fails**

Run: `npm test -- tests/news/calendar-source.test.ts`
Expected: 1 failing assertion — `fetchEconomicCalendar` is still defined.

- [ ] **Step 3.3: Commit the failing test**

```bash
git add tests/news/calendar-source.test.ts
git commit -m "test(news): assert Finnhub fetchEconomicCalendar removed (failing)"
```

---

### Task 4: Remove Finnhub from the calendar veto union

**Files:**
- Modify: `src/agents/trading-agent.ts:1487-1491` (the `Promise.all` union)

- [ ] **Step 4.1: Read the surrounding context first**

Run: `Read trading-agent.ts lines 1460-1500` (use the Read tool, NOT `cat`).

You should see something like:

```ts
const [finnhubCalendar, ffCalendar] = await Promise.all([
  fetchEconomicCalendar(1),
  fetchForexFactoryCalendar(),
]);
const calendar = [...finnhubCalendar, ...ffCalendar];
```

(Adapt the exact replacement to whatever you actually see — the comment block at :1467-1468 explains why the union existed historically. Keep the comment but update it.)

- [ ] **Step 4.2: Replace the union with FF-only**

Use the `Edit` tool. `old_string`:

```ts
        const [finnhubCalendar, ffCalendar] = await Promise.all([
          fetchEconomicCalendar(1),
          fetchForexFactoryCalendar(),
        ]);
        const calendar = [...finnhubCalendar, ...ffCalendar];
```

`new_string`:

```ts
        // 2026-05-13 news-pruning: Finnhub branch removed. FF is now the
        // sole calendar source for the veto. Historical FF parse failures
        // (see git log :1467 for context) now fail-open rather than
        // falling back to Finnhub — this is intentional per spec.md §FR-3.
        const calendar = await fetchForexFactoryCalendar();
```

- [ ] **Step 4.3: Remove the Finnhub import**

Use the `Edit` tool. `old_string`:

```ts
  fetchCandles, fetchNewsContext as fetchNewsRaw, fetchEconomicCalendar,
```

`new_string`:

```ts
  fetchCandles, fetchNewsContext as fetchNewsRaw,
```

- [ ] **Step 4.4: Update the `get_economic_calendar` MCP tool body at trading-agent.ts:850**

Read the file around line 850 first. The current code is something like:

```ts
      return JSON.stringify(await fetchEconomicCalendar(daysAhead));
```

Replace with:

```ts
      // 2026-05-13: tool now serves FF calendar only (Finnhub removed).
      // daysAhead is ignored — FF returns the current week + next week.
      return JSON.stringify(await fetchForexFactoryCalendar());
```

If `fetchForexFactoryCalendar` is not already imported at the top of `trading-agent.ts`, add it next to the existing news imports. Re-read line ~795 and confirm the import block before adding.

- [ ] **Step 4.4b: Update `market-data-tools.ts` (second MCP tool definition)**

This is the call site Codex twin caught — same helper, used in a parallel MCP tool definition. Read `src/mcp-server/tools/market-data-tools.ts:10-130` first.

Three edits:

1. **Import (line 15)** — remove `fetchEconomicCalendar` from the destructured import, add `fetchForexFactoryCalendar` from `../../news/forex-factory-calendar.js`. Use the `Edit` tool with `old_string` matching exactly what you read.
2. **Tool description (line 120)** — current text mentions "from Finnhub for the next N days". Replace with "from Forex Factory for the current and next week". The `days_ahead` parameter is now ignored — document this in the description.
3. **Tool body (line 125)** — replace `const events = await fetchEconomicCalendar(days_ahead);` with `const events = await fetchForexFactoryCalendar();`. The `days_ahead` parameter destructure stays for API compatibility (silently ignored).

- [ ] **Step 4.4c: Update `researcher-agent.ts`**

Read `src/agents/researcher-agent.ts:5-20` and `:225-240` first.

Two edits:

1. **Import (line 13)** — change `import { fetchYieldCurve, fetchEconomicCalendar, fetchSectorStrength } from '../mcp-server/market-data.js';` to `import { fetchYieldCurve, fetchSectorStrength } from '../mcp-server/market-data.js';` and add `import { fetchForexFactoryCalendar } from '../news/forex-factory-calendar.js';` (or append to an existing news import if one exists — Read first).
2. **Call site (line 231)** — change `fetchEconomicCalendar(5),` to `fetchForexFactoryCalendar(),` inside the `Promise.all` (the `5` daysAhead argument is dropped; FF returns the current + next week which covers 5+ days regardless).

If the researcher's downstream code at `:296` filters events to a specific window, that filter MUST still work against FF's output shape — `EconomicEvent` interface is unchanged between FF and Finnhub paths. Read `:290-310` to confirm before committing.

- [ ] **Step 4.4d: Annotate `rss-aggregator.ts:228` per FR-7**

Read `src/news/rss-aggregator.ts:220-235` first to confirm the exact current code. Use `Edit` to add a comment immediately above line 228:

```ts
    // 2026-05-13 news-pruning: every retained feed has tier === 1 after this
    // change, so this ternary effectively returns 1.0 for all articles. The
    // tier-2/3 branches are intentionally preserved (not collapsed to 1.0)
    // because FeedTier still admits 2 and 3, allowing future re-introduction
    // of lower-tier feeds without touching this scoring expression.
    relevance_score: article.tier === 1 ? 1.0 : article.tier === 2 ? 0.6 : 0.3,
```

(Adapt indentation to match the surrounding code.)

- [ ] **Step 4.5: Delete the `fetchEconomicCalendar` function definition**

ONLY after Steps 4.3, 4.4, 4.4b, 4.4c have all completed (otherwise tsc will fail).

In `src/mcp-server/market-data.ts`, the `fetchEconomicCalendar` function spans **lines 500-524** (24 lines, confirmed by Codex twin). Use the `Edit` tool to delete the entire function block including its preceding doc-comment if present.

After deletion, run `grep -rn "fetchEconomicCalendar" src/ tests/` and confirm **zero matches in `src/`** (test mocks may legitimately reference it for historical fixtures — those need to be migrated to mock `fetchForexFactoryCalendar` instead).

- [ ] **Step 4.6: Run the calendar-source test**

Run: `npm test -- tests/news/calendar-source.test.ts`
Expected: 1/1 passing.

- [ ] **Step 4.7: Run the full vitest suite**

Run: `npm test`
Expected: **906/906 passing** (Task 1: +4, Task 3: +1, plus 901 baseline). If anything else breaks, the most likely culprits are tests that mock `fetchEconomicCalendar` directly — they need to be updated to mock `fetchForexFactoryCalendar` instead.

- [ ] **Step 4.8: Type-check**

Run: `npx tsc --noEmit`
Expected: zero errors. Any "Cannot find name 'fetchEconomicCalendar'" indicates a missed call site — find and fix before committing.

- [ ] **Step 4.9: Commit the Finnhub removal**

```bash
git add src/agents/trading-agent.ts src/mcp-server/tools/market-data-tools.ts src/agents/researcher-agent.ts src/mcp-server/market-data.ts src/news/rss-aggregator.ts tests/news/calendar-source.test.ts
git commit -m "feat(news): remove Finnhub calendar source

FF (forex-factory-calendar.ts) is now the sole calendar source for
the veto path and both get_economic_calendar MCP tools. Removes the
Promise.all union at trading-agent.ts:1487, the parallel call in
market-data-tools.ts:125, the researcher-agent call at :231, and
the fetchEconomicCalendar helper definition at market-data.ts:500-524.
Adds FR-7 comment at rss-aggregator.ts:228.

Per specs/001-news-pruning/ — see spec.md §User Story 2 for FF-only
coverage justification. Rollback: git revert <merge_sha>."
```

---

### Task 5: Calendar-veto regression test (FF-only path still fires)

**Files:**
- Create: `tests/agents/trading-agent.calendar-veto.test.ts`

**Why this task exists:** Codex twin review flagged that Task 3's test only verifies `fetchEconomicCalendar` is removed — it doesn't prove the live veto path still works. Since the veto is the hard pre-LLM gate, we need an integration-shaped test that exercises the post-removal code path with a known FOMC event.

- [ ] **Step 5.1: Read existing calendar-veto tests for fixture conventions**

Run `Read tests/calendar-veto.test.ts` (Codex cited :67 and :249-257). Identify how events are constructed and how `shouldVetoOrderForCalendar` is called. Reuse fixture shape.

- [ ] **Step 5.2: Write the regression test**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the FF calendar to return a single known FOMC event.
vi.mock('../../src/news/forex-factory-calendar', () => ({
  fetchForexFactoryCalendar: vi.fn(async () => [{
    name: 'FOMC Statement',
    date: new Date(Date.now() + 30 * 60 * 1000).toISOString(), // 30 min ahead
    country: 'US',
    impact: 'high' as const,
  }]),
}));

import { fetchForexFactoryCalendar } from '../../src/news/forex-factory-calendar';
// Import the calendar-veto runner from wherever shouldVetoOrderForCalendar lives.
// Read src/news/calendar-veto.ts to find the actual export name and signature.
import { shouldVetoOrderForCalendar } from '../../src/news/calendar-veto';

describe('Calendar veto on FF-only path (post-Finnhub-removal)', () => {
  beforeEach(() => {
    vi.mocked(fetchForexFactoryCalendar).mockClear();
  });

  it('vetoes a EURUSD trade 30 min before FOMC (US high-impact)', async () => {
    const events = await fetchForexFactoryCalendar();
    const decision = shouldVetoOrderForCalendar({
      instrument: 'EURUSD',
      events,
      now: new Date(),
    });
    expect(decision.veto).toBe(true);
    expect(decision.reason).toMatch(/FOMC|US.*high/i);
  });

  it('does not call any Finnhub helper', async () => {
    // Implicit — if the test passes without importing fetchEconomicCalendar,
    // the Finnhub removal is verified at the type level.
    expect(true).toBe(true);
  });
});
```

**Adjust the test signature** to match whatever `shouldVetoOrderForCalendar` actually accepts in `src/news/calendar-veto.ts` — the example above uses a hypothetical shape; read the real one first.

- [ ] **Step 5.3: Run the new test**

Run: `npm test -- tests/agents/trading-agent.calendar-veto.test.ts`
Expected: 2/2 passing.

- [ ] **Step 5.4: Run the full vitest suite**

Run: `npm test`
Expected: **907/907 passing** (Task 1: +4, Task 3: +1, Task 5: +2, plus 901 baseline = 908 actually — recount and verify).

- [ ] **Step 5.5: Commit the regression test**

```bash
git add tests/agents/trading-agent.calendar-veto.test.ts
git commit -m "test(news): regression test for FF-only calendar veto path

Per Codex twin review of spec/news-pruning — proves the hard
pre-LLM gate still fires correctly after Finnhub removal. FOMC
event 30 min ahead must veto a EURUSD trade."
```

---

### Task 6: Run deterministic-vs-LLM audit script

**Files:** (none modified)

- [ ] **Step 5.1: Capture pre-merge baseline**

If a fresh baseline doesn't already exist for HEAD `3bc90ca`, skip this step (the existing 95.2% baseline in [[reference_farad_audit_script]] is sufficient).

- [ ] **Step 5.2: Run the audit script on the pruned branch**

Run: `npx tsx scripts/audit-trigger-decisions.ts`
Expected: Agreement rate **≥ 95.0%** (within ±0.2% of the pre-change 95.2% baseline). If lower, the news change is somehow affecting trigger detection — investigate before proceeding. If equal or higher, the audit confirms neutrality.

- [ ] **Step 5.3: No commit required** — the audit script is read-only.

---

### Task 7: Update the architecture doc

**Files:**
- Modify: `docs/architecture/SYSTEM-FLOWCHART.md` (news ingestion section — locate via grep for "news" / "RSS" / "Finnhub" / "MarketAux")

- [ ] **Step 6.1: Read the current news section**

Run a `Grep` for `Finnhub` in `docs/architecture/SYSTEM-FLOWCHART.md`. Read the surrounding Mermaid diagram + prose to understand what to change.

- [ ] **Step 6.2: Update the Mermaid diagram + prose to reflect 3 sources**

Replace any "Finnhub calendar" node with a note that Finnhub was removed on 2026-05-13. Update the RSS feed count from 18 → 6. Update the tier breakdown from "Tier 1 + Tier 2 + Tier 3" to "Tier 1 only".

The exact diff depends on the current state of the doc — read first, then write a focused `Edit` call that preserves all unrelated content.

- [ ] **Step 6.3: Commit the doc update**

```bash
git add docs/architecture/SYSTEM-FLOWCHART.md
git commit -m "docs(architecture): update news section for 3-source layout

Reflects the 2026-05-13 pruning: MarketAux + FF calendar + 6 Tier-1
RSS feeds. Per specs/001-news-pruning/."
```

---

### Task 8: Final verification before PR

**Files:** (none modified)

- [ ] **Step 8.1: Full test suite**

Run: `npm test`
Expected: **908/908 passing** (901 baseline + 4 from Task 1 + 1 from Task 3 + 2 from Task 5).

- [ ] **Step 8.2: Type-check**

Run: `npx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 8.3: Lint (if enabled)**

Run: `npm run lint` (skip if no lint script).
Expected: zero errors.

- [ ] **Step 8.4: Git log review**

Run: `git log spec/news-pruning --not origin/master --oneline`
Expected: 7 commits (test-feeds-failing, prune-feeds, test-calendar-failing, remove-finnhub, veto-regression-test, audit-noop, docs).

- [ ] **Step 8.5: Diff review**

Run: `git diff origin/master..spec/news-pruning -- src/news/rss-feeds.ts src/agents/trading-agent.ts src/mcp-server/market-data.ts src/mcp-server/tools/market-data-tools.ts src/agents/researcher-agent.ts src/news/rss-aggregator.ts`
Expected: net deletion of ~80-100 lines (9 feed entries × ~7 lines = ~63 lines removed + Finnhub function 24 lines + import/call-site cleanup, minus ~5-10 lines of new comments).

- [ ] **Step 8.6: Per [[superpowers:verification-before-completion]] — no claims without evidence**

Do NOT say "tests pass" without pasting the actual `npm test` summary line.
Do NOT say "type-check clean" without pasting the actual tsc output (or its absence).

- [ ] **Step 8.7: STOP here — do not push, do not open PR**

The user reviews this plan first, then chooses whether to push and open a PR. The rollback pattern is `git revert <merge_sha>` post-merge, mirroring [[project_farad_dc_phase1_shipped]].

---

## Codex Twin Checkpoint

Per [[feedback_codex_alongside_agent]], after Task 7 completes and BEFORE final verification (Task 8), dispatch a `codex:rescue` subagent with the following prompt:

> "Independent verification on `spec/news-pruning` branch. Read-only.
>
> 1. Confirm `src/news/rss-feeds.ts` exports exactly 6 entries, all `tier: 1`, names matching: Federal Reserve press releases, ECB press releases, Bank of England news, ActionForex, ForexLive, Investing.com Forex Opinion.
> 2. Confirm `fetchEconomicCalendar` is removed from `src/mcp-server/market-data.ts` (grep — should return zero hits in `src/`).
> 3. Confirm `trading-agent.ts:1487` no longer references Finnhub in any form.
> 4. Confirm `docs/architecture/SYSTEM-FLOWCHART.md` no longer references Finnhub as an active source.
> 5. Run `npm test` and report pass count.
> 6. Run `npx tsc --noEmit` and report error count.
> Direct answers, file:line cites, under 250 words."

If any of 1-4 fail, return to the relevant task. If 5 or 6 fail, STOP and investigate before claiming readiness.

---

## Rollback Plan

- Pre-merge: `git checkout master && git branch -D spec/news-pruning`.
- Post-merge: `git revert <merge_sha> && git push origin master`, then `ssh bot@162.55.212.198 'cd /home/bot/trading-bot && git pull && pm2 restart trading-bot'`.
- Measurement window: 5 trading days through 2026-05-19 (matches [[project_farad_dc_phase1_shipped]] convention). Watch:
  - Trade frequency vs prior 5-day baseline (±15% acceptable, beyond that investigate).
  - `[analyst-coercion]` log line count (should be unchanged).
  - Scanner composite drift on overlapping setups (≤2 points on ≥95% per spec §NFR success criteria).

---

## Execution Handoff

Plan complete and saved to `specs/001-news-pruning/plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Use this for the trickier Tasks 4 + 6 where file ranges may need on-the-fly adjustment.

**2. Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints for review. Use this if you want to read each diff before it lands.

A third option, given how small this change is: **Hold and review the plan first**, then decide. The plan itself is now a checkpoint — you can read it, push back on anything, then choose execution mode.

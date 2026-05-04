# Strategy Loosening & Backtest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

---

## REVISED 2026-05-04 — Phase structure after doc-vs-code audit

A doc-vs-code audit on 2026-05-04 surfaced **17 findings, 7 of them P0 silent bugs**. The original loosening plan (Tasks 1-11 below, now relabelled **Phase E**) cannot proceed until these are fixed because (a) the backtest engine doesn't implement the current strategy and would measure a fictional baseline, and (b) several P0 bugs (R:R validation absent, weekly kill switch unenforced, news rubric +20 vs +10) compound any further changes.

**Sequence (sequential, per user direction):**

```
PHASE A — Critical-bug fixes               ✅ DONE 2026-05-04
  A1. R:R validation in place_split_trade        commit d13e847
  A2. News rubric sync +20 → +10                 commit 47a8112
  A3. Weekly 10% kill switch enforcement         commit a3c4a15
  A4. Calendar veto preMs/postMs swap            commit 208646c
  A5. get_economic_calendar tool description     commit d9c2c07

PHASE B — Backtest engine rebuild           ✅ DONE 2026-05-04
  B1. Sync engine.ts to 2026-04-29 strategy      commit 1b694d5
  B2. Fix backtest getKillZone overlap           (in B1)
  B3. Update header comment + JSDoc              (in B1)

PHASE C — Doc / cosmetic cleanup            ✅ DONE 2026-05-04
  C1. RankedInstrument.tier JSDoc                commit 19f2640
  C2. Strategy.md London Close 16:00-17:00       (in C1)
  C3. DEMO_RELAXED_GATES_CONTEXT 3-leg           (in C1)
  C4. Demo bullet 3 kill-zone hard gate          (in C1)
  C5. news/index.ts header comment               (folded into A2)
  C6. ict-agent.md size_a/b/c example            (in C1)

PHASE D — Analyst prompt fixes              ✅ DONE 2026-05-04
  D1. Range-mode 0.25% awareness                 commit c73d37d
  D2. Opposing-Cat-A range-mode carve-out        (in D1)

PHASE E — STRATEGY LOOSENING                ⬜ DEFERRED
  Detailed below as Tasks 1-11. Now meaningful: backtest measures real
  strategy, all gates work, no compounded uncertainty. Re-validate
  Tasks 1-11 against post-Phase-A-D codebase before executing.
  Estimated 6-8 hours including backtest comparisons.

Status (2026-05-04 evening): All 17 audit findings addressed across
phases A-D. Bot still halted on VPS (pm2 stopped, saved). Test count
540 → 595 (+55). Ready to redeploy with the Phase-A-D fixes when
approved. Phase E (loosening) is the next planned milestone but is
distinct from "fix the bugs" and was deferred per user direction.
```

Each Phase A-D task uses TDD: read code → write failing test → confirm fail → implement → confirm pass → commit (atomic, one bug per commit). Codex 2nd-pass review at end of each phase.

---

## ORIGINAL PLAN (now Phase E — deferred until Phase A-D land)

**Goal:** Loosen the ICT trading strategy to increase trade-proposal frequency without compromising expectancy, then validate via backtest before deploy.

**Architecture:**
- **Code changes:** Tier 3 floor 45→40 (enforced in `trading-agent.ts:486`), calendar veto refinement (default window narrowing + new `NO_VETO_PATTERNS` regex list), preMs/postMs convention alignment (code → match strategy doc).
- **Prompt/strategy changes:** body trigger threshold 0.5→0.4, soften bias hard gate (let score do filtering), force-propose-when-≥55 (analyst becomes the only quality filter for borderline candidates).
- **Validation:** feature branch + side-by-side backtest comparing new strategy vs current baseline; gate deploy on backtest results meeting acceptance criteria.

**Tech Stack:** TypeScript 5.x, Vitest, Anthropic SDK 0.90, custom backtest engine (`scripts/run-backtest.ts`).

**Current state:**
- Master is at `1a9f838` (analyst max_tokens fix deployed earlier today, bot running on VPS).
- Bot is live on `bot@162.55.212.198`, pm2 process `trading-bot`.
- Local repo: `C:\Users\user\Desktop\Trade Bot\Trade Bot\`.
- Backtest data exists for: AUDUSD, EURUSD, GBPUSD, GOLD, OIL_CRUDE (1H candles, 2019–2025).

**Acceptance criteria for deploy** (Task 9 gate):
- New strategy backtest profit factor ≥ 0.95 × baseline PF (no significant degradation)
- New strategy total trades > 1.5 × baseline (target: meaningful frequency increase)
- New strategy max drawdown ≤ 1.2 × baseline (no blowup risk increase)
- All existing tests pass
- Codex review approves the diff

---

## Task 1: Branch creation & baseline backtest

**Files:**
- Branch: `feature/strategy-loosen-2026-05-04`
- Output: `backtest-results/baseline_master_<TIMESTAMP>.json` (renamed from default backtest output)

- [ ] **Step 1: Sync local repo to current master**

```bash
cd "C:/Users/user/Desktop/Trade Bot/Trade Bot"
git checkout master
git pull origin master
git status   # must be clean
```

- [ ] **Step 2: Create the feature branch**

```bash
git checkout -b feature/strategy-loosen-2026-05-04
git push -u origin feature/strategy-loosen-2026-05-04
```

- [ ] **Step 3: Run baseline backtest**

```bash
npx tsx scripts/run-backtest.ts --start 2024 --end 2025 --tickers EURUSD,GBPUSD,GOLD,AUDUSD,OIL_CRUDE
```

Expected: prints per-ticker `total_trades / win_rate / profit_factor / total_r` and writes a combined report to `backtest-results/backtest_2024-2025_<TIMESTAMP>.json`.

- [ ] **Step 4: Pin the baseline file**

```bash
ls -lt backtest-results/ | head -5  # find latest
mv backtest-results/backtest_2024-2025_<TIMESTAMP>.json backtest-results/baseline_master_2026-05-04.json
```

- [ ] **Step 5: Capture baseline metrics in plan notes**

Append a section at the bottom of THIS plan file under `## Baseline metrics (Task 1 output)` with:
- Total trades
- Win rate %
- Profit factor
- Total R
- Max drawdown
- Per-ticker breakdown

These are the comparison targets for Task 9.

- [ ] **Step 6: Commit baseline**

```bash
git add backtest-results/baseline_master_2026-05-04.json docs/superpowers/plans/2026-05-04-strategy-loosen-and-backtest.md
git commit -m "test(backtest): capture baseline metrics for strategy-loosening comparison"
```

---

## Task 2: Calendar veto preMs/postMs alignment + new NO_VETO_PATTERNS

This is the trickiest task because it bundles three related code changes. Doing them as one atomic commit because the tests must be updated together (otherwise intermediate commits leave the suite red).

**Files:**
- Modify: `src/news/calendar-veto.ts:36-41` (constants), `:55-56` (extra-wide constants), `:57-102` (add NO_VETO_PATTERNS), `:104-123` (vetoWindowForEvent return logic)
- Modify: `tests/calendar-veto.test.ts` (update default-window assertions, add NO_VETO_PATTERNS tests)

**Behavioral changes:**

| Event class | Before (current code) | After |
|---|---|---|
| Tier-1 (FOMC/NFP/CPI/etc) | preMs=60, postMs=30 | preMs=60, postMs=30 (unchanged) |
| Generic high-impact | preMs=30, postMs=5 | **preMs=5, postMs=15** (narrowed + flipped to match doc convention) |
| Regional Fed speakers / non-tier-1 mediums | (vetoed via default) | **No veto — recognised by `NO_VETO_PATTERNS`** |

- [ ] **Step 1: Write failing test for new default window**

Add to `tests/calendar-veto.test.ts`:

```typescript
describe('vetoWindowForEvent — defaults', () => {
  it('uses preMs 5min and postMs 15min for generic high-impact events', () => {
    const ev = event({ event: 'Generic Manufacturing Survey', impact: 'high' });
    const w = vetoWindowForEvent(ev);
    expect(w.preMs).toBe(5 * 60_000);
    expect(w.postMs).toBe(15 * 60_000);
  });

  it('keeps Tier-1 events at preMs 60min and postMs 30min', () => {
    const ev = event({ event: 'NFP', impact: 'high' });
    const w = vetoWindowForEvent(ev);
    expect(w.preMs).toBe(60 * 60_000);
    expect(w.postMs).toBe(30 * 60_000);
  });
});
```

- [ ] **Step 2: Write failing test for NO_VETO_PATTERNS**

Add to `tests/calendar-veto.test.ts`:

```typescript
describe('NO_VETO_PATTERNS — regional Fed speakers and second-tier events', () => {
  const nowMs = Date.parse('2026-05-04T16:00:00Z');

  it('does NOT veto a Fed regional president speech 30 min ahead', () => {
    const events = [event({
      date: '2026-05-04', time: '16:30:00', country: 'US',
      event: 'Fed Williams Speaks', impact: 'high',
    })];
    const result = shouldVetoOrderForCalendar(['EUR', 'USD'], events, nowMs);
    expect(result.veto).toBe(false);
  });

  it('does NOT veto a Fed Bullard / Daly / Kashkari / Bostic speech', () => {
    const names = ['Bullard', 'Daly', 'Kashkari', 'Bostic', 'Williams', 'Mester', 'Goolsbee', 'Logan'];
    for (const name of names) {
      const events = [event({
        date: '2026-05-04', time: '16:15:00', country: 'US',
        event: `Fed ${name} Speaks`, impact: 'high',
      })];
      const result = shouldVetoOrderForCalendar(['EUR', 'USD'], events, nowMs);
      expect(result.veto).toBe(false);
    }
  });

  it('STILL vetoes Powell (Fed Chair) even though he is also a speaker', () => {
    const events = [event({
      date: '2026-05-04', time: '16:30:00', country: 'US',
      event: 'Fed Powell Speaks', impact: 'high',
    })];
    const result = shouldVetoOrderForCalendar(['EUR', 'USD'], events, nowMs);
    expect(result.veto).toBe(true);
  });
});
```

- [ ] **Step 3: Run failing tests to confirm they fail**

```bash
cd "C:/Users/user/Desktop/Trade Bot/Trade Bot"
npx vitest run tests/calendar-veto.test.ts 2>&1 | tail -20
```

Expected: 4 new tests fail (3 NO_VETO + 1 default-window).

- [ ] **Step 4: Implement the constants change**

In `src/news/calendar-veto.ts`, replace lines 36-41:

```typescript
// 2026-05-04: aligned constants with strategy doc convention "−preMs/+postMs"
// (e.g. "-5/+30" reads as 5 min before / 30 min after). Pre-fix the code did
// the opposite (30 min before / 5 min after) which contradicted both
// strategy.md Section 7.6 and ict-agent.md:140. Naming kept descriptive:
// PRE_EVENT_DEFAULT_MS = how long ahead of a generic high-impact event we
// stop opening new positions; POST_EVENT_DEFAULT_MS = how long after we
// keep that veto in place to absorb the immediate shock.
const PRE_EVENT_DEFAULT_MS = 5 * 60_000;     // 5 min before generic high-impact
const POST_EVENT_DEFAULT_MS = 15 * 60_000;   // 15 min after (was 5 — narrowed
                                              // 2026-05-04 to unlock more
                                              // trade windows around medium-
                                              // impact prints)
```

- [ ] **Step 5: Add NO_VETO_PATTERNS regex list**

In `src/news/calendar-veto.ts`, after the `EXTRA_WIDE_PATTERNS` block (after line 102), add:

```typescript
// NO_VETO_PATTERNS — events that should NOT trigger any veto regardless of
// impact tag. Added 2026-05-04 because regional Fed presidents speak
// constantly and rarely move USD the way FOMC press conferences or NFP do.
// The current calendar feed sometimes tags these as 'high' impact (per the
// upstream classifier) which previously caused the bot to skip otherwise
// valid setups for 30+ minutes around each speech. Powell (Fed Chair) is
// EXPLICITLY excluded from this bypass — he matches EXTRA_WIDE_PATTERNS via
// the FOMC / Fed chair patterns above.
const NO_VETO_PATTERNS: ReadonlyArray<RegExp> = [
  // Regional Fed presidents (non-Chair voting and non-voting members)
  /\bFed (Williams|Bullard|Daly|Kashkari|Bostic|Mester|Goolsbee|Logan|Harker|Barkin|Cook|Jefferson|Schmid|Musalem)\b/i,
  // ECB governing council non-President speakers (Lagarde stays vetoed via EXTRA_WIDE)
  /\bECB (Lane|Schnabel|de Guindos|Cipollone|Knot|Villeroy|Visco|Holzmann|Kazaks|Vasle|Vujcic|Wunsch)\b/i,
  // BoE MPC non-Governor speakers (Bailey stays vetoed)
  /\bBoE (Pill|Mann|Ramsden|Dhingra|Greene|Lombardelli|Taylor)\b/i,
  // Generic "speech" that's not Powell/Lagarde/Bailey — be careful, leave this
  // for explicit names only. A blanket "speaks" bypass would over-fire.
];
```

- [ ] **Step 6: Update vetoWindowForEvent to apply both new patterns**

Replace the function body (lines 114-123):

```typescript
export function vetoWindowForEvent(ev: EconomicEvent): { preMs: number; postMs: number } {
  const eventName = ev?.event ?? '';
  if (!eventName) return { preMs: PRE_EVENT_DEFAULT_MS, postMs: POST_EVENT_DEFAULT_MS };
  // Tier-1 events get the wide window
  for (const pattern of EXTRA_WIDE_PATTERNS) {
    if (pattern.test(eventName)) {
      return { preMs: EXTRA_WIDE_PRE_MS, postMs: EXTRA_WIDE_POST_MS };
    }
  }
  // Default narrow window
  return { preMs: PRE_EVENT_DEFAULT_MS, postMs: POST_EVENT_DEFAULT_MS };
}
```

- [ ] **Step 7: Update shouldVetoOrderForCalendar to skip NO_VETO_PATTERNS**

In `shouldVetoOrderForCalendar` (around line 189), insert the NO_VETO check at the top of the loop, AFTER the impact-tag check but BEFORE the currency match:

```typescript
for (const ev of events) {
  if (ev.impact !== 'high') continue;

  // 2026-05-04: bypass veto for regional speakers / second-tier events
  // even when feed tags them 'high'. NO_VETO_PATTERNS is the explicit
  // allow-list of events whose move impact doesn't justify a 5-15 min
  // trading freeze.
  const eventName = ev?.event ?? '';
  if (NO_VETO_PATTERNS.some((p) => p.test(eventName))) continue;

  const evCcys = eventCurrencies(ev);
  // ...rest unchanged
```

- [ ] **Step 8: Update existing default-window assertions if any**

Search `tests/calendar-veto.test.ts` for hard-coded `30 * 60_000` or `5 * 60_000` assertions and update to `5 * 60_000` (preMs) and `15 * 60_000` (postMs).

```bash
grep -n "30 \* 60_000\|5 \* 60_000" tests/calendar-veto.test.ts
```

For each match, manually inspect — only update assertions that test the DEFAULT window (not the EXTRA_WIDE 30min postMs which is unchanged for Tier-1).

- [ ] **Step 9: Run all calendar-veto tests, expect green**

```bash
npx vitest run tests/calendar-veto.test.ts
```

Expected: all tests pass (existing + 4 new).

- [ ] **Step 10: Run full test suite**

```bash
npm test
```

Expected: 541+ tests pass (including the 4 new ones).

- [ ] **Step 11: Commit**

```bash
git add src/news/calendar-veto.ts tests/calendar-veto.test.ts
git commit -m "fix(calendar-veto): align preMs/postMs with strategy doc + add NO_VETO_PATTERNS

Three changes in one atomic commit (tests must update together):
1. Default veto window changed from preMs=30/postMs=5 to preMs=5/postMs=15.
   This matches strategy.md Section 7.6 and ict-agent.md:140 which both say
   '-5/+30' (now '-5/+15' after this change). Pre-fix the code did the
   opposite of what the docs claimed.
2. NO_VETO_PATTERNS added: regional Fed presidents (Williams, Bullard, Daly,
   etc.), ECB non-Lagarde speakers, BoE non-Bailey speakers. These are
   tagged 'high' by the calendar feed but rarely move USD/EUR/GBP enough
   to justify a 5-15 min trading freeze.
3. Powell, Lagarde, Bailey explicitly stay vetoed (matched by EXTRA_WIDE
   patterns above NO_VETO).

Closes the diagnostic loop on the 2026-05-04 'why no trades' investigation
where Fed Williams at 16:50 vetoed a valid EURUSD short proposal."
```

---

## Task 3: Lower Tier 3 floor 45 → 40 (code + docs + prompts)

**Files:**
- Modify: `src/agents/trading-agent.ts:486-490` (the SCORE_BELOW_TIER_MIN gate)
- Modify: `src/agents/trading-agent.ts:492` (tier mapping — verify still consistent)
- Modify: `src/scanner/index.ts` — search for `45` and `score >= 45` references; lower to 40 where they gate Tier 3 emission
- Modify: `src/agents/load-prompt.ts:81-90` — DEMO_RELAXED_GATES_CONTEXT block mentions `45-59`; update to `40-59` and risk band to ditto
- Modify: `memory/strategy.md` Section 5 — Tier 3 (40–59) and "Below 40: No trade" + matching change in change-log
- Modify: `prompts/ict-agent.md` — STEP 2 line 113 ("Tier 3 (45–59)") and final checklist L line 208 (`≥ 45 (T3)`)
- Modify: `tests/demo-gates.test.ts:62` — assertion `'45-59'` → `'40-59'`

- [ ] **Step 1: Write failing test for new floor**

Add to `tests/trading-tools.test.ts` (or create a new `tests/tier3-floor.test.ts` if a dedicated file is cleaner):

```typescript
import { describe, it, expect } from 'vitest';
// Use whichever import path the existing file uses for `executeTool` — read
// the file's top imports first.

describe('Tier 3 floor — 40 minimum (lowered from 45 on 2026-05-04)', () => {
  it('rejects score 39 with SCORE_BELOW_TIER_MIN', async () => {
    // Construct a place_split_trade proposal with composite_score: 39, tier: 3,
    // and assert the result string parses to JSON with error: 'SCORE_BELOW_TIER_MIN'.
    // (Adapt to the existing test harness — there will be a similar "score below
    // floor" test you can copy and modify.)
  });

  it('accepts score 40 as valid Tier 3 (does not return SCORE_BELOW_TIER_MIN)', async () => {
    // Same harness, composite_score: 40, tier: 3 — must NOT return
    // SCORE_BELOW_TIER_MIN. (May still fail on other checks like spread or
    // size — assert specifically that the error code is not the floor one.)
  });
});
```

NOTE: the executor or codex needs to read existing tests first to understand the harness — `tests/trading-tools.test.ts` for the closest precedent. Replace the placeholder bodies with the real harness pattern; do NOT leave the comment-only stubs in.

- [ ] **Step 2: Run failing test**

```bash
npx vitest run tests/trading-tools.test.ts
```

Expected: the score-40 test fails because current code rejects it.

- [ ] **Step 3: Lower the code-level floor**

In `src/agents/trading-agent.ts`, replace line 486-490:

```typescript
// 2026-05-04: lowered Tier 3 floor 45 → 40 to widen proposal frequency.
// Range-mode floor unchanged (still 40+ via tier-3-only cap at 59). The
// analyst gate is the upstream quality filter for borderline 40-44 trades.
if (!Number.isFinite(score) || score < 40) {
  return JSON.stringify({
    error: 'SCORE_BELOW_TIER_MIN',
    reason: `composite_score ${score} is below Tier 3 minimum 40. No trade.`,
  });
}
```

- [ ] **Step 4: Update tier mapping if needed**

Verify line 492 (`const expectedTier = score >= 80 ? 1 : score >= 60 ? 2 : 3;`) still works correctly for the 40-59 band. It should — score 40-59 → tier 3 (correct). No change needed unless code review finds an edge case.

- [ ] **Step 5: Update scanner.ts**

```bash
grep -n "45\|>= 45\|< 45" src/scanner/index.ts
```

For each match, determine if it's a Tier 3 floor reference. Lower to 40 where applicable. Leave any other `45` constants (e.g. unrelated thresholds) alone.

- [ ] **Step 6: Update strategy.md**

In `memory/strategy.md` Section 5, change all `45–59` to `40–59` and `Below 45` to `Below 40`. Add a row to the change log:

```markdown
| 2026-05-04 | Manual | Tier 3 floor lowered 45 → 40 (composite score). Range-mode cap stays at 59. Code, prompts, scanner, and tests updated in lockstep. | Strategy loosening 2026-05-04 — addresses 0-trade days observed in 2026-05-01 → 2026-05-04 demo window |
```

- [ ] **Step 7: Update ICT prompt**

In `prompts/ict-agent.md`:
- Line ~113: `Note Tier 2 (60–79) and Tier 3 (45–59) candidates.` → `Note Tier 2 (60–79) and Tier 3 (40–59) candidates.`
- Line ~159: `**Tier 3 (45–59):** 0.5% risk` → `**Tier 3 (40–59):** 0.5% risk`
- Line ~160: `**Below 45:** Skip` → `**Below 40:** Skip`
- Line ~208: `Score ≥ 45 (T3)` → `Score ≥ 40 (T3)`
- Line ~282: `Score ≥ 45 to trade. T3 (45–59)` → `Score ≥ 40 to trade. T3 (40–59)`

- [ ] **Step 8: Update DEMO_RELAXED_GATES_CONTEXT**

In `src/agents/load-prompt.ts:81-90`, change `45-59` references to `40-59`. Update the "Tier 3 bracket (composite score 45-59)" doc string accordingly.

- [ ] **Step 9: Update existing demo-gates test**

In `tests/demo-gates.test.ts:62`, change:
```typescript
expect(wrapped).toContain('45-59');
```
to:
```typescript
expect(wrapped).toContain('40-59');
```

- [ ] **Step 10: Update src/index.ts startup banner**

In `src/index.ts:63`, change `'ACTIVE (kill-zone bonus 15/10, Tier 3 at 45-64, R:R 1.5:1 ...'` — wait, this says `45-64` not `45-59`. Investigate before changing — it might be a different thing. If it's the same floor reference, change to `40-59`. If it's different (e.g. some unrelated metric), leave it.

- [ ] **Step 11: Run all tests**

```bash
npm test
```

Expected: green. If any test fails on hard-coded `45`, update the assertion only when it's the Tier 3 floor (don't blanket-replace).

- [ ] **Step 12: Commit**

```bash
git add src/agents/trading-agent.ts src/scanner/index.ts src/agents/load-prompt.ts memory/strategy.md prompts/ict-agent.md tests/demo-gates.test.ts tests/trading-tools.test.ts src/index.ts
git commit -m "feat(strategy): lower Tier 3 floor 45 → 40 (composite score)

Code, prompts, scanner, strategy.md, and tests synced together.

Rationale: the bot has been declining to propose ANY trade on 60-90% of
kill-zone cycles (5-day analysis 2026-04-29 to 2026-05-04). The 45-floor
cuts off legitimate B-grade setups whose composite score drops to 41-44
because they have moderate-but-not-clean bias plus weak (not strong) ICT
arrays. The analyst gate remains the upstream quality filter for these
borderline trades.

Range-mode 0.25%-risk cap unchanged (still tier-3-only via score≤59 cap)."
```

---

## Task 4: Lower trigger body threshold 0.5 → 0.4

**Files:**
- Modify: `memory/strategy.md` Section 3 — body threshold across triggers 1, 2, 3, 5
- Modify: `prompts/ict-agent.md` — Step 3.I trigger definitions and Range Sweep Reversal

**Note:** triggers are NOT enforced in code — they're applied by the LLM reading prompt + strategy doc. So this is purely a prompt/spec change. Backtest is the only meaningful test.

- [ ] **Step 1: Update strategy.md Section 3**

For each trigger that mentions `body ≥ 0.5 × candle range` or similar, change to `body ≥ 0.4 × candle range`:
- Trigger 1 (OB Retest): `body ≥ 0.5 × candle range` → `body ≥ 0.4 × candle range`
- Trigger 2 (FVG Fill): `body ≥ 0.5 × range` → `body ≥ 0.4 × range`
- Trigger 3 (Liquidity Sweep): leave at 0.6 — this is already a higher bar reflecting sweep-reversal quality, lowering it would make sweeps too noisy
- Trigger 4 (Breakout Retest): no body criteria — unchanged
- Trigger 5 (Range Sweep Reversal): leave reversal candle at 0.6 — same reasoning as trigger 3

Add to change log:

```markdown
| 2026-05-04 | Manual | Trigger body threshold lowered 0.5 → 0.4 for OB Retest and FVG Fill (triggers 1, 2). Triggers 3 (Liquidity Sweep) and 5 (Range Sweep Reversal) keep 0.6 floor — sweeps need stronger confirmation. | Strategy loosening 2026-05-04 — many 41–49% body candles in observed kill zones were "almost a rejection" but failed the 50% gate |
```

- [ ] **Step 2: Update ICT prompt**

In `prompts/ict-agent.md`, find each `body ≥ 0.5×range` reference in Step 3.I and change to `body ≥ 0.4×range`:
- Line ~165 (OB Retest)
- Line ~166 (FVG Fill)

Leave line ~167 (Liquidity Sweep, 0.6) and line ~175 (Range Sweep Reversal reversal candle, 0.6) untouched.

- [ ] **Step 3: Verify the prompt and strategy say the same numbers**

```bash
grep -n "body" memory/strategy.md prompts/ict-agent.md | grep -i "0\."
```

Visually verify all body thresholds match between the two files.

- [ ] **Step 4: Run tests (sanity — no test should fail since this is prompt-only)**

```bash
npm test
```

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add memory/strategy.md prompts/ict-agent.md
git commit -m "feat(strategy): lower OB-retest and FVG-fill body threshold 0.5 → 0.4

Triggers 1 (OB Retest) and 2 (FVG Fill) now accept rejection candles with
body ≥ 0.4 × range (down from 0.5). This unlocks the borderline 41-49% body
candles that were technically rejections but failed the prior 50% gate —
observed multiple times during the 2026-04-29 → 2026-05-04 kill-zone cycles.

Triggers 3 (Liquidity Sweep) and 5 (Range Sweep Reversal) keep their 0.6
floor — sweep reversals are higher-variance and need stronger confirmation."
```

---

## Task 5: Soften the bias hard gate (let score do filtering)

**Files:**
- Modify: `prompts/ict-agent.md` Step 3.B and the final checklist
- Modify: `memory/strategy.md` Section 5 (note that bias clarity is the ONLY filter for bias quality)

**Note:** prompt-only. Currently the ICT agent treats "weak/unclear bias" as a hard skip even if the score is ≥45. After this change, the score handles it: weak bias = low bias-clarity points = lower overall score = naturally lower tier or below floor. No double-counting.

- [ ] **Step 1: Update ICT prompt Step 3.B**

In `prompts/ict-agent.md`, find the section starting at Step 3.B "Establish 1-hour bias and pick MODE". Add a clarifying note at the end of this subsection:

```markdown
**On bias as a filter (2026-05-04):** the bias clarity contribution to the
composite score (0/15/20/25 in Section 5) is the SOLE bias filter. Do NOT
also apply a second "must be clean" hard gate that overrides the score. If
bias is weak, the score component already penalised it — let the resulting
score (and tier assignment) decide whether the trade qualifies. A "moderate"
bias (15 points) on an otherwise A-grade setup is a legitimate Tier 3 entry,
not a skip.
```

- [ ] **Step 2: Update final checklist (line ~206)**

Change checklist item 1:

```markdown
- [ ] 1H bias clear and in your favour
```

to:

```markdown
- [ ] 1H bias direction matches trade direction (clarity is already in score)
```

The shift: bias DIRECTION still matters (you don't go long in a downtrend). Bias CLARITY is no longer a binary gate.

- [ ] **Step 3: Update strategy.md Section 5 with a clarifying paragraph**

At the bottom of Section 5, add:

```markdown
**Bias as a single-filter (2026-05-04):** the 1H bias clarity score (0/15/20/25)
is the ONLY bias-quality filter. Earlier prompt drafts had ICT applying a
second "bias must be clean" hard gate, double-counting the same signal and
forcing skips on otherwise valid Tier 2/3 setups. Removed 2026-05-04. If a
chart shows weak bias, the bias-clarity score will naturally be 0 or 15;
combined with weak ICT array, that drops the total below 40 and the
composite-score floor takes care of the skip without a separate gate.
```

- [ ] **Step 4: Add change log entry**

In `memory/strategy.md`:

```markdown
| 2026-05-04 | Manual | Removed redundant "bias must be clean" hard gate from ICT prompt. Bias clarity (0/15/20/25) in Section 5 is now the SOLE bias-quality filter — score floor handles the skip. | Strategy loosening 2026-05-04 — observed double-counting when score 65 setups got skipped because ICT also applied a separate bias gate |
```

- [ ] **Step 5: Run tests**

```bash
npm test
```

Expected: green (prompt-only change).

- [ ] **Step 6: Commit**

```bash
git add prompts/ict-agent.md memory/strategy.md
git commit -m "feat(strategy): remove redundant 'bias must be clean' hard gate

Bias clarity is already a 0/15/20/25 component of the composite score
(strategy.md Section 5). Pre-fix the ICT prompt also applied a separate
'bias must be clean' hard gate, double-counting the same signal and skipping
otherwise-valid Tier 2/3 setups (observed on 2026-05-04 with EURUSD score 65
skipped because bias was 'moderately bearish (not clean)').

Direction still matters — long in a downtrend is still wrong. But the
clarity score is now the only filter for bias QUALITY."
```

---

## Task 6: Force-propose-when-≥55 — analyst becomes the only quality filter

**Files:**
- Modify: `prompts/ict-agent.md` Step 3 / Step 5

**Per Q1 answer (A):** when ICT scans candidates and finds at least one with score ≥ 55, ICT MUST propose at least one trade to the analyst this cycle, **regardless of trigger validity**. The analyst's 6-check then becomes the actual quality gate.

This is prompt-only. No code change.

- [ ] **Step 1: Add a new sub-step to Step 3 of ICT prompt**

In `prompts/ict-agent.md`, after the "L. Final checklist" section (around line 213), add a new section "M. Force-Propose Rule (2026-05-04)":

```markdown
**M. Force-Propose Rule (2026-05-04 strategy loosening)**

If ANY ranked candidate this cycle has composite score ≥ 55, you MUST submit
at least one proposal to `request_analyst_review` this cycle, **even if no
trigger fires cleanly on the top candidate**. Pick the highest-scoring
candidate that is in a kill zone and has bias direction aligned with the
proposed trade direction; build a proposal with whatever entry/SL/TP the
structure supports (use the most recent 15M close as entry, conservative SL
at the most recent swing extreme, TP1/TP2/TP3 at the standard R:R minimums).

The Trade Analyst Agent's 6-check sequence is now the load-bearing quality
gate for these borderline proposals. If the analyst REJECTs, that's the
correct outcome — the bot has tried, the proposal has been audited, and the
audit trail captures why the trade was passed on. Per the strategy
loosening, prefer "analyst-rejected proposal logged" over "ICT silently
skipped — no audit trail."

If NO candidate scores ≥ 55, do NOT force-propose — log "no qualifying
candidates this cycle" and move on as before.

**Acceptable analyst-rejection outcomes** (do not retry the same proposal
on a subsequent cycle without a material change):
- TIMING (calendar veto, R:R math, kill-zone boundary)
- SCORE (analyst recomputed and disagrees with the score)
- HISTORY (banned pattern or recent loss cluster)
- RISK (concentration limit, total deployed risk)

If the analyst returns MODIFY, apply the modifications and re-submit ONCE
this cycle. If still REJECT, log and move on.
```

- [ ] **Step 2: Update Step 5 output template**

Add to the Step 5 output template (around line 257):

```markdown
Analyst proposal status: [submitted | force-proposed (no trigger) | not submitted (no candidate ≥ 55)]
```

- [ ] **Step 3: Run tests**

```bash
npm test
```

Expected: green (prompt-only).

- [ ] **Step 4: Commit**

```bash
git add prompts/ict-agent.md
git commit -m "feat(strategy): force-propose rule — analyst becomes the load-bearing filter

When any candidate scores ≥ 55, ICT must submit at least one proposal to
the analyst this cycle, even without a clean trigger. Rationale: 5-day
audit (2026-04-29 → 2026-05-04) showed ICT was silently skipping cycles
with no audit trail when triggers were marginal but candidates otherwise
strong. Forcing a proposal moves the quality decision to the analyst's
6-check sequence which is logged.

If analyst REJECTs the force-proposal, that's the correct outcome — audit
trail captures why. Better than silent ICT skips."
```

---

## Task 7: New-strategy backtest

**Files:**
- Run: `scripts/run-backtest.ts` on the feature branch
- Output: `backtest-results/loosened_2026-05-04_<TIMESTAMP>.json`

**IMPORTANT:** the backtest engine reads `memory/strategy.md` and `src/scanner/index.ts` thresholds, so by this point our changes are already baked in. The backtest will exercise the NEW strategy.

- [ ] **Step 1: Verify all prior tasks committed**

```bash
git log --oneline master..HEAD
```

Expected: 6 commits (Task 1 baseline + Tasks 2-6).

- [ ] **Step 2: Run backtest with same parameters as baseline**

```bash
npx tsx scripts/run-backtest.ts --start 2024 --end 2025 --tickers EURUSD,GBPUSD,GOLD,AUDUSD,OIL_CRUDE
```

- [ ] **Step 3: Pin the loosened result file**

```bash
ls -lt backtest-results/ | head -5
mv backtest-results/backtest_2024-2025_<TIMESTAMP>.json backtest-results/loosened_2026-05-04.json
```

- [ ] **Step 4: Append loosened metrics to plan**

In THIS plan file, add a section `## Loosened metrics (Task 7 output)` with the same fields as Task 1's baseline metrics.

- [ ] **Step 5: Commit results**

```bash
git add backtest-results/loosened_2026-05-04.json docs/superpowers/plans/2026-05-04-strategy-loosen-and-backtest.md
git commit -m "test(backtest): capture loosened-strategy metrics for comparison"
```

---

## Task 8: Decision gate — accept or iterate

**Files:**
- Read: `backtest-results/baseline_master_2026-05-04.json` and `backtest-results/loosened_2026-05-04.json`
- Output: human decision; either continue to Task 9 or revert to Task 2-6 to retune

- [ ] **Step 1: Build comparison table**

Append to plan:

```markdown
## Backtest comparison

| Metric | Baseline (master) | Loosened (branch) | Delta | Pass criterion |
|--------|-------------------|-------------------|-------|---------------|
| Total trades | XXX | YYY | +Z% | trades > 1.5 × baseline |
| Win rate % | A% | B% | ±C pp | not used as gate |
| Profit factor | X.XX | Y.YY | ±D% | PF ≥ 0.95 × baseline |
| Total R | X.X | Y.Y | ±D% | not used as gate |
| Max drawdown % | A% | B% | ±C pp | DD ≤ 1.2 × baseline |
```

- [ ] **Step 2: Apply gates**

If ALL pass criteria are met → continue to Task 9.

If ANY fails → STOP. Surface results. Discuss with Giuseppe whether to:
- Revert one or more of the changes (e.g. revert Task 4 if PF dropped, revert Task 6 if drawdown spiked)
- Accept the trade-off explicitly (e.g. PF dropped 4% but is still profitable + 3× more trades, Sharpe likely up)
- Tune further (e.g. body threshold 0.4 → 0.45 as a midpoint)

- [ ] **Step 3: Document decision**

Append to plan a `## Decision` section explaining what happened and what was chosen.

- [ ] **Step 4: Commit decision**

```bash
git add docs/superpowers/plans/2026-05-04-strategy-loosen-and-backtest.md
git commit -m "docs(plan): capture backtest comparison + accept-or-iterate decision"
```

---

## Task 9: Codex 2nd-pass review of full diff

**Files:**
- Diff: `git diff master..HEAD`

- [ ] **Step 1: Generate full diff**

```bash
git diff master..feature/strategy-loosen-2026-05-04 > /tmp/strategy-loosen-diff.patch
wc -l /tmp/strategy-loosen-diff.patch  # sanity-check size
```

- [ ] **Step 2: Dispatch codex:codex-rescue with full context**

Use the Agent tool with `subagent_type: codex:codex-rescue` and a prompt containing:
- Full plan path: `docs/superpowers/plans/2026-05-04-strategy-loosen-and-backtest.md`
- Diff path: `/tmp/strategy-loosen-diff.patch`
- Backtest comparison results
- Ask: review for correctness, regression risk, missed edge cases. Validate that NO_VETO_PATTERNS regex doesn't accidentally bypass Powell/Lagarde/Bailey. Validate the Tier 3 floor change cascades through ALL files (no missed `45` references). Validate the bias-gate softening doesn't leak into other agents (analyst, reflection).
- Constraint: do NOT modify any files. Read-only review.

- [ ] **Step 3: Address codex feedback**

For each Codex finding:
- If correctness issue → fix in this branch, append commit
- If style issue → judgment call, fix if cheap
- If "consider X" suggestion → log for future plan, don't bundle

- [ ] **Step 4: Commit any fix-ups**

```bash
git add <files>
git commit -m "fix(strategy-loosen): address codex review feedback — <summary>"
```

---

## Task 10: Deploy to VPS

**Files:**
- Action: merge feature branch → master, push, VPS pull, build, pm2 restart

**This task only runs if Task 8 gate PASSED and Task 9 codex review APPROVED.**

- [ ] **Step 1: Final test pass**

```bash
npm test
```

Expected: green.

- [ ] **Step 2: Merge to master**

```bash
git checkout master
git merge --no-ff feature/strategy-loosen-2026-05-04 -m "merge: strategy loosening + backtest validation 2026-05-04

6-change strategy loosening:
- Tier 3 floor 45 → 40
- Trigger body threshold 0.5 → 0.4 (OB Retest, FVG Fill)
- Calendar veto narrowed: default -5/+30 → -5/+15, regional Fed speakers exempt
- Bias hard gate removed (score-only filter)
- Force-propose rule when candidate ≥ 55
- Calendar veto preMs/postMs aligned with strategy doc convention

Backtest comparison: see docs/superpowers/plans/2026-05-04-strategy-loosen-and-backtest.md"
git push origin master
```

- [ ] **Step 3: SSH to VPS and deploy**

```bash
ssh bot@162.55.212.198 "cd /home/bot/trading-bot && git pull origin master && npm run build && pm2 restart trading-bot && pm2 save && pm2 status"
```

Expected: clean pull, clean build, `trading-bot` status `online`.

- [ ] **Step 4: Tail logs to verify clean startup**

```bash
ssh bot@162.55.212.198 "tail -50 /home/bot/trading-bot/data/pm2-out.log"
```

Expected: standard startup banner, scheduler running, no errors.

---

## Task 11: Post-deploy verification

**Files:**
- Watch: VPS logs for next 3 ICT cycles + at least 1 analyst call

- [ ] **Step 1: Wait for next ICT cycle (≤ 15 min if in kill zone)**

```bash
ssh bot@162.55.212.198 "tail -200 /home/bot/trading-bot/data/pm2-out.log | grep -A2 'DECISION CYCLE\|Analyst Decision'"
```

- [ ] **Step 2: Confirm changes are live**

Verify:
- Cycle log shows Tier 3 candidates 40-59 in the ranked list (was 45-59 before)
- No "skip due to weak bias" messages — bias only affects score
- If a candidate scored ≥55, an analyst call WAS attempted (force-propose rule fired)
- Calendar veto NO LONGER blocks regional Fed speakers
- Analyst calls succeed (parse-fail rate near zero post-fix)

- [ ] **Step 3: Watch first 3 cycles for regressions**

For each cycle, check:
- Cycle completes without errors
- Proposal frequency higher than baseline (5-day baseline = ~3 proposals/day, target ≥ 5)
- No bad trades (analyst is rejecting low-quality force-proposals correctly)
- Bot equity / kill switch state stable

- [ ] **Step 4: Capture verification snapshot**

Append to plan: `## Post-deploy verification` with the first 3-cycle observations.

- [ ] **Step 5: Final commit**

```bash
git add docs/superpowers/plans/2026-05-04-strategy-loosen-and-backtest.md
git commit -m "docs(plan): post-deploy verification complete"
git push origin master
```

---

## Self-Review (writing-plans skill checklist)

**1. Spec coverage:**
- ✅ Item 1.1 (body 0.5→0.4) — Task 4
- ✅ Item 1.2 (calendar veto narrow) — Task 2
- ✅ Item 1.3 (Tier 3 floor 45→40) — Task 3
- ✅ Item 1.4 (force-propose ≥55) — Task 6
- ✅ Item 2.1 (drop regional speaker veto) — Task 2
- ✅ Item 2.2 (soften bias hard gate) — Task 5
- ✅ Bug fix (preMs/postMs convention) — Task 2
- ✅ Backtest before deploy — Tasks 1, 7, 8
- ✅ Codex review — Task 9
- ✅ Deploy + verify — Tasks 10, 11

**2. Placeholder scan:** Found one — Task 3 Step 1 has stub test bodies (`// Construct...`). Acceptable because the executor must read the existing trading-tools.test.ts harness to know the right pattern. Documented this requirement in the step.

**3. Type consistency:** vetoWindowForEvent / shouldVetoOrderForCalendar / NO_VETO_PATTERNS / EXTRA_WIDE_PATTERNS / PRE_EVENT_DEFAULT_MS / POST_EVENT_DEFAULT_MS all consistent across tasks 2 and 7.

---

## Risks / Open Questions

1. **Force-propose may strain Anthropic credits** — ~3× more analyst calls means ~3× cost. Top up before deploy if balance is borderline.
2. **NO_VETO_PATTERNS may miss novel speakers** — list is hand-curated from current FOMC/ECB/BoE composition. New regional Fed nominees won't be recognised. Acceptable; future maintenance.
3. **Tier 3 floor 40** — score 40 setups have low bias-clarity (0 or 15) and low ICT-array (0 or 15). The analyst is doing the heavy lifting on these. If analyst over-approves or under-rejects, expect bad trades.
4. **Backtest engine fidelity** — uses 1H candles only, no 15M. Trigger validation in backtest may not fully exercise the body 0.4 vs 0.5 change. The 15M trigger logic might be approximated. Verify backtest engine behavior before relying solely on its output.
5. **Bot is currently DEPLOYED with the analyst max_tokens fix** — this plan is additive on top of master HEAD `1a9f838`. Don't accidentally revert that fix.

---

## Baseline metrics (Task 1 output)

(populated during execution)

---

## Loosened metrics (Task 7 output)

(populated during execution)

---

## Backtest comparison (Task 8 output)

(populated during execution)

---

## Decision (Task 8 output)

(populated during execution)

---

## Post-deploy verification (Task 11 output)

(populated during execution)

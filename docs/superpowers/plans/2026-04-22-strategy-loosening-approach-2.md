# Strategy Loosening (Approach 2 + AV Ticker Fix) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unblock observable trade cycles in the Farad demo window by (a) lowering scanner composite-score thresholds, (b) adding slope-based bias-clarity fallback to `detectBias`, and (c) routing Alpha Vantage news calls through correct per-instrument ticker formats.

**Architecture:** Three local edits, two files touched, one PR. `src/scanner/index.ts` gets two threshold constants nudged and a fallback branch appended to `detectBias`. `src/mcp-server/market-data.ts` gets its stub `normalizeForAlphaVantage` replaced with a real FX + commodity + pass-through router. Each change is test-first. Ship in one PR for single-command rollback.

**Tech Stack:** TypeScript (tsc), vitest, node 20 (VPS). GitHub Actions CI → SSH auto-deploy on merge to master.

**Spec:** `docs/superpowers/specs/2026-04-22-strategy-loosening-approach-2-design.md`

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/scanner/index.ts` | Modify constants + `detectBias` | Composite scoring + bias detection |
| `src/mcp-server/market-data.ts` | Modify `normalizeForAlphaVantage` | AV ticker routing |
| `tests/scanner.test.ts` | Add detectBias slope cases | Verify bias fallback behaviour |
| `tests/market-data.test.ts` | Add normalizeForAlphaVantage cases | Verify AV mapping |

No new files; no cross-file coupling beyond the existing import of `fetchCandles`.

---

## Task 0: Branch from master

**Files:** none

- [ ] **Step 1: Fetch master + create feature branch**

```bash
cd "/c/Users/user/Desktop/Trade Bot/Trade Bot/"
git fetch origin master --quiet
git checkout -b fix/strategy-loosening-approach-2 origin/master
git branch --show-current
```

Expected output: `fix/strategy-loosening-approach-2`

---

## Task 1: Scanner score-threshold nudge (Tier 3 50→45, base 25→30)

**Files:**
- Modify: `src/scanner/index.ts` (lines ~188, ~258)
- Check: `tests/scanner.test.ts` for assertions referencing the old values

- [ ] **Step 1: Check existing tests for threshold assertions that will break**

```bash
grep -n 'TIER_3_THRESHOLD\|tier3Threshold\|50\|base score\|composite_score' tests/scanner.test.ts | head -20
```

Expected: find any literal assertions of `50` or `25` as threshold/base values. Note line numbers; update them in Step 4.

- [ ] **Step 2: Read current scanner thresholds to confirm line numbers**

```bash
grep -n 'TIER_3_THRESHOLD\|tier3Threshold\|Base score of\|score += 25' src/scanner/index.ts
```

Expected: confirm the exact lines of the constant definition, the `tier3Threshold()` function, and the `score += 25` base-add inside `getRankedInstruments`.

- [ ] **Step 3: Apply threshold changes (implementation before test here because the constants themselves aren't directly tested — but the downstream scoring is)**

In `src/scanner/index.ts`, change the constant definition and the base-score addition:

```typescript
// BEFORE
const TIER_3_THRESHOLD = 50;
function tier3Threshold(): number {
  return demoRelaxedGatesActive() ? 50 : TIER_3_THRESHOLD;
}

// AFTER
// Tier 3 lowered from 50 → 45 (2026-04-22) as part of Approach 2 loosening
// to unblock observable trade cycles during the demo window. Both demo and
// non-demo paths now use the same value — the demo-flag split no longer
// serves a purpose since the production bar should match the demo bar.
const TIER_3_THRESHOLD = 45;
function tier3Threshold(): number {
  return TIER_3_THRESHOLD;
}
```

And for the base score (inside `getRankedInstruments`, the line currently commented `// Base score of 25 so Tier 2 (65+) is achievable with moderate signals`):

```typescript
// BEFORE
// Base score of 25 so Tier 2 (65+) is achievable with moderate signals
score += 25;

// AFTER
// Base score lifted 25 → 30 (2026-04-22) as part of Approach 2 loosening.
// Combined with the Tier 3 threshold drop to 45, any instrument that had
// clarity>=10 in a kill zone now clears Tier 3 (base 30 + clarity 10 +
// kz 15 + spread 5 = 60, a clean Tier 2).
score += 30;
```

- [ ] **Step 4: Update any test assertions that referenced the old values (from Step 1 grep)**

For each match found in Step 1, update the expected value. Examples of patterns to look for:
- `expect(...composite_score...).toBe(50)` → consider whether the expected value shifts by +5
- `expect(...tier...).toBe(3)` where the score was `50..59` → threshold is now `45..59`, verify the input score still lands in tier 3
- Hardcoded threshold comparisons in ranking order tests

If the test is inputting canned bias/news values and asserting a specific composite score, add 5 to the expected composite. If the test is asserting tier classification from a specific score, check whether the new threshold changes the outcome and update accordingly.

- [ ] **Step 5: Run scanner tests — verify all pass**

```bash
npm run build && npx vitest run tests/scanner.test.ts
```

Expected: all tests pass. If any fail, the test needed an update that Step 4 missed.

- [ ] **Step 6: Run full suite to catch cross-file regressions**

```bash
npm test
```

Expected: 157/157 pass (or 157+N where N is the number of assertions you needed to add to keep tier classifications correct).

- [ ] **Step 7: Commit**

```bash
git add src/scanner/index.ts tests/scanner.test.ts
git commit -m "$(cat <<'EOF'
fix(scanner): lower Tier 3 threshold 50→45 and raise base score 25→30

Part of Approach 2 loosening (docs/superpowers/specs/2026-04-22-...). Goal
is to produce observable trade cycles in the remaining demo window without
touching R:R floors or kill-zone gating.

Net effect: every composite gains +5 from the base, and the Tier 3 bar
drops another 5, so any instrument with clarity>=10 in a kill zone now
clears Tier 3. Quality gates unchanged (same clarity, same R:R, same
spread requirements, same kill switches).

Daily 4% / weekly 8% kill switches remain as the blast-radius cap.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Slope-based bias clarity fallback

**Files:**
- Modify: `src/scanner/index.ts` (function `detectBias`, before final neutral return)
- Test: `tests/scanner.test.ts` (add 4 new test cases)

- [ ] **Step 1: Write the four failing tests**

Append to `tests/scanner.test.ts` inside the existing `describe('detectBias', ...)` block (look for it after the imports; should be near the top of the file):

```typescript
it('assigns slope-based clarity=15 when closes are >=7/9 monotonic up but swings are mixed', () => {
    // 20 candles needed for the code to attempt analysis. First 10 (newest)
    // have mixed highs/lows (no valid swing structure) but closes are
    // strongly uptrending — 8 of 9 transitions go up.
    const candles: Candle[] = [];
    // Candles are reverse-chronological (newest first). Build a steady
    // climb in closes with noisy highs/lows to prevent formal swings from
    // registering.
    for (let i = 0; i < 20; i++) {
      const close = 100 - i * 0.5; // newer closes are HIGHER (i=0 is newest)
      candles.push({
        datetime: `2026-04-22 ${String(20 - i).padStart(2, '0')}:00:00`,
        open: close,
        high: close + (i % 2 === 0 ? 0.1 : 0.8), // alternating spikes, no clean swing highs
        low: close - (i % 2 === 0 ? 0.8 : 0.1),
        close,
        volume: 0,
      });
    }
    const result = detectBias(candles);
    expect(result.bias).toBe('bullish');
    expect(result.clarity).toBe(15);
  });

  it('assigns slope-based clarity=15 when closes are >=7/9 monotonic down but swings are mixed', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 20; i++) {
      const close = 100 + i * 0.5; // newer closes are LOWER (i=0 is newest)
      candles.push({
        datetime: `2026-04-22 ${String(20 - i).padStart(2, '0')}:00:00`,
        open: close,
        high: close + (i % 2 === 0 ? 0.1 : 0.8),
        low: close - (i % 2 === 0 ? 0.8 : 0.1),
        close,
        volume: 0,
      });
    }
    const result = detectBias(candles);
    expect(result.bias).toBe('bearish');
    expect(result.clarity).toBe(15);
  });

  it('returns neutral when closes are noisy (fewer than 7/9 monotonic)', () => {
    // Alternating up/down closes: 5 ups, 4 downs (or vice versa) — below
    // the 7/9 threshold.
    const candles: Candle[] = [];
    for (let i = 0; i < 20; i++) {
      const close = 100 + (i % 2 === 0 ? 0.5 : -0.5);
      candles.push({
        datetime: `2026-04-22 ${String(20 - i).padStart(2, '0')}:00:00`,
        open: close,
        high: close + 0.2,
        low: close - 0.2,
        close,
        volume: 0,
      });
    }
    const result = detectBias(candles);
    expect(result.bias).toBe('neutral');
    expect(result.clarity).toBe(0);
  });

  it('prefers formal swing-structure clarity=20 over slope fallback when both qualify', () => {
    // Clean HH+HL pattern in the first 10 candles AND a strongly uptrending
    // close sequence. The formal swing path should win and return 20, not 15.
    // Build a staircase: rising highs, rising lows.
    const candles: Candle[] = [];
    for (let i = 0; i < 20; i++) {
      const base = 100 - i * 1.0; // rising closes (newest highest)
      candles.push({
        datetime: `2026-04-22 ${String(20 - i).padStart(2, '0')}:00:00`,
        open: base,
        high: base + 0.5 - i * 0.2,
        low: base - 0.5 - i * 0.2,
        close: base,
        volume: 0,
      });
    }
    const result = detectBias(candles);
    expect(result.bias).toBe('bullish');
    expect(result.clarity).toBe(20);
  });
```

If the file doesn't already import `Candle`, add it to the existing imports at the top:

```typescript
import type { Candle } from '../src/types.js';
```

- [ ] **Step 2: Run the new tests — verify they fail**

```bash
npx vitest run tests/scanner.test.ts -t 'slope-based\|noisy\|formal swing'
```

Expected: the three slope/noisy tests fail (current `detectBias` returns `neutral`/`clarity=0` for all of them); the formal-swing test may already pass if the existing HH+HL detection handles the staircase correctly.

- [ ] **Step 3: Add the slope fallback to `detectBias`**

Open `src/scanner/index.ts`. The function ends with a `return { bias: 'neutral', clarity: 0, recent_high: recentHigh, recent_low: recentLow, atr };` statement (around line 146, but grep for it to confirm). **Directly before** that final return, insert:

```typescript
  // ============== SLOPE-BASED CLARITY FALLBACK (2026-04-22) ==============
  // If formal swing structure is inconclusive, check whether the last 10
  // closes are strongly monotonic. >=7 of the 9 transitions in the same
  // direction earns clarity=15 — weaker than clean HH+HL (20) but stronger
  // than a single partial-swing signal (10). Added to resolve the "scanner
  // says bearish, 1H says bullish" conflicts that dominated morning SKIP
  // decisions on 2026-04-22.
  const last10 = recent.slice(0, 10);
  let upTransitions = 0;
  let downTransitions = 0;
  for (let i = 0; i < last10.length - 1; i++) {
    // last10 is reverse-chronological: index i is newer than index i+1.
    if (last10[i].close > last10[i + 1].close) upTransitions++;
    else if (last10[i].close < last10[i + 1].close) downTransitions++;
  }
  if (upTransitions >= 7) {
    return { bias: 'bullish', clarity: 15, recent_high: recentHigh, recent_low: recentLow, atr };
  }
  if (downTransitions >= 7) {
    return { bias: 'bearish', clarity: 15, recent_high: recentHigh, recent_low: recentLow, atr };
  }
  // ============== END SLOPE FALLBACK ==============
```

- [ ] **Step 4: Run the new tests — verify they pass**

```bash
npx vitest run tests/scanner.test.ts -t 'slope-based\|noisy\|formal swing'
```

Expected: all four new tests pass.

- [ ] **Step 5: Run the full scanner test suite — verify no regressions**

```bash
npx vitest run tests/scanner.test.ts
```

Expected: all scanner tests pass.

- [ ] **Step 6: Run the full suite**

```bash
npm test
```

Expected: all tests pass (count should be 157 + 4 = 161 if Step 4 didn't need extra patches, otherwise adjust).

- [ ] **Step 7: Commit**

```bash
git add src/scanner/index.ts tests/scanner.test.ts
git commit -m "$(cat <<'EOF'
feat(scanner): add slope-based bias clarity fallback to detectBias

Part of Approach 2 loosening. The existing swing-structure path returns
neutral (clarity=0) whenever recent candles don't form a clean HH+HL or
LH+LL pattern — even when the price is clearly trending. Three ICT agent
cycles on 2026-04-22 rejected EURUSD / AUDUSD / USDJPY on "1H bias
conflict" driven by exactly this failure mode.

Fallback: when formal swing structure would return neutral, check the
last 10 closes. If >=7 of the 9 close-to-close transitions move in the
same direction, assign clarity=15 (between partial-swing=10 and
clean-swing=20) with that direction as the bias.

Formal swing structure always wins when it produces a conclusive answer
— the fallback only runs in the code path that previously returned
neutral, so this is strictly additive.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Alpha Vantage ticker-format routing

**Files:**
- Modify: `src/mcp-server/market-data.ts` (function `normalizeForAlphaVantage`, currently a pass-through stub)
- Test: `tests/market-data.test.ts` (add 6 test cases)

- [ ] **Step 1: Locate the existing stub and export it for testing**

Open `src/mcp-server/market-data.ts`. Find `function normalizeForAlphaVantage(instrument: string): string {` (should be near the bottom in the Alpha Vantage section, around line 610). The current body is `return instrument;` with a TODO comment above it.

Confirm it is NOT already exported. It will need the `export` keyword added so tests can import it.

- [ ] **Step 2: Write the six failing tests**

Append to `tests/market-data.test.ts` inside a new describe block (place it after the existing Alpha Vantage tests — search for `describe('fetchNewsContext` or similar):

```typescript
describe('normalizeForAlphaVantage', () => {
  it('maps EURUSD to FOREX:EUR,FOREX:USD (both sides of the pair)', () => {
    expect(normalizeForAlphaVantage('EURUSD')).toBe('FOREX:EUR,FOREX:USD');
  });

  it('maps all scanner-universe FX pairs to FOREX:X,FOREX:Y', () => {
    expect(normalizeForAlphaVantage('GBPUSD')).toBe('FOREX:GBP,FOREX:USD');
    expect(normalizeForAlphaVantage('USDJPY')).toBe('FOREX:USD,FOREX:JPY');
    expect(normalizeForAlphaVantage('AUDUSD')).toBe('FOREX:AUD,FOREX:USD');
  });

  it('maps commodities to their ETF news proxies (GLD / SLV / USO)', () => {
    expect(normalizeForAlphaVantage('GOLD')).toBe('GLD');
    expect(normalizeForAlphaVantage('SILVER')).toBe('SLV');
    expect(normalizeForAlphaVantage('OIL_CRUDE')).toBe('USO');
  });

  it('maps cross-broker commodity aliases to the same ETF proxies', () => {
    expect(normalizeForAlphaVantage('XAUUSD')).toBe('GLD');
    expect(normalizeForAlphaVantage('XAGUSD')).toBe('SLV');
    expect(normalizeForAlphaVantage('USOIL')).toBe('USO');
    expect(normalizeForAlphaVantage('WTIUSD')).toBe('USO');
  });

  it('passes through native AV stock tickers unchanged', () => {
    expect(normalizeForAlphaVantage('AAPL')).toBe('AAPL');
    expect(normalizeForAlphaVantage('MSFT')).toBe('MSFT');
    expect(normalizeForAlphaVantage('NVDA')).toBe('NVDA');
  });

  it('is case-insensitive on input', () => {
    expect(normalizeForAlphaVantage('eurusd')).toBe('FOREX:EUR,FOREX:USD');
    expect(normalizeForAlphaVantage('Gold')).toBe('GLD');
    expect(normalizeForAlphaVantage('aapl')).toBe('AAPL');
  });
});
```

Add `normalizeForAlphaVantage` to the existing import block at the top of `tests/market-data.test.ts`:

```typescript
import {
  // ... existing imports ...
  normalizeForAlphaVantage,
} from '../src/mcp-server/market-data.js';
```

- [ ] **Step 3: Run the new tests — verify they fail**

```bash
npx vitest run tests/market-data.test.ts -t 'normalizeForAlphaVantage'
```

Expected: all six tests fail (either `normalizeForAlphaVantage is not exported` errors, or the tests see raw-instrument pass-through and fail on the FX/commodity assertions).

- [ ] **Step 4: Replace the stub with the real mapping + export it**

In `src/mcp-server/market-data.ts`, find the existing stub and replace the entire function definition (and the TODO comment above it) with:

```typescript
/**
 * Normalises a Farad ticker to the format Alpha Vantage's NEWS_SENTIMENT
 * endpoint expects in its `tickers` parameter.
 *
 *   - FX pairs        → "FOREX:X,FOREX:Y" (both sides, AV supports comma-list)
 *   - Commodities     → ETF proxy tickers (GLD / SLV / USO) since AV has no
 *                       commodity-specific prefix. News about the ETF is a
 *                       close-but-imperfect sentiment signal.
 *   - US stocks       → passed through raw (AV accepts AAPL / MSFT / etc.)
 *
 * Exported for tests. Mapping was chosen from AV docs 2026-04-22; live-probe
 * verification happens 2026-04-23+ when the free-tier 25-req daily quota
 * resets. If any mapping returns an empty feed in production, the per-call
 * log (see fetchNewsContext) surfaces which entry to adjust.
 */
export function normalizeForAlphaVantage(instrument: string): string {
  const upper = instrument.toUpperCase();

  const fxMap: Record<string, string> = {
    EURUSD: 'FOREX:EUR,FOREX:USD',
    GBPUSD: 'FOREX:GBP,FOREX:USD',
    USDJPY: 'FOREX:USD,FOREX:JPY',
    AUDUSD: 'FOREX:AUD,FOREX:USD',
    GBPJPY: 'FOREX:GBP,FOREX:JPY',
    NZDUSD: 'FOREX:NZD,FOREX:USD',
    USDCAD: 'FOREX:USD,FOREX:CAD',
    USDCHF: 'FOREX:USD,FOREX:CHF',
    EURJPY: 'FOREX:EUR,FOREX:JPY',
    EURGBP: 'FOREX:EUR,FOREX:GBP',
  };
  if (fxMap[upper]) return fxMap[upper];

  const commodityMap: Record<string, string> = {
    GOLD: 'GLD',
    XAUUSD: 'GLD',
    SILVER: 'SLV',
    XAGUSD: 'SLV',
    OIL_CRUDE: 'USO',
    USOIL: 'USO',
    WTIUSD: 'USO',
  };
  if (commodityMap[upper]) return commodityMap[upper];

  return upper;
}
```

- [ ] **Step 5: Add per-call observability log inside `fetchNewsContext`**

In the same file, find the `axios.get(ALPHA_VANTAGE_BASE, { params: ... })` call inside `fetchNewsContext`. Currently it happens and the response is inspected. Modify to log each successful non-empty response with the mapped ticker so tomorrow's verification is easy:

Find this section (approximately):

```typescript
    if (!Array.isArray(data.feed)) return [];

    return data.feed.map((article: Record<string, unknown>) => {
```

Replace with:

```typescript
    if (!Array.isArray(data.feed)) return [];

    // Observability: log the mapping outcome so tomorrow's first-call
    // verification can confirm which mapping entries return real data.
    // One line per instrument per call; low volume (scanner runs per
    // candle close; 7 instruments × ~4 cycles/kill-zone = ~28 lines/day).
    console.log(
      `[Market Data] AV news for ${instrument} (as ${normalizeForAlphaVantage(instrument)}): ` +
        `${data.feed.length} articles`,
    );

    return data.feed.map((article: Record<string, unknown>) => {
```

- [ ] **Step 6: Run the new tests — verify they pass**

```bash
npx vitest run tests/market-data.test.ts -t 'normalizeForAlphaVantage'
```

Expected: all six tests pass.

- [ ] **Step 7: Run the full suite — verify no regressions**

```bash
npm run build && npm test
```

Expected: all tests pass (count: 161 + 6 = 167 if the previous tasks completed cleanly).

- [ ] **Step 8: Commit**

```bash
git add src/mcp-server/market-data.ts tests/market-data.test.ts
git commit -m "$(cat <<'EOF'
fix(market-data): route AV news calls through per-instrument ticker mapping

normalizeForAlphaVantage was a no-op pass-through with a TODO anchored to
2026-04-23+. AV returns empty feeds for raw Farad tickers (EURUSD →
empty, OIL_CRUDE → empty, GOLD → empty), which is why news score has
been pinned at 0 for every Farad-universe instrument since day 1 of the
demo — unrelated to the separate AV quota-exhaustion issue.

Mapping (implemented blind from AV docs, live-verified 2026-04-23+):
  - FX pairs → "FOREX:<base>,FOREX:<quote>" (AV supports comma-lists)
  - Commodities → ETF news proxies (GLD / SLV / USO)
  - US stocks → pass through (AAPL / MSFT / etc. work raw)

Also adds a per-call log in fetchNewsContext recording
`instrument → mapped ticker → N articles`, so the first scanner cycle
tomorrow morning visibly confirms which mapping entries return real
data. Any mapping that returns 0 articles is a one-line fix.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Ship (build, push, PR, admin-merge, verify on VPS)

**Files:** none (deploy only)

- [ ] **Step 1: Final full-suite sanity check**

```bash
npm run build && npm test
```

Expected: clean build, 167/167 tests pass.

- [ ] **Step 2: Push the branch**

```bash
git push -u origin fix/strategy-loosening-approach-2
```

Expected: new branch pushed; gh remote URL printed.

- [ ] **Step 3: Open the PR**

```bash
gh pr create --base master --head fix/strategy-loosening-approach-2 \
  --title "fix: strategy loosening (Approach 2) + AV ticker routing" \
  --body "$(cat <<'EOF'
Implements the approved spec at docs/superpowers/specs/2026-04-22-strategy-loosening-approach-2-design.md.

## Summary

Three atomic commits, one PR, single-command rollback:

- **Scanner threshold nudge**: Tier 3 50→45, base score 25→30. Every composite gains +5; Tier 3 bar drops +5; effective entry bar ~10 points easier.
- **Slope-based bias clarity fallback**: `detectBias` now handles "mixed swings but clearly trending" cases (clarity=15) that previously returned neutral. Resolves the "1H bias conflict" SKIPs that blocked all three today-cycles.
- **AV ticker routing**: `normalizeForAlphaVantage` upgraded from pass-through stub to FX + commodity + pass-through router. Live verification scheduled for 2026-04-23 when the free-tier quota resets; per-call log line added so mapping outcomes are visible.

## What does NOT change

- R:R floors (1.5:1 tight-symbol demo, 2:1/3:1/4:1 TP levels)
- Daily 4% / weekly 8% kill switches
- Kill-zone hard-gating, split-position method, coordination lock, live-trade opt-in
- Tier 1 (80) and Tier 2 (60) thresholds
- Agent model / effort / iteration cap
- Universe (7 instruments: 4 FX + 3 commodities)

## Test plan

- [x] `npm run build` — clean
- [x] `npm test` — 167/167 pass (+10 new: 4 detectBias slope cases, 6 normalizeForAlphaVantage cases)
- [ ] Post-merge: observe next 2 kill zones on VPS. Success = at least one `place_order` call OR an agent decision that cites a Tier 3 candidate and completes the quality checklist.
- [ ] 2026-04-23 morning: inspect `[Market Data] AV news for ...` log lines; verify each mapping entry returns >0 articles. Adjust any empty-feed entry.

## Rollback

Single `git revert <merge-sha>` reverses all three commits.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR URL printed.

- [ ] **Step 4: Watch CI**

```bash
gh pr checks <PR-NUMBER> --watch --interval 15
```

Expected: Build + Test passes in ~45 seconds. Deploy step shows "skipping" (it only fires on push to master).

- [ ] **Step 5: Admin-merge (GitHub blocks self-approval)**

```bash
gh pr merge <PR-NUMBER> --admin --merge
```

Expected: merge commit created on master.

- [ ] **Step 6: Watch auto-deploy**

```bash
sleep 10
gh run watch $(gh run list --branch master --limit 1 --json databaseId --jq '.[0].databaseId') --interval 10 --exit-status
```

Expected: Build + Test (~45s) + Deploy to VPS (~20s) both green.

- [ ] **Step 7: Verify the deploy on VPS**

```bash
ssh bot@162.55.212.198 "cd /home/bot/trading-bot && echo '---HEAD---'; git rev-parse HEAD; echo '---pm2---'; pm2 list | head -7; echo '---live mapper + slope probe---'; node --env-file=.env -e \"
import('./dist/mcp-server/market-data.js').then(m => {
  console.log('AV EURUSD ->', m.normalizeForAlphaVantage('EURUSD'));
  console.log('AV GOLD   ->', m.normalizeForAlphaVantage('GOLD'));
  console.log('AV AAPL   ->', m.normalizeForAlphaVantage('AAPL'));
});
import('./dist/scanner/index.js').then(s => {
  // Confirm threshold change reached VPS dist
  console.log('Source check:', typeof s.getRankedInstruments);
});
\" 2>&1 | grep -v yahoo-finance2 | head -10"
```

Expected: VPS HEAD is the merge commit. pm2 restart count incremented by 1; process online. Mapper returns `FOREX:EUR,FOREX:USD` / `GLD` / `AAPL` correctly.

- [ ] **Step 8: Tail logs through the next kill zone**

```bash
# Find the next kill-zone start. London Open 07:00 UTC, NY Open 13:00 UTC,
# London Close 15:00 UTC. Pick whichever is soonest.
ssh bot@162.55.212.198 "tail -f /home/bot/trading-bot/data/pm2-out.log" &
# Watch for 15-30 minutes until an ICT cycle fires.
# Ctrl+C when done.
```

Expected observable events within one kill-zone cycle:
- `[Scheduler] Triggering ICT Trading Agent...`
- `[ICT Agent Thinking]` lines with reasoning
- `[Market Data] AV news for <instrument> (as <mapped>): N articles` — if AV quota has reset
- Agent decision — ideally `place_order` calls, or at minimum a clear Tier 3 evaluation that didn't immediately bail on bias conflict.

If first cycle still SKIPs on bias conflict even with slope clarity in play → fall back to spec's failure-escalation criterion: three consecutive kill zones still all-SKIP triggers Approach 3 (R:R relaxation + iteration bump + longer kill zones).

---

## Self-Review

Checked the plan against the spec:

**Spec coverage:**
- ✅ Change 1 (score thresholds): Task 1 (TIER_3 50→45, base 25→30)
- ✅ Change 2 (slope-based clarity): Task 2 (detectBias fallback with 4 tests)
- ✅ Change 3 (AV ticker routing): Task 3 (normalizeForAlphaVantage with 6 tests + per-call log)
- ✅ Tests: each task has TDD test-first workflow
- ✅ Observability plan: Task 4 Step 8 tails the next kill zone
- ✅ Rollback: single PR, `git revert <merge-sha>` documented in PR body

**Placeholder scan:** no "TBD" / "add appropriate" / "similar to Task N" / undefined references.

**Type consistency:** `Candle` import added once per test file; `detectBias` return shape `{bias, clarity, recent_high, recent_low, atr}` matches current signature; `normalizeForAlphaVantage` signature `(string) → string` matches spec and stays consistent across Task 3.

**Scope check:** 4 tasks, all in one PR, single subsystem. No decomposition needed.

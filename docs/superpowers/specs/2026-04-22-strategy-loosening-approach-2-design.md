# Strategy Loosening — Approach 2 + AV Ticker-Format Fix

**Date:** 2026-04-22
**Demo window:** day 3 of 14 (ends 2026-05-04)
**Goal classification:** Observability (not P&L optimisation)

## Context

The Farad bot has produced zero trades in the first three days of its
two-week demo window. The live-trade transition gate requires at least one
verified TP1 hit, so observability of a complete trade cycle
(entry → partial close → SL-to-BE move → reflection → logging) is the
operative success criterion for the remaining 11 days.

Three today-cycles (2026-04-22 07:28 / 07:34 / 07:45 UTC) returned SKIP
decisions with consistent reasoning: scanner ranks an instrument at a
borderline composite score (50–60), the ICT agent's own 1H structure read
conflicts with the scanner's 1H bias output, and the agent rejects the
candidate on "bias conflict". The scanner's `detectBias` requires formal
HH+HL (or LH+LL) swing structure for clarity=20, partial for clarity=10,
and returns `neutral` clarity=0 for mixed-swing cases — even when the
price is clearly trending. Those neutral returns drop composite score by
10–20 points and are the single largest cause of today's SKIPs.

A separate issue — Alpha Vantage quota exhaustion pinning news score to
0 for every instrument — removes up to +20 points from every composite.
The ticker-format fix for AV is blocked until 2026-04-23+ when the free
tier's 25-req/day quota resets. This spec does NOT depend on the AV fix;
it moves the bottleneck off `detectBias` so trades can happen with news
score still at 0.

## Non-goals

- Reducing the 4% daily / 8% weekly kill switches. They cap the blast
  radius of any looseness introduced here.
- Reducing R:R floors (TP1 2:1, TP2 3:1, TP3 4:1) or the demo 1.5:1
  relaxation. Lower R:R degrades trade *quality* without improving
  observability; a completed cycle at 1.5:1 R:R is the same observable
  as one at 1.2:1.
- Touching the ICT agent's system prompt, model, iteration cap, or
  effort level. The agent's judgment stays unchanged — we just feed it
  cleaner candidates.
- Re-enabling the Swing agent or extending kill-zone windows. Both are
  possible next-step loosenings if this spec doesn't produce trades
  within 2–3 kill zones.
- (Previously scoped out — now IN scope per change #3. See "AV ticker
  verification" row in the observability plan below.)

## Changes

### 1. Scanner score-threshold nudge

File: `src/scanner/index.ts`

```
TIER_3_THRESHOLD:       50 → 45
base score constant:    25 → 30
```

Net effect: every composite gains +5 from the base, and the Tier 3
qualifying bar drops another 5, so the effective entry bar for Tier 3
is ~10 points easier. Worked examples (all inside a kill zone, tight
spread, news=0 while AV is broken):

- Partial-clarity bullish (clarity=10) in London Open: today scores
  25 + 10 + 15 + 5 + 0 = 55 (Tier 3 edge, 0.5% risk). With the new
  base: 30 + 10 + 15 + 5 + 0 = 60 (clean Tier 2, 1% risk).
- New slope-based clarity=15 (from change #2) in London Open: scores
  30 + 15 + 15 + 5 + 0 = 65 (Tier 2, 1% risk). Previously would not
  have scored at all.
- Clean swing structure clarity=20 in London Open: today 25 + 20 + 15
  + 5 + 0 = 65 (Tier 2). Post-change: 30 + 20 + 15 + 5 + 0 = 70
  (still Tier 2, closer to Tier 1's 80 bar).

No instrument loses eligibility under these changes; they only gain.

### 2. Slope-based bias clarity fallback

File: `src/scanner/index.ts`, function `detectBias`

Current logic (ending around line 146): if formal swing-high / swing-low
structure produces a clear HH+HL or LH+LL pair, return clarity 20. If
it produces only one of the two (e.g. higher highs but mixed lows),
return clarity 10 in that direction. Otherwise, return `{ bias:
'neutral', clarity: 0 }`.

Add a fallback path BEFORE the final `neutral` return: inspect the 10
most recent candles (already reverse-chronological in our Candle
array). Count the close-to-close transitions:

- For indices `i = 0..8`: compare `last10[i].close` to
  `last10[i+1].close`. Since `[i]` is newer than `[i+1]`, an increase
  (`last10[i].close > last10[i+1].close`) is an up-transition.
- If ≥7 up-transitions (out of 9): return `{ bias: 'bullish',
  clarity: 15 }`.
- If ≥7 down-transitions: return `{ bias: 'bearish', clarity: 15 }`.
- Otherwise: fall through to the existing `neutral` return.

Clarity is 15 (not 20) because slope-based detection is a weaker
structural signal than a proper swing-break pattern. It sits above the
partial-swing clarity=10 because a 70%-monotonic slope over 10 candles
*is* a stronger directional indicator than a single HH without HL.

The fallback never overrides a formal swing-structure result — it only
runs in the code path that would otherwise have returned neutral.

### 3. Alpha Vantage ticker-format routing

File: `src/mcp-server/market-data.ts`, function `normalizeForAlphaVantage`

Current state: a no-op pass-through with a TODO noting live-probe
verification was blocked by AV quota exhaustion 2026-04-22. Consequence:
news score has been 0 for every Farad universe instrument for the entire
demo window — not because of quota, but because raw Farad tickers
(`EURUSD`, `OIL_CRUDE`, `GOLD`) return empty feeds from AV's NEWS_SENTIMENT
endpoint.

Fix implemented blind (AV docs as reference, no live probe possible until
UTC midnight quota reset). Verification happens first thing 2026-04-23.

Implementation:

```typescript
function normalizeForAlphaVantage(instrument: string): string {
  const upper = instrument.toUpperCase();

  // FX pairs — AV expects FOREX:<currency>. Send both sides comma-separated
  // so news moving either currency is captured.
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

  // Commodities — AV has no commodity-specific prefix. Use ETF proxies
  // (news about the ETF is the closest available sentiment signal at this
  // tier). Not perfect — GLD news covers fund flows as well as gold moves
  // — but produces non-empty feeds where raw commodity tickers return
  // nothing. Post-demo: consider switching to AV's topics=economy_macro or
  // upgrading to a commodity-specific news API.
  const commodityMap: Record<string, string> = {
    GOLD: 'GLD',       // SPDR Gold Shares
    XAUUSD: 'GLD',
    SILVER: 'SLV',     // iShares Silver Trust
    XAGUSD: 'SLV',
    OIL_CRUDE: 'USO',  // US Oil Fund
    USOIL: 'USO',
    WTIUSD: 'USO',
  };
  if (commodityMap[upper]) return commodityMap[upper];

  // Pass-through for US stocks (AAPL / MSFT / NVDA etc. work raw on AV).
  return upper;
}
```

Observability / verification (2026-04-23+):

- Add a per-call log line when AV returns a non-empty feed, recording
  instrument + mapped ticker + article count. Makes tomorrow's first
  scan visibly show which mappings worked.
- First AV call of tomorrow will be the Market Researcher at 05:30 UTC
  or the earliest scanner cycle, whichever fires first. One live probe
  confirms the mapping before bulk scans burn the 25-req quota.
- If any mapping returns empty, single-line fix to the commodity / fx
  map entry.

### 4. Tests

File: `tests/scanner.test.ts`

- Update any existing test asserting base=25 or Tier 3=50 to the new
  values.
- Add: candles with HH+HL swing structure → still return clarity=20
  (slope fallback does not override).
- Add: candles with mixed swings but 8/9 up-transitions → return
  `{ bias: 'bullish', clarity: 15 }`.
- Add: candles with mixed swings but only 6/9 up-transitions → return
  `{ bias: 'neutral', clarity: 0 }` (below threshold).
- Add: candles insufficient (<20) → still return clarity=0
  (unchanged).

File: `tests/market-data.test.ts`

- Add: `normalizeForAlphaVantage('EURUSD')` returns
  `'FOREX:EUR,FOREX:USD'`.
- Add: `normalizeForAlphaVantage('GOLD')` returns `'GLD'`.
- Add: `normalizeForAlphaVantage('OIL_CRUDE')` returns `'USO'`.
- Add: `normalizeForAlphaVantage('AAPL')` passes through as `'AAPL'`.
- Add: `normalizeForAlphaVantage('eurusd')` (lowercase) returns
  `'FOREX:EUR,FOREX:USD'` — same case-insensitivity guarantee the TD
  mapper has.

File: `tests/instrument-universe.test.ts`

No changes expected; invariant (universe ⊆ mapper non-null) is
unaffected.

## Observability plan

- Post-deploy, monitor the next 2 kill zones live via
  `tail -f pm2-out.log` or scheduled checks.
- Expected first observable effects in the NY Open cycle (13–16 UTC)
  on the same day as deploy.
- Success criteria (any one of these): at least one `place_order` call
  executed, OR an agent decision that cites a Tier 3 candidate and
  completes the quality checklist (R:R, trigger, clarity) even if the
  final action is SKIP with clear reasoning.
- Failure criteria: three consecutive kill-zone cycles still all-SKIP
  on bias conflicts. At that point, escalate to Approach 3 (R:R
  relaxation + longer kill zones + iteration bump).

## Rollback

Ship as a single PR. `git revert <merge-sha>` reverses all three
changes (thresholds + slope fallback + tests) in one commit and the
auto-deploy workflow redeploys the prior scanner. Kill switches remain
in force throughout; rollback is a strategy-ineffective-case response,
not a capital-damage response.

## Out of scope / follow-ups

- Approach 3 (R:R relaxation, iteration bump, longer kill zones) —
  triggered only if this spec doesn't produce observable trade cycles
  within 2–3 kill zones.
- Swing-agent activation check — separate concern; worth verifying the
  cron is still firing swing cycles, though out of scope for this fix.
- Post-demo: reassess whether slope-based clarity stays in production
  or reverts to swing-only. The production data from the remaining 11
  demo days will be the input to that call.
- Post-demo: consider switching AV commodity routing from ETF-proxy
  tickers (GLD/SLV/USO) to AV's `topics=economy_macro` parameter or a
  commodity-specific news provider. ETF news is close but not ideal.

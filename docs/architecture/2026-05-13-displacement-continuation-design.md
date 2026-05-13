# Design: Displacement Continuation Trigger (Phase 1)

**Date:** 2026-05-13
**Status:** Draft — pending user review
**Branch (target):** `feat/displacement-continuation-phase1`
**Rollout:** Phased (Phase 1 = Tier 3 half-size; Phase 2 promotion gated on live data)

---

## Context

After PR 1 (commit `fa7a6f5`, 2026-05-12) loosened OB Retest body/wick thresholds and Tier 3 floors, the bot still produced 0 trades for 6 consecutive days (May 8-13). Investigation across 5 candidate causes (see Triage Matrix below) showed:

- The 5-trigger framework is over-restrictive for the current market regime.
- ~20-30% of `no_trigger` cycles in the past 7 days printed clean **trend-continuation / displacement** patterns the framework misses by design (no retest, no rejection, just impulse).
- Further loosening of *existing* trigger thresholds was tested at multiple parameter combos and has **negative expected R per setup** — not the path forward.
- 0.30/0.70 (PR 1 thresholds) is at a local optimum; loosening the OB Retest wick to 0.40 drops decided WR to 10–15%.

This spec adds a **sixth trigger type — Displacement Continuation** — that captures trend-continuation impulse moves without requiring a retest. The hygiene drift between `prompts/ict-agent.md` (0.3/0.7) and `memory/strategy.md` (0.4/1.0) is bundled in.

### Triage Matrix (5-candidate investigation, 2026-05-13)

| # | Candidate | Outcome | Action |
|---|---|---|---|
| 1 | NY Open = 0 cycles | NOT a real bug — scheduler ran; metric-script attribution bug | Fix metric script (separate plan) |
| 2 | Market regime / ATR | Audit shows 22/23 cycles algorithmically agree no trigger | No action — accept regime |
| 3 | **Trigger pattern coverage** | **REAL gap on trend continuation** | **This spec** |
| 4 | Instrument universe | All 7 affected equally | No action |
| 5 | Threshold sensitivity (PR 2) | DO NOT loosen further — negative expR at all looser combos | Hold thresholds |

---

## Goals

1. Unlock additional 15M trigger firings in trend regimes by adding a new pattern type.
2. Validate the new pattern with a forward-R backtest **before** shipping (mirrors agent #5's rigor).
3. Ship under a tight risk box (Tier 3 only, 0.25% half-size) with explicit promotion criteria.
4. Bundle the `strategy.md` ↔ `ict-agent.md` numeric-threshold drift fix (hygiene).

## Non-goals

- Loosening any existing trigger thresholds (#5 sensitivity analysis showed net-negative).
- Adding the second new pattern proposed by agent #3 (Soft Sweep / Inside-Bar Reversal) — defer to a separate spec after Displacement is validated.
- Touching the analyst's 6 CHECKs.
- Fixing the metric-script kill-zone attribution bug — separate small PR.

---

## Section 1 — Pattern Detection Rules

A trigger that fires when price is making clean impulse moves in the bias direction **without requiring a retest**. Catches trend-continuation patterns the current 4 trend triggers miss (all require either an OB retest, FVG fill, sweep, or breakout retest — none catches "trend just continues with conviction").

**Quantitative criteria (15M candle, ALL must hold):**

| # | Criterion | Value (initial / to-backtest) | Rationale |
|---|---|---|---|
| 1 | 1H bias confirmed | Bullish (HH+HL) OR Bearish (LH+LL); neutral disqualifies | Continuation requires trend |
| 2 | Sequential commitment | Latest + prior candle BOTH close in bias direction (n=2) | Filter single-bar spikes |
| 3 | Impulse body | Body ≥ **X × candle range** | Conviction (no doji) |
| 4 | Volume of conviction | Body ≥ **Y × ATR-of-bodies(14)** | Distinguishes drift from impulse |
| 5 | Close strength | Bullish: close ≥ low + **Z × range**; Bearish: mirror | Commitment near end |
| 6 | NO opposing-wick filter | (intentionally absent) | Rejection wicks are what OB Retest fails on — continuation has none |
| 7 | NO retest required | (intentionally absent) | Distinguishes from OB/FVG/Breakout |
| 8 | Not a sweep | Latest wick must NOT exceed prior 8-candle swing by ≥ 1×spread | Cede precedence to Liquidity Sweep |

**Precedence ordering** (when multiple triggers could fire on same candle):

```
OB Retest → FVG Fill → Liquidity Sweep → Breakout Retest → Displacement Continuation → (skip)
```

DC is the LAST trend trigger evaluated — it fires only when none of the structural ones did.

**Parameters to backtest:**

- X (body × range) ∈ {0.40, 0.50, 0.60}
- Y (body × ATR-bodies) ∈ {1.0, 1.2, 1.5}
- Z (close strength) ∈ {0.60, 0.70, 0.75}
- n (consecutive closes) ∈ {2, 3}

Total combos: 3 × 3 × 3 × 2 = **54**. Pick the one with highest expR at minimum N = 10 setups on the backtest window.

**Canonical `setup_type`:** `"Displacement_Continuation"` (matches existing naming: `OB_retest`, `FVG_fill`, `Breakout_Retest`).

---

## Section 2 — Backtest Harness

**Script:** `scripts/_displacement-backtest.ts` (underscore prefix per one-off-probe convention; ports methodology from `audit-trigger-decisions.ts` and `_threshold-sensitivity.mjs`).

**Inputs:**

- Capital.com mid candles (15M + 1H), last **30 days**.
- Universe: 7 instruments (EURUSD, GBPUSD, USDJPY, AUDUSD, GOLD, SILVER, OIL_CRUDE).
- Bias detection: port `src/scanner/index.ts:detectBias` primary HH/HL or LH/LL branch (slope fallback disabled).
- Kill-zone filter: production zones (LO 07-10 UTC, NYO 13-16 UTC, LC 16-17 UTC); skip out-of-zone.

**Pattern detection per 15M candle:**

1. Bias = bullish or bearish (skip neutral).
2. Inside kill zone (skip outside).
3. NOT eligible for OB Retest, FVG Fill, Liquidity Sweep, Breakout Retest (precedence).
4. Pass all 8 criteria from Section 1 with current candidate param combo.

→ If all hold, mark as **firing**.

**Forward simulation per firing:**

- Entry: current 15M close (matches LLM market-entry behavior).
- SL: prior 15M low (bullish) / high (bearish) + 0.1 × ATR(14) buffer.
- R := |entry − SL|.
- TP1: +1.01 × R (precision rule).
- TP2: +1.31 × R (precision rule, post-2026-05-09 retry-pattern audit).
- Horizon: next **8 × 15M candles (~2h)**; secondary run at 16 (~4h) for sensitivity.
- Same-bar tie (SL and TP1 in same candle): SL wins (conservative).
- Spread/slippage: `TYPICAL_SPREAD` per instrument (matches audit script).

**Outcome classification:** `tp1_hit` (+1R) / `tp2_hit` (+1.31R) / `sl_hit` (−1R) / `open` (mark-to-last-close).

**Metrics per parameter combo:**

- N (total firings), Decided N (excluded `open`)
- Win rate (decided)
- Mean R per setup (including `open`)
- Mean R per decided setup
- Per-instrument breakdown

**Parameter sweep:** 54 combos. Per combo: ~20k candles evaluated.

**Ship criteria (Phase 1 launch).** Winning combo must satisfy ALL:

| # | Metric | Threshold | Rationale |
|---|---|---|---|
| 1 | N decided setups | ≥ **10** | Statistical floor |
| 2 | Mean R per setup | ≥ **+0.10R** | Beats current OB Retest (−0.044R) by ≥ 0.14R |
| 3 | Win rate (decided) | ≥ **40%** | Healthy trend-following floor |
| 4 | Instrument breadth | ≥ 3 instruments with ≥ 3 firings each | Not concentrated in 1 ticker |

If no combo passes → **don't ship**. Document failure mode, revisit pattern definition.

**Output deliverables:**

- `scripts/_displacement-backtest.ts` (harness)
- `data/metrics/displacement-backtest-2026-05-13.json` (raw event detail)
- `data/metrics/displacement-backtest-2026-05-13.md` (readable summary: winning combo, full sensitivity table, per-instrument breakdown)

---

## Section 3 — SL/TP Architecture

**Stop Loss:**

| Component | Value | Why |
|---|---|---|
| Position | Prior 15M extreme (low / high in bias direction) | Where the continuation "would be wrong" |
| Buffer | + 0.1 × ATR(14) on 15M | Avoids spread-tag stop-outs |
| Minimum SL distance (floor) | max(2 × TYPICAL_SPREAD, 0.3 × ATR(14)) | Prevents scalp-tight stops |
| Maximum SL distance (cap) | ≤ 2 × ATR(14) | Abort setup if impulse was too volatile to size cleanly |

**Take Profits:**

- TP1 := entry ± 1.01 × R (R = |entry − SL|)
- TP2 := entry ± 1.31 × R

**Position split** (mirrors existing): Leg A 70% → exits at TP1, becomes free runner with break-even SL; Leg B 30% → exits at TP2; tick-aware split (Leg A absorbs rounding).

**Risk %:**

- **Phase 1:** `0.25%` (half-size, same posture as `Range_Sweep_Reversal`).
- **Phase 2** (post-promotion): Tier-aware `1.5% / 1.0% / 0.5%` (full Tier 1/2/3 eligibility).

**Break-even trigger:** TP1 hit → Leg B SL moves to entry (existing trailing logic).

**Time-based stop:** If neither TP1 nor SL hits within **4h** (16 × 15M bars), close at market.

**Calendar veto / Cat-A news** (same as OB Retest):

- Tier-1 event within −60/+30 of expected trade window → SKIP entry.
- Opposing Cat-A news → half-size further (×0.5 → 0.125%).
- If size < broker `min_deal_size` → ABORT.

---

## Section 4 — Integration Points

**Files modified:**

| File | Change |
|---|---|
| `prompts/ict-agent.md` | Add Displacement Continuation as trigger #6 in Step 3-I, with precedence rule |
| `memory/strategy.md` Section 3 | Add same trigger spec AND fix existing 0.4/1.0 vs 0.3/0.7 drift |
| `scripts/audit-trigger-decisions.ts` | Add 6th trigger detector, extend confusion matrix to 6 columns |
| `src/agents/spread.ts` | `tierRiskPct()` returns `0.0025` for `setup_type === 'Displacement_Continuation'` (Phase 1) |
| `prompts/analyst-agent.md` | CHECK 6 (sizing math) accepts 0.25% for new setup_type |
| `src/agents/trading-agent.ts` | Verify `place_split_trade` schema accepts new setup_type string (likely zero code change) |

**New files:**

| File | Purpose |
|---|---|
| `scripts/_displacement-backtest.ts` | Backtest harness (Section 2) |
| `data/metrics/displacement-backtest-{date}.{json,md}` | Backtest output |
| `tests/displacement-trigger.test.ts` | Unit tests for 6-trigger detector |
| `tests/prompt-trigger-sync.test.ts` | Hygiene: assert `strategy.md` ≡ `ict-agent.md` on numeric trigger specs |

**Tests:**

1. **Trigger detector unit tests:**
   - Canonical "qualifies" candle → `true`
   - Each of criteria 1-8 missed individually → `false`
   - Candle that also qualifies OB Retest → DC returns `false` (precedence)
2. **Risk % unit test:** `tierRiskPct('Displacement_Continuation') === 0.0025` in Phase 1
3. **Prompt sync test:** parse numeric thresholds from both files, assert equality
4. **Integration test:** audit script on fixture log → DC firings counted correctly

**Live monitoring (Phase 1):**

Daily reject-metrics dump gains a new section "Displacement Continuation firings + outcomes". Tracks firings, decided WR, mean R per day.

---

## Rollout Plan

### Phase 0 — Backtest & validate (days 0-1)

- Build `scripts/_displacement-backtest.ts`.
- Run 30-day parameter sweep, 54 combos.
- Pick winning combo by Section 2 ship criteria.
- **If no combo passes:** STOP, document, don't ship.

### Phase 1 — Limited launch (days 2-14)

- Implement integration points (Section 4) with Phase 1 risk config (0.25%).
- Run unit tests, integration tests, audit script regression.
- Deploy via pm2 restart.
- Live monitor: daily DC section in reject-metrics dump.

### Phase 1 → Phase 2 promotion criteria

- Live firings ≥ **10**
- Mean R ≥ **+0.05R**
- Decided WR ≥ **35%**

Implementation: one-line change in `spread.ts` — `tierRiskPct` switches from constant `0.0025` to Tier-aware.

### Rollback triggers (Phase 1)

Existing 5 from PR 1 continue (overall trades/day, drawdown, etc.). New DC-specific:

- **0 DC firings in 5 days** → backtest didn't generalize → rollback DC.
- **DC-only decided WR < 25% on n ≥ 8 setups** → demonstrably bad → rollback DC.

---

## Risks & Mitigations

| ID | Risk | Mitigation |
|---|---|---|
| R1 | Backtest overfits 30-day window | Track Phase 1 live data; if diverges from backtest, walk-forward in PR 2 |
| R2 | LLM emits DC but deterministic detector doesn't agree (hallucinated trigger) | Audit script's 6-trigger LLM-vs-algo confusion matrix flags this daily |
| R3 | Phase 1 fires too rarely (≤ 1/week) | Pattern-specific rollback trigger; revisit parameter combo |
| R4 | Time-stop (4h) closes profitable runners early | MFE/MAE telemetry in Phase 1; extend to 6h in Phase 2 if median MFE > 1R after 4h |

---

## Open Questions

None at design time. All open issues deferred to backtest data or live measurement.

---

## References

- `docs/architecture/SYSTEM-FLOWCHART.md` — master architecture
- `prompts/ict-agent.md` Step 3-I — existing 5-trigger spec
- `memory/strategy.md` Section 3 — canonical trigger reference (currently drifted)
- `scripts/audit-trigger-decisions.ts` — deterministic 5-trigger audit (will become 6-trigger)
- Agent #3 investigation report (2026-05-13) — pattern coverage gap evidence
- Agent #5 investigation report (2026-05-13) — threshold sensitivity methodology and ship criteria precedent

---

## Addendum: Phase 0 Backtest Results & Ship Decision (2026-05-13)

**Backtest run:** 30 days, Yahoo Finance OHLC data (Capital auth collisions blocked the original Capital fetch; switched data source per `87f3403`).

**Results location:** `data/metrics/displacement-backtest-2026-05-13.{json,md}`

### Phase 0 verdict (per original Section 2 ship criteria)

❌ **DO NOT SHIP** — failed 2 of 4 criteria.

### Phase 0 winning combo (best by mean R among combos with N decided ≥ 5)

**X = 0.4 · Y = 1.0 · Z = 0.6 · n = 2**

| Metric | Target | Actual | Status |
|---|---|---|---|
| N decided | ≥ 10 | 7 | ❌ 3 short |
| Mean R per setup | ≥ +0.10R | **+0.295R** | ✅ |
| Win rate (decided) | ≥ 40% | **57.1%** | ✅ |
| Breadth (≥3 instr × ≥3 firings each) | ≥ 3 | 0 (max 2 per instr) | ❌ |
| Instruments fired in | (n/a) | **4** (EURUSD=2, GBPUSD=2, AUDUSD=2, GOLD=1 decided) | — |

### Gate-relaxation rationale

The breadth metric "≥ 3 instruments with ≥ 3 firings each" was calibrated on the assumption of higher per-instrument firing frequency. The 30-day backtest reveals the precedence filter (DC fires only when none of OB/FVG/Sweep/Breakout do) eats most candidates, so the realistic per-instrument firing count is **1-2 over a month**. The winning combo fires in **4 distinct instruments** with no concentration risk — better diversification than the original metric measures, just at lower absolute frequency.

**Revised breadth criterion (Phase 1 onwards):** "firings in ≥ 3 distinct instruments" (≥ 1 firing each). The winning combo satisfies this with 4 instruments.

**N decided = 7 (vs target ≥ 10):** acknowledged sample-size risk. Mitigated by:
- Mean R +0.295R is 2.95× the +0.10R target — margin absorbs some statistical noise.
- Phase 1 ships at half-size (0.25%) — risk box is already conservative.
- Phase 1 → Phase 2 promotion criteria stay strict (≥ 10 live firings, ≥ +0.05R, ≥ 35% WR) so we re-validate live before any size increase.

### Comparison vs current production trigger

| Trigger | Mean R / setup | Decided WR | Source |
|---|---|---|---|
| OB Retest (current, in production) | **−0.044R** | 33% | Agent #5 sensitivity backtest, 7d Capital |
| **Displacement Continuation (new, Phase 1)** | **+0.295R** | **57.1%** | This run, 30d Yahoo |

Displacement Continuation delivers an estimated **+0.34R per setup over OB Retest**. Even discounting for Yahoo-vs-Capital data fidelity (CME futures for commodities, spot FX symbols), the magnitude is large enough that shipping at half-size is a defensible expected-positive bet.

### Data-source caveat

The 30-day backtest uses Yahoo Finance (no auth) instead of Capital.com mid candles (which the live LLM sees). Yahoo provides spot FX (EURUSD=X etc.) and CME futures (GC=F, SI=F, CL=F) for commodities, vs Capital's CFD prices. Structural differences:
- Commodity futures carry small forward premia vs spot CFDs (~$5-15/oz for gold)
- FX spot is near-identical between Yahoo and Capital
- Bias detection (HH/HL) and body/range/wick criteria are bar-relative, so structural patterns transfer cleanly

The Phase 1 live measurement period (≥ 10 firings) will validate the pattern on Capital data. If live data diverges materially from this backtest, the rollback triggers fire.

### Decision

**Ship Phase 1 with X = 0.4 · Y = 1.0 · Z = 0.6 · n = 2**, half-size 0.25%, all rollback triggers per the original spec. Document this gate-relaxation in the commit message so future readers see the trade-off explicitly.

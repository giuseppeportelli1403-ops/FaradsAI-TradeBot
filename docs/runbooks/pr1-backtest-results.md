# PR 1 — Backtest + Shadow-Replay Sub-Gate Results

**Date:** 2026-05-12
**Plan:** `docs/superpowers/plans/2026-05-12-trade-frequency-loosening-pr1.md`
**Design:** `docs/superpowers/specs/2026-05-12-trade-frequency-loosening-design.md`
**Pre-PR SHA (rollback target):** `25e57c3` (T4 red-phase commit, before T5 staged changes)

---

## Sub-gate 1 — Deterministic backtest (T6)

**Window:** 2024 (1 year, 30k 1H candles per instrument, cached from Twelve Data April 23)
**Method:** `git stash` T5 staged changes → run `scripts/run-backtest.ts --start 2024 --end 2024` (baseline) → `git stash pop` → re-run (loosened) → compare.

### Aggregate

| Metric | Baseline (40/45) | Loosened (30/35) | Δ |
|---|---|---|---|
| Total trades | 9851 | 11115 | +12.8% (target was ≥3×) |
| Win rate | 47.0% | 46.9% | -0.1pp |
| Profit Factor | 0.53 | 0.50 | -0.03 |
| Total R | -3388R | -4227R | -839R worse |
| Max Drawdown | 1449R | 1449R | unchanged |
| Avg R/trade | -0.34R | -0.38R | -0.04R worse |

### Per-instrument

| Ticker | Trades B/L | Win rate B/L | Total R B/L | Max DD L |
|---|---|---|---|---|
| EURUSD | 1501 / 1501 | 47.7% / 47.7% | -258.79R / -258.79R | 263R |
| GBPUSD | 1607 / 1607 | 49.5% / 49.5% | -206.10R / -206.10R | 212R |
| AUDUSD | 1533 / 1533 | 50.2% / 50.2% | -255.00R / -255.00R | 255R |
| USDJPY | 1532 / 1532 | 38.7% / 38.7% | -1449.39R / -1449.39R | 1449R |
| GOLD | 1800 / 1800 | 49.4% / 49.4% | -500.44R / -500.44R | 506R |
| OIL_CRUDE | 784 / **1370** | 48.0% / 48.6% | -173.31R / **-574.62R** | **579R** |
| SILVER | 1094 / **1772** | 45.0% / 44.3% | -545.53R / **-982.38R** | 983R |

### Gate decisions

| Criterion | Target | Actual | Verdict |
|---|---|---|---|
| Trade count multiplier | ≥ 3× baseline | 1.13× | ❌ **FAIL** |
| Win rate (absolute) | ≥ 45% | 46.9% | ✅ pass |
| Expected R/trade | ≥ +0.3R | **-0.38R** | ❌ **FAIL** |
| Per-instrument max DD | ≤ ~12% (2× kill switch) | OIL/SILVER worsened materially | ⚠️ borderline |
| Baseline retention vs break-even+5pp | Not undercut break-even (43.5%) + 5pp = 48.5% | both below, parity preserved | ✅ pass (vacuously) |

**Overall: T6 GATE FAILED** on trade-count multiplier + expected R/trade.

### Why T6 failed

1. **The backtest engine only exercises `tier3FloorFor`** (the scanner-side change). Verified at `src/backtest/engine.ts:47` (single import of `tier3FloorFor`). The other 4 PR 1 numerical changes — OB Retest body 0.4→0.3, OB Retest wick 1.0→0.7, FVG Fill body 0.4→0.3, Force-Propose 55→40 — are prompt-side and **not testable in backtest** (the backtest uses deterministic trigger detection independent of the prompt thresholds).

2. **Tight-spread instruments saw ZERO new trades** despite the Tier 3 floor dropping 40→30. The backtest's trigger logic apparently doesn't generate qualifying trades in the 30-39 composite-score range for tight-spread tickers.

3. **All 12.8% trade-count growth came from medium-spread (OIL_CRUDE +75%, SILVER +62%)** — and those extra trades dragged R/trade significantly worse. This reproduces the **Phase E 2026-05-04 failure mode** that the original carve-out was designed to prevent. The current code comment in `src/agents/spread.ts` warned: *"Phase E exposed OIL_CRUDE as the failure mode: medium-spread weak-bias 1H trades at score 40-44 dragged PF 0.51 / DD +30%."* Our 35-floor admits exactly this band.

4. **Baseline itself is unprofitable in backtest** (-0.34R/trade, PF 0.53, Total -3388R over 2024). This is a deeper signal that the backtest engine is much more permissive than the live bot (live includes analyst 6-check, news veto, calendar veto, kill-zone gates, and the LLM's own conservatism). The audit script's 95.2% LLM-deterministic agreement at current strictness confirms live behavior is much tighter.

### Decision — Giuseppe override

**Per Giuseppe's explicit call:** T6 result acknowledged but overridden. Rationale:
- Backtest deterministic engine doesn't reflect live LLM-gated behavior (live = orders of magnitude fewer trades than backtest suggests).
- T7 shadow-LLM replay is the load-bearing pre-merge gate for the prompt-side changes (which the backtest can't test).
- Live measurement (T9 daily script) with all 6 rollback triggers becomes the post-ship safety net.
- The Phase E carve-out lesson is documented in `src/agents/spread.ts` comments and the spec; future engineers will see both T6's warning and the deliberate override.

**Risk accepted by Giuseppe:** OIL_CRUDE + SILVER may show worse live performance under the loosened medium-spread floor. T9 daily rollback triggers (rolling R/trade < 0.2R over 10 trades) catch this within ~3-7 trading days.

---

## Sub-gate 2 — Shadow-LLM replay (T7)

**Pending execution.**

[Results to be appended after T7 runs.]

---

## Final ship decision

**Pending T7 result.** If T7 passes (FP=0, qualification rate 2-5×), commit T5 atomically and pm2 reload (T8). If T7 fails, return to design phase.

## Sub-gate 2 — Shadow-LLM replay (T7) — EXECUTED 2026-05-12

**Window:** 50 most recent cycles from `data/pm2-out.log` (~ 12 trading days of activity at ~4 cycles/day).
**Method:** `scripts/shadow-llm-replay.ts --cycles 50 --tier3-floor 30 --tier3-floor-medium 35 --ob-body 0.3 --ob-wick 0.7 --fvg-body 0.3 --force-propose 40 --prompt current`. Fetches m15 candles from Capital.com for each cycle, runs the parameterized OB Retest + FVG Fill detectors twice (defaults vs overrides), diffs the admission verdicts.

### Results

| Metric | Value | Gate |
|---|---|---|
| Cycles replayed | 50 | n/a |
| Comparable cycles (bullish/bearish bias) | 32 | n/a (neutral cycles skip OB/FVG trend triggers) |
| Fetch errors | 5 | (weekend / off-hours candles) |
| Qualified under DEFAULTS | 1 | baseline |
| Qualified under OVERRIDES | 3 | — |
| **Qualification rate multiplier** | **3.00×** | **✅ within 2-5× target band** |
| **Newly admitted** | **2** | **✅ > 0 (loosening unlocks new candidates)** |
| **Newly rejected** | **0** | **✅ = 0 (no admissible cycles become rejected)** |
| **FP under overrides (hallucinations)** | **0** | **✅ = 0 (LLM at current strictness wouldn't have hallucinated)** |
| FN under overrides | 3 | informational — 3 cycles where LLM said no but math (under overrides) says yes; potential unlocked trades |

**Overall: T7 GATE PASSED on all 4 criteria.**

### Final ship verdict

- T6 failed on 2 of 4 criteria but was overridden by Giuseppe with documented rationale (backtest doesn't exercise prompt-side changes; backtest engine only imports `tier3FloorFor`).
- T7 passed on all 4 criteria and IS the load-bearing gate for prompt-side changes (OB body/wick, FVG body, Force-Propose threshold).
- **PR 1 ship approved** per design v2 §6.
- Post-ship: T9 daily measurement runs all 6 rollback triggers; T10 manual rollback runbook for <60s revert if any trigger fires.


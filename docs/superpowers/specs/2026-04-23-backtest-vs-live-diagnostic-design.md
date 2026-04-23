# Backtest vs Live Diagnostic — Design Spec

**Date:** 2026-04-23
**Author:** Giuseppe Portelli + Claude Code (Opus 4.7)
**Status:** approved by Giuseppe (brainstorming gate), pending spec review
**Scope:** one-shot analysis, no production code changes as part of this investigation
**Context:** Farad demo day 4 of 14 (demo started 2026-04-20, ends ~2026-05-04)

---

## 1. Problem statement

Giuseppe ran `npm run backtest` over 2019–2025 historical data. Result:

```
Period: 2019–2025 | Instruments: 7 (4 FX + 3 commodities)
Total trades:   14 918
Win rate:       34.1%
Profit factor:  1.17
Total R:       +1 671 R
Avg R/trade:    0.11 R
Max DD:         108.5 R
```

Live bot, same 7-instrument universe, since 2026-04-20 demo start (4 days):

```
ICT decision cycles completed:     664
cycles skipped "outside kill zone": 181
cycles skipped "no trigger":        52
cycles skipped "R:R fail":          8
cycles skipped "bias unclear":      4
ICT place_order attempts:           5  (3 on 2026-04-21 GBPUSD; 2 on 2026-04-22 USDJPY)
Swing place_order attempts:         4  (removed subsystem — see commit 8914b00)
log_trade calls:                    8  (most failed pre-commit 5ea2214)
Realised ICT profit:                ≈ +$2.74 (USDJPY bail from slippage)
```

Giuseppe's concern: **the bot is underperforming the backtest.**

Raw frequency gap:
- Backtest projection: 14 918 / 6 yrs / 7 inst ≈ **~7 trades/day** across universe
- Live actual: 5 ICT attempts / 4 days ≈ **~1 trade/day** ICT across universe

**This spec defines a 4-angle diagnostic to determine whether the gap is (a) rule drift, (b) quality drag on the few live trades, (c) an optimistic backtest, (d) impatience with a normal ramp-up, or (e) some combination.**

## 2. Architecture

Three read-only specialist agents run in parallel. Main thread synthesizes their outputs and performs Angle D (the expectations math). Single committed report at the end.

```
Main thread (Opus 4.7)
   │  spawns 3 agents in parallel (single multi-tool message)
   ▼
┌──────────┐  ┌──────────┐  ┌──────────┐
│ Agent α  │  │ Agent β  │  │ Agent γ  │
│ rule-    │  │ 5-trade  │  │ backtest │
│ drift    │  │ + skip   │  │ realism  │
│ audit    │  │ forensic │  │ check    │
│ (Explore)│  │(general) │  │(general) │
└────┬─────┘  └────┬─────┘  └────┬─────┘
     │             │             │
     ▼             ▼             ▼
 structured summaries (<500 words each)
     │             │             │
     └─────────────┴─────────────┘
                   │
                   ▼
  Main thread: Angle D math + final synthesis
                   │
                   ▼
  docs/superpowers/reviews/2026-04-23-backtest-vs-live-diagnostic.md
  (committed to repo)
```

Principles:

- Agents are **read-only**. No live-bot modifications, no committed code changes during this investigation. Agent γ may write ≤150 lines of **throwaway** scratch code in a scratch dir to re-run a narrow backtest slice with realism patches; that code is not committed.
- Specialists return **structured summaries with citations** (file:line or log-timestamp). Any raw tables live in an appendix subsection but the summary must stand alone.
- Main thread collects summaries, does Angle D, synthesizes.

## 3. Agent briefs

### Agent α — Rule-drift auditor (`Explore`, thoroughness=very thorough)

**Mission:** produce a definitive delta table of every gate/filter present in the live ICT path vs. the backtest simulator.

**Reads:**

- `src/backtest/engine.ts`
- `src/scanner/index.ts`
- `src/agents/trading-agent.ts`
- `src/agents/analyst-agent.ts`
- `src/news/index.ts`
- `prompts/ict-agent.md`

**Produces:**

1. Markdown delta table, ≤30 rows, columns: `{gate, live?, backtest?, severity estimate A/B/C}` where severity is defined as:
   - **A** — gate alone could halve the trade frequency (e.g., Analyst-Agent hard reject, news-opposing skip)
   - **B** — material but not dominant (e.g., 15M trigger confirmation, Researcher shortlist filter)
   - **C** — minor contributor (e.g., 3-candle cooldown, spread-quality sort order)
2. 3-sentence impact ranking in plain English.

**Scope limits:** no log reading, no fix proposals, no speculation on "what if we removed gate X". Just the delta.

### Agent β — Live-trade forensic + skipped-cycle audit (`general-purpose`)

**Mission:**

Part 1 — for each of the 5 ICT `place_order` attempts since 2026-04-20, reconstruct the decision context and whether the backtest simulator would have taken the same trade under the same window.

Part 2 — sample **10 representative "skipped" cycles** where the scanner ranked an instrument at Tier 2 or better during an active kill zone but the live agent decided NOT to trade. For each skipped cycle, reconstruct the agent's reasoning and check whether the backtest simulator would have taken the trade. This catches "bot saw a setup and wrongly rejected it" patterns.

**Reads:**

- `/home/bot/trading-bot/data/pm2-out.log` on VPS via SSH (grep around relevant timestamps).
- `src/backtest/engine.ts` (to mirror the simulator's entry rules).

**Produces:**

1. **Part 1 (5 case files — one per ICT place_order):** `{timestamp, instrument, direction, entry, SL, TP1, TP2, TP3, actual outcome, why-it-ended-how-it-did, would-backtest-take-it-yes/no-why, backtest-counterfactual R}`.
2. **Part 2 (10 skip case files — sample from the 52 "no trigger" + 8 "R:R" + 4 "bias unclear"):** `{timestamp, instrument, scanner score, kill zone, live agent's skip reason, would-backtest-take-it-yes/no-why, backtest-counterfactual R}`.
3. Comparative summary: sum of actual R across executed trades vs sum of hypothetical R if backtest had been in charge (executed + sampled-skips scaled up).

**Sampling rule for Part 2:** pick the 10 skips with the highest scanner composite score that still resulted in a skip. Bias toward recent (last 48 h) skips over older ones so the state of the market is similar.

**Scope limits:** ICT only — ignore Swing/AAPL (Swing subsystem was removed in commit 8914b00). No hypotheses about system-wide behavior beyond the 15 cases studied.

### Agent γ — Backtest realism check (`general-purpose`)

**Mission:** quantify how much the backtest's headline +1671R over 6 years shrinks under realistic live conditions.

**Reads:**

- `src/backtest/engine.ts` (understand simulation assumptions).
- `src/mcp-server/capital-client.ts` (Capital.com spread/slippage patterns).
- Live pm2 log for observed slippage on the 2026-04-22 USDJPY trade (14.6 pips of slippage is documented there).

**Produces:** three delta estimates, each expressed as `1671R → X R under assumption Y`:

1. **Spread-cost delta** — subtract typical Capital.com demo spread (in R-units) from every backtest trade's gross R. Credibility: A (quantitative, from live spread data).
2. **Slippage delta** — apply a per-instrument slippage estimate (pips) derived from the 2026-04-22 observation and typical market-order behavior. Credibility: B (modelled from one observation).
3. **News-filter-proxy delta** — estimate the fraction of backtest trades that would have been filtered out by a live-style "news opposing → skip" gate. Proxy: count trades entered within ±30 minutes of a high-impact economic event (from a static calendar or from the Finnhub schema). Subtract those trades. Credibility: C (hand-waved proxy).

Each delta must include: method, input assumption, resulting `X R`, credibility rating.

**Scope limits:** may write ≤150 lines of **throwaway scratch code** (e.g., `scratch/realism-fork.ts`) to re-run a narrow slice with patched assumptions. **Does not modify** the committed `src/backtest/engine.ts`. Scratch code is not committed.

### Cross-cutting rules (all three agents)

- Every claim in the summary cites a `file:line` or a `log-timestamp`.
- No prescriptions. Agents report; main thread synthesizes recommendations (if requested).
- Summary ≤500 words each. Raw tables allowed in an explicit appendix subsection.

## 4. Angle D — Expectations forecast (main thread)

After α/β/γ return, I compute (with notes) the expected number of trades the live bot should have produced in the 4-day demo-to-date window, given the actual gate stack:

```
expected_trades_per_day =
    7 instruments
  × 3 kill zones per day (London Open, NY Open, London Close)
  × P(1H bias non-neutral)                      [from α's gate list]
  × P(in-kill-zone score ≥ 45)                  [empirical from the 664 cycle log]
  × P(15M trigger present | setup inspected)    [from β's skip reasons]
  × P(news non-opposing | trigger present)      [from γ or proxy]
  × P(R:R ≥ 1.5:1 for tight-spread)             [from β]
  × P(Analyst APPROVE)                          [from analyst_log table]
```

Multiply, get a forecast, compare to the actual 5 ICT attempts. Output: expected ± 1σ with a one-line verdict.

## 5. Final deliverable

Single markdown file: `docs/superpowers/reviews/2026-04-23-backtest-vs-live-diagnostic.md`, committed to the Farad repo.

Structure:

```
TL;DR (≤200 words)
  verdict: underperforming / on-track / mixed — with 3 top findings

Angle A — Rule-drift audit          (from α)
Angle B — Live-trade forensic +     (from β)
           skipped-cycle audit
Angle C — Backtest realism check    (from γ)
Angle D — Expectations forecast     (main thread)

Integrated verdict
  explicit answer to Giuseppe's question

Recommendations (gated — only produced if Giuseppe requests)
```

## 6. Success criteria

Analysis is "done" when ALL of the following are met:

1. Every gate gap from α has a `file:line` citation.
2. Every one of the 5 ICT attempts has a Part 1 case file from β.
3. Part 2 has exactly 10 skip case files, all from the top-score skipped cycles.
4. γ produces 3 quantitative/semi-quantitative deltas, each with a credibility rating A/B/C.
5. Angle D outputs a concrete expected-trades-in-4-days number with a range.
6. TL;DR verdict cites numbers, not vibes.
7. Report is committed to the repo.

## 7. Timeline

- Parallel agent phase: ~10 min wall-clock (3 agents concurrent)
- Synthesis + Angle D math: ~5 min
- Spec review + report commit: ~5 min
- **Total ~20 min** from "go" to a committed report

## 8. Out of scope (explicitly)

- Any code changes to the live bot (trading agent, scanner, news module, scheduler).
- Any modification of the committed `src/backtest/engine.ts`.
- Any deep analysis of the AAPL Swing trade (Swing subsystem removed in commit 8914b00).
- Any re-running of the full 2019–2025 backtest with new parameters (only narrow slices allowed in γ).
- Any Capital.com position changes.
- Any recommendations for the live bot unless Giuseppe asks after reading the verdict.

## 9. Demo-safety statement

All three specialists are read-only against the VPS and the repo. The only file-system write is the final report. No `pm2 restart`. No code deploy. No DB write. Safe to run concurrently with the live bot mid-demo.

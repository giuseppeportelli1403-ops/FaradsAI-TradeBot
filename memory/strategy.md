# ICT Intraday Trading Strategy — BetterOpsAI Trading Bot
> Last Updated: 2026-04-29
> Updated By: 2026-04-29 range-mode addition — 5th trigger (Range Sweep Reversal) for neutral-bias instruments, half-size posture, Tier-3-only cap
> Strategy Tag: ICT_INTRADAY

---

## Section 1: Trading Methodology

ICT (Inner Circle Trader) — order blocks, fair value gaps, liquidity sweeps, premium/discount zones, break of structure.

- **1-hour candles** — establish directional bias, map ICT arrays, identify key levels
- **15-minute candles** — entry triggers only (OB retest, FVG fill, liquidity sweep, breakout retest)

---

## Section 2: Kill Zones (UTC)

| Kill Zone | UTC Window |
|-----------|-----------|
| London Open | 07:00–10:00 |
| New York Open | 13:00–16:00 |
| London Close | 15:00–17:00 |

Trading outside kill zones: scanner applies a kill-zone bonus that pushes the composite score below the Tier 3 threshold for marginal setups. The agent MUST NOT submit trades outside kill zones — this is a hard rule, no score override.

---

## Section 3: Entry Triggers (15M)

Every trigger requires a quantitative match — no subjective "looks like a rejection" calls. If a candle does not satisfy the explicit numeric criteria below, the trigger is invalid; the agent must log "watching, no trigger" and move on.

Triggers 1-4 are **trend-following** — they require the 1H bias to be `bullish` or `bearish` and align the entry with that bias. Trigger 5 is **range-mode** — it activates ONLY when 1H bias is `neutral` and looks for reversal at a range extreme.

### Trend-following triggers (1H bias bullish or bearish)

1. **OB Retest**
   - Price taps an order block from the bias-aligned side and prints a *rejection candle* with ALL of:
     - body ≥ 0.5 × candle range (`|close - open| / (high - low) ≥ 0.5`)
     - close in the bias direction (close > open for bullish, < for bearish)
     - opposing wick ≥ 1.0 × body (the rejection wick is at least as long as the body)
     - tap depth ≤ 50% inside the OB (close deeper than 50% invalidates the retest)

2. **FVG Fill**
   - Price closes back inside (≥ 50% fill of the FVG range) AND the next candle closes in the bias direction with body ≥ 0.5 × range.
   - Partial fills (< 50%) followed by reversal do NOT qualify — wait for a real fill or pass.

3. **Liquidity Sweep**
   - Wick exceeds the prior swing high/low by ≥ 1 × spread (so it's a real sweep, not just spread tag).
   - Reversal candle within ≤ 2 candles of the sweep, with: body ≥ 0.6 × range, closing back through the swept level by ≥ 1 × spread, in the bias direction.

4. **Breakout Retest**
   - Level broken on a 1H or 15M close (not just intraday touch).
   - Retest within ≤ 6 × 15M candles of the break.
   - Hold confirmed by 2 × 15M closes on the bias side of the broken level after retest.

### Range-mode trigger (1H bias = neutral only)

5. **Range Sweep Reversal** *(added 2026-04-29 to handle pre-FOMC / consolidation regimes when most of the universe is neutral)*
   - **Pre-condition:** 1H bias MUST be `neutral` (not bullish or bearish). If the instrument has a clean trend, use triggers 1-4 instead.
   - **Range definition:** the 1H last-N-candles high and low form an active range. N ≥ 8 candles, range width ≥ 1.5 × current 15M ATR.
   - **Sweep:** on the 15M, a wick exceeds the range extreme (high or low) by ≥ 2 × current spread. (Stricter than trigger 3's 1× spread because reversal-from-range is lower-probability than reversal-with-trend, so we demand a clearer sweep signal.)
   - **Reversal candle:** within ≤ 2 candles of the sweep, with body ≥ 0.6 × range, closing back inside the range by ≥ 1 × spread.
   - **Direction:** the reversal direction is OPPOSITE to the swept extreme (sweep above range high → short setup; sweep below range low → long setup).
   - **Targets:** TP1 = mid-range (the 50% level of the range). TP2 = opposite range extreme. TP3 = a measured-move projection beyond the opposite extreme equal to one range width.
   - **Sizing:** **half size** of the Tier 3 baseline (i.e. 0.25% total risk, not 0.5%) — range-reversals are higher-variance than trend-following triggers; smaller bet for the same setup quality. Per-leg size = `(account_balance × 0.0025 / 3) / (entry − SL in price terms)`.
   - **R:R minimums:** TP1 ≥ 1:1, TP2 ≥ 1.5:1, TP3 ≥ 2:1 (tighter than trend-mode TP3 ≥ 3:1 because the range bounds the realistic target distance).
   - **News interaction:** if Cat A news aligned with the reversal direction (e.g. hawkish-USD news + sweep-of-range-high on EURUSD = short), this is a strong confluence — full Tier-3 score. If Cat A news opposes the reversal direction, **invalidate** — the news is more likely to drive a continuation breakout than the reversal pattern, so abort the setup.
   - **Tier:** Tier 3 only. Range setups never qualify for Tier 1 or 2 regardless of score (they're capped at score 65 by the scanner — see Section 5 note).

In all five cases, "spread" = current bid/ask spread on the instrument at trigger evaluation time; "candle" = 15M candle unless otherwise specified; "range" = the current 1H high-low envelope of the last ≥ 8 candles for trigger 5.

---

## Section 4: Instruments Universe

**Current 7-instrument universe** (post-2026-04-22 indices removal — Twelve Data Grow tier was routing US100/US500/US30/DE40/UK100 to unrelated ETFs):

| Ticker | Name | Category | Spread |
|--------|------|----------|--------|
| EURUSD | EUR/USD | FX major | tight |
| GBPUSD | GBP/USD | FX major | tight |
| USDJPY | USD/JPY | FX major | tight |
| AUDUSD | AUD/USD | FX major | tight |
| GOLD | Gold (XAU/USD) | commodity | tight |
| SILVER | Silver (XAG/USD) | commodity | medium |
| OIL_CRUDE | Crude Oil WTI | commodity | medium |

Indices may be re-added when a real index feed is wired (Pro-tier Twelve Data or Finnhub indices endpoint).

---

## Section 5: Composite Scoring Rubric (0–100)

**Rebalanced 2026-04-29:** structure now dominates the score. Pre-rebalance, news + kill-zone + spread-bonus could carry an instrument to Tier 2 (~70 points) without ANY structural backing (zero on bias clarity AND zero on ICT array quality). Post-rebalance, no-structure setups top out around 50 points and never qualify.

Kill zone is **no longer a score component** — it is a hard gate (Section 2). Trading outside kill zones is impossible regardless of score.

| Component | Points |
|-----------|--------|
| 1H bias clarity | 0 (unclear) / 15 (moderate) / 20 (slope-derived) / 25 (clean HH+HL or LH+LL) |
| ICT array quality | 0 (none) / 15 (weak) / 25 (moderate) / 35 (strong) |
| News catalyst | -15 (opposing Cat A) / -5 (opposing Cat B) / 0 (neutral) / +5 (aligned Cat B) / +10 (aligned Cat A) |
| Historical win rate adjustment | -10 (<50% over **2+ trades** on this setup × kill zone) / 0 (neutral / no history) / +10 (>70% over **2+ trades**) |
| Spread quality bonus | 0 (medium) / +5 (tight) |
| Base | 25 |

Maximum theoretical score: 25 (base) + 25 (bias) + 35 (ICT array) + 10 (news) + 10 (history) + 5 (spread) = **110**, capped at 100. Realistic A+ setup ~95.

Maximum no-structure score: 25 (base) + 0 + 0 + 10 (news) + 10 (history) + 5 (spread) = **50**. Below the 45 floor only when there is also no aligned news and no history bonus, which is correct — a chart that shows no bias clarity and no ICT array is not a setup, regardless of news context.

**Tier 1 (score 80–100):** Risk **1.5%** of account. Trailing-stop option on Leg C. *Trend-mode only* (1H bias must be bullish or bearish).
**Tier 2 (score 60–79):** Risk **1.0%** of account. Fixed TP3. *Trend-mode only.*
**Tier 3 (score 45–59):** Risk **0.5%** of account. Fixed TP3. Minimum R:R to TP2: 1.5:1 on tight-spread instruments only. *Trend-mode only.*
**Range-mode (1H neutral, trigger 5 only):** Risk **0.25%** of account (half of Tier 3 baseline). Score capped at 65 by the scanner — range-mode is structurally Tier 3 only, never Tier 1 or 2 regardless of score. R:R min: TP1 ≥ 1:1, TP2 ≥ 1.5:1, TP3 ≥ 2:1.
**Below 45:** No trade. Skip instrument.

**On the historical win-rate adjustment:** the previous 5-trades-per-bucket threshold was effectively dead code — at the bot's typical ~0.5 trades/day, hitting 5 trades per (setup × kill zone × instrument) bucket would take ~2 years. Lowering the activation threshold to 2 trades opens the feedback loop within the demo window. The signal is noisier (a 0/2 vs 1/2 swing matters), but a noisy active feedback loop is better than a clean dead one.

---

## Section 6: Banned Patterns

<!-- Patterns added here by Weekly Review Agent when win rate < 45% over 10+ trades. -->
<!-- Format: | pattern | win_rate | trade_count | added_at | -->

---

## Section 7: Core Risk Management Rules

**These rules CANNOT be removed or weakened by any agent. Code-enforced as of 2026-04-28.**

### Section 7.1: Position Sizing — 3-Leg Split-Position Method

Every trade is opened as **THREE positions** of split size at the same market price, all sharing the same SL. Capital.com supports only one TP per position; this is the only way to get multi-TP exits on a single-TP broker.

```
Total risk    = Account_balance × tier_risk_pct
                where tier_risk_pct = 1.5% T1 / 1.0% T2 / 0.5% T3 / 0.25% range-mode
Size per leg  = (Total risk / 3) / (entry − SL in price terms)
```

- **Position A (Leg A — partial-profit / de-risk leg):** ~34% of total size, TP at TP1 (**1:1 R:R**, or 1.2:1 for breathing room)
- **Position B (Leg B — primary target):** ~33% of total size, TP at TP2 (**≥ 2:1 R:R**)
- **Position C (Leg C — runner):** ~33% of total size, TP at TP3 (**≥ 3:1 R:R**) or trailing stop (Tier 1 only)

**Why TP1 is 1:1 (changed 2026-04-29):** TP1 is the *grab-something-and-de-risk* level, not a trend-continuation target. With TP1 = 1:1, the typical 15M reversal move (which extends 1:1 to 1.5:1 in your favor before chopping back) locks in partial profit and triggers the BE-move on legs B+C. Pre-fix, TP1 was set at 2:1 — meaning even when the analysis was correct, price had to deliver a *trend continuation* to hit TP1, not just a *normal mean-reverting move*. In choppy intraday action this rarely happened, all three legs rode the reversal back through entry to SL together, and the trade took a full -1R loss instead of locking in +0.33R.

**Math after fix (TP1=1R, TP2=2R, TP3=3R, sizes 34%/33%/33%):**

Per-trade outcome P&L in R:
- All three TPs hit: +0.34R + 0.66R + 0.99R = **+1.99R**
- TP1 + TP2 hit, C stopped at TP1 trail: +0.34R + 0.66R + ~0R = **~+1.0R**
- TP1 only, B+C ride to BE-stop: +0.34R + 0R + 0R = **+0.34R**
- Nothing hits, full SL: **−1R**

**Honest expectancy math** (corrected after 2026-04-29 codex review): if every winning trade only hits TP1 (B+C BE-stop) and every losing trade is full -1R, breakeven win rate is `1 / (1 + 0.34) = `**74.6% TP1 hit rate**, not the 50% I claimed in an earlier draft. The realism layer in `src/backtest/realism.ts` shows typical execution costs (spread + slippage) of ~0.42-0.94R per trade on this universe, so the *effective* breakeven moves up further.

**The reason this still beats TP1=2:1:** at TP1=2R the breakeven hit rate is `1 / (1 + 0.66) = `60.2%, but the *probability* of TP1 hitting drops sharply because TP1 now requires a trend-continuation move rather than a typical mean-reverting move. Lots of empirical evidence (and our own intraday FX experience) puts the TP1=1R hit rate roughly 1.5-2× the TP1=2R hit rate — so even if 1:1 needs 75% to break even and 2:1 only needs 60%, the empirical hit rates are roughly 60-70% (1:1) vs 30-40% (2:1). The 1:1 setup is the better expectancy when both are evaluated honestly.

**This is still a tight strategy** — it requires legitimate setup quality and the BE-trail to actually fire correctly when TP1 hits. Spread costs eat into every trade. Positive expectancy is *achievable* but not *automatic*.

If all three are stopped out simultaneously, total loss = exactly the tier risk %. Never size each leg at the full risk %.

### Section 7.2: Kill Switches

- **Daily loss limit: 6% of account equity. Non-negotiable.**
- **Weekly loss limit: 10% of account equity. Non-negotiable.**

When triggered:
- No new positions opened (code-enforced in `executeTool` paths)
- Existing positions managed only (trailing stops, partial closes if targets hit)
- Telegram alert sent immediately
- Daily resets at 00:00 UTC; weekly resets Sunday 00:00 UTC

### Section 7.3: R:R Minimums

**Trend-mode (triggers 1-4):**
- **TP1 (Leg A):** ≥ **1:1** (de-risk threshold; can be 1.2:1 for breathing room)
- **TP2 (Leg B):** ≥ **2:1** for Tier 1 & Tier 2; ≥ **1.5:1** for Tier 3 on tight-spread instruments only (EURUSD, GBPUSD, USDJPY, AUDUSD, GOLD)
- **TP3 (Leg C):** ≥ **3:1**

**Range-mode (trigger 5 only):**
- **TP1:** ≥ **1:1** at mid-range
- **TP2:** ≥ **1.5:1** at opposite range extreme
- **TP3:** ≥ **2:1** at measured-move projection (one range width beyond opposite extreme)

The TP1 ≥ 1:1 is mandatory in both modes — Leg A's job is to lock in something on every winning move, not to wait for trend continuation.

### Section 7.4: Pre-Trade Approval (CODE-ENFORCED, 2026-04-28)

All trades MUST pass the Trade Analyst Agent's 6-check approval before execution. Enforced via the unified `place_split_trade` tool:
- The agent calls `request_analyst_review(proposal)` first.
- If `APPROVE` is returned, the agent receives an `analyst_token` (a hash of the canonicalised proposal).
- `place_split_trade` rejects unless the supplied `analyst_token` matches a same-cycle approval AND the proposal hash matches the approved one (so the agent cannot mutate parameters between approval and placement).

Target Analyst rejection rate: 15-25%. Outside that band, the Weekly Review Agent flags calibration drift.

### Section 7.5: Coordination Lock (CODE-ENFORCED, 2026-04-28)

No new ICT trade may open on an instrument with an existing open or `tp1_hit` or `tp2_hit` position. Enforced in `executeTool('place_split_trade')` via `getOpenTradesByInstrument(epic)`.

### Section 7.6: Calendar Veto (CODE-ENFORCED)

Before any order is forwarded to Capital.com, the calendar veto helper checks for high-impact macro events on the trade currencies:
- **Generic high-impact event:** −5 / +30 min window
- **Tier-1 events (FOMC, NFP, CPI, ECB / BoE / BoJ / RBA / BoC / SNB / RBNZ rate decisions, Core PCE, GDP, ISM PMI, Average Hourly Earnings, Unemployment Rate, Retail Sales, central-bank press conferences):** **−60 / +30 min** (wider pre-event window — these prints have known multi-hour lead-up volatility)

The agent's prompt MUST mirror the code window exactly (`-5/+30` generic, `-60/+30` tier-1) — out-of-sync prompts cause the agent to skip trades that the code allows, leaking opportunities. Sync verified 2026-04-29.

If the calendar fetch fails, the veto fails CLOSED — orders are refused until calendar fetch succeeds.

### Section 7.7: News Layer

- News pipeline: MarketAux + 14-feed tiered RSS aggregator + Forex Factory calendar + Jina Reader full-body enrichment
- Cat A classification: keyword whitelist of high-impact macro events (FOMC, NFP, CPI, ECB, BoE, BoJ, RBA, BoC, SNB, RBNZ, Core PCE, AHE, Unemployment Rate, Retail Sales, ISM PMI, OPEC, oil inventories, etc). Sentiment-magnitude alone does NOT qualify as Cat A.
- Banker surnames (Powell/Lagarde/Bailey/Ueda/Macklem/Jordan/Orr) require central-bank context to count.
- Opposing Cat A news → 50% of normal size (compromise posture, post-2026-04-23 P2 softening).

---

## Change Log

| Date | Agent | Change | Statistical Basis |
|------|-------|--------|-------------------|
| 2026-04-16 | Manual | Initial strategy created | N/A — baseline |
| 2026-04-16 | Manual | V3 update: coordination lock, weekly kill switch, VIX sizing, analyst gate, combined ICT+Swing | N/A — V3 architecture |
| 2026-04-23 | Manual | Swing Agent retired (cost > profit contribution) | Empirical |
| 2026-04-28 | Manual (audit) | **AUDIT REWRITE.** Drift between this file and code identified by 2026-04-28 codex review pass: 2-leg → 3-leg, /2 → /3 sizing, Tier 3 50→45, removed VIX-based sizing (VIX feed retired 2026-04-24), populated empty Section 4 universe, removed Swing references, added Section 7.4 code-enforced analyst gate, Section 7.5 code-enforced coordination lock, Section 7.6 calendar veto, Section 7.7 news layer doc | Manual audit |
| 2026-04-29 | Manual (structural overhaul) | **TP1 R:R 2:1 → 1:1** (de-risk leg, partial-profit target — was structurally negative-expectancy at 2:1). **TP2 floor 2:1 unchanged**, TP3 floor 4:1 → 3:1. **Quantified all 4 trigger definitions** in Section 3 (body/range ratios, fill thresholds, sweep size, retest count). **Rebalanced score rubric**: structure dominates (bias 0–25, ICT 0–35), kill-zone removed as score component (now hard gate only), news capped at +10 / -15. **History-WR threshold lowered** 5+ → 2+ trades to activate the feedback loop within the demo window. **Calendar veto window** doc synced to code: generic -5/+30, tier-1 -60/+30. | Structural fix to documented strategy; addresses negative-expectancy math + trigger ambiguity flagged in 2026-04-29 internal review |
| 2026-04-29 | Manual (range-mode addition) | **5th trigger: Range Sweep Reversal.** Activates only on neutral-bias instruments (the 5/7 universe filtered as neutral during pre-FOMC chop). Range definition (≥ 8 1H candles, width ≥ 1.5 × ATR), sweep ≥ 2× spread, reversal candle within 2 candles, body ≥ 0.6× range, closes back inside range by ≥ 1× spread. TP1 = mid-range, TP2 = opposite extreme, TP3 = measured-move projection. **Half-size posture: 0.25% total risk** (0.5% Tier 3 / 2). Tier 3 only (capped — score 65 max). Tighter R:R: TP1 1:1, TP2 1.5:1, TP3 2:1. Cat-A news must align with reversal direction or invalidate the setup. | Captures range-bound regimes where current 4 triggers find nothing — observed 5/7 universe filtered as neutral during pre-FOMC 2026-04-29 |

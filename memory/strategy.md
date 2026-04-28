# ICT Intraday Trading Strategy — BetterOpsAI Trading Bot
> Last Updated: 2026-04-28
> Updated By: 2026-04-28 audit pass — corrected drift between strategy.md and code
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

1. **OB Retest** — rejection candle closing back in bias direction
2. **FVG Fill** — candle closing back out of gap in bias direction
3. **Liquidity Sweep** — sweep of swing high/low with strong reversal candle
4. **Breakout Retest** — broken level hold confirmed on 15M close

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

| Component | Points |
|-----------|--------|
| 1H bias clarity | 0 (unclear) / 10 (moderate) / 15 (slope-derived) / 20 (clean HH+HL or LH+LL) |
| ICT array quality | 0 (none) / 12 (weak) / 18 (moderate) / 25 (strong) |
| Kill zone alignment | -5 (outside) / 0 (no zone) / 15 (inside) |
| News catalyst | -15 (opposing Cat A) / -5 (opposing Cat B) / 0 (neutral) / +10 (aligned Cat B) / +20 (aligned Cat A) |
| Historical win rate adjustment | -10 (<50% over 5+ trades on this exact setup × kill zone) / 0 (neutral) / +10 (>70% over 5+ trades) |
| Spread quality bonus | 0 (medium) / +5 (tight) |
| Base | 30 |

**Tier 1 (score 80–100):** Risk **1.5%** of account. Trailing-stop option on Leg C.
**Tier 2 (score 60–79):** Risk **1.0%** of account. Fixed TP3 only.
**Tier 3 (score 45–59):** Risk **0.5%** of account. Fixed TP3 only. Minimum R:R to TP2: 1.5:1 on tight-spread instruments only.
**Below 45:** No trade. Skip instrument.

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
Total risk    = Account_balance × tier_risk_pct  (1.5% T1 / 1.0% T2 / 0.5% T3)
Size per leg  = (Total risk / 3) / (entry − SL in price terms)
```

- **Position A (Leg A):** ~34% of total size, TP at TP1 (≥ 2:1 R:R)
- **Position B (Leg B):** ~33% of total size, TP at TP2 (≥ 3:1 R:R)
- **Position C (Leg C):** ~33% of total size, TP at TP3 (≥ 4:1 R:R) or trailing stop (Tier 1 only)

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

- **Tier 1 & 2:** R:R to TP2 ≥ **2:1**
- **Tier 3:** R:R to TP2 ≥ **1.5:1** on tight-spread instruments only (EURUSD, GBPUSD, USDJPY, AUDUSD, GOLD)

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
- Default window: −5 / +30 min (block orders 5 min before to 30 min after a generic high-impact event)
- Wide window for FOMC / NFP / CPI / ECB / BoE / BoJ / RBA / BoC / SNB / RBNZ rate decisions / Core PCE / GDP: −30 / +60 min

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

# Swing Trading Strategy — BetterOpsAI Trading Bot
> Last Updated: April 16, 2026
> Updated By: Manual (initial version)

---

## Section 1: Trading Methodology

Multi-Timeframe Trend Pullback with Confluence — ride dominant trends by entering on controlled pullbacks with technical + momentum + macro confluence.

- **Weekly chart** — macro trend direction (30-week EMA)
- **Daily chart** — setup zone identification
- **4-hour chart** — precise entry trigger
- Hold duration: 2–15 days

---

## Section 2: 4-Layer Framework

### Layer 1 — Weekly Chart (Macro Trend)
| Condition | Bias |
|-----------|------|
| Price above rising 30-week EMA | Bullish (longs only) |
| Price below falling 30-week EMA | Bearish (shorts only) |
| Price chopping around flat 30-week EMA | SKIP instrument this week |

### Layer 2 — Daily Chart (Setup Zone)
1. **Pullback to 20/50 EMA** — in uptrend, daily candle showing rejection wick
2. **Pullback to daily demand zone** — prior consolidation that launched the trend
3. **Flag/pennant/triangle breakout** — with retest of breakout level
4. **Failed breakdown (spring)** — sweep of prior daily low then strong reclaim
5. **Moving average ribbon compression** — then expansion

### Layer 3 — 4-Hour Chart (Entry Trigger)
1. Bullish engulfing or hammer at Layer 2 zone
2. RSI bullish divergence on 4H (or bearish for shorts)
3. Break of 4H counter-trend structure back in main trend direction
4. Volume expansion on the entry candle

### Layer 4 — Macro Context (Filter)
- Major opposing event in next 48h (FOMC, NFP, CPI, central bank) → Wait
- Major supporting event → Proceed normal size
- No major events → Proceed normal size

---

## Section 3: Schedule

| Trigger | Time |
|---------|------|
| End-of-day analysis | Daily 21:30 UTC (after US close) |
| Weekly outlook | Monday 06:00 UTC |
| Position management | Every 4 hours during London/NY sessions |

---

## Section 4: Composite Scoring Rubric (0–100)

| Factor | Points |
|--------|--------|
| Weekly trend clearly aligned | 0 (flat) / 15 (moderate) / 25 (strong) |
| Daily setup quality (clean vs messy) | 0 (none) / 10 (messy) / 20 (clean) |
| 4H trigger strength | 0 (none) / 10 (weak wick) / 20 (strong engulfing + volume) |
| Confluence count (MA, S/R, FVG, Fib 0.5-0.618) | +3 per confluence, max +15 |
| Macro tailwind (calendar + correlation + sector) | -15 (headwind) to +15 (tailwind) |
| Historical win rate for exact setup (from lessons) | -10 (<50%) / 0 (neutral) / +10 (>70%) |

**Tier 1 (score 80+):** Risk 1.5% of account.
**Tier 2 (score 65–79):** Risk 1.0% of account.
**Below 65:** No trade. Skip instrument.

---

## Section 5: Trade Parameters

- **Entry:** Close of 4H trigger candle, or limit at midpoint of setup zone
- **Stop Loss:** 1.5x ATR(14) on daily chart, beyond swing low (long) or swing high (short)
- **TP1:** Nearest prior daily swing high/low in trade direction
- **TP2:** Next significant daily level, or measured move equal to preceding consolidation depth
- **Minimum R:R to TP2:** 3:1 (higher than ICT — paying swap / holding longer)
- **Position sizing:** Same split-leg method as ICT

---

## Section 6: Banned Patterns

<!-- Patterns added here by Weekly Review Agent when win rate < 45% over 10+ trades -->

---

## Section 7: Core Risk Management Rules

**These rules CANNOT be removed or weakened by any agent.**

1. Max risk per trade: 1.5% (Tier 1) / 1% (Tier 2) of account
2. Max open swing positions: 3 (each uses split legs)
3. Combined max across Swing + ICT: 5 total trades (10 T212 positions)
4. No new swing entry if ICT agent has trade open on same instrument
5. Minimum R:R to TP2: 3:1
6. Every trade uses split-position method (2 legs)
7. Size per leg = (total risk / 2) / (entry - SL)
8. Manage on daily closes only — over-management destroys swing edge

### Section 7.2: Kill Switches

**Daily loss limit: 6% of account equity. Non-negotiable.**
**Weekly loss limit: 10% of account equity. Non-negotiable.**

When triggered:
- No new positions opened
- Existing positions managed only
- Telegram alert sent immediately
- Daily resets at 00:00 UTC; weekly resets Sunday 00:00 UTC

### Section 7.3: VIX-Based Sizing

| VIX Level | Action |
|-----------|--------|
| < 15 | Low vol — trend strategies favoured, normal size |
| 15-20 | Normal — both strategies work, normal size |
| 20-30 | Elevated — reduce position size by 25% across both agents |
| > 30 | Crisis — Swing agent stands down entirely, ICT Tier 1 only |

### Section 7.4: Performance Circuit Breaker

If win rate drops below 40% over 20 trades → STOP live trading, trigger Weekly Review pattern audit.

If both ICT and Swing underperform for 2 consecutive weeks → Telegram "system review" alert to user.

---

## Change Log

| Date | Agent | Change | Statistical Basis |
|------|-------|--------|-------------------|
| 2026-04-16 | Manual | Initial swing strategy created | N/A — baseline |

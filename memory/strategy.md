# ICT Intraday Trading Strategy — BetterOpsAI Trading Bot
> Last Updated: April 16, 2026
> Updated By: Manual (V3 update — multi-agent system)
> Strategy Tag: ICT_INTRADAY

---

## Section 1: Trading Methodology

ICT (Inner Circle Trader) — order blocks, fair value gaps, liquidity sweeps, premium/discount zones, break of structure.

- **1-hour candles** — establish directional bias, map ICT arrays, identify key levels
- **15-minute candles** — entry triggers only (OB retest, FVG fill, liquidity sweep, breakout retest)

---

## Section 2: Kill Zones

| Kill Zone | UTC Window |
|-----------|-----------|
| London Open | 07:00–10:00 |
| New York Open | 13:00–16:00 |
| London Close | 15:00–17:00 |

Trading outside kill zones: -15 point score penalty. If score drops below 65, skip.

---

## Section 3: Entry Triggers (15M)

1. **OB Retest** — rejection candle closing back in bias direction
2. **FVG Fill** — candle closing back out of gap in bias direction
3. **Liquidity Sweep** — sweep of swing high/low with strong reversal candle
4. **Breakout Retest** — broken level hold confirmed on 15M close

---

## Section 4: Instruments Universe

<!-- TODO: Define instrument list with trading team -->

---

## Section 5: Composite Scoring Rubric (0–100)

| Component | Points |
|-----------|--------|
| 1H bias clarity | 0 (unclear) / 10 (moderate) / 20 (strong) |
| ICT array quality | 0 (none) / 12 (weak) / 18 (moderate) / 25 (strong) |
| Kill zone alignment | -5 (outside) / 0 (no zone) / 15 (inside) |
| News catalyst | -15 (opposing) to +20 (strong Cat A aligned) |
| Historical win rate adjustment | -10 (<50% over 5+ trades) / 0 (neutral) / +10 (>70% over 5+ trades) |

**Tier 1 (score 80–100):** Risk 1.5% of account. Trailing stop option available.
**Tier 2 (score 60–79):** Risk 1.0% of account. Fixed TP2 only.
**Tier 3 (score 50–59):** Risk 0.5% of account. Fixed TP2 only. Minimum R:R 1.5:1.
**Below 50:** No trade. Skip instrument.

---

## Section 6: Banned Patterns

<!-- Patterns added here by Weekly Review Agent when win rate < 45% over 10+ trades -->

---

## Section 7: Core Risk Management Rules

**These rules CANNOT be removed or weakened by any agent.**

1. Max risk per trade: 1.5% (Tier 1) / 1% (Tier 2) / 0.5% (Tier 3) of account
2. No hard cap on open positions — each trade must independently score >= 50
3. Coordination lock: no new trade on an instrument already held in an open position
4. Minimum R:R to TP2: 2:1 (Tier 1 & 2) / 1.5:1 (Tier 3)
5. Every trade uses split-position method (2 legs)
6. Size per leg = (total risk / 2) / (entry - SL) — never full risk per leg

### Section 7.2: Kill Switches

**Daily loss limit: 6% of account equity. Non-negotiable.**
**Weekly loss limit: 10% of account equity. Non-negotiable.**

When triggered:
- No new positions opened
- Existing positions managed only (trailing stops, partial closes if targets hit)
- Telegram alert sent immediately
- Daily resets at 00:00 UTC; weekly resets Sunday 00:00 UTC

### Section 7.3: VIX-Based Sizing

| VIX Level | Action |
|-----------|--------|
| < 15 | Low vol — trend strategies favoured, normal size |
| 15-20 | Normal — both strategies work, normal size |
| 20-30 | Elevated — reduce position size by 25% across both agents |
| > 30 | Crisis — Swing agent stands down, ICT Tier 1 only |

### Section 7.4: Pre-Trade Approval

All trades must pass the Trade Analyst Agent's 6-check approval before execution.
Target rejection/modification rate: 15-25%.

---

## Change Log

| Date | Agent | Change | Statistical Basis |
|------|-------|--------|-------------------|
| 2026-04-16 | Manual | Initial strategy created | N/A — baseline |
| 2026-04-16 | Manual | V3 update: added coordination lock, weekly kill switch (8%), VIX sizing, analyst approval gate, combined position limits with Swing | N/A — V3 architecture |

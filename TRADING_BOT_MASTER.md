# Self-Learning AI Trading Bot — Master Document
> Built by BetterOpsAI  
> Last Updated: April 16, 2026  
> Status: **Planning Phase — Pre-Build**

---

## Project Overview

An autonomous, self-learning AI trading bot that connects to Capital.com via their REST API through an MCP (Model Context Protocol) server. The bot uses ICT (Inner Circle Trader) methodology across 15-minute and 1-hour candlestick timeframes, reflects on every trade it makes using structured lessons, and improves its own strategy weekly — without human intervention.

---

## Core Ideology

The bot is not just a script that executes rules. It is an **AI agent that thinks, acts, remembers, and learns.**

Three principles drive the design:

1. **Memory** — Every trade is logged with 20+ data points. The bot never forgets what it did or why.
2. **Reflection** — After every trade closes, the bot analyses what happened and writes a structured lesson with a rule suggestion for future improvement.
3. **Evolution** — Every Sunday, the bot reviews the full week, detects patterns across lessons, and rewrites weak parts of its own strategy with statistical justification.

The longer the bot runs, the smarter it becomes.

---

## Technical Stack

| Component | Technology |
|-----------|-----------|
| Language | TypeScript |
| AI Model | Claude claude-sonnet-4-20250514 (Anthropic) |
| MCP Framework | @modelcontextprotocol/sdk |
| HTTP Client | axios |
| Database | SQLite via better-sqlite3 |
| Scheduler | node-cron |
| Telegram Alerts | Telegraf |
| Hosting | VPS (DigitalOcean or Hetzner) |
| Dev Machine | Windows + Node.js + Claude Code |
| Broker | Capital.com (REST API, demo + live) |

---

## Full Architecture

```
VPS Server (Runs 24/7)
│
├── Scheduler
│   ├── Fires every 5 minutes
│   ├── Checks if new 15min candle has closed → triggers Main Agent
│   ├── Checks if new 1hr candle has closed → triggers Main Agent
│   ├── Monitors portfolio for position closures → triggers position management
│   ├── Fires on trade fully closed → triggers Reflection Agent
│   └── Fires every Sunday 00:00 UTC → triggers Weekly Review Agent
│
├── Agent Layer
│   ├── Main Trading Agent (Claude)
│   │   ├── Step 1: Check daily risk status (kill switch at 4% daily loss)
│   │   ├── Step 2: Get ranked instruments from universe scanner
│   │   ├── Step 3: Full ICT analysis per candidate instrument
│   │   │   ├── Get 1H and 15M price data
│   │   │   ├── Establish 1H bias (bullish/bearish/neutral)
│   │   │   ├── Map ICT arrays (order blocks, FVGs, liquidity pools, premium/discount)
│   │   │   ├── Check kill zone alignment
│   │   │   ├── Get and score news context (Cat A/B/C)
│   │   │   ├── Get relevant filtered lessons (by setup type, instrument category, kill zone)
│   │   │   ├── Calculate composite score (0-100)
│   │   │   ├── Look for 15M entry trigger (OB retest, FVG fill, liquidity sweep, breakout retest)
│   │   │   └── Calculate trade parameters (entry, SL, TP1, TP2, position size per leg)
│   │   ├── Step 4: Manage existing positions (TP1 hit → move SL to BE, trailing stops, early exits)
│   │   └── Step 5: Output structured reasoning log for audit trail
│   │
│   ├── Reflection Agent (Claude)
│   │   ├── Fires after every trade fully closes (both legs)
│   │   ├── Receives complete trade record with all context
│   │   └── Writes structured JSON lesson (20+ fields including rule_suggestion)
│   │
│   └── Weekly Review Agent (Claude)
│       ├── Fires every Sunday 00:00 UTC
│       ├── Reads full week of trades from DB
│       ├── Produces performance report (win rate by setup/kill zone/news/instrument category)
│       ├── Updates strategy.md scoring weights and rules (minimum 10 trades per rule change)
│       └── Cannot remove core risk management rules or kill switch
│
├── MCP Server (14 tools)
│   ├── tool: get_prices(instrument, timeframe)          → 15min and 1hr candle data
│   ├── tool: get_portfolio()                            → current open positions
│   ├── tool: get_balance()                              → available cash and account equity
│   ├── tool: place_order(instrument, direction, size, sl, tp, label) → execute a single order leg
│   ├── tool: partial_close(positionId, units)           → manually close specified units on a position
│   ├── tool: close_position(positionId)                 → fully exit an open trade
│   ├── tool: set_trailing_stop(positionId, distance)    → replace fixed SL with trailing stop
│   ├── tool: update_sl(positionId, newSL)               → move stop loss to break even or new level
│   ├── tool: log_trade(tradeData)                       → save trade to DB (both legs as one record)
│   ├── tool: get_lessons(setup_type, instrument_category, kill_zone) → retrieve filtered past lessons
│   ├── tool: get_ranked_instruments(limit)              → top-ranked instruments from universe scanner
│   ├── tool: get_news_context(instrument)               → scored news items for an instrument
│   ├── tool: get_daily_pnl()                            → today's running P&L
│   └── tool: get_trade_history(limit)                   → fetch last N trades from DB
│
├── Universe Scanner
│   └── Ranks instruments by composite score for the Main Agent to review
│
├── News Context System
│   ├── Scores news as Cat A (score 4-5, major catalyst)
│   ├── Cat B (score 2-3, moderate supporting context)
│   └── News opposing technical direction → skip instrument entirely
│
├── Learning Memory
│   ├── SQLite Database        → every trade ever made (split-leg format)
│   ├── Structured JSON lessons → stored in DB, filtered by setup/category/kill zone
│   └── strategy.md            → updated every Sunday by Weekly Review Agent
│
└── Notifications
    └── Telegram Bot
        ├── Trade placed alert (both legs, entry, SL, TP1, TP2, R:R)
        ├── TP1 hit alert (Position A closed, Position B SL moved to BE)
        ├── TP2 hit / full trade complete alert (final P&L in R)
        ├── SL hit alert
        ├── Kill switch activated alert
        └── Weekly performance report

Capital.com REST API
├── Live Price Data (OHLC candles native)
├── Account & Portfolio Data
├── Order Execution (SL/TP/trailing all server-side)
└── Deal Confirmation (async via /confirms/:dealReference)
```

---

## Split-Position Execution Method

Capital.com supports SL/TP/trailing natively per position, but every position still has exactly one TP. The split-position method remains a design choice — it gives us independent exit rules for each leg and enables the TP1 → move-B-to-break-even pattern which is core to the strategy.

Every trade is opened as TWO separate positions simultaneously:

**Position A — "TP1 leg" (50% of total intended size)**
- Size: 50% of calculated position size
- Entry: same as calculated entry
- Stop Loss: same structural SL
- Take Profit: TP1 level (nearest opposing swing high/low)
- Label: "[INSTRUMENT]-A-[timestamp]"

**Position B — "TP2 leg" (50% of total intended size)**
- Size: 50% of calculated position size
- Entry: same as calculated entry
- Stop Loss: same structural SL
- Take Profit: TP2 level (next swing high/low or key HTF level)
- Label: "[INSTRUMENT]-B-[timestamp]"

**After TP1 is hit:** Position A closes automatically. Immediately move Position B's SL to break even (entry + 1 tick). Position B now costs nothing to hold.

**After TP2 is hit:** Both positions fully closed. Log final trade as complete. Trigger Reflection Agent.

**Trailing stop option (Tier 1 setups only, score 80+):** Instead of fixed TP2, set trailing stop at 1.5x original SL distance. Only when strong momentum and no major resistance within 2x SL distance.

**Position sizing with split legs:**
```
Total risk = Account balance x risk% (1.5% Tier 1, 1% Tier 2)
Size per leg = (Total risk / 2) / (entry - SL in price terms)
```
Both legs use the same SL. If both stopped out, total loss = exactly the intended risk%. Never size each leg at the full risk% — that would double your risk.

**Database logging:** Both legs logged as a single trade record with position_a_id, position_b_id, tp1, tp2, size_a, size_b, pnl_a, pnl_b, pnl_total, and status flow: "open" → "tp1_hit" → "complete" or "sl_hit".

---

## Trading Logic

### Methodology
ICT (Inner Circle Trader) — order blocks, fair value gaps, liquidity sweeps, premium/discount zones, break of structure.

### Timeframes
- **1-hour candles** — establish directional bias, map ICT arrays, identify key levels
- **15-minute candles** — entry triggers only (OB retest, FVG fill, liquidity sweep, breakout retest)

### Kill Zones (high-probability trading windows)
- **London Open:** 07:00–10:00 UTC
- **New York Open:** 13:00–16:00 UTC
- **London Close:** 15:00–17:00 UTC
- Trading outside kill zones applies a -15 point score penalty. If score drops below 65, skip.

### Composite Scoring System (0–100)
| Component | Points |
|-----------|--------|
| 1H bias clarity | 0 / 10 / 20 |
| ICT array quality | 0 / 12 / 18 / 25 |
| Kill zone alignment | 0 / 15 |
| News catalyst | -15 to +20 |
| Historical win rate adjustment | -10 / 0 / +10 |

- **Score 80+ (Tier 1):** Risk 1.5% of account. Trailing stop option available.
- **Score 65–79 (Tier 2):** Risk 1% of account. Fixed TP2 only.
- **Score below 65:** No trade. Skip instrument.

### Entry Requirements Checklist
- 1H bias is clear and in your favour
- Valid ICT trigger has printed on 15M
- Composite score is 65 or above
- R:R to TP2 is 2:1 or better
- No conflicting news catalyst
- Daily loss limit (4%) not hit
- Max positions (3) not reached — split legs count as 2
- Not in the same instrument category as 2 existing positions

### Strategy File
- Lives in `memory/strategy.md`
- Written by the trading team as structured rules with scoring rubric
- Gets improved automatically every Sunday by the Weekly Review Agent
- Core risk management rules and kill switch can never be removed by the Weekly Review Agent

---

## Risk Management

| Rule | Value |
|------|-------|
| Max risk per trade (Tier 1, score 80+) | 1.5% of account |
| Max risk per trade (Tier 2, score 65-79) | 1% of account |
| Max open positions | 3 (a split pair counts as 2) |
| Daily loss kill switch | 4% of account equity |
| Minimum R:R to TP2 | 2:1 |
| Max same-category positions | 2 |

---

## Project Folder Structure

```
trading-bot/
├── src/
│   ├── mcp-server/
│   │   └── index.ts              ← MCP server + all 14 tools
│   ├── agents/
│   │   ├── trading-agent.ts      ← main decision agent (5-step cycle)
│   │   ├── reflection-agent.ts   ← post-trade structured lesson writer
│   │   └── review-agent.ts       ← weekly strategy improver
│   ├── scheduler/
│   │   └── index.ts              ← candle close detection + position monitoring + triggers
│   ├── scanner/
│   │   └── index.ts              ← universe scanner — ranks instruments by composite score
│   ├── news/
│   │   └── index.ts              ← news context fetcher and scorer
│   └── database/
│       └── index.ts              ← SQLite setup + queries (split-leg trade schema)
├── memory/
│   └── strategy.md               ← the bot's brain — updated weekly
├── .env                          ← API keys (never committed)
├── .gitignore
└── package.json
```

---

## Environment Variables (.env)

```
CAPITAL_API_KEY=your_capital_com_api_key
CAPITAL_IDENTIFIER=your_login_email
CAPITAL_API_KEY_PASSWORD=your_api_key_password
CAPITAL_API_URL=https://demo-api-capital.backend-capital.com
ANTHROPIC_API_KEY=your_anthropic_api_key
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
TELEGRAM_CHAT_ID=your_chat_id
TWELVE_DATA_API_KEY=your_twelve_data_api_key
FINNHUB_API_KEY=your_finnhub_api_key
FMP_API_KEY=your_fmp_api_key
FRED_API_KEY=your_fred_api_key
ALPHA_VANTAGE_API_KEY=your_alpha_vantage_api_key
```

---

## Build Order

| Step | Task | Method | Status |
|------|------|--------|--------|
| 1 | Get Capital.com demo credentials | Manual — Capital.com Settings → API | Complete |
| 2 | Set up project folder + structure | Claude Code | Pending |
| 3 | Build MCP Server + Capital.com tools (22 tools) | Claude Code | Complete |
| 4 | Build SQLite database (split-leg trade schema + lessons table) | Claude Code | Pending |
| 5 | Build Universe Scanner | Claude Code | Pending |
| 6 | Build News Context System | Claude Code | Pending |
| 7 | Build Main Trading Agent (5-step decision cycle) | Claude Code | Pending |
| 8 | Build Reflection Agent (structured JSON lessons) | Claude Code | Pending |
| 9 | Build Weekly Review Agent (performance report + strategy updates) | Claude Code | Pending |
| 10 | Build Scheduler (candle close detection + position monitoring + agent triggers) | Claude Code | Pending |
| 11 | Add Telegram Alerts (all alert types) | Claude Code | Pending |
| 12 | Write strategy.md with trading team (scoring rubric, ICT rules, banned patterns) | Manual | Pending |
| 13 | Test on Capital.com Demo Account — minimum 2 weeks | Manual monitoring | Pending |
| 14 | Deploy to VPS | Claude Code | Pending |
| 15 | Monitor + tune | Manual | Pending |

---

## Key Decisions Made

| Decision | Choice | Reason |
|----------|--------|--------|
| Language | TypeScript | Best MCP SDK support |
| Timeframes | 15min + 1hr | 1H for bias, 15M for entries |
| Trading methodology | ICT (Inner Circle Trader) | Order blocks, FVGs, liquidity sweeps, premium/discount |
| Agent mode | Autonomous | No human approval needed |
| Strategy approach | Single agent + single strategy file | Simplicity first |
| Execution method | Split-position (2 legs per trade) | Enables independent TP1 / TP2 exits + move-B-to-BE pattern |
| Risk per trade | 1.5% Tier 1, 1% Tier 2 | Tiered by composite score |
| Daily loss limit | 4% of account equity | Kill switch — no new trades after this |
| Max open positions | 3 | Split pair counts as 2 positions on Capital.com |
| Scoring system | Composite 0–100 | 1H bias + ICT arrays + kill zone + news + historical win rate |
| Minimum score to trade | 65 | Below this, skip instrument |
| Trailing stop threshold | Score 80+ (Tier 1 only) | 1.5x SL distance, no major resistance within 2x SL |
| Minimum R:R | 2:1 to TP2 | Non-negotiable |
| Lesson format | Structured JSON (20+ fields) | Enables filtering and pattern detection by Weekly Review Agent |
| Strategy update rules | Min 10 trades per rule change | Small samples lie — Weekly Review Agent must cite exact stats |
| Hosting | VPS | Local machine can't run 24/7 reliably |
| Learning system | 3-layer (memory + reflection + weekly review) | Bot improves over time |
| Testing approach | Capital.com Demo account first | Never risk real money before validation |

---

## Rules and Warnings

1. **Never skip Practice account testing.** Run for minimum 2 weeks before real money.
2. **Never commit the .env file.** API keys must stay out of any repository.
3. **Always establish 1H bias before looking at 15M for entries.** This is built into the 5-step decision cycle.
4. **The strategy.md must be structured rules with a scoring rubric, not a chat export.**
5. **Kill switch at 4% daily loss is non-negotiable.** The Weekly Review Agent cannot remove this.
6. **Every trade is two legs.** Never open a single position — always use the split-position method.
7. **Never size each leg at the full risk%.** That doubles your risk. Size per leg = (total risk / 2) / (entry - SL).
8. **Core risk management rules in strategy.md Section 7 cannot be removed by any agent.**

---

## Decisions Pending

- [x] Capital.com demo credentials — generated and in .env
- [ ] Strategy rules and scoring rubric — trading team to document and formalise
- [ ] VPS provider choice — DigitalOcean vs Hetzner
- [ ] Telegram bot setup — needs a bot token from @BotFather
- [ ] Which instruments to include in the universe scanner
- [ ] News data source — where does the news context system pull from?

---

## Reference Documents

| Document | Purpose |
|----------|---------|
| `TRADING_BOT_MASTER.md` | This file — project overview, architecture, build order, decisions |
| `AGENT_SYSTEM_PROMPTS.md` | Full system prompts for all 3 agents — the "how the bot thinks" doc |
| `memory/strategy.md` | The bot's live strategy file — scoring rubric, ICT rules, banned patterns |

---

## Change Log

| Date | Update |
|------|--------|
| April 15, 2026 | Document created. Full architecture, stack, build order and ideology locked. |
| April 16, 2026 | Major update: integrated agent system prompts doc. Added split-position execution method, ICT methodology, composite scoring system, universe scanner, news context system, expanded MCP tools (9 to 14), structured JSON lesson format, risk management table, revised build order (12 to 15 steps), and all new key decisions. Daily loss limit set at 4%. |

---

*This document is maintained by BetterOpsAI and updated after every planning session.*

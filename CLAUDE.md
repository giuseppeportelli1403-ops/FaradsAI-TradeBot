# BetterOpsAI — Self-Learning AI Trading Bot

## Project Context

This is a self-learning autonomous AI trading bot built by BetterOpsAI. It runs TWO trading strategies (ICT Intraday + Swing) powered by 6 AI agents, connects to Trading 212 via their beta API through an MCP server with 21 tools, and improves itself over time through structured reflection and weekly strategy evolution.

## Reference Documents — READ THESE FIRST

Before building anything, read these files. They are the source of truth for all architecture decisions, agent behaviour, MCP tools, database schema, and risk management rules.

1. **TRADING_BOT_MASTER.md** — Full project overview, architecture diagram, build order, all key decisions, risk management rules, folder structure. (Being updated to V3)
2. **AGENT_SYSTEM_PROMPTS_V3.docx.pdf** — **PRIMARY** — Complete system prompts for all 6 agents (V3). Contains ICT Agent, Swing Agent, Market Researcher, Trade Analyst, Reflection Agent, and Weekly Review Agent.
3. **AGENT_SYSTEM_PROMPTS_2.md.txt** — V2 agent prompts (superseded by V3 but kept for reference)
4. **AGENT_SYSTEM_PROMPTS.md** — V1 agent prompts (superseded)

Do not guess any architecture or design decisions. Everything is documented in those files. **V3 is the source of truth for agent behaviour.**

## Tech Stack

- Language: TypeScript
- AI Model: Claude Sonnet (Anthropic API)
- MCP Framework: @modelcontextprotocol/sdk
- HTTP Client: axios
- Database: SQLite via sql.js (WASM — no native compilation needed on Windows; switch to better-sqlite3 on Linux VPS if needed)
- Scheduler: node-cron
- Telegram Alerts: Telegraf
- Hosting: VPS (DigitalOcean or Hetzner)

## Agent Architecture (V3 — 6 Agents)

| # | Agent | File | Role | Schedule |
|---|-------|------|------|----------|
| 1 | ICT Intraday Agent | trading-agent.ts | 5-step ICT decision cycle, 15M/1H | Every 15M/1H candle close |
| 2 | Swing Trading Agent | swing-agent.ts | 4-layer trend pullback, Daily/4H/Weekly | Daily 21:30 UTC, Mon 06:00 UTC, every 4H |
| 3 | Market Researcher | researcher-agent.ts | Regime, themes, instrument shortlists | Daily 05:30 UTC, Sun 22:00 UTC |
| 4 | Trade Analyst | analyst-agent.ts | Pre-trade approval gate (APPROVE/REJECT/MODIFY) | On demand (before every trade) |
| 5 | Reflection Agent | reflection-agent.ts | Post-trade structured lessons | After every trade closes |
| 6 | Weekly Review Agent | review-agent.ts | Performance report + strategy updates | Sunday 00:00 UTC |

## MCP Tools (21 total)

### Trading 212 Tools (14)
get_prices, get_portfolio, get_balance, place_order, partial_close, close_position, set_trailing_stop, update_sl, log_trade, get_lessons, get_ranked_instruments, get_news_context, get_daily_pnl, get_trade_history

### Market Data Tools (7 — new in V3)
get_economic_calendar, get_correlation_matrix, get_sector_strength, get_vix, get_dxy, get_yield_curve, write_research_brief

## Build Order

| Step | Task | Status |
|------|------|--------|
| 1 | Get T212 API Key (manual) | Pending |
| 2 | Set up project folder + structure | Complete |
| 3 | Build MCP Server with all 21 tools | Complete |
| 4 | Build SQLite database (split-leg schema + lessons table + research briefs) | Complete |
| 5 | Build Universe Scanner | Complete |
| 6a | Build News Context System | Complete |
| 6b | Build Market Researcher Agent | Complete |
| 7a | Build ICT Intraday Trading Agent (5-step decision cycle) | Complete |
| 7b | Build Swing Trading Agent (10-step decision sequence) | Complete |
| 7c | Build Trade Analyst Agent (6-check approval gate) | Complete |
| 8 | Build Reflection Agent (structured JSON lessons — both strategies) | Complete |
| 9 | Build Weekly Review Agent (dual strategy report + updates) | Complete |
| 10 | Build Scheduler (all triggers for 6 agents) | Complete |
| 11 | Add Telegram Alerts (all alert types) | Complete |
| 12 | Write strategy.md + swing_strategy.md with trading team (manual) | Pending |
| 13 | Test on T212 Practice Account — minimum 2 weeks | Pending |
| 14 | Deploy to VPS | Pending |
| 15 | Monitor + tune | Pending |

Update the Status column in this table as each step is completed.

## Key Rules — Never Break These

1. Every trade opens as TWO positions (split-position method). Never open a single position.
2. Size per leg = (Total risk / 2) / (entry - SL). Never size each leg at the full risk%.
3. Max 3 open ICT positions. Max 3 open Swing positions. Combined max 5 total trades (10 T212 positions).
4. Daily loss kill switch at 4%. Weekly loss kill switch at 8%. No new trades after either.
5. Minimum composite score 65 to enter any trade (both strategies).
6. Minimum R:R to TP2: 2:1 (ICT) / 3:1 (Swing). No exceptions.
7. Trailing stops only on Tier 1 (score 80+) setups.
8. Weekly Review Agent cannot remove core risk management rules or kill switches.
9. Never change a strategy rule based on fewer than 10 trades. Small samples lie.
10. Never commit the .env file. API keys stay out of version control.
11. Coordination lock: one strategy per instrument at a time. Never stack ICT + Swing.
12. All trades must pass Trade Analyst Agent approval before execution.
13. VIX > 30 → Swing stands down, ICT Tier 1 only. VIX 20-30 → reduce size 25%.
14. Separate lesson pools for ICT and Swing. Never mix rules across strategies.

## Folder Structure

```
trading-bot/
├── src/
│   ├── mcp-server/
│   │   └── index.ts              ← MCP server + all 21 tools
│   ├── agents/
│   │   ├── trading-agent.ts      ← ICT intraday agent (5-step cycle)
│   │   ├── swing-agent.ts        ← Swing trading agent (10-step sequence) — NEW
│   │   ├── researcher-agent.ts   ← Market researcher (regime + briefs) — NEW
│   │   ├── analyst-agent.ts      ← Trade analyst (pre-trade approval) — NEW
│   │   ├── reflection-agent.ts   ← post-trade structured lesson writer (both strategies)
│   │   └── review-agent.ts       ← weekly strategy improver (both strategies)
│   ├── scheduler/
│   │   └── index.ts              ← all cron jobs + candle detection + agent triggers
│   ├── scanner/
│   │   └── index.ts              ← universe scanner — ranks instruments
│   ├── news/
│   │   └── index.ts              ← news context fetcher and scorer
│   └── database/
│       └── index.ts              ← SQLite setup + queries (split-leg trade schema)
├── memory/
│   ├── strategy.md               ← ICT intraday strategy — updated weekly
│   └── swing_strategy.md         ← Swing strategy — updated weekly — NEW
├── .env                          ← API keys (never committed)
├── .gitignore
├── CLAUDE.md                     ← this file
├── TRADING_BOT_MASTER.md         ← master planning document
├── AGENT_SYSTEM_PROMPTS_V3.docx.pdf ← V3 agent prompts (source of truth)
└── package.json
```

## Obsidian Progress Logging

After completing any build step, write a progress note to the Obsidian vault at:
`C:\Users\user\Desktop\Brain`

Create a folder called `Trading Bot` inside the vault if it does not exist.

For each completed step, create or update a file called `Trading Bot/Build Progress.md` with this format:

```markdown
# Trading Bot — Build Progress

## Step [N]: [Step Name]
**Date:** [YYYY-MM-DD]
**Status:** Complete

### What was built
- [Brief description of what was created]

### Files created or modified
- [List of files]

### Key decisions made during build
- [Any decisions or deviations from the plan]

### Notes
- [Anything worth remembering]

---
```

Append each new step to the bottom of the file so it becomes a running log.

Also update the Build Order table in this CLAUDE.md file — change the status from "Pending" to "Complete" for the finished step.

## How to Work With Me

- I am Giuseppe from BetterOpsAI. Always ask clarifying questions before building anything. Never guess.
- Build one step at a time from the build order. Do not skip ahead.
- After completing a step, update both the CLAUDE.md build order table and the Obsidian progress log.
- If a step has blockers (e.g. API key not available), scaffold the code with placeholder/mock data and note what needs to be plugged in later.
- When writing TypeScript, use strict types. This is a financial system — type safety matters.
- Test each component before moving to the next step.

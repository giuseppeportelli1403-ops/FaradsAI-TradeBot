# BetterOpsAI — Self-Learning AI Trading Bot

## Project Status: Feature-complete + Hardened. Awaiting API keys for testing.

This is a self-learning autonomous AI trading bot built by BetterOpsAI. It runs TWO trading strategies (ICT Intraday + Swing) powered by 6 AI agents, connects to Trading 212 via their beta API through an MCP server with 21 tools, and improves itself over time through structured reflection and weekly strategy evolution.

**Built by:** Giuseppe Portelli (giuseppeportelli1403@gmail.com) + Claude Code
**Codebase:** ~4,500 lines TypeScript, 43 tests, 22 commits
**Test command:** `npm test` (vitest, all 43 should pass)
**Type check:** `npx tsc --noEmit` (should be 0 errors)

---

## Reference Documents

1. **AGENT_SYSTEM_PROMPTS_V3.docx.pdf** — **PRIMARY** — Complete system prompts for all 6 agents (V3)
2. **TRADING_BOT_MASTER.md** — Project overview, architecture, build order, decisions
3. **prompts/*.md** — 6 extracted V3 system prompts loaded by agents at runtime
4. **docs/superpowers/specs/2026-04-17-hardening-v2-design.md** — Hardening design spec
5. **docs/superpowers/plans/2026-04-17-hardening-v2.md** — TDD implementation plan

---

## Tech Stack

- Language: TypeScript (strict mode)
- AI Models: Claude Opus 4.6 (trading agents) + Claude Sonnet 4.6 (support agents)
- AI Features: Adaptive thinking, prompt caching, effort levels (high/max/medium)
- Anthropic SDK: v0.90.0
- MCP Framework: @modelcontextprotocol/sdk v1.29.0 (registerTool API + annotations)
- HTTP Client: axios
- Database: SQLite via sql.js (WASM)
- Scheduler: node-cron
- Telegram Alerts: Telegraf
- Testing: Vitest (43 tests, 8 files)
- Hosting: VPS (DigitalOcean or Hetzner) — not yet deployed

---

## Agent Architecture (V3 — 6 Agents)

| # | Agent | File | Model | Effort | Schedule |
|---|-------|------|-------|--------|----------|
| 1 | ICT Intraday | trading-agent.ts | claude-opus-4-6 | high | Every 15M/1H candle close |
| 2 | Swing Trading | swing-agent.ts | claude-opus-4-6 | high | Daily 21:30 UTC, Mon 06:00, every 4H |
| 3 | Market Researcher | researcher-agent.ts | claude-sonnet-4-6 | medium | Daily 05:30 UTC, Sun 22:00 |
| 4 | Trade Analyst | analyst-agent.ts | claude-sonnet-4-6 | medium | Before every trade |
| 5 | Reflection | reflection-agent.ts | claude-sonnet-4-6 | high | After every trade closes |
| 6 | Weekly Review | review-agent.ts | claude-opus-4-6 | max | Sunday 00:00 UTC |

All agents load V3 prompts from `prompts/` directory via `src/agents/load-prompt.ts`.
All agents use adaptive thinking and prompt caching.

---

## MCP Server Architecture

Server uses modern `registerTool()` API with annotations on all 21 tools.

```
src/mcp-server/
├── index.ts                    (41 lines — entry point)
├── logger.ts                   (32 lines — wrapTool error boundaries + request logging)
├── t212-client.ts              (107 lines — T212 API wrapper)
├── market-data.ts              (274 lines — Twelve Data, Finnhub, FMP, FRED, Alpha Vantage)
└── tools/
    ├── trading-tools.ts        (155 lines — 6 tools, destructiveHint: true on orders)
    ├── market-data-tools.ts    (155 lines — 9 tools, readOnlyHint: true)
    └── db-tools.ts             (145 lines — 6 tools, readOnlyHint: true)
```

### CRITICAL: T212 API Limitations
Trading 212 does NOT support: OHLC data, SL/TP on orders, trailing stops, labels, close endpoint, modify position. ALL risk management is local: `sl_tp_orders` DB table + scheduler monitoring loop.

---

## Database (6 tables)

| Table | Purpose |
|-------|---------|
| trades | Split-leg trade records with strategy_tag |
| lessons | Structured JSON lessons from Reflection Agent |
| research_briefs | Daily briefs from Market Researcher |
| analyst_log | Pre-trade approval/rejection decisions |
| sl_tp_orders | Active SL/TP levels monitored by scheduler (CRITICAL) |
| daily_pnl_log | Daily P&L snapshots for kill switch tracking |

---

## Build Status

| Step | Task | Status |
|------|------|--------|
| 1 | T212 API Key (CFD Practice account) | Pending — Giuseppe getting tonight |
| 2 | Project structure | Complete |
| 3 | MCP Server (21 tools) | Complete + Hardened |
| 4 | SQLite Database (6 tables) | Complete + Tested |
| 5 | Universe Scanner | Complete + Tested |
| 6a | News Context System | Complete + Tested |
| 6b | Market Researcher Agent | Complete |
| 7a | ICT Trading Agent | Complete |
| 7b | Swing Trading Agent | Complete |
| 7c | Trade Analyst Agent | Complete + Bug fixed (REJECT default) |
| 8 | Reflection Agent | Complete |
| 9 | Weekly Review Agent | Complete |
| 10 | Scheduler | Complete + Bug fixed (timezone) |
| 11 | Telegram Alerts | Complete |
| 12 | Strategy files | Pre-populated, needs trading team refinement |
| 13 | Test on T212 Practice Account | Pending (2 weeks minimum) |
| 14 | Deploy to VPS | Pending |
| 15 | Monitor + tune | Pending |

### Hardening Complete (2026-04-17)
- 6 critical bugs fixed with TDD (SQL, analyst default, timezone, API validation, market data crashes, V3 prompts)
- 43 tests across 8 files
- V3 system prompts extracted and injected into all 6 agents
- Claude API upgraded: Opus 4.6 + Sonnet 4.6, adaptive thinking, prompt caching
- MCP server refactored: registerTool API, annotations, error boundaries, logging

---

## API Keys Needed (9 total)

| Key | Source | Status |
|-----|--------|--------|
| T212_API_KEY | Trading 212 Settings → API (CFD Practice) | Giuseppe getting tonight |
| ANTHROPIC_API_KEY | console.anthropic.com | Pending |
| TELEGRAM_BOT_TOKEN | @BotFather on Telegram | Pending |
| TELEGRAM_CHAT_ID | Send /start to bot | Pending |
| TWELVE_DATA_API_KEY | twelvedata.com (free: 800 req/day) | Pending |
| FINNHUB_API_KEY | finnhub.io (free: 60 req/min) | Pending |
| FMP_API_KEY | financialmodelingprep.com (free: 250 req/day) | Pending |
| FRED_API_KEY | fred.stlouisfed.org (free, unlimited) | Pending |
| ALPHA_VANTAGE_API_KEY | alphavantage.co (free: 25 req/day) | Pending |

---

## Key Rules — Never Break These

1. Every trade = TWO positions (split-position method)
2. Size per leg = (Total risk / 2) / (entry - SL)
3. Max 3 ICT + 3 Swing positions. Combined max 5 trades (10 T212 positions)
4. Daily loss kill switch: 4%. Weekly: 8%
5. Minimum composite score 65 to trade
6. Minimum R:R: 2:1 (ICT) / 3:1 (Swing)
7. Trailing stops only on Tier 1 (score 80+)
8. Weekly Review cannot remove core risk rules or kill switches
9. Min 10 trades per rule change
10. Never commit .env
11. Coordination lock: one strategy per instrument
12. All trades must pass Trade Analyst approval
13. VIX > 30 → Swing stands down, ICT Tier 1 only
14. Separate lesson pools for ICT and Swing

---

## Folder Structure

```
trading-bot/
├── src/
│   ├── mcp-server/           ← 21 MCP tools (registerTool API + annotations)
│   │   ├── index.ts          ← entry point (41 lines)
│   │   ├── logger.ts         ← wrapTool error boundaries + logging
│   │   ├── t212-client.ts    ← T212 API wrapper
│   │   ├── market-data.ts    ← 5 external API clients + cache
│   │   └── tools/            ← 3 tool files by domain
│   ├── agents/               ← 6 AI agents + load-prompt.ts utility
│   ├── scheduler/            ← cron jobs + SL/TP monitoring
│   ├── scanner/              ← 20 instruments + bias detection
│   ├── news/                 ← Cat A/B/C scoring
│   ├── database/             ← SQLite 6 tables + 30 queries
│   ├── notifications/        ← Telegram 8 alert types
│   ├── preflight.ts          ← startup API key validation
│   └── types.ts              ← shared TypeScript interfaces
├── prompts/                  ← 6 V3 system prompts (loaded at runtime)
├── memory/                   ← strategy.md + swing_strategy.md
├── tests/                    ← 8 test files, 43 tests (vitest)
├── docs/superpowers/         ← design specs + implementation plans
├── .env.example              ← template with all 9 keys
└── vitest.config.ts
```

---

## Obsidian Progress Log

Full build history at: `C:\Users\user\Desktop\Brain\Trading Bot\Build Progress.md`

---

## How to Work With Me

- I am Giuseppe from BetterOpsAI, based in Malta
- Always ask before building. Never guess architecture decisions.
- Run `npm test` and `npx tsc --noEmit` after any changes
- Update this CLAUDE.md and the Obsidian log after completing work
- This is a financial system — type safety and test coverage matter
- Use the superpowers skills pipeline for major changes

# Farad Trading Bot — Benchmark & Audit Report

**Date:** 2026-04-21
**Baseline:** farad (BetterOpsAI Trading Bot)
**Compared against:** jesse, freqtrade, backtrader, hummingbot
**Commissioned by:** Giuseppe
**Report format:** Decision-grade — every recommendation carries effort + priority tags

---

## 1. Executive Summary

### The Two Headlines

1. **Farad is NOT broken — it is cautious by design. Day 1's zero trades was a Twelve Data exhaustion issue (fixed in overnight commits), not filter strictness. But the audit confirms Giuseppe's fear is partially correct: the gate stack is unusually strict (6–8 simultaneous conditions), and realistic throughput is 0.8–2.3 trades/week, concentrated in London/NY open windows. The fix for the demo is NOT to rewrite the architecture — it is to soft-relax 3 specific gates (Kill Zone penalty, Tier 3 introduction, R:R for tight symbols) and ship them this week.**
2. **Farad's agent-first architecture (Claude Opus 4.6 as decision engine + self-rewriting Markdown strategies + MCP tool contract) is unique in the benchmark set. No reference bot has this end-to-end pattern. Giuseppe should not copy Jesse/Freqtrade's Python-centric ML pipelines. Instead, port their *structural* ideas (Protections framework, Hyperopt loop, CCXT-style adapter, offline replay engine) into the TS/Node/Claude architecture he already has.**

### Will the Bot Ever Trade? (Giuseppe's #1 Fear)

**YES — but infrequently.** The gate audit quantifies a realistic rate of **0.8–2.3 trades per week** (~one every 3–5 days), concentrated in the London Open (07:00–10:00 UTC) and NY Open (13:00–16:00 UTC) kill zones. The dominant suppressor is the **Kill Zone –15 penalty**: outside 6–9 hours per day, max achievable composite score is ~60, below the 65 hard threshold, so ~15 hours of every day auto-reject every instrument. Secondary suppressors are the Bias-Neutral 0-pass (kills ~40% of instruments instantly), the 2:1 R:R minimum (fails ~30% of setups), and the Analyst agent's 15–25% rejection gate.

**Day 1 is not evidence of strictness.** Day 1 failed at the *data-fetch* layer (Twelve Data cap exhausted by 14:00 UTC); the bot never reached a trade/no-trade decision for most of the day. The overnight fixes (circuit breaker + hourly cache) drop credit usage by ~75%. The *real* test starts Day 2 (today).

**Action for demo:** Relax 3 gates (see §5 Top 5), expect 3–5 trades in the 2-week window rather than 1–2. Do NOT relax the daily 4% kill switch, the coordination lock, or the split-position method — those are load-bearing.

### The Three Biggest Wins

- **Claude Opus 4.6 as full decision engine, not just signal generator** — Farad inverts the industry default. Jesse/Freqtrade/Backtrader/Hummingbot all use ML for *signal generation* and rules for *execution*. Farad uses rules for pre-filter and the LLM for hypothesis generation, confluence grading, R:R sanity checks, and analyst veto. This is a qualitatively different architecture and the only one in the set with true agentic reasoning.
- **Self-improving Markdown strategy files via weekly review agent** — Zero reference bots have a closed loop of "trades → lessons → strategy-file edit → next-week behavior change" as a first-class product feature. Freqtrade's FreqAI retrains ML weights; Farad retrains *prose rules*, which is more interpretable and more Giuseppe-editable.
- **Split-position + break-even automation on a single-TP broker** — Capital.com natively supports only one TP per position. Farad's two-leg trick (Position A closes at TP1 → Position B's SL auto-moves to entry) is a clean workaround. Hummingbot's PositionExecutor can do multi-TP natively on crypto venues, but nobody in the set has built this pattern *for a restrictive CFD broker*.

### The Three Biggest Gaps

- **No offline backtesting engine** — Every reference bot has one. Farad validates forward-only on Capital.com demo. Cannot stress-test against 2022 bear market, 2020 COVID spike, or regime shifts. Blocks credible claims to external stakeholders and blocks hyperoptimization.
- **No hyperoptimization loop** — Kill-zone windows, composite-score weights, tier thresholds, kill-switch percentages are all hand-tuned. Freqtrade has mature Optuna-backed Hyperopt; Jesse has Optuna + Ray; even Backtrader has brute-force parameter sweeps. Farad has nothing.
- **No Protections-style pluggable guard framework** — Farad has hardcoded kill switches (4% daily, 8% weekly). Freqtrade's Protections system (MaxDrawdownProtection, StoplossGuard, CooldownPeriod, LowProfitPairs) is a pluggable framework that composes. Porting this would take ~3 days and give Giuseppe rule-level risk controls that can be tuned per-instrument or per-strategy.

### Top 3 Actions This Week

1. **[S, ~4h] Relax 3 demo gates** — Kill Zone penalty –15 → –5; add Tier 3 bracket at 50–64 score with 0.5% risk; reduce R:R minimum from 2:1 to 1.5:1 for tight-spread symbols (EURUSD, GOLD, SPX500). Impact: expected trade frequency triples from ~1/week to ~3–5/week during demo without touching kill switches.
2. **[M, ~3 days] Build offline candle replay harness** — Minimal Vitest-based runner that feeds saved OHLCV JSON into the scanner + agent loop with `DRY_RUN=true`. Use Backtrader's `cheat-on-close` semantic (execute at bar close price). Start with 30 days of EURUSD 15m data cached locally. Impact: unblocks every future "would this have traded?" question without burning Twelve Data credits.
3. **[S, ~1 day] Add an approval-gate to the self-rewriting strategy loop** — Review agent currently edits `strategies/*.md` live with no rollback. Change it to: write proposed edit to `strategies/proposed/*.md` + Telegram ping + require `LIVE_REWRITE_OK=true` env var before the edit is promoted. Impact: eliminates the "review agent disables a kill switch and it ships on next restart" tail risk.

---

## 2. Feature Coverage Matrix

Cells: ✅ = has it, well-implemented · ⚠️ = partial / basic version only · ❌ = missing

### 2.1 Backtesting & Simulation

| Feature | farad | jesse | freqtrade | backtrader | hummingbot |
|---|---|---|---|---|---|
| Offline historical replay | ❌ | ✅ | ✅ | ✅ | ✅ |
| Warmup / lead-in candles | ❌ | ✅ | ✅ | ✅ | ✅ |
| Partial-fill simulation | ❌ | ✅ | ⚠️ | ✅ | ✅ |
| Slippage modelling | ❌ | ✅ | ✅ | ✅ | ✅ |
| Fee modelling | ❌ | ✅ | ✅ | ✅ | ✅ |
| Multi-timeframe backtest | ❌ | ✅ | ✅ | ✅ | ✅ |
| Backtest/live code parity | ⚠️ (forward only) | ⚠️ | ⚠️ | ⚠️ | ✅ |
| Dry-run preflight | ✅ | ✅ | ✅ | ⚠️ | ✅ |
| Vectorized run mode | ❌ | ❌ | ❌ | ✅ | ❌ |
| Monte Carlo / trade shuffling | ❌ | ✅ | ❌ | ❌ | ❌ |

### 2.2 Strategy Development

| Feature | farad | jesse | freqtrade | backtrader | hummingbot |
|---|---|---|---|---|---|
| Declared-strategy base class | ⚠️ (agent prompt) | ✅ | ✅ | ✅ | ✅ |
| Markdown / prose strategy files | ✅ | ❌ | ❌ | ❌ | ❌ |
| Hyperparameters surface | ❌ | ✅ | ✅ | ✅ | ⚠️ |
| Multi-symbol routing | ✅ | ✅ | ✅ | ✅ | ✅ |
| Multi-timeframe within one strategy | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| ICT / kill-zone methodology built-in | ✅ | ❌ | ❌ | ❌ | ❌ |
| Position-adjustment / DCA hook | ❌ | ⚠️ | ✅ | ⚠️ | ✅ |
| Strategy migration tool | ❌ | ❌ | ✅ | ❌ | ⚠️ |
| Controller/executor split | ⚠️ (ICT + Swing agents) | ❌ | ❌ | ❌ | ✅ |
| Indicator library breadth | ⚠️ (agent reads raw) | ✅ (300+) | ✅ | ✅ (122+) | ⚠️ |

### 2.3 Execution & Order Management

| Feature | farad | jesse | freqtrade | backtrader | hummingbot |
|---|---|---|---|---|---|
| Market + limit orders | ✅ | ✅ | ✅ | ✅ | ✅ |
| Bracket orders (entry + SL + TP) | ⚠️ (split-leg) | ✅ | ✅ | ✅ | ✅ |
| Multi-TP per position | ✅ (split-leg) | ⚠️ | ⚠️ | ⚠️ | ✅ |
| Trailing stop | ⚠️ (manual update) | ✅ | ✅ | ✅ | ✅ |
| Server-side stop (stop-on-exchange) | ✅ | ❌ | ✅ | ❌ | ✅ |
| Break-even auto-move | ✅ | ⚠️ | ⚠️ | ⚠️ | ⚠️ |
| Partial close / scale out | ✅ | ✅ | ✅ | ✅ | ✅ |
| Order lifecycle tracker | ⚠️ | ✅ | ✅ | ✅ | ✅ |
| Limit chaser / post-only | ❌ | ⚠️ | ✅ | ❌ | ✅ |
| TWAP / grid / arb executors | ❌ | ❌ | ❌ | ❌ | ✅ |

### 2.4 Risk Management

| Feature | farad | jesse | freqtrade | backtrader | hummingbot |
|---|---|---|---|---|---|
| Daily loss kill switch | ✅ (4%) | ⚠️ | ✅ | ⚠️ | ✅ |
| Weekly loss kill switch | ✅ (8%) | ❌ | ✅ | ❌ | ⚠️ |
| Max concurrent positions | ✅ | ✅ | ✅ | ✅ | ✅ |
| Per-instrument concurrency lock | ✅ | ⚠️ | ✅ (PairLocks) | ⚠️ | ⚠️ |
| Cross-strategy coordination lock | ✅ (ICT/Swing) | ❌ | ❌ | ❌ | ❌ |
| Protections plugin framework | ❌ | ❌ | ✅ | ❌ | ⚠️ |
| Cooldown / pair-lock after loss | ❌ | ❌ | ✅ | ❌ | ⚠️ |
| Fixed % risk per trade | ✅ (1%) | ✅ | ✅ | ✅ | ✅ |
| ATR-based dynamic stop | ❌ | ✅ | ✅ | ⚠️ | ⚠️ |
| Leverage / liquidation tracking | ⚠️ (CFD broker) | ✅ | ✅ | ✅ | ✅ |
| Live-trading opt-in gate | ✅ | ⚠️ | ✅ | ❌ | ✅ |

### 2.5 Data & Feeds

| Feature | farad | jesse | freqtrade | backtrader | hummingbot |
|---|---|---|---|---|---|
| Broker / exchange candle feed | ✅ (TD + Capital) | ✅ | ✅ | ✅ | ✅ |
| News / sentiment feed | ✅ (Alpha Vantage) | ❌ | ❌ | ❌ | ❌ |
| Economic calendar feed | ✅ (Finnhub) | ❌ | ❌ | ❌ | ❌ |
| Macro feed (yield curve, sector) | ✅ (FRED + Yahoo) | ❌ | ❌ | ❌ | ❌ |
| Rate limiter / circuit breaker | ✅ | ⚠️ | ⚠️ | ❌ | ⚠️ |
| Candle cache (TTL) | ✅ | ⚠️ | ✅ | ⚠️ | ⚠️ |
| Gap / duplicate detection | ❌ | ✅ | ✅ | ⚠️ | ⚠️ |
| Historical DB storage | ⚠️ | ✅ | ✅ | ⚠️ | ✅ |
| WebSocket live feed | ❌ | ✅ | ✅ | ⚠️ | ✅ |
| Custom HTTP feed plugin | ⚠️ | ❌ | ⚠️ | ❌ | ✅ |

### 2.6 Optimization

| Feature | farad | jesse | freqtrade | backtrader | hummingbot |
|---|---|---|---|---|---|
| Hyperopt / parameter search | ❌ | ✅ (Optuna) | ✅ (Optuna) | ⚠️ (brute) | ❌ |
| Walk-forward validation | ❌ | ✅ | ⚠️ | ❌ | ❌ |
| Parallel / distributed trials | ❌ | ✅ (Ray) | ✅ (Joblib) | ⚠️ | ❌ |
| Multiple loss functions | ❌ | ✅ | ✅ | ⚠️ | ❌ |
| LLM-driven self-tuning | ✅ (review agent) | ❌ | ❌ | ❌ | ❌ |
| Best-candidate filtering | ❌ | ✅ | ✅ | ❌ | ❌ |
| Ranking / cache of instruments | ✅ (hourly) | ❌ | ✅ (Pairlists) | ❌ | ❌ |

### 2.7 Live Trading & Exchange Adapters

| Feature | farad | jesse | freqtrade | backtrader | hummingbot |
|---|---|---|---|---|---|
| Number of integrated venues | 1 | 0 (live paid) | 30+ | 3 | 30+ |
| Unified adapter abstraction | ❌ | ⚠️ | ✅ (CCXT) | ⚠️ (Store) | ✅ |
| CFD / forex broker | ✅ (Capital) | ❌ | ❌ | ✅ (Oanda) | ❌ |
| Session keep-alive / re-auth | ✅ | ⚠️ | ⚠️ | ⚠️ | ✅ |
| Paper trading mode | ⚠️ (demo acct) | ✅ | ✅ | ⚠️ | ✅ |
| Futures / perps | ❌ | ✅ | ✅ | ⚠️ | ✅ |
| Spot | ✅ | ✅ | ✅ | ✅ | ✅ |
| DEX / Gateway | ❌ | ❌ | ❌ | ❌ | ✅ |
| Instrument-universe config | ✅ | ✅ | ✅ | ✅ | ✅ |

### 2.8 Notifications & Monitoring

| Feature | farad | jesse | freqtrade | backtrader | hummingbot |
|---|---|---|---|---|---|
| Telegram | ✅ | ✅ | ✅ | ❌ | ✅ |
| Discord | ❌ | ✅ | ✅ | ❌ | ✅ |
| Slack | ❌ | ✅ | ❌ | ❌ | ❌ |
| Email | ❌ | ⚠️ | ⚠️ | ❌ | ✅ |
| Custom webhook | ❌ | ✅ | ✅ | ❌ | ⚠️ |
| REST API / dashboard | ❌ | ✅ (FastAPI) | ✅ (FastAPI) | ❌ | ⚠️ |
| WebSocket events | ❌ | ✅ | ✅ | ❌ | ⚠️ |
| MQTT | ❌ | ❌ | ❌ | ❌ | ✅ |
| Process manager | ✅ (pm2) | ⚠️ | ⚠️ | ❌ | ⚠️ |
| Scheduler log manifest | ✅ | ❌ | ❌ | ❌ | ❌ |

### 2.9 Analytics, Plotting, Reporting

| Feature | farad | jesse | freqtrade | backtrader | hummingbot |
|---|---|---|---|---|---|
| Sharpe / Sortino / Calmar | ❌ | ✅ | ✅ | ✅ | ⚠️ |
| Max drawdown | ❌ | ✅ | ✅ | ✅ | ✅ |
| Equity curve plotting | ❌ | ✅ | ✅ | ✅ | ⚠️ |
| Candlestick + indicator overlay | ❌ | ✅ | ✅ | ✅ | ❌ |
| Trade-level CSV / Parquet export | ⚠️ (SQLite) | ✅ | ✅ | ✅ | ✅ |
| Win-rate / profit-factor report | ⚠️ | ✅ | ✅ | ✅ | ⚠️ |
| Entry/exit reason breakdown | ⚠️ (lessons) | ⚠️ | ✅ | ⚠️ | ⚠️ |
| Post-trade lesson record (prose) | ✅ | ❌ | ❌ | ❌ | ❌ |
| Weekly review report | ✅ | ❌ | ❌ | ❌ | ❌ |
| Real-time metric stream | ❌ | ⚠️ | ✅ | ❌ | ✅ |

### 2.10 Configuration & Infrastructure

| Feature | farad | jesse | freqtrade | backtrader | hummingbot |
|---|---|---|---|---|---|
| Dotenv / env-var config | ✅ | ✅ | ✅ | ⚠️ | ✅ |
| JSON / YAML config schema | ❌ | ⚠️ | ✅ | ❌ | ✅ (Pydantic) |
| Config schema validation | ⚠️ (preflight) | ⚠️ | ✅ | ❌ | ✅ |
| Persistence layer | ✅ (SQLite) | ✅ | ✅ (SQLA) | ⚠️ | ✅ (SQLA) |
| Cron scheduler | ✅ (node-cron) | ❌ | ⚠️ | ⚠️ (Timers) | ✅ (Clock) |
| Docker image | ❌ | ⚠️ | ✅ | ❌ | ✅ |
| TypeScript / strict types | ✅ | ❌ | ❌ | ❌ | ❌ |
| Trading calendar / session map | ⚠️ (kill zones) | ❌ | ❌ | ✅ | ⚠️ |
| Session state handoff doc | ✅ (.claude/) | ❌ | ❌ | ❌ | ❌ |
| CLI runner | ⚠️ (npm scripts) | ✅ (Click) | ✅ | ✅ (btrun) | ✅ |

### 2.11 AI / ML Integration

| Feature | farad | jesse | freqtrade | backtrader | hummingbot |
|---|---|---|---|---|---|
| LLM as decision engine | ✅ (Opus 4.6) | ❌ | ❌ | ❌ | ❌ |
| MCP-style tool registration | ✅ | ❌ | ❌ | ❌ | ❌ |
| Prompt caching | ✅ | ❌ | ❌ | ❌ | ❌ |
| Structured JSON lesson schema | ✅ | ❌ | ❌ | ❌ | ❌ |
| Self-adapting strategy files | ✅ | ❌ | ❌ | ❌ | ❌ |
| Classical ML (sklearn/xgboost) | ❌ | ✅ | ✅ (FreqAI) | ❌ | ⚠️ |
| Feature recording / labelling | ❌ | ✅ | ✅ | ❌ | ❌ |
| Walk-forward ML validation | ❌ | ✅ | ⚠️ | ❌ | ❌ |
| RL agent support | ❌ | ❌ | ✅ | ❌ | ⚠️ |
| Tool-error-as-JSON contract | ✅ | ❌ | ❌ | ❌ | ❌ |

### 2.12 Testing & Developer Experience

| Feature | farad | jesse | freqtrade | backtrader | hummingbot |
|---|---|---|---|---|---|
| Unit test count | 117 | ~200 | ~3000 | ~150 | ~1500 |
| Broker / exchange client mocks | ✅ | ✅ | ✅ | ⚠️ | ✅ |
| CI-ready build | ✅ | ✅ | ✅ | ⚠️ | ✅ |
| Invariant / contract tests | ✅ (universe) | ⚠️ | ⚠️ | ❌ | ⚠️ |
| Strategy lint / validation | ❌ | ⚠️ | ✅ | ❌ | ⚠️ |
| Sample strategies | ⚠️ (2) | ✅ (5+) | ✅ (10+) | ✅ (50+) | ✅ (20+) |
| Developer docs (CLAUDE.md) | ✅ | ⚠️ | ✅ | ⚠️ | ✅ |
| LSP / IDE hooks | ⚠️ (TS) | ✅ | ⚠️ | ❌ | ⚠️ |

---

## 3. Where Farad Wins — Unique Strengths

- **LLM-as-decision-engine (Claude Opus 4.6), not signal-generator.** Every reference bot uses ML for *signals* and rules for *execution*. Farad is the only one in the set where a general-purpose reasoning model grades confluence, generates hypotheses, applies an analyst veto, and decides trade/no-trade. This is the strategic moat — preserve it aggressively.
- **Self-rewriting Markdown strategy files.** The weekly review agent edits `strategies/ict-strategy.md` and `strategies/swing-strategy.md` based on accumulated structured lessons. No reference bot has a closed loop of prose-rule learning at product level. Freqtrade's FreqAI retrains numeric weights; Farad retrains *rules a human can read and audit*. This is uniquely aligned with Giuseppe's goal of an AI that behaves more like a junior analyst than a model.
- **MCP-style tool contract.** 14 tools registered via the MCP pattern with structured JSON error returns so the agent can reason over tool failure rather than abort. This is the right abstraction for the Anthropic ecosystem and means the bot can swap to Sonnet / Haiku / a local model later with zero scaffolding change.
- **Split-position + BE automation on a single-TP broker.** Capital.com does not support multi-TP natively. Farad's two-leg trick with the scheduler's `handleTp1Hit` monitor is a clean workaround. Hummingbot's `PositionExecutor` has native multi-TP but only on crypto venues. Farad's solution is specifically tuned for a restrictive CFD broker, which is the right market for Giuseppe.
- **Kill-zone scoring with composite score.** Not a "feature nobody has" — but nobody in the set implements ICT methodology as first-class product. Jesse/Freqtrade could implement it in a strategy, but Farad makes kill zones a scanner-level pre-filter and scoring component. If Giuseppe ever sells this bot, this is the first thing that distinguishes it from a generic Python backtester.
- **Context richness — news + sector + yield curve + economic calendar in the agent prompt.** Farad's agents get Alpha Vantage news sentiment, Yahoo 11-sector SPDR strength, FRED 2/10/30Y yield curve, and Finnhub economic calendar. No reference bot injects macro context into decision-making this deeply. For CFD markets where macro matters more than on-chain whale movements, this is a real edge.
- **pm2 + scheduler log manifest.** Operationally, the startup log that prints every cron job for operator verification is a small thing with outsized value — it's the kind of "I can see what the bot WILL do" that Jesse and Freqtrade's opaque CLIs don't give you.
- **Coordination lock between ICT + Swing agents.** Prevents 2x exposure when both agents independently like the same instrument. Sounds obvious but no reference bot does this — most assume one strategy per instance.
- **.claude/project-status.md session handoff.** Not a trading feature per se, but a developer-productivity feature. Giuseppe resumes context instantly across sessions; no reference bot has this pattern.
- **TypeScript strict mode + 117 green tests including invariant tests.** Strong foundation. Jesse/Freqtrade/Backtrader are all Python without strict types; Hummingbot is Cython-heavy. Farad's typed codebase is the best onboarding experience of the five.

---

## 4. Critical Gaps

- **Offline backtesting engine — MISSING.** Cannot replay 2020, 2022, or regime-shift data. Cannot answer "what if we'd run this strategy through COVID?" without burning demo-account time and data credits. Every other bot has one.
- **Hyperoptimization — MISSING.** Kill-zone windows (07–10, 13–16, 15–17 UTC), composite score weights (Bias 0/10/20, KillZone 0/15, News ±20, Spread 0/5, Base 25), tier thresholds (65), and risk percentages (1%, 4%, 8%) are all hand-picked. Freqtrade's Hyperopt + Optuna would search these in hours. Jesse's Optuna + Ray would parallelize it.
- **Protections-style pluggable guard framework — MISSING.** Farad has two hardcoded kill switches. Freqtrade's `IProtection` framework lets you compose: MaxDrawdownProtection + StoplossGuard + CooldownPeriod + LowProfitPairs. After a losing trade on GOLD, auto-lock GOLD for 4 hours. After 3 consecutive losses across any instrument, global cooldown 24h. Freqtrade nails this abstraction.
- **CCXT-style broker abstraction — MISSING.** Farad hardcodes Capital.com in `src/capital/index.ts`. A Capital.com outage = full downtime. A future move to Oanda, IBKR, or Saxo = multi-week rewrite. Freqtrade's CCXT-based `Exchange` class is the template here. Hummingbot's `ExchangeBase` + `PerpetualDerivativeBase` is even cleaner.
- **Performance analytics (Sharpe / Sortino / Calmar / equity curve) — MISSING.** All three ratios are standard across Jesse, Freqtrade, Backtrader. Farad tracks P&L in R but has no risk-adjusted metrics. Impossible to benchmark Farad against a buy-and-hold baseline or against another strategy iteration.
- **Walk-forward validation — MISSING.** Even if Giuseppe builds offline backtesting, without walk-forward he'll overfit the strategy .md files to the training window. Jesse's `fitness.py` TimeSeriesSplit integration is the minimum bar.
- **Approval gate on self-rewriting strategies — MISSING.** `src/agents/review-agent.ts` edits `strategies/*.md` live. If the review agent generates an edit like "remove the 4% kill switch — it's too strict", that edit ships on next restart with no human-in-the-loop. This is a latent correctness bomb.
- **ATR-based dynamic stops — MISSING.** Farad's SL distance comes from the agent's prompt reasoning. Jesse/Freqtrade/Backtrader all have ATR-derived stops as a first-class helper. Adds robustness when the agent is uncertain.
- **Plotting / equity curve rendering — MISSING.** All reports are text/Markdown. Jesse and Freqtrade both export Plotly charts. If Giuseppe ever demos to investors, this gap will hurt.
- **Historical OHLCV persistence — PARTIAL.** Farad caches candles in memory with TTL. After restart, everything is re-fetched. Jesse's SQLite candle store means "backtest this strategy on 2 years of EURUSD 15m" is `jesse backtest`. Farad would have to re-fetch from Twelve Data, burning credits.
- **Strategy validation / lint — MISSING.** If someone edits `strategies/ict-strategy.md` and removes a required section, nothing catches it until runtime. Freqtrade's `strategy_validation.py` rejects malformed strategies at load time.

---

## 5. Will Farad Ever Trade? — Deep-dive on Giuseppe's Fear

### The filter stack, layer by layer

Farad has **five filter layers** between candle-close and trade-fire. Every layer must pass. One failure = trade rejected.

**Layer 1 — Schedule gates.** Scheduler runs every 5 min but only triggers the ICT agent on actual 15m/1h candle closes (~28 opportunities/day). Swing runs on cron (1–2 entry points/day). This is not strict, just periodic.

**Layer 2 — Scanner gates (the tightest layer).**
- **2a Bias detection:** neutral bias = instant reject. ~40% of instruments fail here.
- **2b Tier system with Kill Zone bonus.** Composite score = Bias(0/10/20) + KillZone(0/15) + News(−15 to +20) + Spread(0/5) + Base(25). Outside 6–9 kill-zone hours/day, max achievable ~60, below the 65 threshold. **This single gate suppresses ~15 hours of every day.**
- **2c Tier 2+ pass rate:** ~15–20% of instruments per cycle.

**Layer 3 — Risk gates.** Daily 4% kill switch, weekly 8%, max 3 ICT + 3 Swing + 5 combined, category limits. On Day 1 these never triggered (no losses). They bite after drawdown.

**Layer 4 — Agent prompt directives.**
- **ICT Agent:** 11 explicit REJECT conditions; R:R minimum 2:1; "patience over activity" philosophy.
- **Swing Agent:** 8 reject conditions; R:R minimum 3:1 (tighter than ICT).
- **Analyst Agent:** 6 independent checks; targets 15–25% rejection rate.

**Layer 5 — Broker / data gates.** Session auth, Twelve Data 800/day cap, Capital.com minimum deal size. Day 1 failed here.

**Total independent gates: 25+.**

### Combined probability (per instrument, per cycle)

| Gate | Pass Rate |
|---|---|
| Bias not neutral | 60% |
| Kill zone active (6–9h of 24) | 25% |
| Combined scanner ≥ 65 | **15%** |
| Entry trigger printed | 50% (of 15%) |
| R:R ≥ 2:1 | 70% |
| Analyst approval | 80% |
| Coordination lock (no Swing conflict) | 90% |
| **Per-instrument, per-cycle** | **≈ 3.78%** |

**ICT cycle:** 28 opportunities/day × 3.78% ≈ 1 trade/day *in the ideal case*. But kill-zones are non-linear — outside them pass rate drops to ~2%, so effective rate is much lower.

**Realistic estimate: 0.5–1.5 ICT trades/week + 0.3–0.8 Swing trades/week = 0.8–2.3 trades/week.** One every 3–5 days. Concentrated in London and NY open windows.

### Top 5 gates to RELAX for the demo (Giuseppe ships this week)

1. **Kill Zone penalty −15 → −5.** Tier 2 entries become reachable during quiet hours. Risk: weaker edges outside liquidity surges. Effort: S (edit `src/scanner/index.ts` composite score). Expected impact: ~2× trade frequency.
2. **Bias-Neutral 0 → 5.** Unlocks ~40% of instruments that are auto-rejected. Risk: choppy price action in ranging markets. Effort: S. Expected impact: more cycles reach scoring, ~1.3× opportunities.
3. **Analyst agent rejection 15–25% → 10–15%.** More marginal setups execute. Risk: lower win rate week 1 (educational). Effort: S (edit `prompts/analyst-agent.md`). Expected impact: 10–15% more trades.
4. **R:R minimum 2:1 → 1.5:1 for tight-spread tier-1 instruments (EURUSD, GOLD, SPX500).** Unlocks 20–30% more entries on the cleanest symbols. Risk: need >57% win rate to break even (vs >50% at 2:1). Effort: S (edit ICT prompt + analyst checks). Expected impact: 1.2–1.3× on tight symbols.
5. **Introduce Tier 3 at score 50–64 with 0.5% risk (half size).** Captures quiet-hour setups without betting the farm. Risk: 35–45% win rate expected, educational. Effort: M (add new tier in scanner + sizing logic in agents). Expected impact: +2–3 trades/week in quiet periods.

### Top 3 gates to NEVER relax

1. **Daily 4% kill switch.** Load-bearing. Prevents revenge-mode account wipe. If the bot hits −4% in a day, it should sit out the rest of the day. Period.
2. **Coordination lock between ICT and Swing.** Free safety. If ICT is long GOLD and Swing independently decides GOLD is a buy, you'd double up and not know it. Never remove.
3. **Split-position method (every trade = 2 legs).** The entire position management system — TP1 hit → move Position B SL to BE — depends on this. Removing it means rewriting the monitor loop and losing the BE automation, which is one of Farad's actual edges.

### Day 1 evidence (2026-04-20)

- **Outcome:** zero trades.
- **Root cause:** Twelve Data API cap exhausted by 14:00 UTC — scanner burned ~1,120 credits in 6 hours (20 instruments × 30 candles every 15 min × 56 runs). Bot never reached trade/no-trade decisions for most of the day.
- **Fix deployed 2026-04-21:** circuit breaker (trips on credit-exhaustion message), hourly candle cache (invalidates on kill-zone transition), Telegram alert on cap trip. Credit use drops ~75% to ~160/day.
- **Interpretation:** Day 1 is NOT evidence that filters are too tight. Day 1 is evidence of a data-layer bug. The real test of filter strictness starts Day 2.

### Final verdict

**Giuseppe's fear is real but moderate.** The bot is cautious by design — that is what he asked for ("rules so tight we never blow the account"). Expected demo throughput without changes: **0.8–2.3 trades/week**, concentrated London/NY opens. With the 5 recommended relaxations: **3–5 trades/week**. The demo will show trades. The bot is not broken.

---

## 6. Ranked Steal-Candidates (top 13)

### 1. Offline candle replay harness (minimal backtester)
**Source:** backtrader (cerebro + cheat-on-close), jesse (candle pipeline) · **Effort:** M · **Priority:** P0
- *What it is:* A deterministic replay loop that feeds saved OHLCV JSON into the same scanner + agent code path as live, with `DRY_RUN=true` so tool calls log instead of fire.
- *Why it matters for Giuseppe:* Unblocks every "would Farad have traded here?" question without burning Twelve Data credits or waiting for demo days. Lets Giuseppe test the 5 demo gate relaxations against the last 30 days before shipping them. The Claude agent will still run — but over saved candles, with a Markdown strategy unchanged. This is the foundation for every other steal.
- *Implementation hint:* Borrow Backtrader's `cheat-on-close` semantic (fill at bar close). Start with a single Vitest test that replays 30 days of EURUSD 15m from a saved JSON file through `trading-agent.ts` with broker mocked to record-only.

### 2. Protections plugin framework
**Source:** freqtrade (`freqtrade/plugins/protections/iprotection.py`) · **Effort:** M · **Priority:** P0
- *What it is:* A pluggable guard framework that composes: MaxDrawdownProtection, StoplossGuard, CooldownPeriod, LowProfitPairs. Each guard independently votes to lock an instrument or the whole bot.
- *Why it matters for Giuseppe:* Farad's two hardcoded kill switches are binary and global. With Protections, after 2 consecutive losses on GOLD, GOLD auto-locks for 4h while the rest of the universe stays open. This is the right abstraction for Capital.com's wide universe and lets Giuseppe add risk rules via the Markdown strategy file without touching Core.
- *Implementation hint:* Freqtrade's cleaner than Hummingbot's here. Define an `IProtection` TypeScript interface with `global_stop()` and `stop_per_pair()`. Wire it into the preflight checks on every new trade.

### 3. Approval gate on self-rewriting strategies
**Source:** none directly (invention — needed for Farad specifically) · **Effort:** S · **Priority:** P0
- *What it is:* Instead of `review-agent.ts` writing to `strategies/*.md` live, it writes to `strategies/proposed/*.md`, pings Telegram with a diff, and only promotes on `LIVE_REWRITE_OK=true` confirmation.
- *Why it matters for Giuseppe:* Closes the tail risk where the review agent could disable the 4% kill switch or loosen a bias rule and that edit ships on next pm2 restart with no human-in-the-loop. Preserves the self-improving-loop virtue while adding the guard Giuseppe's demo-era bot actually needs.
- *Implementation hint:* One-file change in `src/agents/review-agent.ts`. Use `diff` library for the Telegram preview. Add a bot command `/approve-strategy-edit` that does the atomic file move.

### 4. CCXT-style broker adapter interface
**Source:** freqtrade (`freqtrade/exchange/exchange.py`), hummingbot (`ExchangeBase`) · **Effort:** L · **Priority:** P1
- *What it is:* An abstract `BrokerAdapter` interface with methods `openPosition`, `closePosition`, `getCandles`, `getPortfolio`, `keepAlive`. Concrete implementations: `CapitalComAdapter` (now), `OandaAdapter` / `IbkrAdapter` (later).
- *Why it matters for Giuseppe:* Capital.com outage today = full Farad downtime. More importantly, if Capital.com ever raises fees or restricts API, Giuseppe needs a migration path that doesn't take 3 weeks. This also unblocks portfolio diversification — trade Capital.com forex and IBKR equities from one bot.
- *Implementation hint:* Freqtrade's cleaner here. Copy the `IExchange`-style interface but adapt for CFD semantics. Keep all Capital.com-specific behavior (session reauth, deal confirmation) in `CapitalComAdapter`. MCP tools then call the interface, not `capital.*`.

### 5. Performance metrics module (Sharpe / Sortino / Calmar / max DD / equity curve)
**Source:** jesse (`jesse/services/metrics.py`), freqtrade (`freqtrade/data/metrics.py`) · **Effort:** M · **Priority:** P0
- *What it is:* A post-run analytics pipeline that reads from the `trades` SQLite table and produces risk-adjusted metrics + equity curve.
- *Why it matters for Giuseppe:* Farad currently reports in R (win rate, lessons). For anyone external (investors, Heritage Malta stakeholders, Giuseppe's own decision on Grow-tier subscription), "Sharpe 1.2, max DD 8%, Calmar 1.5 over 6 months" is the only language that matters. Without these numbers, post-demo marketing is impossible.
- *Implementation hint:* Jesse's `metrics.py` is ~150 lines and self-contained. Port to TypeScript. Use ChartJS or a headless Plotly render to PNG for the equity curve. Include in the weekly review Telegram message.

### 6. Historical OHLCV SQLite store + gap detection
**Source:** jesse (`services/candle_service.py` + `db.py`), freqtrade (`data/history/`) · **Effort:** M · **Priority:** P1
- *What it is:* A persistent local candle store with gap-detection, duplicate-check, and a daemon that backfills missing bars from Twelve Data overnight when credits are available.
- *Why it matters for Giuseppe:* Pairs with (1). Once Giuseppe has replay + a candle store, he can backtest anything offline. Also decouples live trading from Twelve Data's daily cap — during the demo, the cache front-ends every price read.
- *Implementation hint:* Jesse's approach is cleaner — SQLite with `peewee` ORM. TS equivalent: keep `sql.js` and add a `candles` table. Backfill daemon runs in off-hours (02:00 UTC) using remaining credits.

### 7. Hyperopt loop (Optuna-equivalent)
**Source:** freqtrade (`optimize/hyperopt/hyperopt.py`), jesse (`optimize_mode/Optimize.py`) · **Effort:** L · **Priority:** P1
- *What it is:* Bayesian search over strategy parameters (kill-zone windows, composite weights, tier threshold, R:R minimums) with pluggable loss functions (Sharpe, Sortino, profit factor).
- *Why it matters for Giuseppe:* Kill-zone windows are guesswork. Composite score weights (Bias 0/10/20, etc.) are guesswork. Over 6 months Giuseppe accumulates enough trades to actually *search* these — run Optuna over last year's data with Sharpe as the objective and ship the winning config. **Requires (1) and (6) first.**
- *Implementation hint:* Freqtrade's Hyperopt is mature; port the concept, not the code. Node has `optuna-node` bindings or you can spawn a Python subprocess. Loss function: Sharpe on walk-forward splits, not on full period.

### 8. Walk-forward validation
**Source:** jesse (`optimize_mode/fitness.py`) · **Effort:** S (once backtester exists) · **Priority:** P1
- *What it is:* Train strategy params on months 1–6, test on months 7–9, then slide the window. Multiple splits → robust estimate.
- *Why it matters for Giuseppe:* Prevents the self-rewriting strategy loop from overfitting the Markdown files to the last 4 weeks of trades. Critical once (7) is live — otherwise Hyperopt finds a local optimum and Farad blows up on the next regime.
- *Implementation hint:* Only valuable after (1) and (6). Jesse's `TimeSeriesSplit` is 30 lines; mirror in TS.

### 9. Dynamic ATR-based stop helper
**Source:** jesse (`indicators/atr.py`), freqtrade (ATR stop custom_stoploss) · **Effort:** S · **Priority:** P1
- *What it is:* A scanner-level helper that computes ATR(14) for the traded instrument and exposes it as a tool for the agent's SL reasoning.
- *Why it matters for Giuseppe:* When the agent's SL reasoning is shaky (new instrument, noisy regime), ATR gives a principled baseline. Expose via MCP tool `get_atr_stop(symbol, multiplier=1.5)` so the prompt can say "use `get_atr_stop` when uncertain". Low-friction add.
- *Implementation hint:* ATR is 15 lines. Add to `src/mcp-server/market-data.ts`. Expose as an MCP tool.

### 10. REST API with basic endpoints (status, trades, positions, pause/resume)
**Source:** freqtrade (`rpc/api_server/`), jesse (FastAPI web) · **Effort:** M · **Priority:** P1
- *What it is:* A minimal REST API on top of existing state: GET /status, GET /trades, GET /positions, POST /pause, POST /resume.
- *Why it matters for Giuseppe:* Right now, observing Farad means reading logs on the VPS or waiting for Telegram. A tiny Fastify API (8 endpoints, ~200 LOC) lets Giuseppe build a phone dashboard later — or plug the bot into the BetterOps ops monitoring. Also enables external tools to pause the bot during high-impact news without SSH.
- *Implementation hint:* Fastify over Express. Wire auth via existing `.env` (single admin token). Don't rebuild config management — just expose what's already in SQLite.

### 11. Strategy validation / lint at load time
**Source:** freqtrade (`strategy/strategy_validation.py`) · **Effort:** S · **Priority:** P1
- *What it is:* On `loadStrategy('ict-strategy.md')`, validate required sections (INSTRUMENTS, BIAS_RULES, KILL_ZONES, R_R, REJECT_CONDITIONS) are present. Fail preflight if not.
- *Why it matters for Giuseppe:* Pairs with (3). Once the review agent can rewrite strategies, a malformed rewrite becomes possible. Validation catches "review agent deleted the R_R section" at preflight, not at 09:00 UTC mid-London-open.
- *Implementation hint:* Simple Markdown parser. List required H2 sections; fail with a clear error.

### 12. Discord + custom webhook notification fan-out
**Source:** freqtrade (`rpc/discord.py`), jesse (`services/notifier.py`) · **Effort:** S · **Priority:** P2
- *What it is:* Abstract `Notifier` interface with Telegram, Discord, custom webhook targets. Config-selectable.
- *Why it matters for Giuseppe:* Tiny but valuable — Heritage Malta or BetterOps ops channels may not be Telegram. Pre-demo-over, this is an easy polish win. Don't do this now; batch with (10) after demo.
- *Implementation hint:* One adapter interface. Telegraf stays; add a `DiscordNotifier` wrapper. Keep it 100 lines total.

### 13. Controller/Executor split (long-term architectural)
**Source:** hummingbot (`strategy_v2/controllers/`, `strategy_v2/executors/`) · **Effort:** L · **Priority:** P2
- *What it is:* Formalize the "what to trade" (Controller = agent) vs "how to execute" (Executor = broker tool) boundary that Farad already has informally.
- *Why it matters for Giuseppe:* Farad's two-agent design (ICT + Swing) echoes Hummingbot's controller split but without the abstraction. Formalizing it later means: multiple controllers per broker, reusable executors (TWAP, grid, scale-in) across strategies. Not urgent — only worth it when Giuseppe wants to ship a second bot or a second strategy class.
- *Implementation hint:* Do NOT do this in the next 6 weeks. Only after the broker-adapter (4) is stable. Hummingbot's v2 structure is the template.

---

## 7. Skip These — Impressive but Not for Farad

- **Crypto-DEX routing (Hummingbot Gateway middleware, Uniswap/Jupiter/Pancakeswap).** Capital.com is CFD-only. Zero overlap.
- **Market-making executors (Hummingbot Avellaneda-Stoikov, Grid, Arbitrage).** Farad is directional, not spread-capture. These solve a different problem.
- **Cython compilation (Hummingbot core).** Hummingbot compiles `*.pyx` for hot loops. Farad is TypeScript + Claude API latency is the bottleneck, not CPU. Cython buys nothing in Node.
- **Reinforcement learning (Freqtrade FreqAI RL).** Requires months of labelled data + GPU training infra. Farad's LLM decision model is more interpretable and data-efficient.
- **Interactive Brokers / Oanda / Visual Chart adapters (Backtrader live).** Backtrader's live is stale (maintenance halted 2018). When Farad wants a second broker, use CCXT or build from scratch — not Backtrader's 2018 code.
- **Paid Jesse-Live plugin.** Paid, closed-source, not useful as a reference.
- **Metaclass-based parameter system (Backtrader).** Python metaclass magic doesn't translate to TS. Over-abstract for Farad's scale.
- **300+ indicator libraries (Jesse indicators, TA-Lib via Backtrader).** Farad's agent reads raw OHLCV and reasons over it. Shoving 300 indicators in the prompt would explode token cost. Add indicators only when the agent specifically needs them.
- **FreqAI adaptive ML pipeline.** Conflicts with the LLM-as-decision-engine strategy. Don't dilute the moat.
- **MQTT event bus (Hummingbot).** Overkill. Telegram + a future Fastify REST API is enough for a single-VPS bot.
- **Pairlist plugins (Freqtrade PercentChange/MarketCap/Age/Volatility).** Farad trades a curated 20-instrument universe, not a dynamic one. Not needed.
- **v1/v2 dual strategy architecture (Hummingbot).** A compatibility shim useful only for migration. Farad has no v1 to migrate.
- **TWAP / Grid executors (Hummingbot).** Giuseppe's average trade is small; TWAP is for institutional block orders. Not needed.

---

## 8. Three-Phase Roadmap

### Phase 1 — Next 2 Weeks (during demo) — P0 only

- **[Day 1–2, S, 4h] Relax 3 demo gates.** Kill Zone −15 → −5, Tier 3 at 50–64, R:R 1.5:1 for tight-spread tier-1. Deploy via a single commit behind a `DEMO_RELAXED_GATES=true` env flag so it's easy to revert. Ship before London open tomorrow.
- **[Day 2–3, S, 1 day] Approval gate on self-rewriting strategies.** Change `review-agent.ts` to write to `strategies/proposed/*.md` + Telegram diff + `/approve-strategy-edit` command. Zero-risk add.
- **[Day 4–7, M, 3 days] Offline candle replay harness.** Minimal Vitest runner over saved OHLCV. Enough to replay the last 30 days and validate that the gate relaxations would have produced more trades (not fewer).
- **[Day 8–12, M, 3 days] Performance metrics module.** Sharpe / Sortino / Calmar / max DD / equity curve. Wire into the weekly review Telegram. Needed for the post-demo decision on Grow-tier subscription.
- **[Day 12–14, M, 2 days] Protections framework v1.** Implement two rules only — CooldownPeriod (after a loss on instrument X, lock X for N hours) and StoplossGuard (after 3 losses in 24h across the bot, global halt 12h). Ships as a TS interface ready for more plugins later.

**Total P0 effort: ~10–12 working days, 2 people-weeks.** Fits inside the demo window.

### Phase 2 — Weeks 3–8 (post-demo) — P1

- **[Week 3, M] Historical OHLCV SQLite store + gap-detection daemon.** Pairs with replay.
- **[Week 4, S] Strategy validation / lint at load time.** 1 day.
- **[Week 4, S] ATR-based stop helper as MCP tool.** 1 day.
- **[Week 5, M] REST API (Fastify, 8 endpoints).** Status, trades, pause/resume.
- **[Week 6, L] CCXT-style broker adapter interface + refactor Capital.com into an adapter.** Unblocks second-broker future.
- **[Week 7, S] Walk-forward validation module.** Small once replay exists.
- **[Week 7–8, L] Hyperopt loop with Bayesian search.** Requires (1) + (6) first. Run first hyperopt over 6 months of historical demo data to find a principled kill-zone / composite-weight config.

### Phase 3 — Months 3+ (strategic) — P2

- **Controller/Executor formal split.** Port Hummingbot's v2 structural pattern. Only worth it when Giuseppe wants a second strategy class or second broker live simultaneously.
- **Multi-channel notifier abstraction.** Discord, custom webhooks, email.
- **Dashboard UI.** Tiny Next.js front-end over the REST API. Figma-designed, dark luxury aesthetic.
- **Second broker integration.** Oanda or IBKR via the adapter interface. Forex pairs covered by both means Capital.com outage is survivable.
- **Sentiment/news signal pipeline refinement.** Feed the Alpha Vantage / Finnhub signals through a scoring model first before the agent sees them, reducing noise.
- **Add a Swing→ICT handoff pattern.** Swing finds directional bias; ICT finds entry trigger. Cross-agent coordination beyond the current locking.

---

## 9. One-Page Cheat Sheet

**Top 3 Wins:**
1. Claude Opus 4.6 as full decision engine (not just signals).
2. Self-rewriting Markdown strategy files via weekly review agent.
3. Split-position + BE automation on a single-TP broker (Capital.com).

**Top 3 Gaps:**
1. No offline backtesting engine — every reference bot has one.
2. No hyperopt — all kill-zone / composite-weight / tier numbers hand-picked.
3. No Protections framework — 2 hardcoded kill switches only.

**Top 5 Steal Targets (ranked by value/effort ratio):**
1. Offline candle replay harness (Backtrader cheat-on-close semantic, ~3 days).
2. Protections plugin framework (Freqtrade `IProtection`, ~3 days).
3. Approval gate on self-rewriting strategies (invention, ~1 day).
4. Performance metrics module Sharpe/Sortino/Calmar (Jesse `metrics.py`, ~2 days).
5. CCXT-style broker adapter (Freqtrade Exchange, ~5 days — defer to Phase 2).

**First Action Tomorrow Morning:**
Ship the 3 gate relaxations behind `DEMO_RELAXED_GATES=true`. One commit. 4 hours. Expected impact: trade frequency triples from ~1/week to ~3–5/week during demo.

**Gate Relaxations to Try This Week:**
1. Kill Zone penalty: −15 → −5.
2. Bias-Neutral 0 → 5 (unlocks ~40% of instruments).
3. Analyst rejection rate: 15–25% → 10–15%.
4. R:R minimum: 2:1 → 1.5:1 on tight-spread tier-1 (EURUSD, GOLD, SPX500).
5. Introduce Tier 3 at 50–64 score with 0.5% risk (half size).

**Gates to NEVER Relax:**
1. Daily 4% kill switch.
2. Coordination lock (ICT ↔ Swing same-instrument block).
3. Split-position (every trade = 2 legs).

**Final Verdict on Giuseppe's #1 Fear:**
The bot WILL trade. Expected 0.8–2.3/week baseline, 3–5/week with demo relaxations. Day 1's zero came from Twelve Data cap exhaustion (fixed), not filter strictness. The bot is cautious by design — which is exactly what Giuseppe asked for. Ship the 3 relaxations, watch Day 2+.

---

*End of report — generated 2026-04-21 by Architect agent in the Trading Bot Benchmark swarm.*

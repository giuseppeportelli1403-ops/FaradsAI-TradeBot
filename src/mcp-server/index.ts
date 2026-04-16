// MCP Server — Trading 212 API + Market Data Integration
// Exposes 21 tools for the trading agents via Model Context Protocol
//
// === TRADING 212 TOOLS (14) ===
//   get_prices(instrument, timeframe)          — candle data (15m, 1h, 4h, 1d, 1w)
//   get_portfolio()                            — current open positions
//   get_balance()                              — available cash and account equity
//   place_order(instrument, direction, size, sl, tp, label) — execute a single order leg
//   partial_close(positionId, units)           — manually close specified units
//   close_position(positionId)                 — fully exit an open trade
//   set_trailing_stop(positionId, distance)    — replace fixed SL with trailing stop
//   update_sl(positionId, newSL)               — move stop loss
//   log_trade(tradeData)                       — save trade to DB (split-leg format, includes strategy_tag)
//   get_lessons(setup_type, instrument_category, kill_zone) — retrieve filtered past lessons
//   get_ranked_instruments(limit)              — top-ranked instruments from universe scanner
//   get_news_context(instrument)               — scored news items for an instrument
//   get_daily_pnl()                            — today's running P&L
//   get_trade_history(limit)                   — fetch last N trades from DB
//
// === MARKET DATA TOOLS (7) — used by Researcher + Swing agents ===
//   get_economic_calendar(days_ahead)          — upcoming macro events in next N days
//   get_correlation_matrix(instrument)         — correlation with related assets (e.g. DXY vs FX)
//   get_sector_strength()                      — relative strength of equity sectors
//   get_vix()                                  — current VIX and 30-day average
//   get_dxy()                                  — dollar index and recent direction
//   get_yield_curve()                          — 2y, 10y, 30y Treasury yields
//   write_research_brief(content)              — save brief to shared memory for trading agents
//
// Implementation: Step 3

export {};

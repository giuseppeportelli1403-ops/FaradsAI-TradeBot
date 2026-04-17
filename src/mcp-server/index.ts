// MCP Server — BetterOpsAI Trading Bot
// Exposes 21 tools for the 6 AI trading agents via Model Context Protocol
//
// Tools are split by domain:
//   trading-tools.ts  — 6 tools (place_order, partial_close, close_position, set_trailing_stop, update_sl, log_trade)
//   market-data-tools.ts — 9 tools (get_prices, get_news_context, get_economic_calendar, get_correlation_matrix,
//                                    get_sector_strength, get_vix, get_dxy, get_yield_curve, write_research_brief)
//   db-tools.ts — 6 tools (get_portfolio, get_balance, get_daily_pnl, get_trade_history, get_lessons, get_ranked_instruments)
//
// Every tool is wrapped with:
//   - Error boundaries (try/catch → isError: true)
//   - Request logging (tool name, params, duration, result)
//   - Input validation (zod schemas with .positive(), .min(), etc.)

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTradingTools } from './tools/trading-tools.js';
import { registerMarketDataTools } from './tools/market-data-tools.js';
import { registerDbTools } from './tools/db-tools.js';

const server = new McpServer({
  name: 'betterops-trading-bot',
  version: '0.2.0',
});

// Register all 21 tools
registerTradingTools(server);
registerMarketDataTools(server);
registerDbTools(server);

// Start server
async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('BetterOpsAI MCP Server v0.2.0 running on stdio (21 tools registered)');
}

main().catch((error) => {
  console.error('MCP Server fatal error:', error);
  process.exit(1);
});

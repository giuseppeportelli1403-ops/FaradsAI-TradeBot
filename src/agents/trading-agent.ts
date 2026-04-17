// ICT Intraday Trading Agent — 5-Step Decision Cycle
// Called every time a new 15M or 1H candle closes
// Uses Claude Sonnet to analyse ICT structure and make trade decisions
//
// The agent receives market data via MCP tools and uses the system prompt
// from AGENT_SYSTEM_PROMPTS_V3 Section 1 to guide its reasoning.

import Anthropic from '@anthropic-ai/sdk';
import { loadPrompt, loadStrategy } from './load-prompt.js';
import { getLatestBrief, countOpenPositions, getOpenTradesByInstrument } from '../database/index.js';

const anthropic = new Anthropic();

// ==================== MCP TOOL DEFINITIONS ====================
// These are passed to Claude as tool schemas so it can call them

const MCP_TOOLS: Anthropic.Messages.Tool[] = [
  {
    name: 'get_daily_pnl',
    description: 'Get today\'s running P&L, equity, and kill switch status',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'get_portfolio',
    description: 'Get current open positions from Capital.com',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'get_ranked_instruments',
    description: 'Get top instruments ranked by preliminary composite score',
    input_schema: {
      type: 'object' as const,
      properties: { limit: { type: 'number', description: 'Number of instruments to return' } },
      required: [],
    },
  },
  {
    name: 'get_prices',
    description: 'Fetch OHLC candle data for an instrument',
    input_schema: {
      type: 'object' as const,
      properties: {
        instrument: { type: 'string', description: 'Ticker symbol' },
        timeframe: { type: 'string', enum: ['15m', '1h', '4h', '1d', '1w'] },
        count: { type: 'number', description: 'Number of candles' },
      },
      required: ['instrument', 'timeframe'],
    },
  },
  {
    name: 'get_news_context',
    description: 'Get scored news items for an instrument',
    input_schema: {
      type: 'object' as const,
      properties: { instrument: { type: 'string' } },
      required: ['instrument'],
    },
  },
  {
    name: 'get_lessons',
    description: 'Retrieve past lessons filtered by setup type, category, kill zone',
    input_schema: {
      type: 'object' as const,
      properties: {
        setup_type: { type: 'string' },
        instrument_category: { type: 'string' },
        kill_zone: { type: 'string' },
        strategy_tag: { type: 'string', enum: ['ICT_INTRADAY'] },
      },
      required: [],
    },
  },
  {
    name: 'place_order',
    description: 'Place a market order on Capital.com',
    input_schema: {
      type: 'object' as const,
      properties: {
        epic: { type: 'string' },
        direction: { type: 'string', enum: ['long', 'short'] },
        size: { type: 'number' },
        sl: { type: 'number' },
        tp: { type: 'number' },
        label: { type: 'string' },
      },
      required: ['epic', 'direction', 'size', 'sl', 'tp', 'label'],
    },
  },
  {
    name: 'log_trade',
    description: 'Log a trade to the database with both leg IDs',
    input_schema: {
      type: 'object' as const,
      properties: { trade_data: { type: 'string', description: 'JSON string of trade record' } },
      required: ['trade_data'],
    },
  },
  {
    name: 'update_sl',
    description: 'Update stop loss for a trade in the database',
    input_schema: {
      type: 'object' as const,
      properties: { trade_id: { type: 'string' }, new_sl: { type: 'number' } },
      required: ['trade_id', 'new_sl'],
    },
  },
  {
    name: 'close_position',
    description: 'Close a position on Capital.com',
    input_schema: {
      type: 'object' as const,
      properties: { dealId: { type: 'string' } },
      required: ['dealId'],
    },
  },
];

// ==================== TOOL EXECUTOR ====================
// Routes tool calls from Claude to the actual MCP tool implementations

import {
  fetchCandles, fetchNewsContext as fetchNewsRaw,
} from '../mcp-server/market-data.js';
import { getRankedInstruments } from '../scanner/index.js';
import {
  insertTrade, getTradeHistory, getLessons, getLessonWinRate,
  createSlTpOrder, updateSlPrice, getDailyPnl, upsertDailyPnl,
} from '../database/index.js';
import { CapitalClient } from '../mcp-server/capital-client.js';

const capital = new CapitalClient({
  apiKey: process.env.CAPITAL_API_KEY || '',
  identifier: process.env.CAPITAL_IDENTIFIER || '',
  password: process.env.CAPITAL_PASSWORD || '',
  baseURL: process.env.CAPITAL_API_URL || 'https://demo-api-capital.backend-capital.com',
});

async function getPreferredAccountBalance(): Promise<{ balance: number; deposit: number; profitLoss: number; available: number }> {
  const accounts = await capital.getAccounts();
  const preferred = accounts.find((a) => a.preferred) ?? accounts[0];
  if (!preferred) {
    throw new Error('No Capital.com account available');
  }
  return preferred.balance;
}

async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'get_daily_pnl': {
      const balance = await getPreferredAccountBalance();
      const today = new Date().toISOString().split('T')[0];
      const daily = getDailyPnl(today);
      const pnl = balance.profitLoss + (daily?.realised_pnl ?? 0);
      const equity = balance.balance;
      const pct = equity ? (pnl / equity) * 100 : 0;
      return JSON.stringify({
        total_daily_pnl: pnl, equity,
        daily_pnl_pct: Math.round(pct * 100) / 100,
        kill_switch_active: pct <= -4,
        open_positions: countOpenPositions(),
      });
    }
    case 'get_portfolio':
      return JSON.stringify(await capital.getOpenPositions());
    case 'get_ranked_instruments':
      return JSON.stringify(await getRankedInstruments(Number(input.limit) || 20));
    case 'get_prices':
      return JSON.stringify(await fetchCandles(
        input.instrument as string,
        input.timeframe as '15m' | '1h' | '4h' | '1d' | '1w',
        Number(input.count) || 100
      ));
    case 'get_news_context':
      return JSON.stringify(await fetchNewsRaw(input.instrument as string));
    case 'get_lessons': {
      const lessons = getLessons({
        setup_type: input.setup_type as string | undefined,
        instrument_category: input.instrument_category as string | undefined,
        kill_zone: input.kill_zone as string | undefined,
        strategy_tag: 'ICT_INTRADAY',
      });
      const wr = getLessonWinRate({ strategy_tag: 'ICT_INTRADAY' });
      return JSON.stringify({ lessons, win_rate: wr });
    }
    case 'place_order': {
      const direction: 'BUY' | 'SELL' = input.direction === 'long' ? 'BUY' : 'SELL';
      const confirmation = await capital.openPosition({
        direction,
        epic: input.epic as string,
        size: Math.abs(Number(input.size)),
        stopLevel: Number(input.sl),
        profitLevel: Number(input.tp),
      });
      return JSON.stringify({ capital_result: confirmation, local: input });
    }
    case 'log_trade': {
      const trade = JSON.parse(input.trade_data as string);
      insertTrade(trade);
      createSlTpOrder({ trade_id: trade.id, leg: 'A', instrument: trade.instrument, direction: trade.direction, quantity: trade.size_a, sl_price: trade.sl, tp_price: trade.tp1 });
      createSlTpOrder({ trade_id: trade.id, leg: 'B', instrument: trade.instrument, direction: trade.direction, quantity: trade.size_b, sl_price: trade.sl, tp_price: trade.tp2 });
      return JSON.stringify({ status: 'logged', trade_id: trade.id });
    }
    case 'update_sl':
      updateSlPrice(input.trade_id as string, 'A', Number(input.new_sl));
      updateSlPrice(input.trade_id as string, 'B', Number(input.new_sl));
      return JSON.stringify({ status: 'updated' });
    case 'close_position':
      return JSON.stringify(await capital.closePosition(input.dealId as string));
    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

// ==================== MAIN AGENT LOOP ====================

export async function runTradingAgent(): Promise<void> {
  console.log('ICT Trading Agent starting decision cycle...');

  const systemPrompt = loadPrompt('ict-agent.md');
  const strategy = loadStrategy('strategy.md');
  const brief = getLatestBrief();

  const contextMessage = `Current UTC time: ${new Date().toISOString()}

STRATEGY FILE:
${strategy}

${brief ? `LATEST RESEARCH BRIEF:
${JSON.stringify(brief, null, 2)}` : 'No research brief available yet.'}

Begin your 5-step decision cycle now. Start with Step 1 (check daily risk status).`;

  // Agentic loop: Claude calls tools, we execute, feed results back
  let messages: Anthropic.Messages.MessageParam[] = [
    { role: 'user', content: contextMessage },
  ];

  const maxIterations = 15;

  for (let i = 0; i < maxIterations; i++) {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      tools: MCP_TOOLS,
      messages,
    });

    // Collect text and thinking output
    for (const block of response.content) {
      if (block.type === 'thinking') {
        console.log('[ICT Agent Thinking]', block.thinking.substring(0, 200));
      } else if (block.type === 'text' && block.text.trim()) {
        console.log('[ICT Agent]', block.text);
      }
    }

    // If stop_reason is end_turn, the agent is done
    if (response.stop_reason === 'end_turn') {
      console.log('ICT Trading Agent decision cycle complete.');
      break;
    }

    // If there are tool calls, execute them
    if (response.stop_reason === 'tool_use') {
      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];

      for (const block of response.content) {
        if (block.type === 'tool_use') {
          console.log(`[ICT Agent] Calling tool: ${block.name}`);
          const result = await executeTool(block.name, block.input as Record<string, unknown>);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: result,
          });
        }
      }

      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });
    }
  }
}

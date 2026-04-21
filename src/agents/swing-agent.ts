// Swing Trading Agent — 10-Step Decision Sequence
// Multi-timeframe trend pullback with confluence
// Called daily at 21:30 UTC, Monday 06:00 UTC, every 4H during sessions
//
// Uses Claude Sonnet with the system prompt from AGENT_SYSTEM_PROMPTS_V3 Section 2

import Anthropic from '@anthropic-ai/sdk';
import { loadPrompt, loadPromptWithDemoContext, loadStrategy } from './load-prompt.js';
import { getLatestBrief, countOpenPositions, getOpenTradesByInstrument } from '../database/index.js';

const anthropic = new Anthropic();

// Same MCP tools as ICT agent but with additional timeframes
const MCP_TOOLS: Anthropic.Messages.Tool[] = [
  { name: 'get_daily_pnl', description: 'Get today\'s P&L and kill switch status', input_schema: { type: 'object' as const, properties: {}, required: [] } },
  { name: 'get_portfolio', description: 'Get open positions', input_schema: { type: 'object' as const, properties: {}, required: [] } },
  { name: 'get_ranked_instruments', description: 'Get ranked instruments', input_schema: { type: 'object' as const, properties: { limit: { type: 'number' } }, required: [] } },
  { name: 'get_prices', description: 'Fetch OHLC candles (supports 15m, 1h, 4h, 1d, 1w)', input_schema: { type: 'object' as const, properties: { instrument: { type: 'string' }, timeframe: { type: 'string', enum: ['15m', '1h', '4h', '1d', '1w'] }, count: { type: 'number' } }, required: ['instrument', 'timeframe'] } },
  { name: 'get_news_context', description: 'Get scored news', input_schema: { type: 'object' as const, properties: { instrument: { type: 'string' } }, required: ['instrument'] } },
  { name: 'get_economic_calendar', description: 'Upcoming macro events', input_schema: { type: 'object' as const, properties: { days_ahead: { type: 'number' } }, required: [] } },
  { name: 'get_correlation_matrix', description: 'Correlations with related assets', input_schema: { type: 'object' as const, properties: { instrument: { type: 'string' } }, required: ['instrument'] } },
  { name: 'get_sector_strength', description: 'Relative sector strength', input_schema: { type: 'object' as const, properties: {}, required: [] } },
  { name: 'get_lessons', description: 'Past lessons', input_schema: { type: 'object' as const, properties: { setup_type: { type: 'string' }, instrument_category: { type: 'string' }, strategy_tag: { type: 'string', enum: ['SWING'] } }, required: [] } },
  { name: 'place_order', description: 'Place order on Capital.com', input_schema: { type: 'object' as const, properties: { epic: { type: 'string' }, direction: { type: 'string', enum: ['long', 'short'] }, size: { type: 'number' }, sl: { type: 'number' }, tp: { type: 'number' }, label: { type: 'string' } }, required: ['epic', 'direction', 'size', 'sl', 'tp', 'label'] } },
  { name: 'log_trade', description: 'Log trade to DB', input_schema: { type: 'object' as const, properties: { trade_data: { type: 'string' } }, required: ['trade_data'] } },
  { name: 'update_sl', description: 'Update SL in DB', input_schema: { type: 'object' as const, properties: { trade_id: { type: 'string' }, new_sl: { type: 'number' } }, required: ['trade_id', 'new_sl'] } },
  { name: 'close_position', description: 'Close position on Capital.com', input_schema: { type: 'object' as const, properties: { dealId: { type: 'string' } }, required: ['dealId'] } },
];

// Tool executor — reuses the same implementations as ICT agent
import { fetchCandles, fetchNewsContext as fetchNewsRaw, fetchEconomicCalendar, fetchSectorStrength, computeCorrelation } from '../mcp-server/market-data.js';
import { getRankedInstruments } from '../scanner/index.js';
import { insertTrade, getLessons, getLessonWinRate, createSlTpOrder, updateSlPrice, getDailyPnl } from '../database/index.js';
import { alertTradePlaced } from '../notifications/telegram.js';
import { CapitalClient } from '../mcp-server/capital-client.js';

const capital = new CapitalClient({
  apiKey: process.env.CAPITAL_API_KEY || '',
  identifier: process.env.CAPITAL_IDENTIFIER || '',
  password: process.env.CAPITAL_API_KEY_PASSWORD || '',
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
      return JSON.stringify({ total_daily_pnl: pnl, equity, daily_pnl_pct: Math.round(pct * 100) / 100, kill_switch_active: pct <= -6, open_positions: countOpenPositions() });
    }
    case 'get_portfolio': return JSON.stringify(await capital.getOpenPositions());
    case 'get_ranked_instruments': return JSON.stringify(await getRankedInstruments(Number(input.limit) || 20));
    case 'get_prices': return JSON.stringify(await fetchCandles(input.instrument as string, input.timeframe as '15m' | '1h' | '4h' | '1d' | '1w', Number(input.count) || 100));
    case 'get_news_context': return JSON.stringify(await fetchNewsRaw(input.instrument as string));
    case 'get_economic_calendar': return JSON.stringify(await fetchEconomicCalendar(Number(input.days_ahead) || 5));
    case 'get_correlation_matrix': return JSON.stringify(await computeCorrelation(input.instrument as string, 'DXY'));
    case 'get_sector_strength': return JSON.stringify(await fetchSectorStrength());
    case 'get_lessons': {
      const lessons = getLessons({ setup_type: input.setup_type as string | undefined, instrument_category: input.instrument_category as string | undefined, strategy_tag: 'SWING' });
      return JSON.stringify({ lessons, win_rate: getLessonWinRate({ strategy_tag: 'SWING' }) });
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
      return JSON.stringify(confirmation);
    }
    case 'log_trade': {
      const trade = JSON.parse(input.trade_data as string);
      insertTrade(trade);
      createSlTpOrder({ trade_id: trade.id, leg: 'A', instrument: trade.instrument, direction: trade.direction, quantity: trade.size_a, sl_price: trade.sl, tp_price: trade.tp1, deal_id: trade.position_a_id });
      createSlTpOrder({ trade_id: trade.id, leg: 'B', instrument: trade.instrument, direction: trade.direction, quantity: trade.size_b, sl_price: trade.sl, tp_price: trade.tp2, deal_id: trade.position_b_id });
      if (trade.size_c !== undefined && trade.size_c !== null && trade.tp3 !== undefined && trade.tp3 !== null) {
        createSlTpOrder({ trade_id: trade.id, leg: 'C', instrument: trade.instrument, direction: trade.direction, quantity: trade.size_c, sl_price: trade.sl, tp_price: trade.tp3, deal_id: trade.position_c_id });
      }
      await alertTradePlaced(trade);
      return JSON.stringify({ status: 'logged', trade_id: trade.id });
    }
    case 'update_sl': updateSlPrice(input.trade_id as string, 'B', Number(input.new_sl)); return JSON.stringify({ status: 'updated' });
    case 'close_position': return JSON.stringify(await capital.closePosition(input.dealId as string));
    default: return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

// ==================== MAIN AGENT LOOP ====================

export async function runSwingAgent(): Promise<void> {
  console.log('Swing Trading Agent starting decision cycle...');

  const systemPrompt = loadPromptWithDemoContext('swing-agent.md');
  const strategy = loadStrategy('swing_strategy.md');
  const brief = getLatestBrief();

  const contextMessage = `Current UTC time: ${new Date().toISOString()}

SWING STRATEGY FILE:
${strategy}

${brief ? `LATEST RESEARCH BRIEF:\n${JSON.stringify(brief, null, 2)}` : 'No research brief available yet.'}

Begin your 10-step decision sequence now. Start with Step 1 (risk check).`;

  let messages: Anthropic.Messages.MessageParam[] = [
    { role: 'user', content: contextMessage },
  ];

  // Iteration cap 15 → 8 (2026-04-21) mirrors ICT agent. Swing cycles
  // rarely needed >8 iterations; capping forces earlier decision on
  // long-running research loops.
  for (let i = 0; i < 8; i++) {
    const response = await anthropic.messages.create({
      // Cost optimisation (2026-04-21 part 3): now on Sonnet + medium effort
      // to match ICT agent. Swing's per-cycle reasoning budget shrinks but
      // the 3×/day session-boundary cadence (reduced from 7×/day in this
      // same PR) means total Claude spend drops roughly 2× on Swing. Revert
      // to 'claude-opus-4-6' + effort:'high' if multi-timeframe confluence
      // quality regresses noticeably.
      model: 'claude-sonnet-4-6',
      // max_tokens 16000 → 12000 (2026-04-21) matches ICT agent.
      max_tokens: 12000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      tools: MCP_TOOLS,
      messages,
    });

    for (const block of response.content) {
      if (block.type === 'text' && block.text.trim()) console.log('[Swing Agent]', block.text);
    }

    if (response.stop_reason === 'end_turn') { console.log('Swing Agent decision cycle complete.'); break; }

    if (response.stop_reason === 'tool_use') {
      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type === 'tool_use') {
          console.log(`[Swing Agent] Calling tool: ${block.name}`);
          let content: string;
          try {
            content = await executeTool(block.name, block.input as Record<string, unknown>);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.warn(`[Swing Agent] Tool ${block.name} failed: ${message}`);
            content = JSON.stringify({ error: message, tool: block.name });
          }
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content });
        }
      }
      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });
    }
  }
}

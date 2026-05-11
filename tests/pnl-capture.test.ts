// tests/pnl-capture.test.ts
import { describe, it, expect, vi } from 'vitest';
import { parsePnlString, matchTransactionsToLegs, capturePnlForTrade, captureAndPersistPnl } from '../src/scheduler/pnl-capture.js';
import type { Transaction, TradeRecord } from '../src/types.js';

describe('parsePnlString', () => {
  it('parses plain positive numbers', () => {
    expect(parsePnlString('12.50')).toBe(12.5);
  });
  it('parses plain negative numbers', () => {
    expect(parsePnlString('-3.21')).toBe(-3.21);
  });
  it('parses comma-thousand-separator format', () => {
    expect(parsePnlString('1,234.56')).toBe(1234.56);
  });
  it('strips leading currency symbols if Capital includes them', () => {
    expect(parsePnlString('€19.22')).toBe(19.22);
    expect(parsePnlString('$-3.21')).toBe(-3.21);
  });
  it('returns null on empty / non-numeric inputs', () => {
    expect(parsePnlString('')).toBeNull();
    expect(parsePnlString(undefined)).toBeNull();
    expect(parsePnlString('N/A')).toBeNull();
  });
});

const baseTx = (over: Partial<Transaction>): Transaction => ({
  date: '2026-05-07T13:35:00.000',
  reference: 'REF-DEFAULT',
  transactionType: 'TRADE',
  size: 1,
  currency: 'EUR',
  profitAndLoss: '0',
  ...over,
});

const baseTrade = (over: Partial<TradeRecord>): TradeRecord => ({
  id: 'trade-1',
  strategy_tag: 'ICT_INTRADAY',
  instrument: 'GOLD',
  instrument_category: 'COMMODITY',
  direction: 'long',
  setup_type: 'OB_RETEST',
  entry: 4735,
  sl: 4723,
  tp1: 4748,
  tp2: 4760,
  position_a_id: 'DEAL-A',
  position_b_id: 'DEAL-B',
  size_a: 0.5,
  size_b: 0.3,
  status: 'complete',
  pnl_a: null,
  pnl_b: null,
  pnl_total: null,
  composite_score: 65,
  kill_zone: 'NY_OPEN',
  news_category: null,
  analyst_decision: 'APPROVE',
  reasoning: '',
  closure_reason: null,
  opened_at: '2026-05-07T13:16:50.502Z',
  closed_at: '2026-05-07T13:35:01.106Z',
  ...over,
} as TradeRecord);

describe('matchTransactionsToLegs', () => {
  it('matches by exact size when both legs differ', () => {
    const trade = baseTrade({});
    const txs = [
      baseTx({ size: 0.5, profitAndLoss: '10.50', reference: 'X' }),
      baseTx({ size: 0.3, profitAndLoss: '8.72', reference: 'Y' }),
    ];
    const result = matchTransactionsToLegs(txs, trade, 'EUR');
    expect(result.pnlA).toBeCloseTo(10.5);
    expect(result.pnlB).toBeCloseTo(8.72);
    expect(result.pnlTotal).toBeCloseTo(19.22);
    expect(result.unmatched).toBe(0);
  });

  it('falls back to total-only when sizes are ambiguous', () => {
    const trade = baseTrade({ size_a: 0.5, size_b: 0.5 });
    const txs = [
      baseTx({ size: 0.5, profitAndLoss: '6.00' }),
      baseTx({ size: 0.5, profitAndLoss: '6.01' }),
    ];
    const result = matchTransactionsToLegs(txs, trade, 'EUR');
    expect(result.pnlA).toBeNull();
    expect(result.pnlB).toBeNull();
    expect(result.pnlTotal).toBeCloseTo(12.01);
  });

  it('filters by currency', () => {
    const trade = baseTrade({});
    const txs = [
      baseTx({ size: 0.5, profitAndLoss: '10.50', currency: 'USD' }), // wrong currency
      baseTx({ size: 0.3, profitAndLoss: '8.72', currency: 'EUR' }),
    ];
    const result = matchTransactionsToLegs(txs, trade, 'EUR');
    expect(result.pnlTotal).toBeCloseTo(8.72);
  });

  it('skips rows with null profitAndLoss', () => {
    const trade = baseTrade({});
    const txs = [
      baseTx({ size: 0.5, profitAndLoss: undefined }),
      baseTx({ size: 0.3, profitAndLoss: '5.00' }),
    ];
    const result = matchTransactionsToLegs(txs, trade, 'EUR');
    expect(result.pnlTotal).toBeCloseTo(5);
  });

  it('returns zero matches when no transactions in window', () => {
    const trade = baseTrade({});
    const result = matchTransactionsToLegs([], trade, 'EUR');
    expect(result.pnlTotal).toBe(0);
    expect(result.matched).toBe(0);
  });

  it('tags transactions whose size matches neither leg as unmatched (avoids polluting pnlTotal from adjacent trades)', () => {
    const trade = baseTrade({});  // size_a=0.5, size_b=0.3
    const txs = [
      baseTx({ size: 0.5, profitAndLoss: '10.50' }),       // leg A
      baseTx({ size: 0.3, profitAndLoss: '8.72' }),        // leg B
      baseTx({ size: 1.7, profitAndLoss: '99.99' }),       // unrelated trade
    ];
    const result = matchTransactionsToLegs(txs, trade, 'EUR');
    expect(result.pnlA).toBeCloseTo(10.5);
    expect(result.pnlB).toBeCloseTo(8.72);
    expect(result.pnlTotal).toBeCloseTo(19.22);
    expect(result.matched).toBe(2);
    expect(result.unmatched).toBe(1);
  });
});

describe('capturePnlForTrade', () => {
  it('returns pnl from broker transactions for a closed trade', async () => {
    const trade = baseTrade({});
    const capital = {
      getTransactionHistory: async (_from?: string, _to?: string) => ([
        baseTx({ size: 0.5, profitAndLoss: '10.50' }),
        baseTx({ size: 0.3, profitAndLoss: '8.72' }),
      ]),
    };
    const result = await capturePnlForTrade({
      trade,
      capital,
      accountCurrency: 'EUR',
      now: () => new Date('2026-05-07T13:40:00.000Z'),
    });
    expect(result.pnlTotal).toBeCloseTo(19.22);
    expect(result.pnlA).toBeCloseTo(10.5);
    expect(result.pnlB).toBeCloseTo(8.72);
    expect(result.matched).toBe(2);
  });

  it('returns zero-match result without throwing on Capital error', async () => {
    const trade = baseTrade({});
    const capital = {
      getTransactionHistory: async () => {
        throw new Error('Capital API down');
      },
    };
    const result = await capturePnlForTrade({
      trade,
      capital,
      accountCurrency: 'EUR',
      now: () => new Date('2026-05-07T13:40:00.000Z'),
    });
    expect(result.pnlTotal).toBe(0);
    expect(result.matched).toBe(0);
    expect(result.note).toContain('Capital API down');
  });

  it('uses [opened_at, now+5min] as the query window', async () => {
    const trade = baseTrade({});
    let capturedFrom = '';
    let capturedTo = '';
    const capital = {
      getTransactionHistory: async (from?: string, to?: string) => {
        capturedFrom = from ?? '';
        capturedTo = to ?? '';
        return [];
      },
    };
    await capturePnlForTrade({
      trade,
      capital,
      accountCurrency: 'EUR',
      now: () => new Date('2026-05-07T13:40:00.000Z'),
    });
    // Capital format strips milliseconds and Z (see scheduler/index.ts:299-301).
    expect(capturedFrom).toBe('2026-05-07T13:16:50');
    expect(capturedTo).toBe('2026-05-07T13:45:00');
  });

  it('partial windowMode uses [now-1min, now+5min] for tight isolation', async () => {
    const trade = baseTrade({});
    let capturedFrom = '';
    let capturedTo = '';
    const capital = {
      getTransactionHistory: async (from?: string, to?: string) => {
        capturedFrom = from ?? '';
        capturedTo = to ?? '';
        return [];
      },
    };
    await capturePnlForTrade({
      trade,
      capital,
      accountCurrency: 'EUR',
      windowMode: 'partial',
      now: () => new Date('2026-05-07T13:40:00.000Z'),
    });
    expect(capturedFrom).toBe('2026-05-07T13:39:00');  // now - 1min
    expect(capturedTo).toBe('2026-05-07T13:45:00');    // now + 5min
  });
});

describe('captureAndPersistPnl — partial-close defense', () => {
  it('skips write when partial capture finds multiple ambiguous-size matches', async () => {
    const trade = baseTrade({ size_a: 0.5, size_b: 0.5 }); // ambiguous
    const persist = vi.fn();
    let warnMsg = '';
    const origWarn = console.warn;
    console.warn = (msg: string) => { warnMsg = msg; };
    try {
      await captureAndPersistPnl({
        trade,
        capture: async () => ({
          pnlA: null, pnlB: null, pnlTotal: 12.01, matched: 2, unmatched: 0, note: '', found: true,
        }),
        persist,
        logTag: '[pnl-capture:close-partial]',
        legHint: 'A',
      });
    } finally {
      console.warn = origWarn;
    }
    expect(persist).not.toHaveBeenCalled();
    expect(warnMsg).toContain('ambiguous-size matches in window, skipping write');
  });
});

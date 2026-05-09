import { describe, it, expect, vi } from 'vitest';
import { computeBeStop, handleTp1Hit } from '../src/scheduler/index.js';
import type { TradeRecord } from '../src/types.js';

describe('computeBeStop', () => {
  it('long: entry + 0.1R when 0.1R > 2×spread (GOLD R=12.54)', () => {
    const beStop = computeBeStop({
      direction: 'long', entry: 4735.54, sl: 4723, instrument: 'GOLD',
    });
    // R = 12.54, 0.1R = 1.254, 2×spread = 0.80 → 0.1R wins
    expect(beStop).toBeCloseTo(4736.794, 3);
  });

  it('short: entry − 0.1R when 0.1R > 2×spread', () => {
    const beStop = computeBeStop({
      direction: 'short', entry: 4735.54, sl: 4748.08, instrument: 'GOLD',
    });
    expect(beStop).toBeCloseTo(4734.286, 3); // 4735.54 - 1.254
  });

  it('small-R FX long: spread floor wins over 0.1R (EURUSD R=5pips)', () => {
    const beStop = computeBeStop({
      direction: 'long', entry: 1.10000, sl: 1.09995, instrument: 'EURUSD',
    });
    // R = 0.00005, 0.1R = 0.000005, 2×spread = 0.00016 → spread floor wins
    expect(beStop).toBeCloseTo(1.10016, 5);
  });

  it('small-R FX short: spread floor in opposite direction', () => {
    const beStop = computeBeStop({
      direction: 'short', entry: 1.10000, sl: 1.10005, instrument: 'EURUSD',
    });
    expect(beStop).toBeCloseTo(1.09984, 5); // 1.10000 - 0.00016
  });

  it('zero-R defensive: returns entry exactly and warns', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const beStop = computeBeStop({
      direction: 'long', entry: 100, sl: 100, instrument: 'GOLD',
    });
    expect(beStop).toBe(100);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('zero R'),
    );
    warnSpy.mockRestore();
  });

  it('invariant sweep: 5 instruments × 2 directions, beStop respects sign', () => {
    const cases: Array<{ inst: string; entry: number; sl: number; }> = [
      { inst: 'EURUSD', entry: 1.10, sl: 1.099 },
      { inst: 'GBPUSD', entry: 1.27, sl: 1.268 },
      { inst: 'GOLD',   entry: 4735, sl: 4723  },
      { inst: 'SILVER', entry: 78.88, sl: 78.03 },
      { inst: 'OIL_CRUDE', entry: 75.0, sl: 74.5 },
    ];
    for (const { inst, entry, sl } of cases) {
      const long  = computeBeStop({ direction: 'long',  entry, sl, instrument: inst });
      const short = computeBeStop({ direction: 'short', entry, sl: 2*entry - sl, instrument: inst });
      expect(long).toBeGreaterThan(entry);
      expect(short).toBeLessThan(entry);
    }
  });
});

const makeTrade = (over: Partial<TradeRecord> = {}): TradeRecord => ({
  id: 'trade-test', strategy_tag: 'ICT_INTRADAY', instrument: 'GOLD',
  instrument_category: 'commodity', direction: 'long', setup_type: 'OB_retest',
  entry: 4735.54, sl: 4723, tp1: 4748.08, tp2: 4751.84, tp3: null,
  position_a_id: 'A', position_b_id: 'B', position_c_id: null,
  size_a: 0.56, size_b: 0.24, size_c: null,
  status: 'open',
  pnl_a: null, pnl_b: null, pnl_c: null, pnl_total: null,
  composite_score: 65, kill_zone: 'NY Open',
  news_category: null, analyst_decision: 'APPROVE', reasoning: '',
  closure_reason: null, opened_at: '2026-05-08T13:00:00Z', closed_at: null,
  ...over,
});

const makeDeps = (amendResult: 'applied' | 'skipped') => {
  const calls: Array<{ dealId: string; changes: any }> = [];
  return {
    calls,
    capital: {
      safelyAmendPosition: vi.fn(async (dealId: string, changes: any) => {
        calls.push({ dealId, changes });
        if (amendResult === 'applied') return { applied: true, dealStatus: 'ACCEPTED' } as any;
        return { applied: false, dealReference: `synthetic-amend-skipped-${dealId}` } as any;
      }),
    } as any,
    updateTradeStatus: vi.fn(),
    deactivateSlTpOrder: vi.fn(),
    alertTp1Hit: vi.fn(async () => {}),
  };
};

describe('handleTp1Hit — offset + applied logging', () => {
  it('long 2-leg: amends Leg B SL to entry + max(0.1R, 2×spread); logs "applied"', async () => {
    const trade = makeTrade();
    const deps = makeDeps('applied');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await handleTp1Hit(trade, trade.id, deps as any);
    expect(deps.calls).toHaveLength(1);
    expect(deps.calls[0].dealId).toBe('B');
    expect(deps.calls[0].changes.stopLevel).toBeCloseTo(4736.794, 3);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\[TP1\] GOLD .* applied/),
    );
    logSpy.mockRestore();
  });

  it('short 2-leg: SL goes BELOW entry by floored offset', async () => {
    const trade = makeTrade({ direction: 'short', entry: 4735.54, sl: 4748.08, tp1: 4723, tp2: 4719 });
    const deps = makeDeps('applied');
    await handleTp1Hit(trade, trade.id, deps as any);
    expect(deps.calls[0].changes.stopLevel).toBeCloseTo(4734.286, 3);
  });

  it('race-skip: status flips to tp1_hit; "skipped" log fires; no throw', async () => {
    const trade = makeTrade();
    const deps = makeDeps('skipped');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await handleTp1Hit(trade, trade.id, deps as any);
    expect(deps.updateTradeStatus).toHaveBeenCalledWith(trade.id, 'tp1_hit');
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\[TP1\] GOLD .* skipped \(race against fast TP fill\)/),
    );
    logSpy.mockRestore();
  });

  it('undefined applied defaults to "applied" log (defensive against future callers that forget the field)', async () => {
    const trade = makeTrade();
    const deps = {
      ...makeDeps('applied'),
      capital: {
        safelyAmendPosition: vi.fn(async () => ({ /* no applied field */ dealStatus: 'ACCEPTED' } as any)),
      } as any,
    };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await handleTp1Hit(trade, trade.id, deps as any);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringMatching(/applied/),
    );
    expect(logSpy).not.toHaveBeenCalledWith(
      expect.stringMatching(/skipped/),
    );
    logSpy.mockRestore();
  });
});

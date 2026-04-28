// Tests for ensureTradeId — fixes the "insertTrade: required field(s) missing: id"
// production bug logged 2026-04-24 09:27 UTC where the agent's log_trade payload
// omitted the id field, throwing in insertTrade and orphaning the trade record.
import { describe, it, expect } from 'vitest';
import { ensureTradeId } from '../src/agents/trade-id.js';

describe('ensureTradeId', () => {
  it('generates a trade-prefixed UUID id when the field is missing', () => {
    const result = ensureTradeId({ instrument: 'EURUSD' });
    expect(result.id).toMatch(/^trade-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('generates a trade-prefixed UUID id when the field is empty string', () => {
    const result = ensureTradeId({ id: '', instrument: 'EURUSD' });
    expect(result.id).toMatch(/^trade-/);
  });

  it('generates a trade-prefixed UUID id when the field is undefined', () => {
    const result = ensureTradeId({ id: undefined, instrument: 'EURUSD' });
    expect(result.id).toMatch(/^trade-/);
  });

  it('preserves an existing non-empty id verbatim', () => {
    const result = ensureTradeId({ id: 'trade-legacy-abc123', instrument: 'EURUSD' });
    expect(result.id).toBe('trade-legacy-abc123');
  });

  it('produces unique ids on consecutive calls', () => {
    const a = ensureTradeId({}).id;
    const b = ensureTradeId({}).id;
    expect(a).not.toBe(b);
  });

  it('does not mutate the input payload', () => {
    const input: { id?: string; instrument: string } = { instrument: 'EURUSD' };
    ensureTradeId(input);
    expect(input.id).toBeUndefined();
  });

  it('preserves all other fields on the payload', () => {
    const input = {
      instrument: 'SILVER',
      direction: 'short',
      strategy_tag: 'ICT_INTRADAY',
      setup_type: 'bearish_ob_retest',
    };
    const result = ensureTradeId(input);
    expect(result.instrument).toBe('SILVER');
    expect(result.direction).toBe('short');
    expect(result.strategy_tag).toBe('ICT_INTRADAY');
    expect(result.setup_type).toBe('bearish_ob_retest');
  });
});

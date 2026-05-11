// tests/pnl-capture.test.ts
import { describe, it, expect } from 'vitest';
import { parsePnlString } from '../src/scheduler/pnl-capture.js';

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

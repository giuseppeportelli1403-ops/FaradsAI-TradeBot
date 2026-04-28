// Tests for parseTwelveDataDatetime — robust UTC parsing for TD candle
// datetime strings. Codex review CR-3 (2026-04-28) flagged that the prior
// inline `Date.parse(String(v.datetime).replace(' ', 'T') + 'Z')` would
// produce invalid strings ("...ZZ", "...+02:00Z") when TD returned ISO
// formats already containing a timezone. An invalid parse silently bypassed
// the future-candle drop guard.
import { describe, it, expect } from 'vitest';
import { parseTwelveDataDatetime } from '../src/mcp-server/td-datetime.js';

describe('parseTwelveDataDatetime', () => {
  it('parses bare YYYY-MM-DD HH:mm:ss as UTC', () => {
    const ms = parseTwelveDataDatetime('2026-04-28 12:00:00');
    expect(ms).toBe(Date.UTC(2026, 3, 28, 12, 0, 0));
  });

  it('parses ISO-8601 with Z suffix as UTC', () => {
    const ms = parseTwelveDataDatetime('2026-04-28T12:00:00Z');
    expect(ms).toBe(Date.UTC(2026, 3, 28, 12, 0, 0));
  });

  it('parses ISO-8601 with millisecond Z suffix', () => {
    const ms = parseTwelveDataDatetime('2026-04-28T12:00:00.500Z');
    expect(ms).toBe(Date.UTC(2026, 3, 28, 12, 0, 0) + 500);
  });

  it('parses ISO-8601 with positive UTC offset', () => {
    // 14:00+02:00 = 12:00 UTC
    const ms = parseTwelveDataDatetime('2026-04-28T14:00:00+02:00');
    expect(ms).toBe(Date.UTC(2026, 3, 28, 12, 0, 0));
  });

  it('parses ISO-8601 with negative UTC offset', () => {
    // 07:00-05:00 = 12:00 UTC
    const ms = parseTwelveDataDatetime('2026-04-28T07:00:00-05:00');
    expect(ms).toBe(Date.UTC(2026, 3, 28, 12, 0, 0));
  });

  it('parses ISO-8601 with compact offset (no colon)', () => {
    // Some feeds emit +0200 instead of +02:00
    const ms = parseTwelveDataDatetime('2026-04-28T14:00:00+0200');
    expect(ms).toBe(Date.UTC(2026, 3, 28, 12, 0, 0));
  });

  it('returns null on empty string', () => {
    expect(parseTwelveDataDatetime('')).toBeNull();
  });

  it('returns null on garbage input', () => {
    expect(parseTwelveDataDatetime('not a date')).toBeNull();
    expect(parseTwelveDataDatetime('2026-99-99 99:99:99')).toBeNull();
  });

  it('returns null on undefined / null', () => {
    expect(parseTwelveDataDatetime(undefined as unknown as string)).toBeNull();
    expect(parseTwelveDataDatetime(null as unknown as string)).toBeNull();
  });

  it('round-trips a Date.toISOString back to its original ms value', () => {
    const original = Date.UTC(2026, 5, 15, 8, 30, 45);
    const iso = new Date(original).toISOString(); // '2026-06-15T08:30:45.000Z'
    expect(parseTwelveDataDatetime(iso)).toBe(original);
  });

  it('does not double-append Z when input already has Z (regression for CR-3)', () => {
    // The prior bug: replace(' ', 'T') + 'Z' on '2026-04-28T12:00:00Z' produced
    // '2026-04-28T12:00:00ZZ', which Date.parse returns NaN for. The new helper
    // must detect the trailing Z and not append another.
    expect(parseTwelveDataDatetime('2026-04-28T12:00:00Z')).not.toBeNull();
  });

  it('does not append Z when input has an offset (regression for CR-3)', () => {
    // The prior bug: replace(' ', 'T') + 'Z' on '2026-04-28T14:00:00+02:00'
    // produced '2026-04-28T14:00:00+02:00Z', invalid. The new helper must
    // detect the offset suffix and parse as-is.
    const ms = parseTwelveDataDatetime('2026-04-28T14:00:00+02:00');
    expect(ms).not.toBeNull();
    expect(ms).toBe(Date.UTC(2026, 3, 28, 12, 0, 0));
  });
});

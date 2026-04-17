// Tests for preflight environment checks
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { checkEnvKeys } from '../src/preflight.js';

describe('checkEnvKeys', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Clone env to avoid pollution between tests
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns canStart=false when required T212_API_KEY is missing', () => {
    delete process.env.T212_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const result = checkEnvKeys();
    expect(result.canStart).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some(e => e.includes('T212_API_KEY'))).toBe(true);
  });

  it('returns canStart=false when required ANTHROPIC_API_KEY is missing', () => {
    process.env.T212_API_KEY = 'some-key';
    delete process.env.ANTHROPIC_API_KEY;
    const result = checkEnvKeys();
    expect(result.canStart).toBe(false);
    expect(result.errors.some(e => e.includes('ANTHROPIC_API_KEY'))).toBe(true);
  });

  it('returns canStart=true with warnings when optional keys are missing', () => {
    process.env.T212_API_KEY = 'key1';
    process.env.ANTHROPIC_API_KEY = 'key2';
    // All optional keys missing
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    delete process.env.TWELVE_DATA_API_KEY;
    delete process.env.FINNHUB_API_KEY;
    delete process.env.FMP_API_KEY;
    delete process.env.FRED_API_KEY;
    delete process.env.ALPHA_VANTAGE_API_KEY;

    const result = checkEnvKeys();
    expect(result.canStart).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('returns clean result when all keys are present', () => {
    process.env.T212_API_KEY = 'key1';
    process.env.ANTHROPIC_API_KEY = 'key2';
    process.env.TELEGRAM_BOT_TOKEN = 'key3';
    process.env.TELEGRAM_CHAT_ID = 'key4';
    process.env.TWELVE_DATA_API_KEY = 'key5';
    process.env.FINNHUB_API_KEY = 'key6';
    process.env.FMP_API_KEY = 'key7';
    process.env.FRED_API_KEY = 'key8';
    process.env.ALPHA_VANTAGE_API_KEY = 'key9';

    const result = checkEnvKeys();
    expect(result.canStart).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });
});

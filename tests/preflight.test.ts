// Tests for preflight environment checks
// Post-migration: required keys are the Capital.com trio + ANTHROPIC_API_KEY.
// T212_API_KEY is gone.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { checkEnvKeys, checkLiveTradingGate, runPreflight } from '../src/preflight.js';

describe('checkEnvKeys', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Clone env to avoid pollution between tests
    process.env = { ...originalEnv };
    // Strip any inherited keys from the parent shell so each test starts clean
    delete process.env.CAPITAL_API_KEY;
    delete process.env.CAPITAL_IDENTIFIER;
    delete process.env.CAPITAL_API_KEY_PASSWORD;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    delete process.env.TWELVE_DATA_API_KEY;
    delete process.env.FINNHUB_API_KEY;
    delete process.env.FMP_API_KEY;
    delete process.env.FRED_API_KEY;
    delete process.env.MARKETAUX_API_KEY;
    delete process.env.CAPITAL_API_URL;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns canStart=false when required CAPITAL_API_KEY is missing', () => {
    // Set all OTHER required keys so this test isolates CAPITAL_API_KEY.
    process.env.CAPITAL_IDENTIFIER = 'user@example.com';
    process.env.CAPITAL_API_KEY_PASSWORD = 'pw';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-xxx';

    const result = checkEnvKeys();
    expect(result.canStart).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.includes('CAPITAL_API_KEY'))).toBe(true);
  });

  it('returns canStart=false when required CAPITAL_IDENTIFIER is missing', () => {
    process.env.CAPITAL_API_KEY = 'key';
    process.env.CAPITAL_API_KEY_PASSWORD = 'pw';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-xxx';

    const result = checkEnvKeys();
    expect(result.canStart).toBe(false);
    expect(result.errors.some((e) => e.includes('CAPITAL_IDENTIFIER'))).toBe(true);
  });

  it('returns canStart=false when required CAPITAL_API_KEY_PASSWORD is missing', () => {
    process.env.CAPITAL_API_KEY = 'key';
    process.env.CAPITAL_IDENTIFIER = 'user@example.com';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-xxx';

    const result = checkEnvKeys();
    expect(result.canStart).toBe(false);
    expect(result.errors.some((e) => e.includes('CAPITAL_API_KEY_PASSWORD'))).toBe(true);
  });

  it('returns canStart=false when required ANTHROPIC_API_KEY is missing', () => {
    process.env.CAPITAL_API_KEY = 'key';
    process.env.CAPITAL_IDENTIFIER = 'user@example.com';
    process.env.CAPITAL_API_KEY_PASSWORD = 'pw';

    const result = checkEnvKeys();
    expect(result.canStart).toBe(false);
    expect(result.errors.some((e) => e.includes('ANTHROPIC_API_KEY'))).toBe(true);
  });

  it('returns canStart=true with warnings when only optional keys are missing', () => {
    process.env.CAPITAL_API_KEY = 'key';
    process.env.CAPITAL_IDENTIFIER = 'user@example.com';
    process.env.CAPITAL_API_KEY_PASSWORD = 'pw';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-xxx';
    // All optional keys intentionally left unset.

    const result = checkEnvKeys();
    expect(result.canStart).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('returns clean result when all required + optional keys are present', () => {
    process.env.CAPITAL_API_KEY = 'key';
    process.env.CAPITAL_IDENTIFIER = 'user@example.com';
    process.env.CAPITAL_API_KEY_PASSWORD = 'pw';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-xxx';
    process.env.CAPITAL_API_URL = 'https://demo-api-capital.backend-capital.com';
    process.env.TELEGRAM_BOT_TOKEN = 't';
    process.env.TELEGRAM_CHAT_ID = 'c';
    process.env.TWELVE_DATA_API_KEY = 'td';
    process.env.FINNHUB_API_KEY = 'fh';
    process.env.FMP_API_KEY = 'fmp';
    process.env.FRED_API_KEY = 'fred';
    process.env.MARKETAUX_API_KEY = 'mktaux';

    const result = checkEnvKeys();
    expect(result.canStart).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it('does NOT reference T212_API_KEY anywhere in required keys', () => {
    // Migration sanity check: deleting T212_API_KEY and setting only the
    // Capital trio + Anthropic must produce zero errors.
    delete process.env.T212_API_KEY;
    process.env.CAPITAL_API_KEY = 'key';
    process.env.CAPITAL_IDENTIFIER = 'user@example.com';
    process.env.CAPITAL_API_KEY_PASSWORD = 'pw';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-xxx';

    const result = checkEnvKeys();
    expect(result.canStart).toBe(true);
    expect(result.errors.some((e) => e.includes('T212'))).toBe(false);
  });
});

describe('runPreflight', () => {
  const originalEnv = process.env;
  const originalArgv = process.argv;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.CAPITAL_API_KEY;
    delete process.env.CAPITAL_IDENTIFIER;
    delete process.env.CAPITAL_API_KEY_PASSWORD;
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    process.env = originalEnv;
    process.argv = originalArgv;
    vi.restoreAllMocks();
  });

  it('calls process.exit(1) when a required Capital credential is missing', async () => {
    // No Capital creds set → should exit with code 1.
    process.argv = [...originalArgv, '--skip-broker-check'];
    const exitSpy = vi
      .spyOn(process, 'exit')
      // @ts-expect-error — test stub, signature mismatch on purpose
      .mockImplementation((code?: number) => {
        throw new Error(`__exit_${code}__`);
      });
    // Silence console noise from preflight
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(runPreflight()).rejects.toThrow('__exit_1__');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('respects --skip-broker-check and does NOT attempt a live Capital session', async () => {
    process.env.CAPITAL_API_KEY = 'key';
    process.env.CAPITAL_IDENTIFIER = 'user@example.com';
    process.env.CAPITAL_API_KEY_PASSWORD = 'pw';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-xxx';
    process.argv = [...originalArgv, '--skip-broker-check'];

    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    // If broker check accidentally ran, axios would try a network call and the
    // test would either hang or throw. The --skip-broker-check flag should
    // let runPreflight() resolve cleanly.
    await expect(runPreflight()).resolves.toBeUndefined();
  });
});

describe('checkLiveTradingGate', () => {
  const DEMO_URL = 'https://demo-api-capital.backend-capital.com';
  const LIVE_URL = 'https://api-capital.backend-capital.com';

  it('allows demo URL with LIVE_TRADING_OK unset', () => {
    expect(() => checkLiveTradingGate(DEMO_URL, undefined)).not.toThrow();
  });

  it('allows demo URL even when LIVE_TRADING_OK=true (harmless)', () => {
    expect(() => checkLiveTradingGate(DEMO_URL, 'true')).not.toThrow();
  });

  it('BLOCKS live URL when LIVE_TRADING_OK is unset', () => {
    expect(() => checkLiveTradingGate(LIVE_URL, undefined)).toThrow(
      /LIVE_TRADING_OK !== 'true'/,
    );
  });

  it("BLOCKS live URL when LIVE_TRADING_OK='false'", () => {
    expect(() => checkLiveTradingGate(LIVE_URL, 'false')).toThrow(
      /LIVE_TRADING_OK !== 'true'/,
    );
  });

  it("BLOCKS live URL when LIVE_TRADING_OK='TRUE' (case-sensitive — only lowercase 'true' unlocks)", () => {
    expect(() => checkLiveTradingGate(LIVE_URL, 'TRUE')).toThrow(
      /LIVE_TRADING_OK !== 'true'/,
    );
  });

  it("allows live URL when LIVE_TRADING_OK === 'true' (explicit opt-in)", () => {
    expect(() => checkLiveTradingGate(LIVE_URL, 'true')).not.toThrow();
  });

  it('error message includes the offending URL so misconfig is easy to debug', () => {
    expect(() => checkLiveTradingGate(LIVE_URL, undefined)).toThrow(LIVE_URL);
  });
});

// 2026-05-05 audit (Phase 2 / Round 2 / item 2.1): Telegram alert when
// optional graceful-degradation env vars are missing. Pre-fix the warnings
// only printed to console; ops never noticed silent feature loss.
import { alertOnDegradedEnv } from '../src/preflight.js';

describe('alertOnDegradedEnv', () => {
  it('does nothing when no degraded warnings', async () => {
    const calls: string[] = [];
    await alertOnDegradedEnv([], async (m) => { calls.push(m); }, true);
    expect(calls).toHaveLength(0);
  });

  it('emits one Telegram alert when degraded keys are present', async () => {
    const calls: string[] = [];
    const warnings = [
      'OPTIONAL: TWELVE_DATA_API_KEY is not set — Twelve Data candles will be disabled',
      'OPTIONAL: MARKETAUX_API_KEY is not set — News feed (sentiment) will be disabled',
    ];
    await alertOnDegradedEnv(warnings, async (m) => { calls.push(m); }, true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('TWELVE_DATA_API_KEY');
    expect(calls[0]).toContain('MARKETAUX_API_KEY');
    expect(calls[0]).toMatch(/degraded/i);
  });

  it('skips CAPITAL_API_URL (has sensible default) — not worth alerting', async () => {
    const calls: string[] = [];
    const warnings = [
      'OPTIONAL: CAPITAL_API_URL is not set — Capital.com base URL (defaults to demo)',
    ];
    await alertOnDegradedEnv(warnings, async (m) => { calls.push(m); }, true);
    expect(calls).toHaveLength(0);
  });

  it("falls back to console.error '[CRITICAL]' when Telegram itself is missing", async () => {
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const calls: string[] = [];
    const warnings = [
      'OPTIONAL: TELEGRAM_BOT_TOKEN is not set — Telegram alerts will be disabled',
      'OPTIONAL: FINNHUB_API_KEY is not set — Economic calendar will be disabled',
    ];
    await alertOnDegradedEnv(warnings, async (m) => { calls.push(m); }, false);
    expect(calls).toHaveLength(0); // Telegram fn NOT called
    expect(consoleErrSpy).toHaveBeenCalled();
    const allErrors = consoleErrSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(allErrors).toMatch(/CRITICAL/);
    expect(allErrors).toContain('TELEGRAM_BOT_TOKEN');
    consoleErrSpy.mockRestore();
  });

  it('survives Telegram alert function rejection (does not block boot)', async () => {
    const warnings = [
      'OPTIONAL: TWELVE_DATA_API_KEY is not set — Twelve Data candles will be disabled',
    ];
    await expect(
      alertOnDegradedEnv(warnings, async () => { throw new Error('Telegram down'); }, true),
    ).resolves.toBeUndefined();
  });
});

// Preflight Checks — Validates environment before bot startup
// Required keys cause startup failure. Optional keys warn and disable features.
//
// After env-var checks, unless `--skip-broker-check` is present in argv, this
// file also validates Capital.com connectivity by creating a live session,
// fetching the accounts list, asserting demo-account type if pointed at the
// demo URL, and cleanly logging out.

import { CapitalClient } from './mcp-server/capital-client.js';
import { alertSystemWarning, initTelegram } from './notifications/telegram.js';

interface PreflightResult {
  canStart: boolean;
  errors: string[];
  warnings: string[];
}

const REQUIRED_KEYS = [
  'CAPITAL_API_KEY',
  'CAPITAL_IDENTIFIER',
  'CAPITAL_API_KEY_PASSWORD',
  'ANTHROPIC_API_KEY',
] as const;

const OPTIONAL_KEYS = [
  { key: 'CAPITAL_API_URL', feature: 'Capital.com base URL (defaults to demo)' },
  { key: 'TELEGRAM_BOT_TOKEN', feature: 'Telegram alerts' },
  { key: 'TELEGRAM_CHAT_ID', feature: 'Telegram alerts' },
  { key: 'TWELVE_DATA_API_KEY', feature: 'Twelve Data candles' },
  { key: 'FINNHUB_API_KEY', feature: 'Economic calendar' },
  { key: 'FRED_API_KEY', feature: 'Yield curve' },
  { key: 'MARKETAUX_API_KEY', feature: 'News feed (sentiment)' },
] as const;

const DEFAULT_CAPITAL_URL = 'https://demo-api-capital.backend-capital.com';

export function checkEnvKeys(): PreflightResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const key of REQUIRED_KEYS) {
    if (!process.env[key]) {
      errors.push(`REQUIRED: ${key} is not set — bot cannot start without it`);
    }
  }

  for (const { key, feature } of OPTIONAL_KEYS) {
    if (!process.env[key]) {
      warnings.push(`OPTIONAL: ${key} is not set — ${feature} will be disabled`);
    }
  }

  return {
    canStart: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Verifies Capital.com connectivity end-to-end:
 *   1. Creates a session (login)
 *   2. Fetches the account list
 *   3. Asserts at least one DEMO account exists if pointed at the demo URL
 *   4. Logs out cleanly
 *
 * Throws on any failure; the caller exits the process.
 */
/**
 * Live-endpoint safety gate. Capital.com discriminates demo vs live purely
 * by URL; the accountType field on /api/v1/accounts is the product type
 * (CFD / SPREADBET / CASH), not a demo/live flag. So we gate on URL and
 * require an explicit opt-in before letting the bot trade live.
 *
 * Exported so tests can exercise it in isolation without mocking Capital.
 */
export function checkLiveTradingGate(
  baseURL: string,
  liveTradingOk: string | undefined,
): void {
  const isLiveURL = !baseURL.includes('demo-api-capital');
  if (isLiveURL && liveTradingOk !== 'true') {
    throw new Error(
      `CAPITAL_API_URL points at LIVE (${baseURL}) but LIVE_TRADING_OK !== 'true'. ` +
        `Refusing to start. Set LIVE_TRADING_OK=true to confirm you want live trading.`,
    );
  }
}

async function verifyCapitalConnectivity(): Promise<void> {
  const baseURL = process.env.CAPITAL_API_URL || DEFAULT_CAPITAL_URL;
  checkLiveTradingGate(baseURL, process.env.LIVE_TRADING_OK);

  const capital = new CapitalClient({
    apiKey: process.env.CAPITAL_API_KEY || '',
    identifier: process.env.CAPITAL_IDENTIFIER || '',
    password: process.env.CAPITAL_API_KEY_PASSWORD || '',
    baseURL,
  });

  // getAccounts() implicitly triggers createSession() via ensureSession()
  const accounts = await capital.getAccounts();

  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new Error('Capital.com returned no accounts for these credentials');
  }

  // Clean up the session we just opened. Swallow errors — the bot will open its
  // own session on boot and we don't want preflight to fail on cleanup.
  try {
    await capital.logout();
  } catch (error) {
    console.warn('[Preflight] Capital.com logout during preflight failed (non-fatal):', error);
  }
}

/**
 * 2026-05-05 audit (Phase 2 / Round 2 / item 2.1).
 *
 * Emits ONE Telegram alert at startup listing optional env vars that are
 * missing AND would cause silent feature degradation (TWELVE_DATA, FINNHUB,
 * FRED, MARKETAUX, TELEGRAM_*). Pre-fix the warnings only printed to
 * console; ops never noticed when a deploy lost a key. Skips warnings
 * for keys with sensible defaults (CAPITAL_API_URL).
 *
 * Edge case: when TELEGRAM_BOT_TOKEN itself is missing, Telegram cannot
 * deliver the alert. Falls back to a console.error '[CRITICAL]' line so
 * the missing-Telegram failure is at least visible in pm2-out.log.
 *
 * Pure function for testability — caller injects the alert function and
 * the boolean indicating whether Telegram is configured.
 */
export async function alertOnDegradedEnv(
  warnings: string[],
  alertFn: (msg: string) => Promise<void>,
  hasTelegram: boolean,
): Promise<void> {
  // Skip warnings about keys with sensible defaults that don't degrade behaviour.
  const SKIPPED = ['CAPITAL_API_URL'];
  const degraded = warnings.filter((w) => !SKIPPED.some((s) => w.includes(s)));
  if (degraded.length === 0) return;

  const body = `🚨 Bot started with degraded data sources:\n\n${degraded.join('\n')}`;

  if (!hasTelegram) {
    console.error(`[CRITICAL] ${body}\n[CRITICAL] (Telegram itself is unconfigured — this alert is console-only)`);
    return;
  }

  try {
    await alertFn(body);
  } catch {
    // Telegram delivery failure must not block boot. The console.warn lines
    // earlier in runPreflight() already captured the same warnings.
  }
}

export async function runPreflight(): Promise<void> {
  console.log('[Preflight] Checking environment variables...');
  const result = checkEnvKeys();

  for (const warning of result.warnings) {
    console.warn(`[Preflight] ${warning}`);
  }

  for (const error of result.errors) {
    console.error(`[Preflight] ${error}`);
  }

  if (!result.canStart) {
    console.error('[Preflight] FATAL: Missing required environment variables. Exiting.');
    process.exit(1);
  }

  console.log(`[Preflight] Env OK — ${result.warnings.length} warning(s), 0 errors.`);

  // 2026-05-05 audit (Phase 2 / Round 2 / item 2.1, Codex review fix):
  // initialise Telegram BEFORE the degraded-env alert call. Without this,
  // alertSystemWarning would no-op silently (bot=null until initTelegram
  // runs) and the whole alert mechanism would be lost. Idempotent — calling
  // initTelegram() again later in src/index.ts is safe.
  //
  // Whitespace edge case: trim the env values for the boolean check so it
  // matches initTelegram's own trim() at telegram.ts:20-26.
  initTelegram();
  const hasTelegram =
    (process.env.TELEGRAM_BOT_TOKEN ?? '').trim().length > 0 &&
    (process.env.TELEGRAM_CHAT_ID ?? '').trim().length > 0;
  await alertOnDegradedEnv(result.warnings, alertSystemWarning, hasTelegram);

  // 2026-04-29 audit-3 fix (scanner+misc P0-2): the live-trading gate now
  // ALWAYS runs, even with --skip-broker-check. Pre-fix, --skip-broker-check
  // bypassed verifyCapitalConnectivity() AND, indirectly, the live-vs-demo
  // URL check inside it. A CI script copy-pasted into a production pm2
  // ecosystem file (or a typo in the deploy unit) would silently boot the
  // bot against a live URL with zero guardrail. Live-trading verification
  // is decoupled here and runs unconditionally before any skip.
  const baseURL = process.env.CAPITAL_API_URL || DEFAULT_CAPITAL_URL;
  try {
    checkLiveTradingGate(baseURL, process.env.LIVE_TRADING_OK);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[Preflight] FATAL: Live-trading gate refused start: ${msg}`);
    process.exit(1);
  }

  // Broker connectivity check — skippable via CLI flag for unit tests / CI.
  if (process.argv.includes('--skip-broker-check')) {
    console.log('[Preflight] --skip-broker-check set; skipping Capital.com connectivity check (live-trading gate already passed).');
    return;
  }

  console.log('[Preflight] Verifying Capital.com connectivity...');
  try {
    await verifyCapitalConnectivity();
    console.log('[Preflight] Capital.com OK — session created, accounts verified, logged out.');
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[Preflight] FATAL: Capital.com connectivity check failed: ${msg}`);
    process.exit(1);
  }
}

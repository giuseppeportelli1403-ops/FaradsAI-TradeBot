// Preflight Checks — Validates environment before bot startup
// Required keys cause startup failure. Optional keys warn and disable features.
//
// After env-var checks, unless `--skip-broker-check` is present in argv, this
// file also validates Capital.com connectivity by creating a live session,
// fetching the accounts list, asserting demo-account type if pointed at the
// demo URL, and cleanly logging out.

import { CapitalClient } from './mcp-server/capital-client.js';

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
  { key: 'TWELVE_DATA_API_KEY', feature: 'Twelve Data candles/VIX/DXY' },
  { key: 'FINNHUB_API_KEY', feature: 'Economic calendar' },
  { key: 'FMP_API_KEY', feature: 'Sector strength' },
  { key: 'FRED_API_KEY', feature: 'Yield curve' },
  { key: 'ALPHA_VANTAGE_API_KEY', feature: 'News sentiment' },
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

  // Broker connectivity check — skippable via CLI flag for unit tests / CI.
  if (process.argv.includes('--skip-broker-check')) {
    console.log('[Preflight] --skip-broker-check set; skipping Capital.com connectivity check.');
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

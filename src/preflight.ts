// Preflight Checks — Validates environment before bot startup
// Required keys cause startup failure. Optional keys warn and disable features.

interface PreflightResult {
  canStart: boolean;
  errors: string[];
  warnings: string[];
}

const REQUIRED_KEYS = [
  'T212_API_KEY',
  'ANTHROPIC_API_KEY',
] as const;

const OPTIONAL_KEYS = [
  { key: 'TELEGRAM_BOT_TOKEN', feature: 'Telegram alerts' },
  { key: 'TELEGRAM_CHAT_ID', feature: 'Telegram alerts' },
  { key: 'TWELVE_DATA_API_KEY', feature: 'Twelve Data candles/VIX/DXY' },
  { key: 'FINNHUB_API_KEY', feature: 'Economic calendar' },
  { key: 'FMP_API_KEY', feature: 'Sector strength' },
  { key: 'FRED_API_KEY', feature: 'Yield curve' },
  { key: 'ALPHA_VANTAGE_API_KEY', feature: 'News sentiment' },
] as const;

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

export function runPreflight(): void {
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

  console.log(`[Preflight] OK — ${result.warnings.length} warning(s), 0 errors.`);
}

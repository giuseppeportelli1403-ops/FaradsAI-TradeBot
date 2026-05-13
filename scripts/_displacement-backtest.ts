// scripts/_displacement-backtest.ts
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import process from 'node:process';
import { CapitalClient } from '../src/mcp-server/capital-client.js';
import type { Candle } from '../src/types.js';

const SUPPORTED_TICKERS = [
  'EURUSD', 'GBPUSD', 'AUDUSD', 'USDJPY',
  'GOLD', 'SILVER', 'OIL_CRUDE',
] as const;
type Ticker = (typeof SUPPORTED_TICKERS)[number];

const TYPICAL_SPREAD: Record<Ticker, number> = {
  EURUSD: 0.00010, GBPUSD: 0.00015, AUDUSD: 0.00015, USDJPY: 0.010,
  GOLD: 0.30, SILVER: 0.020, OIL_CRUDE: 0.030,
};

const RATE_LIMIT_MS = 250;

function parseArgs(argv: string[]) {
  const days = Number(argv.find((_, i) => argv[i - 1] === '--days') ?? 30);
  const outDir = argv.find((_, i) => argv[i - 1] === '--out') ?? 'data/metrics';
  const horizon = Number(argv.find((_, i) => argv[i - 1] === '--horizon') ?? 8);
  return { days, outDir, horizon };
}

async function main() {
  const { days, outDir, horizon } = parseArgs(process.argv.slice(2));
  console.log(`Displacement Continuation backtest — days=${days}, horizon=${horizon}×15M`);
  // TODO: fill in with Tasks 2-8
}

main().catch(e => { console.error(e); process.exit(1); });

// ---------------------------------------------------------------------------
// Bias detection — Task 2
// Port of src/scanner/index.ts:detectBias — primary HH+HL / LH+LL branch.
// Slope fallback disabled (matches production SCANNER_SLOPE_FALLBACK=false default).
// ---------------------------------------------------------------------------
export type Bias = 'bullish' | 'bearish' | 'neutral';

export function detectBias(candles1h: ReadonlyArray<Pick<Candle, 'high' | 'low'>>): Bias {
  if (candles1h.length < 4) return 'neutral';
  const last4 = candles1h.slice(-4);
  const hh = last4.every((c, i) => i === 0 || c.high > last4[i - 1].high);
  const hl = last4.every((c, i) => i === 0 || c.low > last4[i - 1].low);
  if (hh && hl) return 'bullish';
  const lh = last4.every((c, i) => i === 0 || c.high < last4[i - 1].high);
  const ll = last4.every((c, i) => i === 0 || c.low < last4[i - 1].low);
  if (lh && ll) return 'bearish';
  return 'neutral';
}

// ---------------------------------------------------------------------------
// Task 3: Precedence check — existingTriggerFires
//
// Returns true if ANY of the 4 existing trend triggers (OB Retest, FVG Fill,
// Liquidity Sweep, Breakout Retest) qualifies on the given candle array.
// The Displacement Continuation trigger should only fire when NONE of these
// qualify — this function implements that gate.
//
// Signature mirrors the exported detectors in audit-trigger-decisions.ts.
// qualifies === true means the detector confirms a trigger (boolean per
// TriggerResult type, not 'yes'/'no').
// ---------------------------------------------------------------------------
import {
  checkObRetest,
  checkFvgFill,
  checkLiquiditySweep,
  checkBreakoutRetest,
} from './audit-trigger-decisions.js';

export function existingTriggerFires(
  candles15m: ReadonlyArray<Candle>,
  bias: Bias,
  spread: number,
): boolean {
  if (bias === 'neutral') return false;
  const m15 = candles15m as Candle[];
  const dir = bias as 'bullish' | 'bearish';
  if (checkObRetest(m15, dir).qualifies === true) return true;
  if (checkFvgFill(m15, dir).qualifies === true) return true;
  if (checkLiquiditySweep(m15, dir, spread).qualifies === true) return true;
  if (checkBreakoutRetest(m15, dir).qualifies === true) return true;
  return false;
}

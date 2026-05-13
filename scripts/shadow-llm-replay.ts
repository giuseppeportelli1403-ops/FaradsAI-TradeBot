// scripts/shadow-llm-replay.ts
//
// Shadow-LLM replay tool for PR 1 / PR 2 validation (codex finding #1 + #8,
// design v2 §6 PR 1 Sub-gate 2). Reuses the parameterized detectors from
// audit-trigger-decisions.ts (OB Retest + FVG Fill — the two with PR 1
// threshold changes); other detectors use unchanged defaults.
//
// Usage:
//   npx tsx scripts/shadow-llm-replay.ts \
//     --tier3-floor 30 --tier3-floor-medium 35 \
//     --ob-body 0.3 --ob-wick 0.7 --fvg-body 0.3 \
//     --force-propose 40 \
//     --cycles 50
//
// Reads recent cycles from data/pm2-out.log, fetches m15+h1 candles from
// Capital.com, runs each cycle's detectors twice (defaults vs overrides),
// emits JSON summary of qualification deltas + hallucination check.

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { CapitalClient } from '../src/mcp-server/capital-client.js';
import {
  checkObRetest,
  checkFvgFill,
} from './audit-trigger-decisions.js';

// ==================== TYPES + DEFAULTS ====================

export interface ThresholdOverrides {
  tier3FloorTight?: number;
  tier3FloorMedium?: number;
  obBody?: number;
  obWick?: number;
  fvgBody?: number;
  forceProposeFloor?: number;
}

export interface ResolvedThresholds {
  tier3FloorTight: number;
  tier3FloorMedium: number;
  obBody: number;
  obWick: number;
  fvgBody: number;
  forceProposeFloor: number;
}

export const SHADOW_REPLAY_DEFAULTS: ResolvedThresholds = {
  tier3FloorTight: 40,
  tier3FloorMedium: 45,
  obBody: 0.4,
  obWick: 1.0,
  fvgBody: 0.4,
  forceProposeFloor: 55,
};

// Use `??` so a deliberate `0` override is preserved (codex edge case).
export function applyThresholdOverrides(overrides: ThresholdOverrides): ResolvedThresholds {
  return {
    tier3FloorTight: overrides.tier3FloorTight ?? SHADOW_REPLAY_DEFAULTS.tier3FloorTight,
    tier3FloorMedium: overrides.tier3FloorMedium ?? SHADOW_REPLAY_DEFAULTS.tier3FloorMedium,
    obBody: overrides.obBody ?? SHADOW_REPLAY_DEFAULTS.obBody,
    obWick: overrides.obWick ?? SHADOW_REPLAY_DEFAULTS.obWick,
    fvgBody: overrides.fvgBody ?? SHADOW_REPLAY_DEFAULTS.fvgBody,
    forceProposeFloor: overrides.forceProposeFloor ?? SHADOW_REPLAY_DEFAULTS.forceProposeFloor,
  };
}

export interface RecentCycle {
  timestamp: Date;
  ticker: string;
  bias: 'bullish' | 'bearish' | 'neutral' | 'unknown';
  llmVerdict: 'yes' | 'no' | 'unknown';
}

export interface ReplaySummary {
  cycleCount: number;
  comparableCycleCount: number; // bullish/bearish bias only (OB+FVG triggers are trend-mode)
  fetchErrorCount: number;
  qualifiedUnderDefaults: number;
  qualifiedUnderOverrides: number;
  qualificationRateMultiplier: number;
  newlyAdmitted: number;
  newlyRejected: number;
  unchangedAdmitted: number;
  unchangedRejected: number;
  fpUnderOverrides: number; // LLM yes + math no — hallucination check, MUST be 0
  fnUnderOverrides: number; // LLM no + math yes — missed-trade signal
}

// ==================== LOG PARSING ====================

const SUPPORTED_TICKERS = ['EURUSD', 'GBPUSD', 'AUDUSD', 'USDJPY', 'GOLD', 'OIL_CRUDE', 'SILVER'] as const;

function stripPm2Prefix(line: string): string {
  return line.replace(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \+\d{2}:\d{2}: /, '');
}

export function parseRecentCycles(rawContent: string, nCycles: number): RecentCycle[] {
  const content = rawContent.split('\n').map(stripPm2Prefix).join('\n');
  const blocks = content.split(/^DECISION CYCLE\s*—\s*/m);
  const cycles: RecentCycle[] = [];
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];
    const dtMatch = block.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[^\s\n]*Z)/);
    const tkMatch = block.match(/Top candidate:\s*([A-Z_]+)/);
    const biMatch = block.match(/1H Bias:\s*(\w+)/i);
    const trMatch = block.match(/Trigger confirmed:\s*(YES|NO|Yes|No|yes|no)/);
    if (!dtMatch || !tkMatch) continue;
    const ticker = tkMatch[1];
    if (!(SUPPORTED_TICKERS as readonly string[]).includes(ticker)) continue;
    const biasRaw = (biMatch?.[1] ?? 'unknown').toLowerCase();
    const bias: RecentCycle['bias'] =
      biasRaw === 'bullish' || biasRaw === 'bearish' || biasRaw === 'neutral'
        ? biasRaw
        : 'unknown';
    cycles.push({
      timestamp: new Date(dtMatch[1]),
      ticker,
      bias,
      llmVerdict: trMatch ? (trMatch[1].toLowerCase().startsWith('y') ? 'yes' : 'no') : 'unknown',
    });
  }
  return cycles.slice(-nCycles);
}

// ==================== PER-CYCLE EVAL ====================

function anyParameterizedTriggerQualifies(
  m15: any[],
  bias: 'bullish' | 'bearish',
  thresholds: ResolvedThresholds,
): boolean {
  // PR 1 only loosens OB Retest + FVG Fill thresholds. The other 3 triggers
  // (Liquidity_Sweep, Breakout_Retest, Range_Sweep_Reversal) keep current
  // defaults — they're not loosened in PR 1 scope.
  const ob = checkObRetest(m15, bias, { bodyMin: thresholds.obBody, wickMin: thresholds.obWick });
  if (ob.qualifies === true) return true;
  const fvg = checkFvgFill(m15, bias, { bodyMin: thresholds.fvgBody });
  if (fvg.qualifies === true) return true;
  return false;
}

// ==================== MAIN ====================

function parseCli(): { overrides: ThresholdOverrides; cycles: number; logPath: string; prompt: string } {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      'tier3-floor': { type: 'string' },
      'tier3-floor-medium': { type: 'string' },
      'ob-body': { type: 'string' },
      'ob-wick': { type: 'string' },
      'fvg-body': { type: 'string' },
      'force-propose': { type: 'string' },
      'cycles': { type: 'string' },
      'log-path': { type: 'string' },
      'prompt': { type: 'string' },
    },
    allowPositionals: true,
  });
  const overrides: ThresholdOverrides = {
    tier3FloorTight: values['tier3-floor'] !== undefined ? Number(values['tier3-floor']) : undefined,
    tier3FloorMedium: values['tier3-floor-medium'] !== undefined ? Number(values['tier3-floor-medium']) : undefined,
    obBody: values['ob-body'] !== undefined ? Number(values['ob-body']) : undefined,
    obWick: values['ob-wick'] !== undefined ? Number(values['ob-wick']) : undefined,
    fvgBody: values['fvg-body'] !== undefined ? Number(values['fvg-body']) : undefined,
    forceProposeFloor: values['force-propose'] !== undefined ? Number(values['force-propose']) : undefined,
  };
  return {
    overrides,
    cycles: values['cycles'] !== undefined ? Number(values['cycles']) : 50,
    logPath: String(values['log-path'] ?? `${process.env.HOME ?? ''}/trading-bot/data/pm2-out.log`),
    prompt: String(values['prompt'] ?? 'current'),
  };
}

async function main() {
  const cli = parseCli();
  const resolved = applyThresholdOverrides(cli.overrides);

  console.error('Shadow-LLM replay (PR 1 / PR 2 validation sub-gate)');
  console.error('  Resolved thresholds:', JSON.stringify(resolved));
  console.error('  Defaults:           ', JSON.stringify(SHADOW_REPLAY_DEFAULTS));
  console.error('  Prompt version:     ', cli.prompt);
  console.error('  Cycles to replay:   ', cli.cycles);
  console.error('  Log path:           ', cli.logPath);
  console.error('');

  const apiKey = process.env.CAPITAL_API_KEY ?? '';
  const identifier = process.env.CAPITAL_IDENTIFIER ?? '';
  const password = process.env.CAPITAL_API_KEY_PASSWORD ?? '';
  const baseURL = process.env.CAPITAL_API_URL ?? 'https://demo-api-capital.backend-capital.com';
  if (!apiKey || !identifier || !password) {
    console.error('Missing Capital.com creds (CAPITAL_API_KEY / CAPITAL_IDENTIFIER / CAPITAL_API_KEY_PASSWORD)');
    process.exit(1);
  }

  const rawContent = readFileSync(cli.logPath, 'utf-8');
  const cycles = parseRecentCycles(rawContent, cli.cycles);
  console.error(`  Parsed ${cycles.length} recent cycles`);

  const capital = new CapitalClient({ apiKey, identifier, password, baseURL });

  const summary: ReplaySummary = {
    cycleCount: cycles.length,
    comparableCycleCount: 0,
    fetchErrorCount: 0,
    qualifiedUnderDefaults: 0,
    qualifiedUnderOverrides: 0,
    qualificationRateMultiplier: 0,
    newlyAdmitted: 0,
    newlyRejected: 0,
    unchangedAdmitted: 0,
    unchangedRejected: 0,
    fpUnderOverrides: 0,
    fnUnderOverrides: 0,
  };

  for (const cycle of cycles) {
    if (cycle.bias !== 'bullish' && cycle.bias !== 'bearish') continue;
    summary.comparableCycleCount++;

    let m15: any[] = [];
    try {
      const before = new Date(cycle.timestamp.getTime() - 1 * 60 * 1000);
      const from = new Date(before.getTime() - 25 * 15 * 60 * 1000);
      m15 = await capital.getCandlesAsCandles(
        cycle.ticker,
        '15m',
        25,
        from.toISOString().slice(0, 19),
        before.toISOString().slice(0, 19),
      );
    } catch (e) {
      summary.fetchErrorCount++;
      continue;
    }
    if (m15.length < 5) {
      summary.fetchErrorCount++;
      continue;
    }

    const defaultsQ = anyParameterizedTriggerQualifies(m15, cycle.bias, SHADOW_REPLAY_DEFAULTS);
    const overridesQ = anyParameterizedTriggerQualifies(m15, cycle.bias, resolved);

    if (defaultsQ) summary.qualifiedUnderDefaults++;
    if (overridesQ) summary.qualifiedUnderOverrides++;
    if (!defaultsQ && overridesQ) summary.newlyAdmitted++;
    else if (defaultsQ && !overridesQ) summary.newlyRejected++;
    else if (defaultsQ && overridesQ) summary.unchangedAdmitted++;
    else summary.unchangedRejected++;

    if (cycle.llmVerdict === 'yes' && !overridesQ) summary.fpUnderOverrides++;
    else if (cycle.llmVerdict === 'no' && overridesQ) summary.fnUnderOverrides++;

    // Be nice to Capital's rate limiter
    await new Promise((r) => setTimeout(r, 250));
  }

  summary.qualificationRateMultiplier =
    summary.qualifiedUnderDefaults > 0
      ? summary.qualifiedUnderOverrides / summary.qualifiedUnderDefaults
      : summary.qualifiedUnderOverrides > 0
        ? Infinity
        : 1;

  console.log(JSON.stringify(summary, null, 2));

  console.error('\nGate verdicts:');
  console.error(`  FP under overrides (must be 0): ${summary.fpUnderOverrides} ${summary.fpUnderOverrides === 0 ? '✅' : '❌ HALLUCINATION'}`);
  console.error(`  Qualification rate multiplier (target 2-5x): ${summary.qualificationRateMultiplier.toFixed(2)}x ${summary.qualificationRateMultiplier >= 2 && summary.qualificationRateMultiplier <= 5 ? '✅' : '⚠️'}`);
  console.error(`  Newly admitted cycles (must be > 0): ${summary.newlyAdmitted} ${summary.newlyAdmitted > 0 ? '✅' : '⚠️'}`);
  console.error(`  Newly rejected cycles (must be 0): ${summary.newlyRejected} ${summary.newlyRejected === 0 ? '✅' : '❌'}`);
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  main().catch((err) => {
    console.error('Shadow replay failed:', err);
    process.exit(1);
  });
}

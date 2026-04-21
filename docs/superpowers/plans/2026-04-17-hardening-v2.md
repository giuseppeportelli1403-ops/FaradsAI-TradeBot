# Hardening V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 6 critical bugs, inject V3 system prompts into all 6 agents, and add comprehensive test coverage — all using TDD on a `hardening-v2` branch.

**Architecture:** Three parallel work streams (bug fixes, V3 prompts, tests) that touch non-overlapping files. Each bug fix uses TDD: write failing test → fix → verify. Stream 4 (review) runs after all three complete.

**Tech Stack:** TypeScript, Vitest (testing), sql.js, @anthropic-ai/sdk, @modelcontextprotocol/sdk

---

## File Map

### Modified Files
| File | Changes |
|------|---------|
| `src/database/index.ts` | Fix `getLessonWinRate()` SQL query |
| `src/agents/analyst-agent.ts` | Default to REJECT on parse failure + load V3 prompt |
| `src/agents/trading-agent.ts` | Load V3 prompt |
| `src/agents/swing-agent.ts` | Load V3 prompt |
| `src/agents/researcher-agent.ts` | Load V3 prompt |
| `src/agents/reflection-agent.ts` | Load V3 prompt |
| `src/agents/review-agent.ts` | Load V3 prompt |
| `src/scheduler/index.ts` | Fix candle detection + export functions for testing |
| `src/mcp-server/market-data.ts` | Add caching + error handling wrappers |
| `src/index.ts` | Add preflight checks |
| `package.json` | Add vitest + test script |

### New Files
| File | Purpose |
|------|---------|
| `src/preflight.ts` | Startup API key validation + connectivity checks |
| `prompts/ict-agent.md` | V3 Section 1 system prompt |
| `prompts/swing-agent.md` | V3 Section 2 system prompt |
| `prompts/researcher-agent.md` | V3 Section 3 system prompt |
| `prompts/analyst-agent.md` | V3 Section 4 system prompt |
| `prompts/reflection-agent.md` | V3 Section 5 system prompt |
| `prompts/review-agent.md` | V3 Section 6 system prompt |
| `vitest.config.ts` | Vitest configuration |
| `tests/database.test.ts` | Database module tests |
| `tests/scanner.test.ts` | Scanner/bias detection tests |
| `tests/news.test.ts` | News scoring tests |
| `tests/scheduler.test.ts` | Candle detection + SL/TP tests |
| `tests/analyst.test.ts` | Analyst parse failure tests |
| `tests/market-data.test.ts` | Market data caching + error tests |
| `tests/telegram.test.ts` | Message formatting tests |
| `tests/preflight.test.ts` | Startup validation tests |

---

## Task 0: Setup Branch + Test Infrastructure

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`

- [ ] **Step 1: Create hardening branch**

```bash
cd "/c/Users/user/Desktop/Trade Bot/Trade Bot"
git checkout -b hardening-v2
```

- [ ] **Step 2: Install vitest**

```bash
npm install --save-dev vitest
```

- [ ] **Step 3: Create vitest config**

Create `vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 10000,
  },
});
```

- [ ] **Step 4: Add test script to package.json**

Add to `scripts` in `package.json`:

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 5: Create tests directory**

```bash
mkdir -p tests
```

- [ ] **Step 6: Verify vitest runs (no tests yet)**

```bash
npm test
```

Expected: "No test files found" or similar — no errors.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json vitest.config.ts
git commit -m "chore: add vitest test framework"
```

---

## Task 1: Fix Lesson Win Rate SQL Bug (TDD)

**Files:**
- Create: `tests/database.test.ts`
- Modify: `src/database/index.ts`

- [ ] **Step 1: Write failing test**

Create `tests/database.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  initDatabaseAsync, insertLesson, getLessonWinRate, getLessons,
  insertTrade, getOpenTrades, updateTradeStatus, getTradeHistory,
  createSlTpOrder, getActiveSlTpOrders, updateSlPrice, deactivateSlTpOrder,
  upsertDailyPnl, getDailyPnl, countOpenPositions,
} from '../src/database/index.js';
import type { Lesson, TradeRecord } from '../src/types.js';

beforeAll(async () => {
  await initDatabaseAsync();
});

// Helper to create a test lesson
function makeLessonn(overrides: Partial<Lesson> = {}): Lesson {
  return {
    lesson_id: `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date().toISOString(),
    strategy_tag: 'ICT_INTRADAY',
    instrument: 'XAUUSD',
    instrument_category: 'commodity',
    direction: 'long',
    setup_type: 'OB retest',
    kill_zone: 'NY Open',
    news_category: 'B',
    news_description: 'moderate catalyst',
    composite_score: 75,
    position_a_outcome: 'TP1 hit',
    position_b_outcome: 'TP2 hit',
    pnl_a_r: 1.0,
    pnl_b_r: 2.0,
    pnl_total_r: 1.5,
    was_bias_correct: true,
    was_trigger_valid: true,
    was_news_correctly_weighted: true,
    was_split_execution_clean: true,
    analyst_decision: 'APPROVED',
    hold_duration: '45m',
    score_accuracy_notes: 'Score was accurate',
    lesson: 'Test lesson',
    rule_suggestion: '',
    ...overrides,
  };
}

describe('getLessonWinRate', () => {
  it('returns correct win rate with no filters', () => {
    // Insert 3 wins and 2 losses
    insertLesson(makeLessonn({ pnl_total_r: 2.0 }));
    insertLesson(makeLessonn({ pnl_total_r: 1.5 }));
    insertLesson(makeLessonn({ pnl_total_r: 3.0 }));
    insertLesson(makeLessonn({ pnl_total_r: -1.0 }));
    insertLesson(makeLessonn({ pnl_total_r: -0.5 }));

    const result = getLessonWinRate({});
    expect(result.total).toBeGreaterThanOrEqual(5);
    expect(result.wins).toBeGreaterThanOrEqual(3);
    expect(result.win_rate).toBeGreaterThan(0);
  });

  it('returns correct win rate with one filter', () => {
    const tag = `unique-setup-${Date.now()}`;
    insertLesson(makeLessonn({ setup_type: tag, pnl_total_r: 2.0 }));
    insertLesson(makeLessonn({ setup_type: tag, pnl_total_r: -1.0 }));

    const result = getLessonWinRate({ setup_type: tag });
    expect(result.total).toBe(2);
    expect(result.wins).toBe(1);
    expect(result.win_rate).toBe(50);
  });

  it('returns correct win rate with multiple filters', () => {
    const tag = `multi-filter-${Date.now()}`;
    insertLesson(makeLessonn({ setup_type: tag, instrument_category: 'commodity', kill_zone: 'London Open', pnl_total_r: 2.0 }));
    insertLesson(makeLessonn({ setup_type: tag, instrument_category: 'commodity', kill_zone: 'London Open', pnl_total_r: -1.0 }));
    insertLesson(makeLessonn({ setup_type: tag, instrument_category: 'commodity', kill_zone: 'London Open', pnl_total_r: 1.5 }));

    const result = getLessonWinRate({ setup_type: tag, instrument_category: 'commodity', kill_zone: 'London Open' });
    expect(result.total).toBe(3);
    expect(result.wins).toBe(2);
    expect(result.win_rate).toBeCloseTo(66.7, 0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/database.test.ts
```

Expected: FAIL — the multi-filter test will produce wrong SQL.

- [ ] **Step 3: Fix getLessonWinRate in database/index.ts**

Replace `getLessonWinRate` function (lines 321-344) with:

```typescript
export function getLessonWinRate(filters: {
  setup_type?: string;
  instrument_category?: string;
  kill_zone?: string;
  strategy_tag?: StrategyTag;
}): { total: number; wins: number; win_rate: number } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.setup_type) { conditions.push('setup_type = ?'); params.push(filters.setup_type); }
  if (filters.instrument_category) { conditions.push('instrument_category = ?'); params.push(filters.instrument_category); }
  if (filters.kill_zone) { conditions.push('kill_zone = ?'); params.push(filters.kill_zone); }
  if (filters.strategy_tag) { conditions.push('strategy_tag = ?'); params.push(filters.strategy_tag); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const totalResult = db.exec(`SELECT COUNT(*) FROM lessons ${where}`, params);
  const total = totalResult[0]?.values[0]?.[0] as number || 0;

  // Build win query with pnl_total_r > 0 as an additional condition
  const winConditions = [...conditions, 'pnl_total_r > 0'];
  const winWhere = `WHERE ${winConditions.join(' AND ')}`;
  const winsResult = db.exec(`SELECT COUNT(*) FROM lessons ${winWhere}`, [...params]);
  const wins = winsResult[0]?.values[0]?.[0] as number || 0;

  return { total, wins, win_rate: total > 0 ? Math.round((wins / total) * 1000) / 10 : 0 };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- tests/database.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/database/index.ts tests/database.test.ts
git commit -m "fix: correct SQL win rate query with multiple filters (TDD)"
```

---

## Task 2: Fix Analyst Agent Default to REJECT (TDD)

**Files:**
- Create: `tests/analyst.test.ts`
- Modify: `src/agents/analyst-agent.ts`

- [ ] **Step 1: Write failing test**

Create `tests/analyst.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import type { AnalystDecision } from '../src/types.js';

// Extract the parse logic into a testable function
// We'll refactor analyst-agent.ts to export this
import { parseAnalystResponse } from '../src/agents/analyst-agent.js';

describe('parseAnalystResponse', () => {
  it('returns REJECT when response has no JSON', () => {
    const result = parseAnalystResponse('This is just plain text with no JSON');
    expect(result.decision).toBe('REJECT');
    expect(result.reason).toContain('parse failure');
  });

  it('returns REJECT when response has malformed JSON', () => {
    const result = parseAnalystResponse('Here is my analysis: {broken json}}}');
    expect(result.decision).toBe('REJECT');
    expect(result.reason).toContain('parse failure');
  });

  it('parses valid APPROVE response', () => {
    const json = JSON.stringify({
      decision: 'APPROVE',
      reason: 'All checks passed',
      modifications: {},
      confidence: 0.9,
    });
    const result = parseAnalystResponse(`My analysis: ${json}`);
    expect(result.decision).toBe('APPROVE');
    expect(result.confidence).toBe(0.9);
  });

  it('parses valid REJECT response', () => {
    const json = JSON.stringify({
      decision: 'REJECT',
      reason: 'Correlated risk too high',
      modifications: {},
      confidence: 0.85,
    });
    const result = parseAnalystResponse(`Check failed: ${json}`);
    expect(result.decision).toBe('REJECT');
  });

  it('parses valid MODIFY response with modifications', () => {
    const json = JSON.stringify({
      decision: 'MODIFY',
      reason: 'Reduce size due to VIX',
      modifications: { risk_pct: 0.75 },
      confidence: 0.8,
    });
    const result = parseAnalystResponse(json);
    expect(result.decision).toBe('MODIFY');
    expect(result.modifications).toEqual({ risk_pct: 0.75 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/analyst.test.ts
```

Expected: FAIL — `parseAnalystResponse` doesn't exist yet.

- [ ] **Step 3: Extract parse logic and fix default**

In `src/agents/analyst-agent.ts`, add this exported function before `runAnalystAgent`:

```typescript
export function parseAnalystResponse(text: string): AnalystDecision {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]);
    }
  } catch {
    // Fall through to reject
  }
  return {
    decision: 'REJECT',
    reason: 'JSON parse failure — defaulting to reject for safety',
    modifications: {},
    confidence: 0,
  };
}
```

Then replace lines 133-143 in `runAnalystAgent` with:

```typescript
  const decision = parseAnalystResponse(text);
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- tests/analyst.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agents/analyst-agent.ts tests/analyst.test.ts
git commit -m "fix: analyst agent defaults to REJECT on parse failure (TDD)"
```

---

## Task 3: Fix Candle Close Detection Timezone Bug (TDD)

**Files:**
- Create: `tests/scheduler.test.ts`
- Modify: `src/scheduler/index.ts`

- [ ] **Step 1: Write failing test**

Create `tests/scheduler.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { makeCandleKey } from '../src/scheduler/index.js';

describe('makeCandleKey', () => {
  it('produces consistent key for January (month 0 in JS)', () => {
    const date = new Date('2026-01-15T14:30:00Z');
    const key = makeCandleKey(date, '15m');
    expect(key).toBe('2026-01-15T14:30');
  });

  it('produces consistent key for December (month 11 in JS)', () => {
    const date = new Date('2026-12-31T23:45:00Z');
    const key = makeCandleKey(date, '15m');
    expect(key).toBe('2026-12-31T23:45');
  });

  it('produces correct 1h key', () => {
    const date = new Date('2026-04-30T08:22:00Z');
    const key = makeCandleKey(date, '1h');
    expect(key).toBe('2026-04-30T08:00');
  });

  it('handles month boundary correctly', () => {
    const april30 = new Date('2026-04-30T23:45:00Z');
    const may1 = new Date('2026-05-01T00:00:00Z');
    const keyApril = makeCandleKey(april30, '1h');
    const keyMay = makeCandleKey(may1, '1h');
    expect(keyApril).not.toBe(keyMay);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/scheduler.test.ts
```

Expected: FAIL — `makeCandleKey` doesn't exist.

- [ ] **Step 3: Fix candle detection in scheduler/index.ts**

Add this exported function at the top of the file (after imports):

```typescript
export function makeCandleKey(date: Date, timeframe: '15m' | '1h'): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const h = String(date.getUTCHours()).padStart(2, '0');

  if (timeframe === '1h') {
    return `${y}-${m}-${d}T${h}:00`;
  }
  const candleMinute = Math.floor(date.getUTCMinutes() / 15) * 15;
  const min = String(candleMinute).padStart(2, '0');
  return `${y}-${m}-${d}T${h}:${min}`;
}
```

Then replace `check15mCandleClose` (lines 25-37):

```typescript
async function check15mCandleClose(): Promise<boolean> {
  const now = new Date();
  const candleKey = makeCandleKey(now, '15m');

  if (candleKey !== last15mCandle && now.getUTCMinutes() % 15 < 5) {
    last15mCandle = candleKey;
    return true;
  }
  return false;
}
```

And replace `check1hCandleClose` (lines 40-48):

```typescript
async function check1hCandleClose(): Promise<boolean> {
  const now = new Date();
  const candleKey = makeCandleKey(now, '1h');

  if (candleKey !== last1hCandle && now.getUTCMinutes() < 5) {
    last1hCandle = candleKey;
    return true;
  }
  return false;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- tests/scheduler.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/index.ts tests/scheduler.test.ts
git commit -m "fix: candle close detection uses ISO-safe date keys (TDD)"
```

---

## Task 4: Add Market Data Error Handling + Caching (TDD)

**Files:**
- Create: `tests/market-data.test.ts`
- Modify: `src/mcp-server/market-data.ts`

- [ ] **Step 1: Write failing test**

Create `tests/market-data.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Test the cache and error handling wrappers
import { withCache, withFallback } from '../src/mcp-server/market-data.js';

describe('withCache', () => {
  it('returns cached value within TTL', async () => {
    let callCount = 0;
    const fetcher = async () => { callCount++; return 42; };
    const cached = withCache('test-key', fetcher, 5000);

    const first = await cached();
    const second = await cached();

    expect(first).toBe(42);
    expect(second).toBe(42);
    expect(callCount).toBe(1); // Only called once
  });
});

describe('withFallback', () => {
  it('returns default value when function throws', async () => {
    const failingFn = async () => { throw new Error('API down'); };
    const safe = withFallback(failingFn, []);

    const result = await safe();
    expect(result).toEqual([]);
  });

  it('returns real value when function succeeds', async () => {
    const workingFn = async () => [1, 2, 3];
    const safe = withFallback(workingFn, []);

    const result = await safe();
    expect(result).toEqual([1, 2, 3]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/market-data.test.ts
```

Expected: FAIL — `withCache` and `withFallback` don't exist.

- [ ] **Step 3: Add cache and fallback utilities to market-data.ts**

Add at the top of `src/mcp-server/market-data.ts` (after imports):

```typescript
// ==================== CACHE + ERROR HANDLING ====================

const cache = new Map<string, { data: unknown; expiry: number }>();

export function withCache<T>(key: string, fetcher: () => Promise<T>, ttlMs: number = 300000): () => Promise<T> {
  return async () => {
    const cached = cache.get(key);
    if (cached && Date.now() < cached.expiry) {
      return cached.data as T;
    }
    const data = await fetcher();
    cache.set(key, { data, expiry: Date.now() + ttlMs });
    return data;
  };
}

export function withFallback<A extends unknown[], T>(
  fn: (...args: A) => Promise<T>,
  defaultValue: T
): (...args: A) => Promise<T> {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (error) {
      console.error(`[Market Data] API error, using fallback:`, error instanceof Error ? error.message : error);
      return defaultValue;
    }
  };
}
```

Then wrap `fetchCandles` throw with fallback — replace the `if (!apiKey)` throw at line 36:

```typescript
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) {
    console.error('[Market Data] TWELVE_DATA_API_KEY not set — returning empty candles');
    return [];
  }
```

Apply the same pattern to `fetchEconomicCalendar`, `fetchSectorStrength`, `fetchFredSeries`, and `fetchNewsContext` — replace `throw` with `console.error` + return empty default.

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- tests/market-data.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp-server/market-data.ts tests/market-data.test.ts
git commit -m "fix: add caching + graceful fallback for market data APIs (TDD)"
```

---

## Task 5: Add Startup Preflight Checks (TDD)

**Files:**
- Create: `src/preflight.ts`
- Create: `tests/preflight.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write failing test**

Create `tests/preflight.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkEnvKeys } from '../src/preflight.js';

describe('checkEnvKeys', () => {
  beforeEach(() => {
    // Clear all env vars
    delete process.env.T212_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TWELVE_DATA_API_KEY;
  });

  it('fails when required key T212_API_KEY is missing', () => {
    process.env.ANTHROPIC_API_KEY = 'test';
    const result = checkEnvKeys();
    expect(result.canStart).toBe(false);
    expect(result.missing_required).toContain('T212_API_KEY');
  });

  it('fails when required key ANTHROPIC_API_KEY is missing', () => {
    process.env.T212_API_KEY = 'test';
    const result = checkEnvKeys();
    expect(result.canStart).toBe(false);
    expect(result.missing_required).toContain('ANTHROPIC_API_KEY');
  });

  it('passes with warnings when only optional keys missing', () => {
    process.env.T212_API_KEY = 'test';
    process.env.ANTHROPIC_API_KEY = 'test';
    const result = checkEnvKeys();
    expect(result.canStart).toBe(true);
    expect(result.missing_optional.length).toBeGreaterThan(0);
  });

  it('passes clean when all keys present', () => {
    process.env.T212_API_KEY = 'test';
    process.env.ANTHROPIC_API_KEY = 'test';
    process.env.TELEGRAM_BOT_TOKEN = 'test';
    process.env.TELEGRAM_CHAT_ID = 'test';
    process.env.TWELVE_DATA_API_KEY = 'test';
    process.env.FINNHUB_API_KEY = 'test';
    process.env.FMP_API_KEY = 'test';
    process.env.FRED_API_KEY = 'test';
    process.env.ALPHA_VANTAGE_API_KEY = 'test';
    const result = checkEnvKeys();
    expect(result.canStart).toBe(true);
    expect(result.missing_required).toHaveLength(0);
    expect(result.missing_optional).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/preflight.test.ts
```

Expected: FAIL — `checkEnvKeys` doesn't exist.

- [ ] **Step 3: Implement preflight module**

Create `src/preflight.ts`:

```typescript
// Preflight Checks — Validate environment before bot starts

const REQUIRED_KEYS = ['T212_API_KEY', 'ANTHROPIC_API_KEY'] as const;

const OPTIONAL_KEYS = [
  { key: 'TELEGRAM_BOT_TOKEN', feature: 'Telegram alerts' },
  { key: 'TELEGRAM_CHAT_ID', feature: 'Telegram alerts' },
  { key: 'TWELVE_DATA_API_KEY', feature: 'Price data (candles, VIX, DXY)' },
  { key: 'FINNHUB_API_KEY', feature: 'Economic calendar' },
  { key: 'FMP_API_KEY', feature: 'Sector strength' },
  { key: 'FRED_API_KEY', feature: 'Treasury yields' },
  { key: 'ALPHA_VANTAGE_API_KEY', feature: 'News sentiment' },
] as const;

export interface PreflightResult {
  canStart: boolean;
  missing_required: string[];
  missing_optional: string[];
  warnings: string[];
}

export function checkEnvKeys(): PreflightResult {
  const missing_required: string[] = [];
  const missing_optional: string[] = [];
  const warnings: string[] = [];

  for (const key of REQUIRED_KEYS) {
    if (!process.env[key]) {
      missing_required.push(key);
    }
  }

  for (const { key, feature } of OPTIONAL_KEYS) {
    if (!process.env[key]) {
      missing_optional.push(key);
      warnings.push(`${key} not set — ${feature} disabled`);
    }
  }

  return {
    canStart: missing_required.length === 0,
    missing_required,
    missing_optional,
    warnings,
  };
}

export function runPreflight(): void {
  console.log('Running preflight checks...');
  const result = checkEnvKeys();

  if (result.warnings.length > 0) {
    for (const w of result.warnings) {
      console.warn(`  [WARN] ${w}`);
    }
  }

  if (!result.canStart) {
    console.error(`  [FAIL] Missing required keys: ${result.missing_required.join(', ')}`);
    console.error('  Bot cannot start. Set these in .env and try again.');
    process.exit(1);
  }

  console.log(`  [OK] Required keys present. ${result.missing_optional.length} optional keys missing.`);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- tests/preflight.test.ts
```

Expected: PASS

- [ ] **Step 5: Wire preflight into src/index.ts**

Replace `src/index.ts` content:

```typescript
import { runPreflight } from './preflight.js';
import { initDatabaseAsync } from './database/index.js';
import { initTelegram } from './notifications/telegram.js';
import { startScheduler } from './scheduler/index.js';

async function main(): Promise<void> {
  console.log('='.repeat(50));
  console.log('BetterOpsAI Trading Bot v0.2.0');
  console.log('='.repeat(50));

  // Step 0: Preflight checks
  runPreflight();

  // Step 1: Initialise database
  await initDatabaseAsync();
  console.log('[OK] Database initialised.');

  // Step 2: Initialise Telegram notifications
  initTelegram();
  console.log('[OK] Telegram initialised.');

  // Step 3: Start scheduler
  startScheduler();
  console.log('[OK] Scheduler running. Bot is live.');
  console.log('='.repeat(50));
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
```

- [ ] **Step 6: Commit**

```bash
git add src/preflight.ts src/index.ts tests/preflight.test.ts
git commit -m "feat: add startup preflight checks with graceful degradation (TDD)"
```

---

## Task 6: Extract V3 System Prompts to Markdown Files

**Files:**
- Create: `prompts/ict-agent.md`
- Create: `prompts/swing-agent.md`
- Create: `prompts/researcher-agent.md`
- Create: `prompts/analyst-agent.md`
- Create: `prompts/reflection-agent.md`
- Create: `prompts/review-agent.md`

- [ ] **Step 1: Create prompts directory**

```bash
mkdir -p prompts
```

- [ ] **Step 2: Extract all 6 V3 system prompts from `AGENT_SYSTEM_PROMPTS_V3.docx.pdf`**

Read the PDF and create each markdown file with the EXACT text from the corresponding V3 section. Each file is the complete system prompt — copy verbatim, section headers and all.

- `prompts/ict-agent.md` — V3 Section 1: "MAIN ICT TRADING AGENT — SYSTEM PROMPT" through "WHAT MAKES YOU DIFFERENT FROM A DUMB TRADING BOT"
- `prompts/swing-agent.md` — V3 Section 2: "SWING TRADING AGENT — SYSTEM PROMPT" through "WHAT MAKES A GREAT SWING TRADER"
- `prompts/researcher-agent.md` — V3 Section 3: "MARKET RESEARCHER AGENT — SYSTEM PROMPT" through the research brief JSON format
- `prompts/analyst-agent.md` — V3 Section 4: "TRADE ANALYST AGENT — SYSTEM PROMPT" through the response format
- `prompts/reflection-agent.md` — V3 Section 5: "REFLECTION AGENT — SYSTEM PROMPT (UPDATED)" through the lesson JSON format
- `prompts/review-agent.md` — V3 Section 6: "WEEKLY REVIEW AGENT — SYSTEM PROMPT (UPDATED)" through the strategy update rules

- [ ] **Step 3: Verify each file is non-empty and contains key sections**

```bash
wc -l prompts/*.md
grep -l "STEP 1" prompts/ict-agent.md prompts/swing-agent.md
grep -l "CHECK 1" prompts/analyst-agent.md
grep -l "lesson_id" prompts/reflection-agent.md
```

- [ ] **Step 4: Commit**

```bash
git add prompts/
git commit -m "feat: extract V3 system prompts to markdown files"
```

---

## Task 7: Refactor All Agents to Load V3 Prompts from Files

**Files:**
- Modify: `src/agents/trading-agent.ts`
- Modify: `src/agents/swing-agent.ts`
- Modify: `src/agents/researcher-agent.ts`
- Modify: `src/agents/analyst-agent.ts`
- Modify: `src/agents/reflection-agent.ts`
- Modify: `src/agents/review-agent.ts`

- [ ] **Step 1: Create a shared prompt loader utility**

Add to a new file `src/agents/load-prompt.ts`:

```typescript
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function loadPrompt(filename: string): string {
  const path = join(__dirname, '..', '..', 'prompts', filename);
  return readFileSync(path, 'utf-8');
}

export function loadStrategy(filename: string): string {
  const path = join(__dirname, '..', '..', 'memory', filename);
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return `Strategy file ${filename} not found.`;
  }
}
```

- [ ] **Step 2: Refactor each agent to use loadPrompt**

In each agent file, replace the hardcoded `const ICT_SYSTEM_PROMPT = ...` (or equivalent) with:

```typescript
import { loadPrompt, loadStrategy } from './load-prompt.js';

// In the agent function:
const systemPrompt = loadPrompt('ict-agent.md'); // or swing-agent.md, etc.
```

Remove the old hardcoded prompt strings entirely. Apply to all 6 agent files:
- `trading-agent.ts` → `loadPrompt('ict-agent.md')` + `loadStrategy('strategy.md')`
- `swing-agent.ts` → `loadPrompt('swing-agent.md')` + `loadStrategy('swing_strategy.md')`
- `researcher-agent.ts` → `loadPrompt('researcher-agent.md')`
- `analyst-agent.ts` → `loadPrompt('analyst-agent.md')`
- `reflection-agent.ts` → `loadPrompt('reflection-agent.md')`
- `review-agent.ts` → `loadPrompt('review-agent.md')`

- [ ] **Step 3: Remove duplicate loadStrategy/loadFile functions from individual agent files**

Each agent currently has its own `loadStrategy()` or `loadFile()` function. Delete these — they're now centralized in `load-prompt.ts`.

- [ ] **Step 4: Type check**

```bash
npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 5: Commit**

```bash
git add src/agents/
git commit -m "feat: all 6 agents load V3 prompts from markdown files"
```

---

## Task 8: Add Remaining Module Tests

**Files:**
- Create: `tests/scanner.test.ts`
- Create: `tests/news.test.ts`
- Create: `tests/telegram.test.ts`

- [ ] **Step 1: Write scanner tests**

Create `tests/scanner.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import type { Candle } from '../src/types.js';

// Import the bias detection function — need to export it from scanner
import { detectBias, getCurrentKillZone } from '../src/scanner/index.js';

function makeCandles(pattern: 'bullish' | 'bearish' | 'neutral', count: number = 20): Candle[] {
  const candles: Candle[] = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    const change = pattern === 'bullish' ? 1 + Math.random() : pattern === 'bearish' ? -(1 + Math.random()) : (Math.random() - 0.5);
    price += change;
    candles.push({
      datetime: new Date(Date.now() - i * 3600000).toISOString(),
      open: price - 0.5,
      high: price + 1,
      low: price - 1,
      close: price,
      volume: 1000,
    });
  }
  return candles;
}

describe('detectBias', () => {
  it('detects bullish bias from ascending candles', () => {
    const result = detectBias(makeCandles('bullish', 25));
    expect(['bullish', 'neutral']).toContain(result.bias);
    expect(result.atr).toBeGreaterThan(0);
  });

  it('returns neutral for insufficient data', () => {
    const result = detectBias(makeCandles('bullish', 5));
    expect(result.bias).toBe('neutral');
    expect(result.clarity).toBe(0);
  });

  it('calculates ATR as positive number', () => {
    const result = detectBias(makeCandles('bullish', 25));
    expect(result.atr).toBeGreaterThan(0);
  });
});

describe('getCurrentKillZone', () => {
  it('returns an object with inKillZone and zone', () => {
    const result = getCurrentKillZone();
    expect(result).toHaveProperty('inKillZone');
    expect(result).toHaveProperty('zone');
    expect(typeof result.inKillZone).toBe('boolean');
  });
});
```

Note: `detectBias` and `getCurrentKillZone` need to be exported from `src/scanner/index.ts`. Add `export` keyword to both functions.

- [ ] **Step 2: Write news tests**

Create `tests/news.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { isNewsOpposing } from '../src/news/index.js';

describe('isNewsOpposing', () => {
  it('returns true when Cat A news opposes bullish bias', () => {
    expect(isNewsOpposing('bearish', 'A', 'bullish')).toBe(true);
  });

  it('returns true when Cat A news opposes bearish bias', () => {
    expect(isNewsOpposing('bullish', 'A', 'bearish')).toBe(true);
  });

  it('returns false for Cat B opposing news (not strong enough)', () => {
    expect(isNewsOpposing('bearish', 'B', 'bullish')).toBe(false);
  });

  it('returns false when news aligns with bias', () => {
    expect(isNewsOpposing('bullish', 'A', 'bullish')).toBe(false);
  });

  it('returns false for neutral news', () => {
    expect(isNewsOpposing('neutral', 'A', 'bullish')).toBe(false);
  });
});
```

- [ ] **Step 3: Write telegram tests**

Create `tests/telegram.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import type { TradeRecord } from '../src/types.js';

// We need to test the message formatting logic
// For now, test that the module imports without error
describe('telegram module', () => {
  it('imports without error', async () => {
    const mod = await import('../src/notifications/telegram.js');
    expect(mod.initTelegram).toBeDefined();
    expect(mod.alertTradePlaced).toBeDefined();
    expect(mod.alertKillSwitch).toBeDefined();
  });
});
```

- [ ] **Step 4: Export detectBias and getCurrentKillZone from scanner**

In `src/scanner/index.ts`, add `export` to the `detectBias` function and `getCurrentKillZone` function declarations.

- [ ] **Step 5: Run all tests**

```bash
npm test
```

Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add tests/ src/scanner/index.ts
git commit -m "test: add unit tests for scanner, news, and telegram modules"
```

---

## Task 9: Final Verification + Type Check

- [ ] **Step 1: Run full type check**

```bash
npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 2: Run all tests**

```bash
npm test
```

Expected: ALL PASS, zero failures.

- [ ] **Step 3: Verify V3 prompts load**

```bash
node --input-type=module -e "
import { readFileSync } from 'fs';
const files = ['ict-agent.md', 'swing-agent.md', 'researcher-agent.md', 'analyst-agent.md', 'reflection-agent.md', 'review-agent.md'];
for (const f of files) {
  const content = readFileSync('prompts/' + f, 'utf-8');
  console.log(f + ': ' + content.length + ' chars, starts with: ' + content.substring(0, 50).replace(/\n/g, ' '));
}
"
```

Expected: All 6 files load with non-trivial content.

- [ ] **Step 4: Count lines changed**

```bash
git diff master --stat
```

- [ ] **Step 5: Final commit if any uncommitted changes**

```bash
git add -A
git status
# If changes exist:
git commit -m "chore: final hardening cleanup"
```

---

## Summary

| Task | What | Tests |
|------|------|-------|
| 0 | Setup branch + vitest | — |
| 1 | Fix SQL win rate bug | 3 tests |
| 2 | Fix analyst default to REJECT | 5 tests |
| 3 | Fix candle detection timezone | 4 tests |
| 4 | Add market data caching + fallback | 3 tests |
| 5 | Add startup preflight checks | 4 tests |
| 6 | Extract V3 prompts to files | — |
| 7 | Refactor agents to load V3 prompts | — |
| 8 | Add scanner/news/telegram tests | 7 tests |
| 9 | Final verification | — |
| **Total** | **9 tasks, ~10 commits** | **26 tests** |

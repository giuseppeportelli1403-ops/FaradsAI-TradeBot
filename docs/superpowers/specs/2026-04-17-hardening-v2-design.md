# Hardening V2 — Design Spec
> BetterOpsAI Trading Bot
> Date: 2026-04-17
> Branch: `hardening-v2` off `master`
> Approach: TDD Hardening with parallel agent streams

---

## Context

The trading bot was built in a single rapid session (3,265 lines, 6 commits). It is feature-complete but has 6 critical bugs, 5 high-priority issues, zero test coverage, and the V3 agent system prompts are not properly injected. This hardening pass fixes all critical/high issues, injects the real V3 prompts, and adds comprehensive test coverage — all using TDD.

---

## Scope

### In Scope
- Fix 6 critical bugs (SQL, analyst default, timezone, API validation, atomic logging, error handling)
- Extract and inject all 6 V3 system prompts from PDF to markdown files
- Add Vitest test framework with unit tests for all critical modules
- Startup preflight checks with graceful degradation
- All work on `hardening-v2` branch

### Out of Scope
- New features or agents
- UI/dashboard
- VPS deployment
- Actual API key procurement (done separately with Giuseppe)
- Refactoring modules that work correctly (scanner, news scoring, telegram formatting)

---

## Section 1: Critical Bug Fixes

### 1.1 Lesson Win Rate SQL Bug
- **File:** `src/database/index.ts` — `getLessonWinRate()`
- **Bug:** Query appends `WHERE pnl_total_r > 0` incorrectly when filters exist
- **Fix:** Rewrite query construction — always build WHERE clause from conditions array, then join with AND
- **Test:** Query with 0 filters, 1 filter, and 3 filters all return correct win rates

### 1.2 Analyst Agent Defaults to APPROVE on Parse Failure
- **File:** `src/agents/analyst-agent.ts` lines 140-142
- **Bug:** Invalid JSON from Claude → APPROVE with 0.5 confidence (fail-open)
- **Fix:** Default to REJECT with reason "JSON parse failure — defaulting to reject for safety"
- **Test:** Feed malformed JSON, verify REJECT returned

### 1.3 Candle Close Detection Timezone Bug
- **File:** `src/scheduler/index.ts` — `check15mCandleClose()`, `check1hCandleClose()`
- **Bug:** `getUTCMonth()` returns 0-11, used in string comparison without +1 or padding
- **Fix:** Use ISO timestamp substring for candle key comparison
- **Test:** Verify correct detection at month boundaries (e.g. April 30 → May 1)

### 1.4 No API Key Validation at Startup
- **File:** `src/index.ts` (new preflight module)
- **Bug:** Missing API keys default to empty string, bot runs silently broken
- **Fix:** New `src/preflight.ts` module:
  - Check all 9 env vars exist
  - Required keys (T212, ANTHROPIC): fail startup if missing
  - Optional keys (TELEGRAM, market data): warn and disable feature
  - T212: test connectivity with `get_balance()` call
  - Report status table at startup
- **Test:** Verify startup fails with missing required keys, warns on missing optional keys

### 1.5 No Atomic Trade Leg Logging
- **File:** `src/agents/trading-agent.ts`, `src/agents/swing-agent.ts` — `executeTool('place_order')`
- **Bug:** Place order A → place order B → log. If B fails, orphaned Position A
- **Fix:** In the tool executor, wrap both place_order calls:
  1. Place order A → capture result
  2. Place order B → if fails, immediately close order A, return error
  3. Only call log_trade after both succeed
- **Test:** Simulate order B failure, verify order A is closed and no trade logged

### 1.6 Market Data API Silent Crashes
- **File:** `src/mcp-server/market-data.ts` — all fetch functions
- **Bug:** Missing API key throws, killing the scheduler loop
- **Fix:** Wrap each external API function with try/catch:
  - Return empty/default data on failure
  - Log the error with API name and reason
  - Add in-memory cache (5-min TTL) to reduce API calls and serve stale data on failure
- **Test:** Verify each function returns default data when API key missing or API errors

---

## Section 2: V3 System Prompt Injection

### 2.1 Extract Prompts to Markdown Files
- **Source:** `AGENT_SYSTEM_PROMPTS_V3.docx.pdf` (18 pages, 6 sections)
- **Output:** New `prompts/` directory with 6 files:
  - `prompts/ict-agent.md` — V3 Section 1 (ICT 5-step cycle, split-position, all rules)
  - `prompts/swing-agent.md` — V3 Section 2 (4-layer framework, 10-step sequence)
  - `prompts/researcher-agent.md` — V3 Section 3 (regime, themes, shortlists)
  - `prompts/analyst-agent.md` — V3 Section 4 (6-check approval, response format)
  - `prompts/reflection-agent.md` — V3 Section 5 (structured lesson JSON format)
  - `prompts/review-agent.md` — V3 Section 6 (weekly report, strategy update rules)

### 2.2 Refactor Agent Prompt Loading
- **Files:** All 6 agent files in `src/agents/`
- **Change:** Replace hardcoded stub system prompts with:
  ```typescript
  const systemPrompt = readFileSync(join(__dirname, '..', '..', 'prompts', 'ict-agent.md'), 'utf-8');
  ```
- **Each agent receives:** V3 system prompt + current strategy file + latest research brief
- **Stub prompts removed entirely** from TypeScript files

### 2.3 Verification
- Read each extracted markdown file back and compare key sections against V3 PDF
- Verify all 6 agents load their prompt file without error
- TypeScript compiles with zero errors

---

## Section 3: Test Coverage

### 3.1 Test Framework
- **Tool:** Vitest (fast, TypeScript-native, ESM-compatible)
- **Config:** `vitest.config.ts` at project root
- **Structure:** `tests/` directory mirroring `src/` structure
- **Run:** `npm test` script in package.json

### 3.2 Test Files

| Test File | Module Under Test | Key Tests |
|-----------|------------------|-----------|
| `tests/database.test.ts` | `src/database/index.ts` | Insert/query trades, lessons, win rate calc (with/without filters), SL/TP order CRUD, daily P&L upsert, trade status updates |
| `tests/scanner.test.ts` | `src/scanner/index.ts` | Bias detection from candle arrays (bullish/bearish/neutral), kill zone detection by UTC hour, ATR calculation |
| `tests/news.test.ts` | `src/news/index.ts` | Cat A/B/C classification from sentiment scores, direction opposition logic, score calculation |
| `tests/scheduler.test.ts` | `src/scheduler/index.ts` | Candle close detection (15M, 1H, month boundaries), SL hit detection (long/short), TP hit → SL to BE logic |
| `tests/analyst.test.ts` | `src/agents/analyst-agent.ts` | JSON parse failure → REJECT, valid JSON → correct parsing |
| `tests/market-data.test.ts` | `src/mcp-server/market-data.ts` | VIX regime classification, DXY direction logic, correlation math, graceful failures on missing keys |
| `tests/telegram.test.ts` | `src/notifications/telegram.ts` | Message formatting, 4096 char truncation |
| `tests/preflight.test.ts` | `src/preflight.ts` | Required key missing → fail, optional key missing → warn, all present → pass |

### 3.3 Test Data
- Mock candle arrays (bullish, bearish, neutral patterns)
- Mock T212 portfolio/balance responses
- Mock news items with various sentiment scores
- No real API calls in tests — all mocked

---

## Section 4: Parallel Work Streams

### Stream 1: Critical Bug Fixes (TDD)
- **Files touched:** `database/index.ts`, `agents/analyst-agent.ts`, `scheduler/index.ts`, `agents/trading-agent.ts`, `agents/swing-agent.ts`, `mcp-server/market-data.ts`
- **New files:** `src/preflight.ts`
- **Depends on:** Vitest installed (from Stream 3 setup)

### Stream 2: V3 Prompt Injection
- **Files touched:** All 6 agent files in `src/agents/`
- **New files:** 6 markdown files in `prompts/`
- **No overlap with Stream 1** — Stream 1 fixes bug logic, Stream 2 replaces prompt strings

### Stream 3: Test Infrastructure + Module Tests
- **New files:** `vitest.config.ts`, 8 test files in `tests/`
- **Package changes:** Add vitest to devDependencies
- **No overlap** — creates new test files only

### Stream 4: Review (sequential, after 1-3)
- Code review all changes against this spec
- Run `npx tsc --noEmit` — zero errors
- Run `npm test` — all tests pass
- Verify V3 prompts load correctly
- Final verification using `/verification-before-completion`

---

## Verification Plan

1. `npx tsc --noEmit` — zero TypeScript errors
2. `npm test` — all tests pass
3. Each critical bug has a specific test that would have caught it
4. All 6 agents load V3 prompts from `prompts/` directory
5. Bot starts with mock `.env` — preflight reports status correctly
6. Bot starts with missing optional keys — warns but doesn't crash
7. Bot refuses to start with missing required keys (T212, ANTHROPIC)

---

## Files Changed Summary

### Modified
- `src/database/index.ts` — fix win rate SQL
- `src/agents/analyst-agent.ts` — fix default to REJECT + load V3 prompt
- `src/agents/trading-agent.ts` — atomic logging + load V3 prompt
- `src/agents/swing-agent.ts` — atomic logging + load V3 prompt
- `src/agents/researcher-agent.ts` — load V3 prompt
- `src/agents/reflection-agent.ts` — load V3 prompt
- `src/agents/review-agent.ts` — load V3 prompt
- `src/scheduler/index.ts` — fix candle detection
- `src/mcp-server/market-data.ts` — error handling + caching
- `src/index.ts` — add preflight checks
- `package.json` — add vitest

### New
- `src/preflight.ts` — startup validation
- `prompts/ict-agent.md`
- `prompts/swing-agent.md`
- `prompts/researcher-agent.md`
- `prompts/analyst-agent.md`
- `prompts/reflection-agent.md`
- `prompts/review-agent.md`
- `vitest.config.ts`
- `tests/database.test.ts`
- `tests/scanner.test.ts`
- `tests/news.test.ts`
- `tests/scheduler.test.ts`
- `tests/analyst.test.ts`
- `tests/market-data.test.ts`
- `tests/telegram.test.ts`
- `tests/preflight.test.ts`

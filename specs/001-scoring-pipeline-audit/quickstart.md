# Phase 1 — Quickstart Verification

**Feature:** Scoring Pipeline Audit & Silent-Rejection Fix
**Spec:** [spec.md](./spec.md) | **Plan:** [plan.md](./plan.md) | **Data Model:** [data-model.md](./data-model.md)
**Date:** 2026-05-12

This document is a copy-pasteable verification recipe per user story. Use it after each PR merges to confirm the acceptance scenarios from spec.md actually behave as specified. Every recipe runs against a local dev DB (`data/trading-bot-dev.db`) — never production.

**Prerequisites:**
```powershell
Set-Location "C:\Users\user\Desktop\Trade Bot\Trade Bot"
git checkout spec/scoring-pipeline-audit  # or the merged branch
npm install
npm run build
$env:NODE_ENV = "test"  # uses data/trading-bot-test.db, isolated from VPS data
```

---

## US-1 — Score must be deterministic and reproducible

**Acceptance scenario 1 reference:** Same snapshot → same score on every run.

```powershell
# Run the determinism harness
npm test -- tests/scoring/compose.test.ts

# Expected: PASS — "10 runs of identical input produce identical composite_score (variance = 0)"

# Manually replay one snapshot and inspect the breakdown
node -e "
  const { composeScore } = require('./build/scoring/compose.js');
  const fixture = require('./tests/fixtures/scoring/historical-snapshots.json')[0];
  for (let i = 0; i < 5; i++) {
    const r = composeScore(fixture.input);
    console.log(JSON.stringify({ run: i, score: r.composite_score, tier: r.tier, breakdown: r.score_breakdown }));
  }
"

# Expected: 5 lines, all identical except for "run" index. score_breakdown shows base/bias/ict_array/news/history/spread keys.
```

**Acceptance scenario 3 reference:** Re-scoring historical T1 trades — ≥80% retain T1 (SC-006).

```powershell
npm run scoring-regression -- --days 30
# Custom script under scripts/scoring-regression.ts that:
#  1. Loads last 30 days of trades from VPS DB snapshot (read-only)
#  2. For each trade, re-runs composeScore() against its frozen input
#  3. Reports: "47/52 historical T1 trades retain T1 = 90.4% (PASS)"
```

---

## US-2 — Every rejection visible and categorised

**Acceptance scenario 1 reference:** Forced API timeout → digest shows `ANALYST_FAIL_CLOSED_API_ERROR: 1`.

```powershell
# Force an analyst API timeout via env var
$env:ANALYST_FORCE_TIMEOUT = "true"

# Run one trading cycle
npm run trade-cycle-once

# Build today's digest
npm run digest -- --date today
# Expected output snippet:
#   ANALYST_FAIL_CLOSED_API_ERROR : 1
#   ANALYST_APPROVE               : 0
#   (other categories: 0)

# Cleanup
Remove-Item env:ANALYST_FORCE_TIMEOUT
```

**Acceptance scenario 2 reference:** Hash mismatch on approved trade → `POST_APPROVAL_HASH_MISMATCH` row.

```powershell
npm test -- tests/rejection-log/digest.test.ts
# The integration test plants an approved trade, mutates the proposal payload, then triggers placement.
# Expected: trade_rejections row with category='POST_APPROVAL_HASH_MISMATCH' AND digest line for that category.
```

**Acceptance scenario 3 reference:** 12 rejections across 5 categories → digest sums to exactly 12.

```powershell
# Generate 12 forced rejections across 5 categories using the test harness
npm test -- tests/rejection-log/categories.test.ts -- --grep "12 rejections sum"

# Manually:
sqlite3 data/trading-bot-test.db "SELECT category, COUNT(*) FROM trade_rejections GROUP BY category"
# Expected: 5 rows, sum of counts = 12, no 'OTHER' row.
```

---

## US-3 — Code-level cooldown after 3 losses

**Acceptance scenario 1 reference:** 3 consecutive losses → next proposal rejected with `COOLDOWN_3_LOSSES_ACTIVE`.

```powershell
# Plant 3 closed losing trades into the test DB
npm run plant-trades -- --losses 3

# Submit a fresh proposal of any tier
npm run submit-proposal -- --instrument EURUSD --tier 2

# Expected stdout:
#   REJECTED: COOLDOWN_3_LOSSES_ACTIVE
#   reason: 3 consecutive losses recorded; cooldown active until 2026-05-13T18:30:00Z

# Check the DB
sqlite3 data/trading-bot-test.db "SELECT category, reason_text FROM trade_rejections ORDER BY ts DESC LIMIT 1"
# Expected: COOLDOWN_3_LOSSES_ACTIVE row.
```

**Acceptance scenario 2 reference:** 2 losses + 1 win → cooldown does NOT fire.

```powershell
npm run plant-trades -- --pattern LLW
npm run submit-proposal -- --instrument EURUSD --tier 2
# Expected: proposal proceeds to analyst (no cooldown rejection)
```

**Acceptance scenario 3 reference:** Cooldown clears after 24h.

```powershell
npm test -- tests/cooldown/state.test.ts -- --grep "clears after 24h"
# Test uses a frozen-clock helper to advance time.
```

---

## US-4 — Range-mode evaluation (gated on backtest)

**Acceptance scenario 1 reference:** Backtest favours cap removal → range setups can be Tier 2.

```powershell
# Run the range-mode backtest harness
npm run backtest:range-mode -- --days 90 --report specs/001-scoring-pipeline-audit/range-mode-backtest.md

# Expected: report file written. Open it:
code specs/001-scoring-pipeline-audit/range-mode-backtest.md

# Decision logic:
# IF report shows range-mode T2-eligible win rate ≥45% AND ≥1.3R avg AND within 5pp of trend-mode T2:
#   → US-4 ships: cap removed
# ELSE:
#   → US-4 closes as "evaluated, no change". Report committed for record.
```

**Acceptance scenario 2 reference (cap kept):** Range setup with raw 78 → still capped at 59 AND log line emitted.

```powershell
npm test -- tests/scanner.test.ts -- --grep "range_cap_applied logged"
# After the test, query:
sqlite3 data/trading-bot-test.db "SELECT breakdown_json FROM score_breakdowns WHERE instrument='EURUSD' ORDER BY scored_at DESC LIMIT 1"
# Expected: JSON contains "range_cap_applied": true
```

---

## US-5 — Structure component in scanner score

**Acceptance scenario 1 reference:** High structure beats high bias.

```powershell
npm test -- tests/scoring/ict-array.test.ts -- --grep "structure outranks bias"

# Manual verification:
node -e "
  const { composeScore } = require('./build/scoring/compose.js');
  const A = { /* bias_clarity=15, ict_array=high (sweep+OB+FVG), news=0, spread=tight */ };
  const B = { /* bias_clarity=25, ict_array=low (none), news=0, spread=tight */ };
  console.log('A:', composeScore(A).composite_score);
  console.log('B:', composeScore(B).composite_score);
"
# Expected: A.composite_score >= B.composite_score
```

**Acceptance scenario 2 reference:** ≥80% historical T1 retention (SC-006). See US-1 quickstart.

---

## US-6 — Surface post-approval drops

**Acceptance scenario 1 reference:** TTL expiry logged with both timestamps.

```powershell
npm test -- tests/rejection-log/digest.test.ts -- --grep "POST_APPROVAL_TTL_EXPIRED"

# Manual: plant an approval, advance clock past TTL, attempt placement
npm run plant-approval -- --ttl 1
Start-Sleep -Seconds 2
npm run place-pending
sqlite3 data/trading-bot-test.db "SELECT category, subcategory, reason_text FROM trade_rejections ORDER BY ts DESC LIMIT 1"
# Expected: POST_APPROVAL_TTL_EXPIRED with subcategory containing both timestamps and elapsed delta.
```

---

## US-7 — Opt-in concurrent trades within risk budget

**Acceptance scenario 1 reference:** budget=2.5%, two T2 trades both approved.

```powershell
# Set the risk budget
sqlite3 data/trading-bot-test.db "UPDATE pm_state SET value='2.5' WHERE key='max_total_risk_pct'"

# Open one T2 trade
npm run submit-proposal -- --instrument EURUSD --tier 2 --risk_pct 1.0
# Expected: APPROVED (open_risk=0, proposed=1.0, budget=2.5 → ok)

# Submit second T2
npm run submit-proposal -- --instrument GBPUSD --tier 2 --risk_pct 1.0
# Expected: APPROVED (open_risk=1.0, proposed=1.0, budget=2.5 → ok)

# Submit third T1
npm run submit-proposal -- --instrument USDJPY --tier 1 --risk_pct 1.5
# Expected: REJECTED with EXECUTOR_REJECT_RISK_BUDGET_EXCEEDED (open_risk=2.0, proposed=1.5, budget=2.5 → no)
```

**Acceptance scenario 3 reference:** budget=0 (default) preserves single-trade behaviour.

```powershell
sqlite3 data/trading-bot-test.db "UPDATE pm_state SET value='0.0' WHERE key='max_total_risk_pct'"
npm run submit-proposal -- --instrument EURUSD --tier 2 --risk_pct 1.0
# Expected: APPROVED
npm run submit-proposal -- --instrument GBPUSD --tier 2 --risk_pct 1.0
# Expected: REJECTED with EXECUTOR_REJECT_TRADE_OPEN (legacy gate, identical to today)
```

---

## Full-system smoke after PR merge

After ANY of the three PRs merges to master:

```powershell
# 1. Run the entire test suite — must stay green
npm test
# Expected: 820 + N new tests pass. ZERO regressions.

# 2. Replay the last 7 production days through the scoring pipeline (read-only)
npm run scoring-regression -- --days 7 --source-db /tmp/vps-snapshot.db
# Expected: ≥95% of historical scores match within ±2 points OR each delta documented

# 3. Generate today's digest from production DB snapshot
npm run digest -- --source-db /tmp/vps-snapshot.db --date today --dry-run
# Expected: every rejection has a category, no 'OTHER', no nulls

# 4. tsc clean check
npm run tsc -- --noEmit
# Expected: zero errors
```

**Pre-deploy gate:** All four steps above MUST pass before `git push origin master` and the VPS pull.

**Post-deploy gate:** 24h after deploy, query the production digest and verify SC-008 (rejection rate ≤ baseline + 10pp).

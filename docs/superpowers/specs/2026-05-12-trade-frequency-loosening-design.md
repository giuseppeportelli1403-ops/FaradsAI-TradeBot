# Trade-Frequency Loosening Initiative — Design

**Date:** 2026-05-12
**Status:** Design approved by Giuseppe 2026-05-12; awaiting implementation-plan handoff
**Related work:** `docs/superpowers/plans/2026-05-11-remove-modify-decision.md` (just-shipped), `scripts/audit-trigger-decisions.ts` (empirical evidence base), `C:\Users\user\AppData\Local\Temp\farad-strictness-comparison.md` (the comparison that surfaced the over-strictness finding)

---

## 1. Problem

Farad bot fires **0–1 trades per day** in practice (yesterday: 20 ICT cycles, 1 proposal submitted to analyst; today's first post-reload cycle: NO TRADE). Empirical evidence chain:

- **Strictness comparison vs 5 OSS bots** (`farad-strictness-comparison.md`): of 12 gate dimensions, Farad is stricter than the average comparator on 8, comparable on 1, looser on 3. Net verdict: *"meaningfully stricter than any single comparator… defensive against the LLM rather than predictive about the market."*
- **Audit script** (`scripts/audit-trigger-decisions.ts` on 30 days): 95.2% agreement between LLM trigger decisions and deterministic math; **zero hallucinations** (LLM never claims a trigger that fails the math); 1 confirmed real LLM miss in 30 days. The bot's gates are correctly applied; the gates ARE the strictness.
- **Yesterday's MODIFY-removal session conclusion**: *"LLM is overcautious — Force-Propose Rule fires almost never; when triggers qualify, the LLM sometimes overlooks them. Cost is missed trades, not bad trades."*

Three independent evidence sources converge: the bot is too strict for the desired trade cadence. Giuseppe's target: **3–5 trades per day**, a 3–10× lift over current rate.

## 2. Goal

Increase the bot's executed trade frequency to **3–5 trades/day average** by loosening selected gates without weakening safety-critical ones. Keep the bot active only in current kill zones (no time-window expansion).

**Non-goal:** higher trade frequency at the cost of catastrophic loss exposure. The 6% daily and 10% weekly kill switches are off-limits.

**Non-goal:** rewriting the multi-agent architecture or the deterministic safety scaffolding (analyst_token hash binding, server-side resizing, fail-closed coercion). Those are load-bearing properties from the MODIFY-removal work and the strictness comparison's "unusually strict" column.

## 3. Approach

Two-PR sequenced rollout: numerical loosening (backtest-gated + **shadow-LLM-replay-gated**) ships first, ICT prompt restructure (demo-measurement-gated + **A/B-prompt-replay-gated**) ships second. Each PR is independently revertible. Demo-only — no live capital at risk during the validation window.

If the moderate-aggressive loosening lands trade frequency in the 1–3/day band rather than the 3–5 target, **Option 3 (very aggressive)** — Tier 3 25/30, body 0.25, wick 0.5, Force-Propose 35 — is held in reserve **but is UNCONDITIONALLY GATED** behind: (a) a separate backtest sweep, AND (b) a shadow-LLM hallucination review using the audit-script confusion matrix (current shows zero hallucinations at current strictness — must remain zero under Option 3 thresholds before activation). Option 3 is NOT an emergency knob; treat as a Phase 2 spec requiring its own brainstorm + design.

## 4. In-scope changes (loosen)

| Gate | Current | New | File / Anchor |
|---|---|---|---|
| Tier 3 score floor — tight-spread instruments (EURUSD, GBPUSD, AUDUSD, USDJPY, GOLD) | 40 | **30** | `src/scanner/index.ts` (`tier3FloorFor`) |
| Tier 3 score floor — medium-spread instruments (OIL_CRUDE, SILVER) | 45 | **35** | same |
| OB Retest body ratio | ≥ 0.4 × range | **≥ 0.3 × range** | `prompts/ict-agent.md` line ~179 |
| OB Retest opposing wick | ≥ 1.0 × body | **≥ 0.7 × body** | `prompts/ict-agent.md` line ~179 |
| FVG Fill confirmation candle body ratio | ≥ 0.4 × range | **≥ 0.3 × range** | `prompts/ict-agent.md` line ~180 |
| Force-Propose threshold (composite_score) | ≥ 55 | **≥ 40** | `prompts/ict-agent.md` Step 3M |
| ICT prompt — trigger evaluation logic | Sequential / narrative-anchored (audit caught OB anchoring → FVG_fill miss on 2026-05-04) | **Parallel multi-trigger evaluation per cycle** — score each of 5 triggers independently against the candidate's OHLC; propose if ANY trigger fires AND composite_score ≥ Force-Propose floor | `prompts/ict-agent.md` Step 3I |

**Not changed in this scope (also "in-scope" but kept at current values):**
- Liquidity Sweep body ≥ 0.6 × range (no change — already permissive)
- Range Sweep Reversal body ≥ 0.6 × range (no change)
- Breakout Retest hold-confirm = 2 consecutive closes on bias side (no change)
- 5 trigger types — count and shape unchanged

## 5. Out-of-scope (off-limits, NOT touched)

Explicitly preserved at current values per Giuseppe's instruction:

- **Calendar veto** — Tier-1 events (FOMC/NFP/CPI/CB rate/Core PCE/GDP/ISM/AHE/UR/Retail Sales) keep the −60/+30 min window. Generic high-impact events keep the −5/+15 min window. *Note: there is a documented prompt-vs-code drift on the generic window (prompt says +30, code says +15) — that bug is tracked separately and is NOT addressed in this PR set. R2 from the strictness comparison.*
- **News veto Cat A opposing** — keep half-size on trend-mode, invalidate on range-mode.
- **Kill zones** — keep 3 sessions only (London Open 07–10, NY Open 13–16, London Close 15–18 UTC). No Asia session, no window expansion.
- **6% daily kill switch** — keep.
- **10% weekly kill switch** — keep.
- **Analyst 6-check gate** — keep. Zero hallucinations in audit; load-bearing.
- **Analyst_token hash binding + server-side resizing** — keep. Defense against the MODIFY-incident class.
- **Order-side / R:R floor / sizing-math pre-checks** — keep. Cheap defensive validation.
- **Fail-closed coercion paths** — keep. All 5 fail-closed paths (calendar fetch, balance fetch, market-details fetch, live-positions fetch, analyst_token validation) preserved.
- **Bias clarity score contribution** (`src/scanner/index.ts` — bias clarity 0/15/20/25 toward composite_score) — **unchanged**. Tier 3 floor drop is on the COMPOSITE score, not on bias clarity. Lowering Tier 3 floor admits candidates with weaker bias clarity into the analyst gate, but the bias-clarity-to-composite-score mapping itself stays at its current calibration. Per codex finding #7.
- **Session bias validity / confluence-count gates** (if any exist as separate scanner-side filters) — unchanged. Implementation plan must audit `src/scanner/index.ts` to confirm no other scanner-side gates are implicitly affected by Tier 3 floor drop.

## 6. Architecture: two-PR sequence

### PR 1 — Numerical loosening (backtest-gated)

**Files touched:** `src/scanner/index.ts` (Tier 3 floor constants), `prompts/ict-agent.md` (body/wick thresholds in Steps 3I/3M, Force-Propose threshold in Step 3M).

**Validation gate (must pass before merging — TWO sub-gates):**

**Sub-gate 1 (deterministic backtest):** run `scripts/run-backtest.ts` on 30–90 days of historical data with the NEW thresholds. Compare to baseline (current thresholds, same date range, same instruments). **Ship criteria — REVISED per codex findings #2, #9:**

- Trade count: ≥ 3× baseline (target: hit 3-5 trades/day frequency)
- **Win rate: ≥ 45% absolute floor** (NOT retention-based). Break-even at 1.3R wins / 1.0R losses is 43.5% — design floor sits 1.5pp above break-even. Codex math: 25% × 1.3R − 75% × 1.0R = **−0.425R/trade** (negative expectancy) — the prior "25% retention" criterion would have approved a losing strategy.
- **Expected R/trade: ≥ 0.3R** as a HARD ship gate, computed as `win_rate × avg_win_R − loss_rate × avg_loss_R`. Per-instrument breakdown required.
- **Baseline-retention NEVER undercuts break-even + 5pp margin**: regardless of absolute win rate, if (new_win_rate < baseline_win_rate − 5pp) AND new_win_rate < 48%, fail. Prevents shipping changes that gut win rate even if expectancy looks acceptable on biased sample.
- No single instrument shows total drawdown > 2× current 6% daily kill switch ceiling (12%) under the loosened thresholds.
- **Per-instrument reporting required** (codex finding #10): trade count, win rate, avg win R, avg loss R, expected R/trade — reported per ticker. GOLD / OIL_CRUDE / SILVER may respond differently from FX pairs.

**Sub-gate 2 (shadow-LLM replay, codex findings #1 + #8):** before PR 1 merge, replay the last 50 ICT cycles from `data/pm2-out.log` through the CURRENT sequential prompt + NEW thresholds. Focus on newly-admitted candidates (composite_score 30-39 and Force-Propose 40-54 range — the range NEW thresholds unlock that the OLD thresholds rejected). Use `scripts/audit-trigger-decisions.ts --debug-cycle` mode in batch. Measure:
- Trigger qualification rate under NEW thresholds vs OLD thresholds
- Analyst proposal rate (how many new candidates would have hit analyst)
- Hallucination delta (audit-script confusion-matrix FP count must remain 0)

If shadow replay shows hallucinations appearing (FP count > 0): NEW thresholds are too loose, tune up. If trigger qualification rate jumps > 5× (way past 3-5/day target): cap at 5× by holding back the loosest dimension.

Additionally, replay 20 cycles through PR 2's prompt structure (parallel multi-trigger) with NEW thresholds. If PR 2 behavior diverges materially from the deterministic backtest, hold PR 1 merge until PR 2 design is also stable — sequential PR ordering must not invalidate PR 1's backtest assumptions.

If either sub-gate fails: tune individual thresholds (e.g., keep body 0.4 but lower Tier 3 floor only; or vice versa), re-run, re-check. Iterate up to 5 cycles before escalating to user.

**Per-cycle analyst load limit (codex finding #3):** lowering Tier 3 floor 40→30 AND Force-Propose 55→40 simultaneously could 3-5× the analyst's per-cycle load. Add to implementation:
- **Hard cap: max 5 candidates submitted to analyst per cycle**. If scanner returns >5 candidates above Force-Propose floor, submit only top-5-by-composite-score. Prevents analyst-call flood.
- **Latency SLO**: analyst call timeout stays at 60s (current); if rolling-average analyst-call duration exceeds 90s over 10 cycles, flag for investigation (could indicate truncation under load).
- **Measurement**: track `candidates_reviewed / trade_placed` ratio. Current baseline is ~20:1 (most cycles see candidates but none qualify). Expect ratio stays ≥ 10:1 after loosening. If it drops below 5:1, analyst is rubber-stamping — investigate.

### PR 2 — ICT prompt restructure (demo-measurement-gated)

**Files touched:** `prompts/ict-agent.md` — rewrite Step 3I from "evaluate top candidate's trigger" to "score each of 5 triggers independently for each candidate; propose if ANY trigger fires AND composite_score ≥ Force-Propose floor."

The exact prompt rewrite is the implementation-plan's job. Direction-setting only here:
- Remove narrative-driven trigger selection language ("Top candidate GOLD shows OB structure visible…")
- Replace with structured trigger-by-trigger evaluation table the agent must fill in for the top N candidates
- Force the agent to explicitly mark each of (OB_retest, FVG_fill, Liquidity_Sweep, Breakout_Retest, Range_Sweep_Reversal) as PASS/FAIL with one-line reason per cycle's top candidate
- Submit proposal if any row is PASS

**Validation gate (TWO sub-gates):**

**Sub-gate 1 — pre-merge A/B prompt replay (codex finding #4):** before PR 2 merge, replay the last 7 days of decision cycles through BOTH prompt versions (current sequential + new parallel multi-trigger) on the SAME historical OHLC data. Measure via audit-script confusion matrix:
- **Hallucination delta (FP count):** new prompt FP must be ≤ old prompt's
- **Missed-veto delta (FN count):** new prompt FN must be ≤ old prompt's (new should catch MORE triggers, not fewer)
- **Agreement rate vs deterministic math:** must remain ≥ current 95.2%

If new prompt is worse on any axis, refuse merge. Tune the rewrite (less aggressive multi-trigger framing) and re-run.

**Sub-gate 2 — post-merge demo measurement:** ship to live demo. Measure for **1 calendar week minimum** before drawing conclusions. Audit script (`scripts/audit-trigger-decisions.ts --days 7`) re-runs daily during the measurement window — FN count should drop (fewer LLM misses on triggers the math agrees qualify).

## 7. Measurement plan

Daily tracking from PR-2 ship day. **Per-instrument breakdown required for every metric** (codex finding #10 — GOLD / OIL_CRUDE / SILVER may respond differently from FX pairs):

| Metric | Source | Target band | Rollback trigger |
|---|---|---|---|
| Trades placed/day | `analyst_log` APPROVE count, or `place_split_trade` success log | **3–5** | < 1 for 3 consecutive days OR > 8 for 2 consecutive days |
| Win rate (closed trades, absolute) | `trades` table P&L | **≥ 45% absolute** rolling-3-day (raised from 40% — 43.5% is break-even at 1.3R/1.0R, design floor sits at +1.5pp safety margin) | **< 35% rolling-3-day absolute** |
| **Rolling expected R/trade (NEW per codex finding #5)** | `trades` table — computed as `win_rate × avg_win_R − loss_rate × avg_loss_R` over min 10 closed trades | **≥ 0.3R** rolling-10-trade | **< 0.2R rolling-10-trade** — addresses failure mode where bot fires 3-5/day at 50%+ win rate AND still loses money because avg R/trade collapsed from 1.4R to 0.6R |
| Daily kill switch hits | trading-agent log | 0 | 2 consecutive days |
| `[analyst-coercion]` log count | `pm2-out.log` grep | 0 (already monitored from MODIFY-removal) | Non-zero — investigate separately, not a rollback trigger for this initiative |
| Audit script confusion matrix FN count | weekly `npx tsx scripts/audit-trigger-decisions.ts --days 7` | Lower than pre-PR-2 baseline | If FN count INCREASES, the restructure isn't helping — investigate |
| **Audit script FP count (NEW per codex finding #6)** | weekly audit run | **0** (current baseline) | **Non-zero post-PR-2** — hallucinations appearing means the prompt restructure or threshold loosening is too permissive; rollback |
| **Candidates_reviewed / trade_placed ratio (NEW per codex finding #3)** | analyst_log query: count of analyst calls divided by APPROVE count, per day | **≥ 10:1** (current baseline ~20:1) | **< 5:1** — analyst is rubber-stamping under load; investigate |
| **Analyst call latency p50/p95 (NEW per codex finding #3)** | trading-agent log timing | p50 < 30s, p95 < 60s | p95 sustained > 90s for 1 day — analyst timing out under flood |

## 8. Rollback mechanism

Per-PR rollback procedure documented in each PR description. Demo-only — no DB schema change, no infrastructure migration. Standard sequence:

```
ssh bot@162.55.212.198 "cd ~/trading-bot && git reset --hard <pre-PR-SHA> && npm run build && pm2 reload trading-bot"
```

Reverts in <60 seconds. Pre-PR SHAs recorded in the per-PR commit message.

Optional automation (not in initial scope, can build in a follow-up): a cron job that checks the rollback-trigger metrics nightly and auto-runs `git revert` if any trigger fires. Building this is its own small spec — for now, manual oversight.

## 9. Open questions / known unknowns

- **Backtest historical data coverage**: does Twelve Data have the 30–90 days of 15M/1H data we need for all 7 instruments? Memory says backtest harness is 1H — 15M coverage TBD. Implementation plan must check first and downgrade backtest scope if 15M isn't available.
- **Tier 1 / Tier 2 floor impact**: this design only changes Tier 3 floor. Tier 2 cuts (60-79) and Tier 1 (80+) are unchanged. Worth verifying that lowering Tier 3 to 30 doesn't unintentionally rebalance tier distribution (e.g., setups that scored 55 used to be Tier 3 with 0.5% risk; now they'd still be Tier 3 with 0.5% but the population grows).
- **Audit script's effect on PR 2 baseline**: the audit script measured against current thresholds. After PR 1 ships, the comparable cycle count will increase but the LLM might still anchor (PR 2's target). The audit baseline needs re-establishing between PRs.

## 10. Success criteria

End of the 1-week post-PR-2 measurement window:
- Average trades/day ≥ 3 (lower bound of target)
- Win rate ≥ 40%
- Zero daily kill switch fires during the week
- Audit FN count = 0 OR explicable (FVG fills that the LLM correctly evaluated and rejected for non-trigger reasons)

If all 4 met: hold position, monitor for 1 more week, then consider Option 3 (very aggressive) for further loosening if 3–5 target not yet hit.
If any failed: roll back to pre-PR-2 SHA, return to design phase with the failure data as new evidence.

---

## Spec self-review

- **Placeholders:** none — all numbers concrete, all files named, all gates listed.
- **Internal consistency:** §4 in-scope and §5 out-of-scope explicitly cover every gate dimension from the strictness comparison. No overlap, no gap.
- **Scope check:** focused on a single coherent initiative (trade-frequency loosening). The known unknowns in §9 are bounded — they don't require restructuring the design, just attention during implementation.
- **Ambiguity check:** Force-Propose threshold drop is in PR 1 (numerical) not PR 2 (prompt) — explicitly assigned to scanner-side or prompt-side once for clarity. PR 1 owns the numerical Force-Propose change; PR 2 only touches Step 3I evaluation logic.
- **Risk register:** §6 PR 1 validation gate + §7 measurement plan + §8 rollback are the three safety layers. R3 (regression check) from the comparison agent is folded into PR 1's gate criteria.

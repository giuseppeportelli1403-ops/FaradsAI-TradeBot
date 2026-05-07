# 2-TP Restructure: 3-Leg → 2-Leg with R:R Floors and SL→Entry on TP1

**Date:** 2026-05-07
**Author:** Claude (with Giuseppe / BetterOps AI)
**Status:** Locked 2026-05-07 — Giuseppe answered Q1=A, Q2=A, Q3=yes, Q4=B. Building.

## Locked decisions

- **Q1 SL placement on TP1 fill:** `trade.entry` (working-order request price). No buffer, no broker-fill lookup. Same as current handler.
- **Q2 TP2 R:R floor:** **universal 1.3R across all modes/tiers.** Lowered from current 1.5R (range, T3-tight) and 2.0R (trend T1/T2, T3-medium). This is a material strategy loosening — backtest will quantify the trade-frequency / PF impact.
- **Q3 TP1 R:R floor:** universal 1.0R (unchanged).
- **Q4 Sizing:** tick-aware 70/30 with Leg A absorbing rounding remainder. Total risk pct preserved.

## TL;DR

Giuseppe wants the strategy collapsed from a 3-leg ladder (33/33/33 across TP1/TP2/TP3) to a 2-leg ladder with concentrated take-profit on a closer target:

| Leg | Size | R:R minimum |
|---|---|---|
| TP1 | **70%** | **≥ 1:1** (reward ≥ 1× risk) |
| TP2 | **30%** | **≥ 1:1.3** (reward ≥ 1.3× risk) |
| TP3 | — | **REMOVED** |

When TP1 fills, the bot moves the runner leg's SL to entry (already implemented in `handleTp1Hit` after Phase 1's `safelyAmendPosition` refactor). The current 3-leg system also moves Leg C's SL to TP1 on TP2 fill; that path goes away with TP3 removed.

## Why now

Per Giuseppe (2026-05-07 prompt): tighten EV per trade. 70% locked in at 1R captures the bulk of the win in a single hit; the 30% runner trades risk-free toward a 1.3R+ target. The existing 3-leg ladder spread profits across 3 hard-to-reach R:R levels (1:1, 2:1, 3:1) — TP3 in particular rarely fired and contributed mostly to giving back unrealized profit on reversal.

## Live in-flight constraint

The SILVER trade `trade-a8a0eb21` (opened 2026-05-07 07:02:31 UTC, status `tp1_hit`) is the only currently-active trade and is on the OLD 3-leg system with TPs at 80.58/81.43. New logic **does NOT retroactively touch in-flight trades** — the SILVER runners ride to their original targets under the existing handlers. Phase 2 applies only to trades opened after deploy.

## Code surface

### Files modified
1. `src/agents/trading-agent.ts`
   - `place_split_trade` proposal builder — drop tp3 / size_c from the schema and DB write; emit only Leg A (70%) and Leg B (30%)
   - `validateRRFloor` — drop tp3 input, change TP1/TP2 floors per the rules above
   - `request_analyst_review` proposal handler — same schema reduction
   - ICT system prompt blocks (`load-prompt.ts`) — TP3 references removed; sizing rule updated
2. `src/scheduler/index.ts`
   - `handleTp2Hit` — when `position_c_id` is null (the new norm), trade goes to `complete` (this branch already exists for "legacy 2-leg trades"; it just becomes the only branch that fires for new trades)
   - `handleTp3Hit` — becomes dead code for new trades; kept for legacy in-flight rows
3. `src/database/index.ts`
   - No schema migration. `tp3 / position_c_id / size_c / pnl_c` stay nullable; new trades insert NULL.
4. `prompts/ict-agent.md`
   - 2-TP examples replace 3-TP examples; size split documented as 70/30
5. Tests: `tests/scheduler.test.ts`, new `tests/rr-validation.test.ts` cases for the new floors, `tests/trading-tools.test.ts` for the proposal builder

### Files NOT modified
- `src/mcp-server/capital-client.ts` — `safelyAmendPosition` already in place from Phase 1
- `src/types.ts` — `TradeRecord` already has nullable tp3/position_c_id/size_c/pnl_c (legacy 2-leg precedent)
- DB schema — already permits NULL on the C-leg columns

## Backtest gate

Same pattern as the 2026-05-04 carve-out:
- Run cache-only backtest on EURUSD/GBPUSD/GOLD/AUDUSD/OIL_CRUDE for 2024+2025
- Compare against `baseline_master_2026-05-04.json`
- **Block deploy if PF regresses > 5%** (i.e., new PF must be ≥ 0.95 × baseline)
- Trade-count change is informational, not a gate
- Backtest is 1H-only; live frequency impact must be measured post-deploy

## Open questions for Giuseppe (NEED CONFIRMATION before proceeding)

### Q1 — SL placement on TP1 fill: which "entry"?

The existing handler does `updatePosition(legB, { stopLevel: trade.entry })`. `trade.entry` is the working-order request price stored in DB (e.g., 78.88 on the SILVER trade). Capital.com's actual fill is sometimes slightly different due to slippage (78.802/78.807 on SILVER). Three options:

- **A. Keep current — `trade.entry` (working-order price).** Fast (no extra API call), deterministic from DB. May result in SL slightly above-or-below the broker's true breakeven depending on fill direction. The SILVER trade you approved 2026-05-07 used this — SL ended up at 78.88 vs actual fills at 78.802/78.807, i.e. SL is **above** the long's actual entry (a small profit-lock).
- **B. Use broker's actual fill — `position.openLevel` from Capital GET.** True BE. Adds one extra GET per amend (already cheap thanks to `safelyAmendPosition`). Eliminates the slippage-driven asymmetry.
- **C. Buffered — `trade.entry ± small_buffer` (anti-wick toward profit side).** Locks a tiny guaranteed profit (e.g., +1 spread on a long). Reduces wick stop-out frequency at the cost of slightly worse runner R:R.

**Recommend: A** — your description was "a bit less than entry point" but the SILVER state shows it's actually a hair above. You've already approved this behavior live, so it stays unless you want to change it.

### Q2 — TP2 R:R floor: universal 1.3 or mode-specific minimums?

The existing `validateRRFloor` enforces different TP2 floors by mode/tier:

| Mode | Existing TP2 floor |
|---|---|
| Range-mode | 1.5R |
| Trend T1/T2 | 2.0R |
| Trend T3 tight-spread | 1.5R |
| Trend T3 medium-spread | 2.0R |

Your request says "TP2 R:R ≥ 1:1.3" — that's a floor. Two readings:

- **A. Universal 1.3R floor.** Lower all existing floors to 1.3R. Loosest interpretation. **Materially looser strategy** — proposals previously rejected for being too close to entry will now pass. Backtest will quantify the impact (probably +trade-count, possibly -PF).
- **B. Mode-specific floors capped at 1.3R minimum.** Keep range/T3-tight at 1.5R (already above 1.3). Lower trend T1/T2 and T3-medium from 2.0R to 1.3R. Mixed change.
- **C. Add 1.3R as an absolute minimum but keep existing higher floors where stricter.** No floor goes BELOW 1.3, but existing higher floors stay. Effectively no change (since all current floors are ≥ 1.3). Just adds a defensive floor for any future mode that doesn't have one.

**Recommend: B** — relaxes the floor for the modes you most likely meant (trend-mode T1/T2 makes up most trades), keeps range-mode and T3-tight at their existing tighter floors. Aligns with "1.3 is a NEW floor" without nuking existing risk discipline.

### Q3 — TP1 R:R floor: keep at 1.0R universally?

Existing TP1 floor is 1.0R across all modes. Your request says "TP1 R:R ≥ 1:1" — same 1.0R. No change needed. **Confirm: keep TP1 floor at 1.0R, no per-mode variation.**

### Q4 — Position sizing: hard 70/30, or rounded to broker tick size?

Capital.com requires position sizes in instrument-specific ticks (e.g., SILVER min size 0.5, GOLD min 0.1). For total qty Q split 70/30:
- Pure: `size_a = 0.7 * Q`, `size_b = 0.3 * Q`
- Tick-aware: round each leg to instrument min-size, distribute remainder to Leg A

**Recommend: tick-aware rounding.** Total risk pct stays correct (rounding leg-by-leg can drift); leg A absorbs any rounding remainder so it stays the dominant leg.

## Implementation phases

1. **Phase 2.1 — Validator + types** (~30 min)
   - Drop `tp3` from `RRValidationInput`; reflow `validateRRFloor` per Q2 decision
   - Add new `tests/rr-validation.test.ts` cases for the new floors
   - All 726 existing tests pass

2. **Phase 2.2 — Proposal builder** (~45 min)
   - `place_split_trade` accepts only tp1/tp2/size_a/size_b; sets size_c/tp3/position_c_id to NULL
   - `request_analyst_review` schema mirrors
   - 70/30 sizing computed from total risk + tick rounding
   - ICT system prompt updated (load-prompt.ts blocks)
   - Tests updated

3. **Phase 2.3 — Scheduler simplification** (~15 min)
   - `handleTp1Hit` unchanged (already correct via Phase 1's `safelyAmendPosition`)
   - `handleTp2Hit` — verify legacy 2-leg path becomes the default; tests cover this
   - `handleTp3Hit` — kept (dead path for new trades, live for legacy 3-leg in-flight rows)

4. **Phase 2.4 — Backtest verification** (~20 min)
   - Cache-only run, 2024+2025, 5-instrument universe
   - Compare against baseline_master_2026-05-04.json
   - Block deploy if PF regresses > 5%

5. **Phase 2.5 — Codex review pass + ship** (~15 min)
   - Per project pattern; expect 2-3 nits

## Test count target

Currently 726. Phase 2 adds ~10-15 new tests (R:R floor variants, 70/30 sizing, NULL-leg-C scheduler path). Target: 740-745 pass post-merge.

## Risks

- **Backtest is 1H-only.** It can't measure the value of more frequent TP1 hits at 1R (which is why we're doing this). Live verification over 5-10 trades will be the truth.
- **Looser TP2 floor (if Q2=A or B) → more trades reach the analyst.** Could increase Anthropic credit burn. Worth tagging credits at deploy + 1 day later.
- **2-leg trade-monitor classification edge cases.** When B closes at TP2, monitor must classify it as TP and finalize trade=`complete`. The existing legacy 2-leg branch in `handleTp2Hit` handles this — but tests must explicitly cover the new norm.

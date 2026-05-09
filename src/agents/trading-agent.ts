// ICT Intraday Trading Agent — 5-Step Decision Cycle
// Called every time a new 15M or 1H candle closes
// Uses Claude Sonnet to analyse ICT structure and make trade decisions
//
// The agent receives market data via MCP tools and uses the system prompt
// from AGENT_SYSTEM_PROMPTS_V3 Section 1 to guide its reasoning.

import Anthropic from '@anthropic-ai/sdk';
import { createHash, randomUUID } from 'node:crypto';
import { loadPrompt, loadPromptWithDemoContext, loadStrategy } from './load-prompt.js';
import { loadRecentJournal } from './eod-journal-agent.js';
import { withTimeout } from './llm-output.js';
import { runAnalystAgent, type TradeProposal } from './analyst-agent.js';
import { instrumentToCurrencies, shouldVetoOrderForCalendar } from '../news/calendar-veto.js';
import { fetchForexFactoryCalendar } from '../news/forex-factory-calendar.js';
import { getLatestBrief, countOpenPositions, getOpenTradesByInstrument, getRealisedPnlSince } from '../database/index.js';
import { alertTradePlaced, alertSystemWarning } from '../notifications/telegram.js';

const anthropic = new Anthropic();

// ==================== ANALYST APPROVAL TRACKING ====================
// Codex-recommended pattern (2026-04-28): the agent must call
// request_analyst_review BEFORE place_split_trade, and place_split_trade
// requires the analyst_token to match a same-cycle approval whose
// proposal-hash matches the actual order being placed. This prevents
// the LLM from getting an Analyst APPROVE on a clean-looking proposal
// and then mutating SL/TP/score/tier between approval and placement.
// (Pre-2026-05-07 this list also included size_a/size_b; sizes are now
// computed server-side from total_risk_pct + balance + minDealSize and
// are no longer part of the hashed projection.)
//
// Approval entries TTL after 10 min — same-cycle matching only.

interface ApprovalEntry {
  approvedAt: number;
  proposal: TradeProposal;
}

const APPROVAL_TTL_MS = 10 * 60_000;
const approvedProposals = new Map<string, ApprovalEntry>();

/** Exposed for tests — clear the approval map. */
export function _resetAnalystApprovals(): void {
  approvedProposals.clear();
}

// 2026-05-09: Telegram dedup for ICT cycle timeouts. Module-level state.
// Safe under module-level mutation because ICT cycles are serialized via
// scheduler/index.ts ictRunning + ictOverlapQueue — two runTradingAgent
// invocations never run concurrently. See spec
// docs/superpowers/specs/2026-05-08-ict-iteration-cap-bump-design.md
// "Change 3" for the serialization invariant.
let lastIctTimeoutAlertDate: string | null = null;

/** Test-only: reset dedup so a same-day timeout re-alerts. */
export function _resetIctTimeoutAlertDate(): void {
  lastIctTimeoutAlertDate = null;
}

/** Test-only: read current dedup state. Symmetry with _getPingFailureStreak. */
export function _getIctTimeoutAlertDate(): string | null {
  return lastIctTimeoutAlertDate;
}

/**
 * Compute a deterministic hash of the canonicalised proposal. Used as the
 * analyst_token. The agent cannot mutate proposal fields between approval
 * and placement: place_split_trade re-hashes the supplied proposal and
 * verifies it matches the analyst_token.
 *
 * 2026-04-29 audit fix (P0-TA2): expanded the canonical projection to
 * include `instrument`, `instrument_category`, and `kill_zone`. Pre-fix
 * the hash was anchored on `epic` only — usually identical to instrument
 * but if they ever diverged the coordination lock + DB persistence used
 * `instrument` while the hash anchored on `epic`. Including all three
 * eliminates any opportunity for the LLM to swap them between approval
 * and placement. instrument_category and kill_zone affect tier sizing
 * downstream and were similarly omitted.
 */
export function proposalHash(proposal: Omit<TradeProposal, 'trade_id'>): string {
  // Canonicalise: explicit field order, fixed precision on numbers, lower-
  // case strings where applicable. Drop fields that don't affect the trade
  // identity (trade_id is generated FROM this hash; reasoning is free-text).
  //
  // 2026-05-07 — 2-TP restructure (Phase 2). tp3 + size_c removed from
  // canonical projection. Proposals are 2-leg only (TP1 70% + TP2 30%);
  // any in-flight approval entries from the old 3-leg path will simply
  // hash differently and TTL out of approvedProposals naturally.
  //
  // 2026-05-07 — Codex follow-up. size_a + size_b also removed from the
  // canonical projection. Sizing is now SERVER-COMPUTED from
  // (total_risk_pct + entry + sl + epic + balance + minDealSize); the LLM's
  // size_a/size_b inputs are ignored on the placement path. Including the
  // LLM-supplied sizes in the hash would either:
  //   (a) break hash verification at place_split_trade — request_analyst_review
  //       hashes LLM sizes, place_split_trade overrides them server-side then
  //       re-hashes with server sizes → mismatch, or
  //   (b) force the LLM to predict server-computed sizes, which defeats the
  //       point of moving sizing server-side.
  // The hashed fields (entry, sl, total_risk_pct, instrument/epic) plus
  // server-side state (balance, minDealSize) determine sizing deterministically,
  // so the post-hash sizing override is fully reproducible and the analyst
  // approval still gates the only LLM-controlled levers (price levels, score,
  // tier, risk pct).
  const canonical = {
    instrument: proposal.instrument.toUpperCase(),
    instrument_category: proposal.instrument_category.toLowerCase(),
    epic: proposal.epic.toUpperCase(),
    direction: proposal.direction,
    entry: Number(proposal.entry.toFixed(5)),
    sl: Number(proposal.sl.toFixed(5)),
    tp1: Number(proposal.tp1.toFixed(5)),
    tp2: Number(proposal.tp2.toFixed(5)),
    composite_score: Math.round(proposal.composite_score),
    tier: proposal.tier,
    total_risk_pct: Number(proposal.total_risk_pct.toFixed(4)),
    setup_type: proposal.setup_type.toLowerCase(),
    kill_zone: proposal.kill_zone.toLowerCase(),
    strategy_tag: proposal.strategy_tag,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 16);
}

function pruneStaleApprovals(): void {
  const cutoff = Date.now() - APPROVAL_TTL_MS;
  for (const [key, entry] of approvedProposals) {
    if (entry.approvedAt < cutoff) approvedProposals.delete(key);
  }
}

// ==================== R:R FLOOR VALIDATION ====================
// 2026-05-04 (Phase A1, audit Finding #2): pre-fix the place_split_trade
// validation chain only checked order-side (sl<entry<tp1<tp2<tp3 for longs,
// opposite for shorts). There was NO check that TP magnitudes respected
// strategy.md Section 7.3 R:R minimums. A hallucinated proposal with TP1
// 1 pip past entry could pass every code gate. The Analyst's 6-check
// sanity step also doesn't verify R:R floors — only "TP1 closer to entry
// than TP2".
//
// Strategy.md Section 7.3 (authoritative):
//   Trend-mode (triggers 1-4):
//     TP1 ≥ 1:1 (de-risk leg, 1.2:1 acceptable)
//     TP2 ≥ 2:1 for Tier 1 & 2; ≥ 1.5:1 for Tier 3 on tight-spread only
//     TP3 ≥ 3:1
//   Range-mode (trigger 5):
//     TP1 ≥ 1:1, TP2 ≥ 1.5:1, TP3 ≥ 2:1
//
// Tight-spread instruments (memory/strategy.md Section 4):
//   EURUSD, GBPUSD, USDJPY, AUDUSD, GOLD
// Medium-spread (no T3 tight-spread carve-out):
//   SILVER, OIL_CRUDE
//
// The classifier itself lives in ./spread to break a cycle with the
// scanner (which also needs it for the Tier 3 score floor). Re-exported
// here so existing tests/imports keep working.
import { isTightSpreadTicker, tier3FloorFor } from './spread.js';
export { isTightSpreadTicker, tier3FloorFor };

export interface RRValidationInput {
  direction: 'long' | 'short';
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  tier: 1 | 2 | 3;
  ticker: string;
  isRangeMode: boolean;
}

export type RRValidationResult =
  | { ok: true }
  | { ok: false; error: 'INVALID_RISK' | 'RR_FLOOR_VIOLATION'; reason: string };

// 2026-05-07 — 2-TP restructure (Phase 2). The 3-leg ladder (TP1/TP2/TP3 with
// per-mode/per-tier floors) is replaced by a 2-leg ladder with universal
// floors:
//   TP1 ≥ 1.0R   — same as before
//   TP2 ≥ 1.3R   — UNIVERSAL across all modes/tiers (lowered from 1.5R/2.0R)
//
// This is a deliberate strategy loosening per Giuseppe's request 2026-05-07.
// The `tier` and `isRangeMode` fields are kept on RRValidationInput for
// future use and to keep the ICT prompt/proposal contract stable, but they
// no longer affect the floors. The ticker-specific tight-spread carve-out
// also no longer applies (the new universal floor is below all of the old
// per-mode floors anyway).
const TP1_FLOOR_R = 1.0;
const TP2_FLOOR_R = 1.3;

/**
 * Validate that the proposal's TPs respect the strategy R:R floors.
 *
 * Pure function: no side effects, no async, no DB. The caller (place_split_trade
 * executor) invokes this AFTER the order-side validation so we know
 * sl/entry/tps are on the correct sides — this lets us use abs(price - entry)
 * for the R:R math regardless of long/short.
 *
 * Returns { ok: true } on pass, { ok: false, error, reason } with a specific
 * machine-readable error code on fail. The reason mentions which TP leg
 * violated and the actual ratio so the LLM can fix and retry.
 */
export function validateRRFloor(input: RRValidationInput): RRValidationResult {
  const { entry, sl, tp1, tp2 } = input;
  const risk = Math.abs(entry - sl);
  if (risk === 0 || !Number.isFinite(risk)) {
    return {
      ok: false,
      error: 'INVALID_RISK',
      reason: `Cannot compute R:R: entry (${entry}) equals SL (${sl}) or risk is non-finite.`,
    };
  }

  const rr = (tp: number) => Math.abs(tp - entry) / risk;
  const rr1 = rr(tp1);
  const rr2 = rr(tp2);

  // Tolerance: allow tiny floating-point overshoot (0.001 R) so e.g. an
  // exactly-at-floor proposal isn't rejected on rounding.
  const tol = 0.001;
  if (rr1 + tol < TP1_FLOOR_R) {
    return {
      ok: false,
      error: 'RR_FLOOR_VIOLATION',
      reason: `TP1 R:R is ${rr1.toFixed(2)}, below universal floor of ${TP1_FLOOR_R}. ` +
              `Re-compute: entry=${entry}, sl=${sl}, tp1=${tp1}.`,
    };
  }
  if (rr2 + tol < TP2_FLOOR_R) {
    return {
      ok: false,
      error: 'RR_FLOOR_VIOLATION',
      reason: `TP2 R:R is ${rr2.toFixed(2)}, below universal floor of ${TP2_FLOOR_R}. ` +
              `Re-compute: entry=${entry}, sl=${sl}, tp2=${tp2}.`,
    };
  }

  return { ok: true };
}

// ==================== INSTRUMENT CATEGORY ====================
// 2026-05-05 audit (A6): pre-fix, the proposal builder accepted
// `input.instrument_category` from the LLM with `?? 'unknown'` fallback.
// Lessons rows tagged 'unknown' silently fail category-based reflection
// filtering. Now: derive deterministically from INSTRUMENT_UNIVERSE so
// the LLM cannot poison the analytics dimension. Fail closed if the ticker
// isn't in the universe.

export function resolveInstrumentCategory(ticker: string): string | null {
  const upper = ticker.toUpperCase();
  const entry = INSTRUMENT_UNIVERSE.find((i) => i.ticker.toUpperCase() === upper);
  return entry ? entry.category : null;
}

// ==================== RISK-PCT TOLERANCE ====================
// 2026-05-05 audit (Phase 2 / Round 5+ / item A1): the existing inline
// check `Math.abs(riskPct - expectedRiskPct) > 0.05` allowed ±0.05 absolute
// tolerance, which is 20% overage on Tier 3 range-mode (expected 0.25%, so
// 0.20-0.30% accepted). At 0.30%, range-mode trade takes 1.2× intended
// risk; multiplied across 3 legs the daily kill-switch (-6%) becomes
// 6.67% loss before tripping. Tightened to ±0.005% absolute — small
// enough to catch the over-sizing class, large enough to absorb any
// floating-point precision artefacts (0.5/2 = 0.25 cleanly in IEEE 754
// but defensive math like (0.1 + 0.15) wouldn't be).

export interface RiskPctValidationInput {
  riskPct: number;
  expectedRiskPct: number;
}

export type RiskPctValidationResult =
  | { ok: true }
  | { ok: false; reason: string };

const RISK_PCT_TOLERANCE = 0.005;

export function validateRiskPct(input: RiskPctValidationInput): RiskPctValidationResult {
  const { riskPct, expectedRiskPct } = input;
  if (!Number.isFinite(riskPct) || !Number.isFinite(expectedRiskPct)) {
    return { ok: false, reason: `Non-finite risk values: riskPct=${riskPct}, expectedRiskPct=${expectedRiskPct}` };
  }
  if (Math.abs(riskPct - expectedRiskPct) > RISK_PCT_TOLERANCE) {
    return {
      ok: false,
      reason: `Risk ${riskPct}% diverges from expected ${expectedRiskPct}% by more than ±${RISK_PCT_TOLERANCE}%`,
    };
  }
  return { ok: true };
}

// ==================== ORDER-SIDE PRE-CHECK ====================
// 2026-05-05 audit. Pre-existing place_split_trade had per-leg side checks
// but the cheap path (request_analyst_review, called BEFORE any LLM cost)
// did not. The 2026-05-04 08:31 UTC live failure was a GOLD SHORT proposal
// with SL=4575 < entry=4576.29 and TPs above entry. The analyst correctly
// detected the inversion but its long rejection prose truncated the JSON
// output, dropping analyst parse rate to 0/6 over 6 days. This validator
// is the cheap gate that catches the problem before the analyst is paid.

export interface OrderSideInput {
  direction: 'long' | 'short';
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
}

export type OrderSideResult = { ok: true } | { ok: false; reason: string };

/**
 * Geometric sanity for the proposal. Pure, side-effect-free, no DB or
 * network. Cheap pre-check called BEFORE the analyst LLM call, mirroring
 * the same defense in place_split_trade.
 *
 * 2026-05-07 — 2-TP restructure (Phase 2). TP3 dropped; the new invariant
 * uses only the two retained legs.
 *
 * Long invariant:  sl < entry < tp1 < tp2
 * Short invariant: tp2 < tp1 < entry < sl
 */
export function validateOrderSide(input: OrderSideInput): OrderSideResult {
  const { direction, entry, sl, tp1, tp2 } = input;

  for (const [k, v] of Object.entries({ entry, sl, tp1, tp2 })) {
    if (!Number.isFinite(v)) {
      return { ok: false, reason: `Order-side rejected: ${k}=${v} is not a finite number.` };
    }
  }

  if (direction === 'long') {
    if (!(sl < entry && entry < tp1 && tp1 < tp2)) {
      return {
        ok: false,
        reason: `Long order-side invariant violated: need sl<entry<tp1<tp2, got sl=${sl}, entry=${entry}, tp1=${tp1}, tp2=${tp2}.`,
      };
    }
  } else {
    if (!(tp2 < tp1 && tp1 < entry && entry < sl)) {
      return {
        ok: false,
        reason: `Short order-side invariant violated: need tp2<tp1<entry<sl, got sl=${sl}, entry=${entry}, tp1=${tp1}, tp2=${tp2}.`,
      };
    }
  }
  return { ok: true };
}

// ==================== SERVER-SIDE 70/30 SIZING ====================
// 2026-05-07 (Phase 2 / Codex follow-up). Pre-fix `place_split_trade` trusted
// LLM-supplied size_a/size_b values. Codex flagged this as a deploy blocker:
// the LLM's arithmetic is non-deterministic across runs, the broker tick rule
// can be violated (Capital.com requires size to be a multiple of minDealSize),
// and even a "correct" LLM size can drift from the intended 70/30 by enough
// to push the runner leg above the 30% target.
//
// Solution: server computes size_a + size_b deterministically from
// (total_risk_pct, balance, entry, sl, minDealSize). The LLM's size_a/size_b
// values are IGNORED on the placement path — the LLM still emits them for
// proposal-shape compatibility but they don't reach Capital.com.
//
// Algorithm (pure):
//   total_qty   = (balance * total_risk_pct/100) / |entry − sl|
//   size_b_raw  = 0.30 × total_qty
//   size_b      = floor(size_b_raw / minDealSize) × minDealSize    ← tick-aware DOWN
//   size_a      = total_qty − size_b                                ← absorbs remainder
//
// Floor case: if size_b rounds to 0 (i.e. raw < minDealSize) the trade is
// undersized at the 30% leg even though the 70% leg would clear the floor.
// We refuse rather than silently re-allocate. The LLM can re-propose at a
// higher tier or skip.
//
// Note re hash compatibility: proposalHash (pre-Codex follow-up) included
// size_a + size_b in the canonical projection. Including them after the
// server overrides the LLM's values would break hash verification at
// place_split_trade Step 1, because request_analyst_review would have hashed
// the LLM's sizes and place_split_trade would re-hash with the server-
// computed sizes. The follow-up removes size_a/size_b from the canonical
// projection (sizing is now derived deterministically from the other hashed
// fields + balance + market details, both of which are server-side state).

export interface ServerSizingInput {
  /** Account balance in account currency. */
  balance: number;
  /** Total risk percent for this trade (1.5 / 1.0 / 0.5 / 0.25). */
  totalRiskPct: number;
  /** Order entry price (working-order request price). */
  entry: number;
  /** Stop-loss price. */
  sl: number;
  /** Capital.com minimum deal size for this instrument. Doubles as the size
   *  step (Capital quantises position sizes in multiples of this value). */
  minDealSize: number;
}

export type ServerSizingResult =
  | { ok: true; sizeA: number; sizeB: number; totalQty: number }
  | { ok: false; error: 'INVALID_INPUT' | 'BELOW_MIN_SIZE'; reason: string };

/**
 * Pure function: compute tick-aware 70/30 leg sizes server-side.
 *
 * 2026-05-07 (Codex Round 2 — Finding #7 BLOCKER fix). Pre-fix only Leg B
 * was tick-aligned and Leg A absorbed the raw remainder, which produced
 * non-tick-aligned sizes for Leg A on instruments where minDealSize doesn't
 * cleanly divide totalQty (e.g. GOLD totalQty=10.55, minDealSize=0.1 →
 * old algorithm returned sizeA=7.45, which Capital REJECTS as not a 0.1
 * multiple). The fix: integer-tick math throughout.
 *
 * Algorithm:
 *   total_ticks  = floor(total_qty / minDealSize)
 *   size_b_ticks = floor(total_ticks * 0.30)            ← always integer
 *   size_a_ticks = total_ticks - size_b_ticks           ← always integer
 *   size_a       = size_a_ticks * minDealSize           ← tick-aligned
 *   size_b       = size_b_ticks * minDealSize           ← tick-aligned
 *
 * Both legs are integer multiples of minDealSize by construction. The total
 * placed (size_a + size_b) is total_ticks * minDealSize, which is at most
 * total_qty (rounding loss ≤ 1 tick). Leg A still absorbs the rounding
 * remainder because it gets `total_ticks - size_b_ticks` rather than its
 * own independent floor.
 *
 * Returns BELOW_MIN_SIZE when either leg would fall below 1 tick — the
 * caller should refuse the trade and let the agent re-propose at a higher
 * tier or skip the instrument until the account grows.
 */
export function computeServerSizing(input: ServerSizingInput): ServerSizingResult {
  const { balance, totalRiskPct, entry, sl, minDealSize } = input;

  if (!Number.isFinite(balance) || !Number.isFinite(totalRiskPct) ||
      !Number.isFinite(entry) || !Number.isFinite(sl) ||
      !Number.isFinite(minDealSize)) {
    return {
      ok: false,
      error: 'INVALID_INPUT',
      reason: `Non-finite input: balance=${balance}, totalRiskPct=${totalRiskPct}, entry=${entry}, sl=${sl}, minDealSize=${minDealSize}`,
    };
  }
  if (balance <= 0 || totalRiskPct <= 0 || minDealSize <= 0) {
    return {
      ok: false,
      error: 'INVALID_INPUT',
      reason: `Non-positive input: balance=${balance}, totalRiskPct=${totalRiskPct}, minDealSize=${minDealSize}`,
    };
  }
  const stopDistance = Math.abs(entry - sl);
  if (stopDistance <= 0) {
    return {
      ok: false,
      error: 'INVALID_INPUT',
      reason: `Zero or negative stop distance: |entry − sl| = ${stopDistance}`,
    };
  }

  const riskAmount = balance * (totalRiskPct / 100);
  const totalQty = riskAmount / stopDistance;

  // Integer-tick math: convert totalQty to ticks first, split 70/30 in tick
  // space, multiply back out. This guarantees BOTH legs are exact integer
  // multiples of minDealSize — Capital.com rejects non-tick-aligned sizes
  // and Codex Round 2 (Finding #7) flagged Leg A's absorption of the raw
  // remainder as a deploy blocker.
  //
  // IEEE 754 noise absorption: on clean inputs (e.g. balance=1000,
  // riskPct=1.0, stop=0.0020) totalQty arithmetic produces 4999.999999999995
  // instead of 5000 — Math.floor of that divided by 1000 gives 4 ticks
  // instead of 5, undersizing by a full tick (20% risk loss on this case).
  // Adding 1e-9 before Math.floor absorbs the noise without affecting any
  // case that genuinely needs to round down. The epsilon is much smaller
  // than the smallest realistic minDealSize (0.1 GOLD), and much smaller
  // than any rounding step the algorithm actually intends to apply.
  const TICK_EPSILON = 1e-9;
  const totalTicks = Math.floor(totalQty / minDealSize + TICK_EPSILON);
  if (totalTicks < 2) {
    // Need at least 2 ticks to give 1 to each leg. Fewer than that means
    // the trade is fundamentally too small for this instrument's tick
    // rule given the requested risk pct + stop distance.
    return {
      ok: false,
      error: 'BELOW_MIN_SIZE',
      reason: `Total qty ${totalQty.toFixed(6)} would round to ${totalTicks} tick(s) of size ${minDealSize}; need at least 2 ticks (one per leg). Account too small for this tier × stop distance combination. Either upgrade the tier (raises total_risk_pct → larger total_qty), tighten the SL (smaller |entry−sl| → larger total_qty), or skip until the account grows.`,
    };
  }
  const sizeBTicks = Math.floor(totalTicks * 0.30);
  const sizeATicks = totalTicks - sizeBTicks;
  const sizeA = sizeATicks * minDealSize;
  const sizeB = sizeBTicks * minDealSize;

  if (sizeBTicks < 1) {
    // 30% of fewer than ~3 ticks rounds to 0. Same remediation as above.
    return {
      ok: false,
      error: 'BELOW_MIN_SIZE',
      reason: `Leg B at 30% of ${totalTicks} ticks rounds to 0 (size_b=${sizeB}, below minDealSize ${minDealSize}). Account too small for this tier × stop distance combination.`,
    };
  }
  if (sizeATicks < 1) {
    // Would only happen if sizeBTicks somehow consumed all ticks — guarded
    // by the totalTicks ≥ 2 check above, but defensive.
    return {
      ok: false,
      error: 'BELOW_MIN_SIZE',
      reason: `Leg A would receive ${sizeATicks} ticks (size_a=${sizeA}, below minDealSize ${minDealSize}). Account too small for this tier × stop distance combination.`,
    };
  }

  return { ok: true, sizeA, sizeB, totalQty };
}

// ==================== WEEKLY KILL SWITCH ====================
// 2026-05-04 (Phase A3, audit Finding #6): pre-fix, strategy.md Section 7.2
// said "Weekly loss limit: 10% of account equity. Non-negotiable. When
// triggered: No new positions opened (code-enforced in executeTool paths)"
// — but no caller invoked getWeeklyPnl anywhere in the trading path. A 10%
// weekly drawdown would not stop the bot. Daily 6% catches the worst day,
// but four bad days in a week could clear 10% with the bot still trading.
//
// Strategy doc convention: weekly resets Sunday 00:00 UTC (matches the
// weekly-review cron at `0 0 * * 0`). Current week runs from the most
// recent Sunday 00:00 UTC to next Sunday 00:00 UTC.

const WEEKLY_KILL_SWITCH_PCT = -10;

/**
 * Compute the YYYY-MM-DD UTC date of the most recent Sunday at 00:00 UTC.
 *
 * Sunday is day 0 in JavaScript's getUTCDay(). If today is Sunday, returns
 * today's date. Otherwise subtracts (dayOfWeek) days to roll back to Sunday.
 * Always returns a date in UTC — never local time.
 */
export function computeWeekStartUTC(now: Date = new Date()): string {
  const dow = now.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const sunday = new Date(now);
  sunday.setUTCDate(now.getUTCDate() - dow);
  sunday.setUTCHours(0, 0, 0, 0);
  return sunday.toISOString().split('T')[0];
}

export interface WeeklyKillSwitchInput {
  weeklyPnl: number;   // realised P&L this week (Sun → now) + current unrealised
  equity: number;      // current account equity
}

export type WeeklyKillSwitchResult =
  | { ok: true }
  | { ok: false; error: 'WEEKLY_KILL_SWITCH_ACTIVE'; reason: string; currentPct: number; thresholdPct: number };

/**
 * Block trades when weekly P&L percentage is at or beyond -10%.
 *
 * Pure function: no side effects, no async, no DB. The caller computes
 * weeklyPnl by summing realised_pnl from this week's Sunday + balance's
 * current unrealised. equity is the account balance.
 *
 * Fail-open at equity=0 — a zero-equity account can't take any position
 * anyway, and a divide-by-zero check on the kill switch would mask the
 * downstream rejection in a misleading way.
 */
export function validateWeeklyKillSwitch(input: WeeklyKillSwitchInput): WeeklyKillSwitchResult {
  const { weeklyPnl, equity } = input;
  if (equity <= 0) return { ok: true };
  const currentPct = (weeklyPnl / equity) * 100;
  if (currentPct <= WEEKLY_KILL_SWITCH_PCT) {
    return {
      ok: false,
      error: 'WEEKLY_KILL_SWITCH_ACTIVE',
      reason: `Weekly P&L is ${currentPct.toFixed(2)}% — at or beyond the ${WEEKLY_KILL_SWITCH_PCT}% kill-switch threshold. No new positions until next Sunday 00:00 UTC.`,
      currentPct,
      thresholdPct: WEEKLY_KILL_SWITCH_PCT,
    };
  }
  return { ok: true };
}

// ==================== MCP TOOL DEFINITIONS ====================
// These are passed to Claude as tool schemas so it can call them

/**
 * Tools whose execution has no observable side effect on broker state, the
 * trades DB, or the analyst sub-LLM — safe to run concurrently within a
 * single agent turn via Promise.all. Stateful tools (anything not in this
 * Set) are run sequentially to avoid races.
 *
 * Source-of-truth: each tool's `readOnlyHint` annotation in
 * `src/mcp-server/tools/{db,market-data,trading}-tools.ts`. This Set must
 * stay in sync with those annotations — the agent loop can't read the MCP
 * registry directly because `MCP_TOOLS` (below) is a separate Anthropic-SDK
 * tool definitions array that doesn't carry the hints. See
 * `tests/trading-agent-loop.test.ts` for the contract test that pins
 * read-only-batch-vs-stateful-sequential ordering.
 */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'get_daily_pnl',
  'get_portfolio',
  'get_ranked_instruments',
  'get_prices',
  'get_news_context',
  'get_economic_calendar',
  'get_lessons',
]);

const MCP_TOOLS: Anthropic.Messages.Tool[] = [
  {
    name: 'get_daily_pnl',
    description: 'Get today\'s running P&L, equity, and kill switch status',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'get_portfolio',
    description: 'Get current open positions from Capital.com',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'get_ranked_instruments',
    description: 'Get top instruments ranked by preliminary composite score',
    input_schema: {
      type: 'object' as const,
      properties: { limit: { type: 'number', description: 'Number of instruments to return' } },
      required: [],
    },
  },
  {
    name: 'get_prices',
    description: 'Fetch OHLC candle data for an instrument',
    input_schema: {
      type: 'object' as const,
      properties: {
        instrument: { type: 'string', description: 'Ticker symbol' },
        timeframe: { type: 'string', enum: ['15m', '1h', '4h', '1d', '1w'] },
        count: { type: 'number', description: 'Number of candles' },
      },
      required: ['instrument', 'timeframe'],
    },
  },
  {
    name: 'get_news_context',
    description: 'Get scored news items for an instrument',
    input_schema: {
      type: 'object' as const,
      properties: { instrument: { type: 'string' } },
      required: ['instrument'],
    },
  },
  {
    name: 'get_economic_calendar',
    description:
      'Return upcoming high/medium/low-impact macro events (FOMC, NFP, CPI, ECB, BoE, BoJ, central-bank rate decisions, GDP, Core PCE, AHE, Unemployment Rate, Retail Sales, ISM PMI, payrolls). YOU MUST CALL THIS before any request_analyst_review/place_split_trade — trading into a high-impact print on the trade currency is a hard rule violation. place_split_trade is code-level vetoed when a high-impact event for any currency in the trade pair falls inside the per-event veto window: generic high-impact events use −5/+30 min (5 before / 30 after); Tier-1 events (FOMC/NFP/CPI/central-bank rate decisions/Core PCE/GDP/ISM PMI/AHE/Unemployment Rate/Retail Sales/central-bank press conferences) use the wider −60/+30 min window.',
    input_schema: {
      type: 'object' as const,
      properties: {
        days_ahead: { type: 'number', description: 'Lookahead window in days. Default 1.' },
      },
      required: [],
    },
  },
  {
    name: 'get_lessons',
    description: 'Retrieve past lessons filtered by setup type, category, kill zone',
    input_schema: {
      type: 'object' as const,
      properties: {
        setup_type: { type: 'string' },
        instrument_category: { type: 'string' },
        kill_zone: { type: 'string' },
        strategy_tag: { type: 'string', enum: ['ICT_INTRADAY'] },
      },
      required: [],
    },
  },
  // 2026-04-28 audit refactor: replaced bare place_order + log_trade with
  // the unified place_split_trade tool. The new tool atomically validates
  // (composite_score / tier-risk / coordination lock / analyst approval /
  // calendar veto / order side), places the legs, persists the DB
  // record, and compensates on partial failure. The agent MUST call
  // request_analyst_review FIRST to get an analyst_token, then pass that
  // token to place_split_trade.
  // 2026-05-07 — 2-TP restructure (Phase 2). Schema reduced from 3 legs to
  // 2 legs (Leg A 70% TP1, Leg B 30% TP2). tp3 / size_c dropped.
  {
    name: 'request_analyst_review',
    description:
      'MANDATORY before place_split_trade. Submits the full 2-leg trade proposal to the Trade Analyst Agent. Returns { decision: APPROVE|REJECT|MODIFY, reason, analyst_token, proposal_hash, computed_sizes }. The analyst_token is a hash of the canonicalised proposal — place_split_trade rejects unless the supplied token matches a same-cycle approval AND the proposal hash matches. You CANNOT mutate SL/TP/score/risk_pct between approval and placement. **Sizing (size_a / size_b) is COMPUTED SERVER-SIDE** from total_risk_pct, balance, and the broker tick rule — any size_a/size_b you supply is IGNORED and replaced with the server values. Inspect computed_sizes in the response if you need them for logging.',
    input_schema: {
      type: 'object' as const,
      properties: {
        instrument: { type: 'string' },
        epic: { type: 'string' },
        instrument_category: { type: 'string', description: "e.g. 'fx' or 'commodity'" },
        direction: { type: 'string', enum: ['long', 'short'] },
        entry: { type: 'number' },
        sl: { type: 'number' },
        tp1: { type: 'number' },
        tp2: { type: 'number' },
        size_a: { type: 'number', description: 'IGNORED — computed server-side. Field kept for back-compat with the LLM proposal shape; supply any positive number (e.g. 1) or omit.' },
        size_b: { type: 'number', description: 'IGNORED — computed server-side. Field kept for back-compat with the LLM proposal shape; supply any positive number (e.g. 1) or omit.' },
        composite_score: { type: 'number' },
        tier: { type: 'number', enum: [1, 2, 3] },
        total_risk_pct: { type: 'number', description: '1.5 / 1.0 / 0.5 per tier (0.25 for range-mode). This drives the server-side sizing computation.' },
        setup_type: { type: 'string' },
        kill_zone: { type: 'string' },
        reasoning: { type: 'string' },
      },
      required: ['instrument', 'epic', 'direction', 'entry', 'sl', 'tp1', 'tp2', 'composite_score', 'tier', 'total_risk_pct', 'setup_type', 'kill_zone'],
    },
  },
  {
    name: 'place_split_trade',
    description:
      'Atomically place a 2-leg split-position ICT trade after analyst approval. Validates score/tier/risk/coordination/calendar, places legs A→B, persists to DB, compensates on partial failure. REQUIRES analyst_token from request_analyst_review whose proposal_hash matches THIS proposal exactly. Returns dealIds + trade_id on success, or a structured error otherwise. **Sizing (size_a / size_b) is computed server-side** from total_risk_pct + balance + broker tick rule — supply the same proposal fields you sent to request_analyst_review and the server will derive the correct sizes.',
    input_schema: {
      type: 'object' as const,
      properties: {
        analyst_token: { type: 'string', description: 'Token returned by request_analyst_review' },
        instrument: { type: 'string' },
        epic: { type: 'string' },
        instrument_category: { type: 'string' },
        direction: { type: 'string', enum: ['long', 'short'] },
        entry: { type: 'number' },
        sl: { type: 'number' },
        tp1: { type: 'number' },
        tp2: { type: 'number' },
        size_a: { type: 'number', description: 'IGNORED — computed server-side from total_risk_pct.' },
        size_b: { type: 'number', description: 'IGNORED — computed server-side from total_risk_pct.' },
        composite_score: { type: 'number' },
        tier: { type: 'number', enum: [1, 2, 3] },
        total_risk_pct: { type: 'number' },
        setup_type: { type: 'string' },
        kill_zone: { type: 'string' },
        reasoning: { type: 'string' },
      },
      required: ['analyst_token', 'instrument', 'epic', 'direction', 'entry', 'sl', 'tp1', 'tp2', 'composite_score', 'tier', 'total_risk_pct', 'setup_type', 'kill_zone'],
    },
  },
  {
    name: 'update_sl',
    description: 'Update stop loss for a trade in the database',
    input_schema: {
      type: 'object' as const,
      properties: { trade_id: { type: 'string' }, new_sl: { type: 'number' } },
      required: ['trade_id', 'new_sl'],
    },
  },
  {
    name: 'close_position',
    description: 'Close a position on Capital.com',
    input_schema: {
      type: 'object' as const,
      properties: { dealId: { type: 'string' } },
      required: ['dealId'],
    },
  },
];

// ==================== TOOL EXECUTOR ====================
// Routes tool calls from Claude to the actual MCP tool implementations

import {
  fetchCandles, fetchNewsContext as fetchNewsRaw, fetchEconomicCalendar,
} from '../mcp-server/market-data.js';
import { getRankedInstruments, INSTRUMENT_UNIVERSE } from '../scanner/index.js';
import {
  insertTrade, getTradeHistory, getLessons, getLessonWinRate,
  createSlTpOrder, updateSlPrice, getDailyPnl, upsertDailyPnl,
  getActiveSlTpOrdersByTradeId, getTradeByDealId, markTradeClosedEarly,
  deactivateSlTpOrder,
  enterCriticalSection, exitCriticalSection,
} from '../database/index.js';
import { CapitalClient } from '../mcp-server/capital-client.js';

const capital = new CapitalClient({
  apiKey: process.env.CAPITAL_API_KEY || '',
  identifier: process.env.CAPITAL_IDENTIFIER || '',
  password: process.env.CAPITAL_API_KEY_PASSWORD || '',
  baseURL: process.env.CAPITAL_API_URL || 'https://demo-api-capital.backend-capital.com',
});

async function getPreferredAccountBalance(): Promise<{ balance: number; deposit: number; profitLoss: number; available: number }> {
  const accounts = await capital.getAccounts();
  const preferred = accounts.find((a) => a.preferred) ?? accounts[0];
  if (!preferred) {
    throw new Error('No Capital.com account available');
  }
  return preferred.balance;
}

export async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'get_daily_pnl': {
      const balance = await getPreferredAccountBalance();
      const today = new Date().toISOString().split('T')[0];
      const daily = getDailyPnl(today);
      const pnl = balance.profitLoss + (daily?.realised_pnl ?? 0);
      const equity = balance.balance;
      const pct = equity ? (pnl / equity) * 100 : 0;
      return JSON.stringify({
        total_daily_pnl: pnl, equity,
        daily_pnl_pct: Math.round(pct * 100) / 100,
        kill_switch_active: pct <= -6,
        open_positions: countOpenPositions(),
      });
    }
    case 'get_portfolio':
      return JSON.stringify(await capital.getOpenPositions());
    case 'get_ranked_instruments':
      return JSON.stringify(await getRankedInstruments(Number(input.limit) || 20));
    case 'get_prices':
      return JSON.stringify(await fetchCandles(
        input.instrument as string,
        input.timeframe as '15m' | '1h' | '4h' | '1d' | '1w',
        Number(input.count) || 100
      ));
    case 'get_news_context':
      return JSON.stringify(await fetchNewsRaw(input.instrument as string));
    case 'get_economic_calendar': {
      const daysAhead = Number(input.days_ahead) > 0 ? Number(input.days_ahead) : 1;
      return JSON.stringify(await fetchEconomicCalendar(daysAhead));
    }
    case 'get_lessons': {
      const filters = {
        setup_type: input.setup_type as string | undefined,
        instrument_category: input.instrument_category as string | undefined,
        kill_zone: input.kill_zone as string | undefined,
        strategy_tag: 'ICT_INTRADAY' as const,
      };
      const lessons = getLessons(filters);
      // Codex P1 #13 (2026-04-28): pass the SAME filters to the win-rate
      // calculation. Previously this was passed only strategy_tag, so the
      // setup-specific penalty in the agent prompt ("if win rate <50% on
      // 5+ trades on this exact setup × kill zone, -10 points") was being
      // applied based on the GLOBAL ICT win rate across all setups —
      // unrelated history poisoning the score.
      const wr = getLessonWinRate(filters);
      return JSON.stringify({ lessons, win_rate: wr });
    }
    case 'request_analyst_review': {
      // 2026-04-29 audit fix (P0-AN1): trade_id chain. Pre-fix this case
      // generated trade-{8hex} for the analyst_log row, and place_split_trade
      // separately generated trade-{12hex} for trades.id — different hashes,
      // different lengths, no possible JOIN. Every analyst_log row was
      // ORPHANED and Weekly Review's calibration calc was permanently broken.
      //
      // Fix: derive trade_id deterministically from the proposal hash. The
      // hash is content-addressed and stable; place_split_trade re-hashes
      // and uses the SAME `trade-${hash}` as trades.id, so analyst_log.trade_id
      // joins to trades.id by construction.
      pruneStaleApprovals();
      // 2026-05-05 audit (A6): derive instrument_category from the universe,
      // not from the LLM. Fail closed if ticker isn't in the universe.
      const reqInstrument = String(input.instrument);
      const reqCategory = resolveInstrumentCategory(reqInstrument);
      if (reqCategory === null) {
        return JSON.stringify({
          error: 'INSTRUMENT_NOT_RECOGNISED',
          reason: `Cannot resolve instrument_category for ${reqInstrument} — ticker not in INSTRUMENT_UNIVERSE.`,
        });
      }
      // 2026-05-07 — 2-TP restructure (Phase 2): tp3 / size_c dropped from
      // the proposal contract. Set to null on the draft so any persisted
      // downstream object (TradeRecord cols are nullable) carries NULL.
      //
      // 2026-05-07 — Codex follow-up: size_a / size_b are computed server-side
      // (see computeServerSizing). The LLM-supplied values are ignored. We
      // still need numeric placeholders on the draft because the analyst's
      // openTradesProjection inspects them and downstream logging carries
      // them — but the placeholders are SERVER values, never the LLM's.
      const reqEpic = String(input.epic ?? input.instrument);
      const reqDirection = input.direction as 'long' | 'short';
      const reqEntry = Number(input.entry);
      const reqSl = Number(input.sl);
      const reqTotalRiskPct = Number(input.total_risk_pct);

      // Server-side sizing — pull balance + market details, refuse on either
      // fetch failure (sizing is mandatory for placement; without these
      // numbers the analyst would be evaluating a fictional proposal).
      let serverSizing: ServerSizingResult;
      try {
        const balance = await getPreferredAccountBalance();
        const md = await capital.getMarketDetails(reqEpic);
        const minRule = md?.dealingRules?.minDealSize;
        const minSize = typeof minRule?.value === 'number' && Number.isFinite(minRule.value)
          ? minRule.value
          : null;
        if (minSize === null) {
          // Fail-CLOSED. Without the broker's tick rule we cannot guarantee a
          // tick-aligned size, and Capital would reject the order anyway.
          return JSON.stringify({
            decision: 'REJECT',
            reason: `Cannot determine minDealSize for ${reqEpic} — refusing analyst review until Capital.com market details respond with a numeric minDealSize.`,
            analyst_token: '',
            proposal_hash: '',
            trade_id: '',
            confidence: 0,
            modifications: {},
          });
        }
        serverSizing = computeServerSizing({
          balance: balance.balance,
          totalRiskPct: reqTotalRiskPct,
          entry: reqEntry,
          sl: reqSl,
          minDealSize: minSize,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[Analyst Pre-Check] Sizing fetch failed for ${reqEpic}: ${msg}`);
        return JSON.stringify({
          decision: 'REJECT',
          reason: `Server-side sizing failed (balance/market-details fetch): ${msg}. Refusing analyst review.`,
          analyst_token: '',
          proposal_hash: '',
          trade_id: '',
          confidence: 0,
          modifications: {},
        });
      }
      if (!serverSizing.ok) {
        console.log(`[Analyst Pre-Check] ${reqInstrument} ${reqDirection}: server-sizing ${serverSizing.error} — skipping analyst call.`);
        return JSON.stringify({
          decision: 'REJECT',
          reason: `Pre-analyst sizing rejection (${serverSizing.error}): ${serverSizing.reason}`,
          analyst_token: '',
          proposal_hash: '',
          trade_id: '',
          confidence: 0,
          modifications: {},
        });
      }
      const { sizeA: serverSizeA, sizeB: serverSizeB } = serverSizing;

      const proposalDraft = {
        // trade_id placeholder — overwritten below with a unique id.
        trade_id: '',
        strategy_tag: 'ICT_INTRADAY' as const,
        instrument: reqInstrument,
        epic: reqEpic,
        instrument_category: reqCategory,
        direction: reqDirection,
        entry: reqEntry,
        sl: reqSl,
        tp1: Number(input.tp1),
        tp2: Number(input.tp2),
        // Sizes are server-computed; LLM input is ignored.
        size_a: serverSizeA,
        size_b: serverSizeB,
        total_risk_pct: reqTotalRiskPct,
        composite_score: Number(input.composite_score),
        tier: input.tier as 1 | 2 | 3,
        setup_type: String(input.setup_type),
        kill_zone: String(input.kill_zone),
        reasoning: String(input.reasoning ?? ''),
      };
      const hash = proposalHash(proposalDraft);
      // Codex P1 (final review, 2026-04-29): unique trade_id, NOT
      // `trade-${hash}` directly. The hash is content-addressed and
      // identical for identical proposals; if the same setup recurs
      // (e.g. EURUSD long at 1.0850 SL 1.0830 — common pattern), the
      // second trade would collide on trades.id PRIMARY KEY at the
      // DB write step in place_split_trade. Use `trade-${hash}-${uuid}`
      // for uniqueness; the hash is still part of the id for
      // log-grepping and is still in the analyst_token for verification.
      const tradeId = `trade-${hash}-${randomUUID().slice(0, 8)}`;
      const proposal: TradeProposal = { ...proposalDraft, trade_id: tradeId };

      // Phase A6 (2026-05-04, codex 2nd-pass review of Phase A-D): R:R floor
      // pre-check BEFORE the analyst LLM call. Pre-fix the R:R check only
      // ran inside place_split_trade Step 3.3 AFTER the analyst token had
      // been consumed — wasting a Sonnet 4.6 + adaptive-thinking analyst
      // call (~30-45s, $0.10-0.50) on proposals destined to be rejected on
      // geometry alone. The check is duplicated in place_split_trade as
      // defense-in-depth (in case future call paths bypass this handler).
      // Limited to R:R for now per "one change at a time"; other proposal-
      // internal checks (score/tier/risk consistency, finite numerics,
      // order-side) follow the same pattern and are candidates for the
      // same pre-check refactor in a future commit.
      const isRangeModeProposal = /^range_/.test(
        proposal.setup_type.trim().toLowerCase().replace(/[\s_]+/g, '_'),
      );
      const rrPreCheck = validateRRFloor({
        direction: proposal.direction,
        entry: proposal.entry,
        sl: proposal.sl,
        tp1: proposal.tp1,
        tp2: proposal.tp2,
        tier: proposal.tier,
        ticker: proposal.instrument,
        isRangeMode: isRangeModeProposal,
      });
      if (!rrPreCheck.ok) {
        console.log(`[Analyst Pre-Check] ${proposal.instrument} ${proposal.direction}: ${rrPreCheck.error} — skipping analyst call.`);
        return JSON.stringify({
          decision: 'REJECT',
          reason: `Pre-analyst R:R floor violation: ${rrPreCheck.reason}`,
          analyst_token: '',  // empty — cannot authorize place_split_trade
          proposal_hash: hash,
          trade_id: proposal.trade_id,
          confidence: 0,
          modifications: {},
        });
      }

      // Phase B (2026-05-05 audit): order-side pre-check. Catches inverted
      // SL/TPs (e.g. SHORT with SL below entry — observed live 2026-05-04
      // 08:31 on GOLD) before the analyst LLM call. Without this gate the
      // analyst's verbose markdown rejection of malformed proposals was the
      // dominant truncation trigger (0/6 parseable decisions over 6 days).
      const orderSidePreCheck = validateOrderSide({
        direction: proposal.direction,
        entry: proposal.entry,
        sl: proposal.sl,
        tp1: proposal.tp1,
        tp2: proposal.tp2,
      });
      if (!orderSidePreCheck.ok) {
        console.log(`[Analyst Pre-Check] ${proposal.instrument} ${proposal.direction}: ${orderSidePreCheck.reason} — skipping analyst call.`);
        return JSON.stringify({
          decision: 'REJECT',
          reason: `Pre-analyst order-side violation: ${orderSidePreCheck.reason}`,
          analyst_token: '',
          proposal_hash: hash,
          trade_id: proposal.trade_id,
          confidence: 0,
          modifications: {},
        });
      }

      const decision = await runAnalystAgent(proposal);
      if (decision.decision === 'APPROVE') {
        approvedProposals.set(hash, { approvedAt: Date.now(), proposal });
      } else {
        // 2026-04-29 audit-3 fix (P0-3): invalidate any prior APPROVE on a
        // REJECT/MODIFY for the same proposal hash. Pre-fix scenario: the
        // agent calls request_analyst_review twice in the same cycle (e.g.
        // re-asking after a fresh news fetch); first call APPROVEs and
        // stores the token, second call REJECTs but the OLD APPROVE token
        // remains live in approvedProposals for the 10-min TTL. The agent
        // could then call place_split_trade with the original token and
        // the order would go through despite the most recent analyst
        // verdict being REJECT. Fix: any non-APPROVE verdict on a hash
        // explicitly invalidates any prior approval for that same hash.
        approvedProposals.delete(hash);
      }
      return JSON.stringify({
        decision: decision.decision,
        reason: decision.reason,
        analyst_token: hash,
        proposal_hash: hash,
        trade_id: proposal.trade_id,
        confidence: decision.confidence,
        modifications: decision.modifications,
        // 2026-05-07 — Codex follow-up: surface server-computed sizes so the
        // LLM can log them in its decision-cycle output. Any size_a/size_b
        // values the LLM supplied to this tool were ignored and replaced
        // with these.
        computed_sizes: { size_a: serverSizeA, size_b: serverSizeB },
      });
    }

    case 'place_split_trade': {
      // Unified atomic 2-leg placement with full validation cascade.
      // Replaces bare place_order + log_trade. Codex P0+P1 fixes
      // (2026-04-28): #1 (analyst gate), #2 (atomic order+log), #8 (score
      // contract), #9 (coordination lock), plus order-side, finite, and
      // calendar checks. (Was 3-leg pre-2026-05-07; collapsed to 2-leg in
      // the Phase 2 restructure.)
      const epic = String(input.epic);
      const direction = input.direction as 'long' | 'short';

      // === Step 1: rebuild proposal from input + verify hash matches token
      pruneStaleApprovals();
      // 2026-05-05 audit (A6): derive instrument_category from the universe;
      // fail closed if not recognised. The hash includes instrument_category
      // so this MUST match what request_analyst_review derived (it does, via
      // the same resolveInstrumentCategory call).
      const splitInstrument = String(input.instrument);
      const splitCategory = resolveInstrumentCategory(splitInstrument);
      if (splitCategory === null) {
        return JSON.stringify({
          error: 'INSTRUMENT_NOT_RECOGNISED',
          reason: `Cannot resolve instrument_category for ${splitInstrument} — ticker not in INSTRUMENT_UNIVERSE.`,
        });
      }
      // 2026-05-07 — 2-TP restructure (Phase 2): tp3 / size_c removed from
      // the placement contract. Set to null so the persisted TradeRecord
      // carries NULL on the legacy columns.
      //
      // 2026-05-07 — Codex follow-up: size_a / size_b are NOT part of the
      // canonical hash anymore (sizing is server-computed). We pass 0
      // placeholders into proposalForVerify here purely to satisfy the
      // TradeProposal type — the actual placement sizes are computed below
      // at Step 3.5 from balance + market details.
      const proposalForVerify: TradeProposal = {
        trade_id: '<placeholder — not part of hash>',
        strategy_tag: 'ICT_INTRADAY',
        instrument: splitInstrument,
        epic,
        instrument_category: splitCategory,
        direction,
        entry: Number(input.entry),
        sl: Number(input.sl),
        tp1: Number(input.tp1),
        tp2: Number(input.tp2),
        // proposalHash ignores these post-Codex-follow-up. 0 is a safe sentinel.
        size_a: 0,
        size_b: 0,
        total_risk_pct: Number(input.total_risk_pct),
        composite_score: Number(input.composite_score),
        tier: input.tier as 1 | 2 | 3,
        setup_type: String(input.setup_type),
        kill_zone: String(input.kill_zone),
        reasoning: String(input.reasoning ?? ''),
      };
      const hash = proposalHash(proposalForVerify);
      const tokenStr = String(input.analyst_token ?? '');
      // 2026-04-29 codex-review fix (Finding 3): atomic verify-and-consume.
      // Pre-fix the token was verified at Step 1 but only consumed at
      // Step 5.5 (after balance / min-size / live-position / calendar
      // awaits). Two concurrent place_split_trade calls with the same
      // approved token could BOTH pass verification across those awaits
      // and both attempt placement — duplicate trade. JS is single-threaded
      // within a synchronous block, so doing get + delete with NO await
      // between them is atomic across concurrent callers (the second one
      // sees `undefined` from .get() because the first one's .delete()
      // already ran). Move consume here, before any await in the validation
      // cascade. If a later step fails, the token is gone and the agent
      // re-requests review on the next cycle — small extra Sonnet call,
      // eliminates the race.
      const approval = approvedProposals.get(tokenStr);
      if (!approval) {
        return JSON.stringify({
          error: 'ANALYST_NOT_APPROVED',
          reason: 'No analyst approval found for the supplied analyst_token. Call request_analyst_review first.',
        });
      }
      if (tokenStr !== hash) {
        return JSON.stringify({
          error: 'PROPOSAL_HASH_MISMATCH',
          reason: 'analyst_token was issued for a different proposal. The trade params must match exactly what was approved (entry, SL, TP1/TP2, score, tier, total_risk_pct, setup_type, kill_zone, instrument/epic). Note: size_a and size_b are NOT part of the hash post-2026-05-07 — sizing is computed server-side from total_risk_pct + balance + minDealSize. Re-request analyst_review with the current proposal.',
          expected_hash: hash,
          provided_token: input.analyst_token,
        });
      }
      approvedProposals.delete(tokenStr);

      // === Step 2: composite_score / tier / risk-pct internal consistency
      const score = Number(input.composite_score);
      const tier = Number(input.tier);
      const riskPct = Number(input.total_risk_pct);
      const setupType = String(input.setup_type ?? '');
      // 2026-04-29 range-mode addition: setup_type indicating range-mode
      // signals 0.25% total risk (vs standard 0.5% Tier 3). The match is
      // intentionally lenient — Haiku may emit "Range_Sweep_Reversal"
      // (canonical), "Range Sweep Reversal" (with spaces), or
      // "range_sweep_reversal" (lowercase). Codex review of 7b6db35
      // flagged that the strict /^Range_/i regex would reject
      // space-separated variants → correct 0.25% proposal gets a
      // RISK_PCT_TIER_MISMATCH error. Match any setup_type whose first
      // word (after trimming whitespace/underscores) is "range".
      const setupTypeNorm = setupType.trim().toLowerCase().replace(/[\s_]+/g, '_');
      const isRangeMode = /^range_/.test(setupTypeNorm);
      const tier3Floor = tier3FloorFor(proposalForVerify.instrument);
      if (!Number.isFinite(score) || score < tier3Floor) {
        return JSON.stringify({
          error: 'SCORE_BELOW_TIER_MIN',
          reason: `composite_score ${score} is below Tier 3 floor ${tier3Floor} for ${proposalForVerify.instrument}. No trade.`,
        });
      }
      const expectedTier = score >= 80 ? 1 : score >= 60 ? 2 : 3;
      if (tier !== expectedTier) {
        return JSON.stringify({
          error: 'TIER_SCORE_MISMATCH',
          reason: `composite_score ${score} maps to Tier ${expectedTier}, but proposal claims Tier ${tier}.`,
        });
      }
      // Range-mode is structurally Tier 3 only — reject T1/T2 proposals
      // that try to use a Range_* setup_type.
      if (isRangeMode && tier !== 3) {
        return JSON.stringify({
          error: 'RANGE_MODE_TIER_MISMATCH',
          reason: `setup_type "${setupType}" is range-mode and Tier 3 only. Proposal has Tier ${tier}.`,
        });
      }
      const expectedRiskPct = isRangeMode ? 0.25
        : expectedTier === 1 ? 1.5
        : expectedTier === 2 ? 1.0
        : 0.5;
      const riskPctCheck = validateRiskPct({ riskPct, expectedRiskPct });
      if (!riskPctCheck.ok) {
        return JSON.stringify({
          error: 'RISK_PCT_TIER_MISMATCH',
          reason: `${isRangeMode ? 'Range-mode' : `Tier ${expectedTier}`} requires risk ${expectedRiskPct}%. ${riskPctCheck.reason}.`,
        });
      }

      // === Step 3: order-side + finite-numbers
      // 2026-05-07 — 2-TP restructure (Phase 2): tp3 / sizeC dropped.
      // 2026-05-07 — Codex follow-up: sizeA / sizeB no longer read from input.
      // They are computed server-side at Step 3.5 below from balance + market
      // details. The LLM-supplied size_a/size_b values are discarded.
      const entry = Number(input.entry);
      const sl = Number(input.sl);
      const tp1 = Number(input.tp1);
      const tp2 = Number(input.tp2);
      const allFinite = [entry, sl, tp1, tp2].every((n) => Number.isFinite(n));
      if (!allFinite) {
        return JSON.stringify({
          error: 'INVALID_NUMERICS',
          reason: `Non-finite numeric in proposal: entry=${entry}, sl=${sl}, tps=[${tp1},${tp2}]`,
        });
      }
      const sideOk = direction === 'long'
        ? sl < entry && entry < tp1 && tp1 < tp2
        : sl > entry && entry > tp1 && tp1 > tp2;
      if (!sideOk) {
        return JSON.stringify({
          error: 'INVALID_ORDER_SIDE',
          reason: `For direction='${direction}', expected ${direction === 'long' ? 'SL<entry<TP1<TP2' : 'SL>entry>TP1>TP2'}. Got SL=${sl} entry=${entry} TP1=${tp1} TP2=${tp2}.`,
        });
      }

      // === Step 3.3: R:R floor validation (Phase A1, 2026-05-04, audit Finding #2)
      // strategy.md Section 7.3 specifies trend-mode TP1≥1, TP2≥2 (or 1.5 for
      // T3 tight-spread), TP3≥3; range-mode TP1≥1, TP2≥1.5, TP3≥2. Pre-fix
      // there was NO magnitude check — only ordering. A hallucinated proposal
      // with TP1 1 pip past entry could pass every gate. See validateRRFloor
      // above for the full rationale.
      const rrCheck = validateRRFloor({
        direction,
        entry,
        sl,
        tp1,
        tp2,
        tier: expectedTier,
        ticker: String(input.instrument ?? '').toUpperCase(),
        isRangeMode,
      });
      if (!rrCheck.ok) {
        return JSON.stringify({
          error: rrCheck.error,
          reason: rrCheck.reason,
        });
      }

      // === Step 3.5: code-enforced 6% daily + 10% weekly kill switches
      // Daily 6%: Codex P0-TA1 (2026-04-29). strategy.md Section 7.2 says
      // daily 6% loss is non-negotiable. Pre-fix this was only visible to
      // the LLM via get_daily_pnl as a FLAG — no code-level gate.
      // Weekly 10%: Phase A3 (2026-05-04, audit Finding #6). strategy.md
      // Section 7.2 also says "Weekly loss limit: 10% of account equity.
      // Non-negotiable. When triggered: No new positions opened
      // (code-enforced in executeTool paths)" — but pre-fix no caller
      // invoked getWeeklyPnl. Daily caught the worst day; four bad days
      // could still clear 10% with the bot trading. Now enforced.
      try {
        const balance = await getPreferredAccountBalance();
        const today = new Date().toISOString().split('T')[0];
        const daily = getDailyPnl(today);
        const equity = balance.balance;

        // Daily check (unchanged behaviour)
        const pnl = balance.profitLoss + (daily?.realised_pnl ?? 0);
        const pct = equity ? (pnl / equity) * 100 : 0;
        if (pct <= -6) {
          console.error(`[ICT Agent] DAILY KILL SWITCH ACTIVE: ${pct.toFixed(2)}% — refusing place_split_trade for ${input.instrument}.`);
          return JSON.stringify({
            error: 'DAILY_KILL_SWITCH_ACTIVE',
            reason: `Daily P&L is ${pct.toFixed(2)}% — at or beyond the -6% kill-switch threshold. No new positions until UTC midnight.`,
            current_pct: pct,
            threshold_pct: -6,
          });
        }

        // Weekly check (new). Realised P&L from this week's Sunday onward
        // (includes today's realised if the daily log has been updated this
        // tick) plus current unrealised. Avoids double-counting today's
        // unrealised by using realised-only sum + balance.profitLoss.
        const weekStart = computeWeekStartUTC(new Date());
        const weeklyRealised = getRealisedPnlSince(weekStart);
        const weeklyPnl = weeklyRealised + balance.profitLoss;
        const weeklyCheck = validateWeeklyKillSwitch({ weeklyPnl, equity });
        if (!weeklyCheck.ok) {
          console.error(`[ICT Agent] WEEKLY KILL SWITCH ACTIVE: ${weeklyCheck.currentPct.toFixed(2)}% — refusing place_split_trade for ${input.instrument}.`);
          return JSON.stringify({
            error: weeklyCheck.error,
            reason: weeklyCheck.reason,
            current_pct: weeklyCheck.currentPct,
            threshold_pct: weeklyCheck.thresholdPct,
            week_start: weekStart,
          });
        }
      } catch (err) {
        // Fail-CLOSED on inability to read balance/PnL. A risk gate cannot
        // be allowed to silently bypass on data-source failure.
        // 2026-05-05 audit (A3): pre-fix this only logged to pm2-out and
        // returned an error to the agent — Giuseppe had no idea the bot was
        // refusing trades because of fetch failures. Now: Telegram alert.
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[ICT Agent] DAILY/WEEKLY P&L FETCH FAILED: ${msg}. Refusing place_split_trade — cannot verify kill switch.`);
        alertSystemWarning(
          `🛑 Kill-switch verification FAILED — refusing trade. Cause: ${msg}. ` +
          `Bot will keep refusing place_split_trade until balance/P&L fetch recovers.`,
        ).catch(() => { /* don't let alert failure block the trade-rejection path */ });
        return JSON.stringify({
          error: 'DAILY_PNL_FETCH_FAILED',
          reason: `Cannot verify daily/weekly kill switch: ${msg}. Refusing order — risk gate fails closed.`,
        });
      }

      // === Step 3.7: server-side tick-aware 70/30 sizing
      // 2026-05-07 (Codex follow-up). Pre-fix this step was a defensive min-
      // size guardrail that VALIDATED the LLM's size_a/size_b against the
      // broker's minDealSize. Codex flagged that as insufficient — the LLM
      // can produce sizes that pass the minimum check but violate the broker
      // tick rule (sizes must be multiples of minDealSize) or drift from the
      // intended 70/30 split. The fix: compute size_a + size_b SERVER-SIDE
      // here from balance + total_risk_pct + minDealSize, ignoring whatever
      // the LLM submitted in input.size_a / input.size_b.
      //
      // Fail-CLOSED on getMarketDetails / balance fetch failure: without a
      // numeric minDealSize we cannot guarantee a tick-aligned size, and
      // Capital.com would reject the placement anyway. The earlier permissive
      // "log-and-continue" stance only worked when sizing came from the LLM;
      // server-side sizing requires the broker tick rule as a HARD input.
      let sizeA: number;
      let sizeB: number;
      try {
        const balance = await getPreferredAccountBalance();
        const md = await capital.getMarketDetails(epic);
        const minRule = md?.dealingRules?.minDealSize;
        const minSize = typeof minRule?.value === 'number' && Number.isFinite(minRule.value)
          ? minRule.value
          : null;
        if (minSize === null) {
          return JSON.stringify({
            error: 'MIN_DEAL_SIZE_UNAVAILABLE',
            reason: `Capital.com market details for ${epic} did not include a numeric minDealSize. Cannot tick-align position size — refusing placement.`,
          });
        }
        const sizing = computeServerSizing({
          balance: balance.balance,
          totalRiskPct: riskPct,
          entry,
          sl,
          minDealSize: minSize,
        });
        if (!sizing.ok) {
          return JSON.stringify({
            error: sizing.error,
            reason: sizing.reason,
            min_deal_size: minSize,
          });
        }
        sizeA = sizing.sizeA;
        sizeB = sizing.sizeB;
        console.log(
          `[ICT Agent] Server-computed sizes for ${epic}: total_qty=${(sizing.totalQty).toFixed(4)}, ` +
          `size_a=${sizeA} (~70%), size_b=${sizeB} (~30%, tick-aligned to ${minSize})`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[ICT Agent] Server-sizing fetch failed for ${epic}: ${msg}`);
        return JSON.stringify({
          error: 'SIZING_FETCH_FAILED',
          reason: `Cannot compute server-side sizing (balance/market-details fetch): ${msg}. Refusing order — sizing gate fails closed.`,
        });
      }

      // === Step 4: code-enforced coordination lock
      // 2026-04-29 audit fix (P0-TA3): check BOTH the local DB AND the
      // live Capital state. Pre-fix the lock checked only the DB, so a
      // restart with empty DB while Capital had open positions would let
      // the LLM open a duplicate. Now we union the two.
      const existing = getOpenTradesByInstrument(String(input.instrument));
      if (existing.length > 0) {
        return JSON.stringify({
          error: 'COORDINATION_LOCK',
          reason: `An open ${input.instrument} position already exists in DB (trade_id=${existing[0].id}, status=${existing[0].status}). Coordination lock prevents duplicate-instrument entries.`,
        });
      }
      try {
        const livePositions = await capital.getOpenPositions();
        const sameEpic = livePositions.filter(
          (p) => String(p.market?.epic ?? '').toUpperCase() === epic.toUpperCase(),
        );
        if (sameEpic.length > 0) {
          return JSON.stringify({
            error: 'COORDINATION_LOCK_LIVE',
            reason: `Capital.com has ${sameEpic.length} live position(s) on ${epic} that are NOT in the local DB. Possible orphan from a prior session — manual reconciliation required before opening more.`,
            live_deal_ids: sameEpic.map((p) => p.position?.dealId).filter(Boolean),
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[ICT Agent] LIVE POSITION CHECK FAILED for ${epic}: ${msg}. Refusing place_split_trade — coordination gate fails closed.`);
        return JSON.stringify({
          error: 'LIVE_POSITION_CHECK_FAILED',
          reason: `Cannot verify Capital.com live state for coordination lock: ${msg}. Refusing order — fails closed.`,
        });
      }

      // === Step 5: calendar veto (fail-closed on fetch error)
      // 2026-04-29 audit-3 fix (P0-4): drop the `.catch(() => [])` on
      // fetchForexFactoryCalendar. Pre-fix, an FF outage silently swallowed
      // the error and returned [] — the calendar veto then ran on Finnhub
      // alone, leaving FX-calibrated tier-1 events that Finnhub doesn't
      // carry (or carries late) invisible. The outer try/catch already
      // fails closed on Promise.all rejection; let FF rejection propagate.
      const tradeCurrencies = instrumentToCurrencies(epic);
      if (tradeCurrencies.length === 0) {
        // 2026-05-05 audit (A4): pre-fix this silently bypassed the calendar
        // veto for any ticker that instrumentToCurrencies didn't recognize
        // (typos, future universe additions). An unknown ticker now fails
        // closed — the bot refuses the trade until the helper is updated to
        // map the new ticker. Loud refusal is the right failure mode.
        const msg = `Cannot derive currencies for ${epic} — calendar veto cannot run. Refusing trade until instrumentToCurrencies recognizes the ticker.`;
        console.error(`[ICT Agent] ${msg}`);
        alertSystemWarning(`🛑 ${msg}`).catch(() => { /* alert failure non-blocking */ });
        return JSON.stringify({
          error: 'INSTRUMENT_NOT_RECOGNISED',
          reason: msg,
        });
      }
      try {
        const [finnhubCalendar, ffCalendar] = await Promise.all([
          fetchEconomicCalendar(1),
          fetchForexFactoryCalendar(),
        ]);
        const calendar = [...finnhubCalendar, ...ffCalendar];
        const veto = shouldVetoOrderForCalendar(tradeCurrencies, calendar, Date.now());
        if (veto.veto) {
          return JSON.stringify({
            error: 'CALENDAR_VETO',
            reason: veto.reason,
            event: veto.event,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[ICT Agent] CALENDAR FETCH FAILED for ${epic}: ${msg}. Refusing — fail closed.`);
        return JSON.stringify({
          error: 'CALENDAR_FETCH_FAILED',
          reason: `Calendar fetch failed (${msg}). Refusing order — risk gate fails closed.`,
        });
      }

      // (Step 5.5 — token consumption — has moved to immediately after
      // verification at Step 1 to eliminate the cross-await race condition
      // codex flagged on 2026-04-29. The token was already consumed before
      // any of Steps 3.5/3.7/4/5 ran.)

      // === Step 6: place legs sequentially with compensation
      // 2026-05-07 — 2-TP restructure (Phase 2): two legs only (A=TP1, B=TP2).
      // Leg C is no longer placed; the third openPosition call has been removed.
      const tsCompact = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
      const labelBase = `ICT-${input.instrument}-${tsCompact}`;
      const placedDeals: Array<{ leg: 'A' | 'B'; dealId: string }> = [];
      const capDirection: 'BUY' | 'SELL' = direction === 'long' ? 'BUY' : 'SELL';

      const placeLeg = async (leg: 'A' | 'B', size: number, tp: number): Promise<string> => {
        const conf = await capital.openPosition({
          direction: capDirection,
          epic,
          size,
          stopLevel: sl,
          profitLevel: tp,
        });
        if (!conf.dealId) {
          throw new Error(`Capital returned no dealId for leg ${leg}: ${JSON.stringify(conf)}`);
        }
        return conf.dealId;
      };

      // 2026-05-05 audit (B3): mark this code path as a critical section.
      // The shutdown handler in src/index.ts polls getCriticalSectionDepth()
      // and waits up to ~1.4s for it to reach 0 before flushing the DB +
      // exiting. Pre-fix a SIGTERM between leg placement and insertTrade
      // could leave a position live on Capital with no DB row.
      enterCriticalSection();
      try {
        const dealA = await placeLeg('A', sizeA, tp1);
        placedDeals.push({ leg: 'A', dealId: dealA });
        const dealB = await placeLeg('B', sizeB, tp2);
        placedDeals.push({ leg: 'B', dealId: dealB });
      } catch (err) {
        // === Compensation: close any successfully-placed legs
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[ICT Agent] place_split_trade partial failure: ${errMsg}. Rolling back ${placedDeals.length} placed legs.`);
        const rollbackErrors: string[] = [];
        for (const p of placedDeals) {
          try {
            await capital.closePosition(p.dealId);
          } catch (closeErr) {
            const closeMsg = closeErr instanceof Error ? closeErr.message : String(closeErr);
            rollbackErrors.push(`Leg ${p.leg} (deal ${p.dealId}): ${closeMsg}`);
          }
        }
        exitCriticalSection();
        return JSON.stringify({
          error: 'PLACE_SPLIT_PARTIAL_FAILURE',
          reason: `Placement of leg ${placedDeals.length === 0 ? 'A' : 'B'} failed: ${errMsg}.`,
          placed_legs: placedDeals,
          rollback_errors: rollbackErrors,
          guidance: rollbackErrors.length === 0
            ? 'All placed legs successfully closed. Account is flat. Retry on next cycle.'
            : '⚠️ ROLLBACK INCOMPLETE — some legs may still be open on Capital. Inspect manually + reconcile.',
        });
      }

      // === Step 7: persist trade record + SL/TP rows + Telegram alert
      // 2026-04-29 audit fix (P0-AN1): use the trade_id from the approved
      // proposal — the ONE generated in request_analyst_review and stored
      // in the approval map. analyst_log.trade_id row was written with this
      // exact id when the Analyst returned APPROVE, so trades.id JOINs
      // cleanly. Codex final-review fix: this id includes a UUID suffix to
      // prevent collision when the same setup recurs across time.
      const tradeId = approval.proposal.trade_id;
      // The tradeRow shape is the agent's payload that insertTrade
      // normalises defensively. We use `as any` here because Parameters<
      // typeof insertTrade>[0] resolves to a strict type that TS struggles
      // to infer compatibility for given the optional/null fields. The
      // runtime shape is verified by insertTrade's own field-by-field
      // normalization in src/database/index.ts.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      // 2026-05-07 — 2-TP restructure (Phase 2): legacy C-leg columns
      // (tp3 / position_c_id / size_c / pnl_c) are omitted from the INSERT
      // and default to NULL at the DB layer. Explicit-null writes were
      // removed in Task 5 of the 3-leg removal plan (2026-05-09).
      const tradeRow: any = {
        id: tradeId,
        strategy_tag: 'ICT_INTRADAY',
        instrument: splitInstrument,
        // splitCategory was already validated as non-null at Step 1 above.
        instrument_category: splitCategory,
        direction,
        setup_type: String(input.setup_type),
        entry,
        sl,
        tp1,
        tp2,
        position_a_id: placedDeals[0].dealId,
        position_b_id: placedDeals[1].dealId,
        size_a: sizeA,
        size_b: sizeB,
        status: 'open',
        composite_score: score,
        kill_zone: String(input.kill_zone),
        analyst_decision: 'APPROVE',
        reasoning: String(input.reasoning ?? ''),
      };
      try {
        insertTrade(tradeRow);
        createSlTpOrder({ trade_id: tradeId, leg: 'A', instrument: tradeRow.instrument, direction, quantity: sizeA, sl_price: sl, tp_price: tp1, deal_id: placedDeals[0].dealId });
        createSlTpOrder({ trade_id: tradeId, leg: 'B', instrument: tradeRow.instrument, direction, quantity: sizeB, sl_price: sl, tp_price: tp2, deal_id: placedDeals[1].dealId });
      } catch (err) {
        // DB write failed AFTER successful Capital placement. This is the
        // exact orphan-position scenario CR-9 was meant to prevent —
        // positions exist on Capital but no DB record means scheduler
        // can't manage them. Don't roll back the live positions (closing
        // them costs spread+slippage); instead, alert LOUDLY and log all
        // dealIds so ops can manually reconcile.
        const dbErr = err instanceof Error ? err.message : String(err);
        console.error(
          `[ICT Agent] CRITICAL: Capital legs placed but DB log_trade FAILED — ${dbErr}\n` +
            `Orphan dealIds: ${placedDeals.map((p) => `${p.leg}=${p.dealId}`).join(', ')}\n` +
            `MANUAL RECONCILE REQUIRED.`,
        );
        exitCriticalSection();
        return JSON.stringify({
          error: 'DB_LOG_FAILED_AFTER_PLACEMENT',
          reason: `Capital placement succeeded for both legs, but DB persistence failed: ${dbErr}.`,
          orphan_deals: placedDeals,
          guidance: 'Live positions exist on Capital with no DB record. Manual reconciliation required. Do NOT retry — that would double-place.',
        });
      }
      // DB writes successful — critical section ends here. Subsequent
      // Telegram alert + return are non-critical (data is persisted).
      exitCriticalSection();

      // Approval was consumed at step 5.5 (before placement) so we don't
      // re-delete here. (Comment kept as breadcrumb for the next reader.)

      await alertTradePlaced(tradeRow);
      console.log(`[ICT Agent] Trade placed: ${tradeId} ${input.instrument} ${direction} ${score}/T${tier} (2 legs)`);
      return JSON.stringify({
        status: 'placed',
        trade_id: tradeId,
        deals: placedDeals,
        total_risk_pct: riskPct,
        composite_score: score,
        tier,
      });
    }
    case 'update_sl': {
      // 2026-04-29 audit-3 fix (Researcher P0-1): pre-fix this tool wrote
      // ONLY to the local DB sl_tp_orders.sl_price and never reached
      // Capital.com. The system prompt told the LLM "use update_sl to
      // tighten SL on a structural change" and the response was
      // {status:'updated'} — but the broker's stopLevel was unchanged.
      // Every "tighten SL" action the LLM thought it executed was fake.
      //
      // Fix: discover all active legs for this trade_id, push the new
      // stopLevel to Capital.com via safelyAmendPosition for each (which
      // round-trips broker-side TP/trailing to defeat the partial-amend
      // strip — see capital-client.safelyAmendPosition), AND update the
      // DB to keep them in sync. Failures are reported per-leg so the
      // agent sees which legs succeeded.
      const tradeId = String(input.trade_id);
      const newSl = Number(input.new_sl);
      if (!Number.isFinite(newSl)) {
        return JSON.stringify({ error: 'INVALID_SL', reason: `new_sl must be finite. Got ${input.new_sl}` });
      }
      const activeOrders = getActiveSlTpOrdersByTradeId(tradeId);
      if (activeOrders.length === 0) {
        return JSON.stringify({
          error: 'NO_ACTIVE_LEGS',
          reason: `No active sl_tp_orders rows for trade_id=${tradeId}. Either the trade is already closed or the trade_id is wrong.`,
        });
      }
      const results: Array<{ leg: string; deal_id: string | null; ok: boolean; error?: string }> = [];
      for (const order of activeOrders) {
        if (!order.deal_id) {
          results.push({ leg: order.leg, deal_id: null, ok: false, error: 'No deal_id on this leg row.' });
          continue;
        }
        try {
          // safelyAmendPosition preserves existing profitLevel + trailingStop
          // on each leg — Capital.com strips omitted fields on PUT amend.
          await capital.safelyAmendPosition(order.deal_id, { stopLevel: newSl });
          updateSlPrice(tradeId, order.leg, newSl);
          results.push({ leg: order.leg, deal_id: order.deal_id, ok: true });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[ICT Agent] update_sl failed for trade=${tradeId} leg=${order.leg} deal=${order.deal_id}: ${msg}`);
          results.push({ leg: order.leg, deal_id: order.deal_id, ok: false, error: msg });
        }
      }
      const allOk = results.every((r) => r.ok);
      return JSON.stringify({
        status: allOk ? 'updated' : 'partial_failure',
        new_sl: newSl,
        per_leg: results,
        guidance: allOk
          ? `All ${results.length} active legs updated on Capital + DB.`
          : 'One or more legs failed to update on Capital — broker truth is now divergent across legs. Review per_leg results and consider close_position on the failing legs.',
      });
    }
    case 'close_position': {
      // 2026-04-29 audit-3 fix (Researcher P0-2): pre-fix this tool only
      // called Capital.closePosition; the local DB was untouched. The next
      // monitorSplitPositions tick saw the closed position with no PROFIT/
      // STOP activity match → classifyCloseReason returned 'OTHER' →
      // handleSlOnLeg eventually finalised the trade as `sl_hit`. Every
      // agent-initiated early close was misrecorded as a stop-out, polluting
      // Weekly Review win-rate calc and the Reflection lesson.
      //
      // Fix: after Capital close succeeds, locate the trade record by
      // deal_id, mark it `closed_early` with a closure_reason, deactivate
      // the leg's sl_tp_orders row. The `closed_early` enum value was
      // already in the schema, just dead code.
      const dealId = String(input.dealId);
      const reasonText = typeof input.reason === 'string' ? input.reason : 'agent-initiated early close';
      let capitalResult: unknown;
      try {
        capitalResult = await capital.closePosition(dealId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return JSON.stringify({ error: 'CAPITAL_CLOSE_FAILED', reason: msg, dealId });
      }
      // Locate the owning trade and update DB.
      const trade = getTradeByDealId(dealId);
      if (!trade) {
        // Could happen if the deal_id is wrong, or for a position that
        // was placed outside the bot. Don't fail — return success with
        // a warning.
        return JSON.stringify({
          status: 'closed_on_capital',
          warning: 'No DB trade record found for this deal_id — Capital position closed but no DB row updated. Verify the dealId.',
          capital_result: capitalResult,
        });
      }
      // Find which leg this deal_id belongs to and deactivate just that row
      // (NOT the entire trade — other legs may still be running).
      const allLegs = getActiveSlTpOrdersByTradeId(trade.id);
      const matchedLeg = allLegs.find((l) => l.deal_id === dealId);
      if (matchedLeg) {
        deactivateSlTpOrder(trade.id, matchedLeg.leg);
      }
      // Mark trade closed_early ONLY if no other legs remain active
      // (i.e. this close finishes off the trade). Otherwise the trade
      // is still partially live.
      const remainingActive = getActiveSlTpOrdersByTradeId(trade.id);
      if (remainingActive.length === 0) {
        markTradeClosedEarly(trade.id, `${reasonText} (deal=${dealId}, leg=${matchedLeg?.leg ?? '?'})`);
      }
      return JSON.stringify({
        status: 'closed',
        trade_id: trade.id,
        leg_closed: matchedLeg?.leg ?? null,
        remaining_legs: remainingActive.length,
        trade_status: remainingActive.length === 0 ? 'closed_early' : trade.status,
        capital_result: capitalResult,
      });
    }
    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

// 2026-05-09: Test seam for the loop's tool dispatch. Both Claude and
// Codex plan-reviewers flagged that vi.spyOn(module, 'executeTool')
// cannot intercept the loop's in-file lexical call — ESM exports a
// binding to the function, but the call resolves via lexical scope,
// not via the export object. The seam below routes the loop through
// a mutable module-level binding that tests can patch via
// _setExecuteToolImpl. Default is the real executeTool above.
let _executeToolImpl: typeof executeTool = executeTool;

/** Test-only: patch the loop's tool dispatcher. Restore via _resetExecuteToolImpl. */
export function _setExecuteToolImpl(impl: typeof executeTool): void {
  _executeToolImpl = impl;
}

/** Test-only: restore the default executeTool dispatcher. */
export function _resetExecuteToolImpl(): void {
  _executeToolImpl = executeTool;
}

// ==================== MAIN AGENT LOOP ====================

export async function runTradingAgent(): Promise<void> {
  console.log('ICT Trading Agent starting decision cycle...');

  const systemPrompt = loadPromptWithDemoContext('ict-agent.md');
  const strategy = loadStrategy('strategy.md');
  const brief = getLatestBrief();
  // B (2026-04-28): preload yesterday's EOD journal so the ICT cycle
  // starts with "yesterday I learned X" preamble. Walks back up to 3 days
  // (CR-9 narrowed from 5) to handle weekend gaps without injecting stale
  // ancient journals during extended downtime.
  // CR-9 also caps the journal markdown at 4000 chars before injection so
  // a verbose entry can't blow out the ICT context budget.
  const JOURNAL_PREAMBLE_MAX_CHARS = 4000;
  const journal = loadRecentJournal();
  const journalMarkdown = journal
    ? (journal.markdown.length > JOURNAL_PREAMBLE_MAX_CHARS
        ? `${journal.markdown.slice(0, JOURNAL_PREAMBLE_MAX_CHARS)}\n\n[…truncated for context budget]`
        : journal.markdown)
    : null;

  const contextMessage = `Current UTC time: ${new Date().toISOString()}

${journal && journalMarkdown ? `YESTERDAY'S JOURNAL (${journal.date}) — read this before deciding, it captures patterns from the most recent trading day:

${journalMarkdown}

---

` : ''}STRATEGY FILE:
${strategy}

${brief ? `LATEST RESEARCH BRIEF:
${JSON.stringify(brief, null, 2)}` : 'No research brief available yet.'}

Begin your 5-step decision cycle now. Start with Step 1 (check daily risk status).`;

  // Agentic loop: Claude calls tools, we execute, feed results back
  let messages: Anthropic.Messages.MessageParam[] = [
    { role: 'user', content: contextMessage },
  ];

  // 2026-04-21: cap reduced 15 → 8 to force decisions; runs that hit 15
  // were stuck in a never-converging research loop. The reduction
  // prioritised "force a decision with the data the agent has gathered"
  // over occasional quality on borderline cases.
  //
  // 2026-05-09: cap bumped 8 → 12. NFP Friday (2026-05-08) surfaced 5 of
  // 12 cycles hitting the 8 cap before reaching end_turn. Decision graph
  // has grown since 2026-04-21 (calendar veto check, bias-mismatch
  // validation, sizing constraint check, Force-Propose mandatory analyst
  // submission, multi-candidate pivot logic) — 8 is now too tight on
  // complex days. 12 keeps the "force decision" guardrail at a higher
  // threshold.
  //
  // ICT_AGENT_MAX_ITER env override added 2026-05-09 so live tuning
  // (during a kill zone) doesn't require a redeploy. Reads as Number();
  // falls back to 12 on NaN, non-integer, or out-of-range. 1 ≤ N ≤ 50.
  const envCap = Number(process.env.ICT_AGENT_MAX_ITER);
  const maxIterations =
    Number.isInteger(envCap) && envCap >= 1 && envCap <= 50 ? envCap : 12;

  // 2026-04-29 audit (continued bug hunt): the ICT main loop had no per-
  // iteration timeout. With 8 iterations and the SDK's 600s default, a
  // wedged Anthropic call could hold the cycle for 80 minutes. Now each
  // iteration has a 90s budget — long enough for typical thinking +
  // tool-routing, short enough that 8 wedged iterations is "only" 12 min
  // (still bad, but bounded). A wedged iteration throws, the loop's
  // outer scheduler catches it via safeRun.
  const iterationTimeoutMs = 90_000;
  // Track whether the loop exited via `break` (clean end_turn) or by
  // exhausting maxIterations. Codex final-review P2: pre-fix the
  // "CYCLE TIMED OUT" log fired even on a clean break.
  let cleanlyCompleted = false;

  // 2026-05-09: bookkeeping for the enriched timeout log. Tracks what the
  // agent was doing at the moment the cap fired so pm2-err.log lines can
  // answer "is the agent looping on a single tool, or making real
  // progress that just runs out of room?".
  let lastIterToolNames: string[] = [];
  let lastStopReason: string | null = null;
  let totalToolCalls = 0;
  const distinctTools = new Set<string>();

  for (let i = 0; i < maxIterations; i++) {
    const response = await withTimeout(anthropic.messages.create({
      // Cost optimisation (2026-04-29): downgraded Sonnet → Haiku 4.5 per
      // user direction. ICT runs ~70× per kill-zone-active day, so it's
      // the single biggest Claude-API line-item. Trade-off: Haiku is a
      // smaller model, so quantitative reasoning (R:R math, order-block
      // structure detection) may regress versus Sonnet. If decision
      // quality demonstrably drops (more bad-trigger trades / fewer
      // legitimate setups taken) revert the `model` field to
      // 'claude-sonnet-4-6'. Trade-Analyst stays on Sonnet — ALL trade
      // approvals still run through analyst review, so Haiku ICT errors
      // are caught at the analyst gate before any Capital order.
      model: 'claude-haiku-4-5-20251001',
      // max_tokens 16000 → 12000 (2026-04-21): caps the output each
      // iteration can generate. Typical response is 2-5k, so 12k is
      // still generous headroom. Rare verbose responses now truncate
      // earlier — saves worst-case output cost without affecting the
      // 95th percentile.
      max_tokens: 12000,
      // 2026-04-29: removed `thinking: { type: 'adaptive' }` and
      // `output_config: { effort }` when the model was downgraded to
      // Haiku 4.5. Both params are Sonnet/Opus-only — Haiku 4.5 returns
      // HTTP 400 "adaptive thinking is not supported on this model".
      // Caught live in production at the first cycle after downgrade
      // (08:30 UTC). If we re-upgrade to Sonnet, restore both lines.
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      tools: MCP_TOOLS,
      messages,
    }), iterationTimeoutMs, `ICT iter ${i + 1}/${maxIterations}`);

    // Collect text and thinking output
    for (const block of response.content) {
      if (block.type === 'thinking') {
        console.log('[ICT Agent Thinking]', block.thinking.substring(0, 200));
      } else if (block.type === 'text' && block.text.trim()) {
        console.log('[ICT Agent]', block.text);
      }
    }

    // If stop_reason is end_turn, the agent is done
    if (response.stop_reason === 'end_turn') {
      console.log('ICT Trading Agent decision cycle complete.');
      cleanlyCompleted = true;
      break;
    }

    // If there are tool calls, execute them
    if (response.stop_reason === 'tool_use') {
      lastStopReason = response.stop_reason;

      // 2026-05-09: parallel tool execution with stateful-tool race guard.
      // Pre-fix (Spec 1, morning of 2026-05-09): for-await ran tools
      // serially even when the model emitted parallel tool_use blocks; we
      // moved to Promise.all to recover wall-time on multi-read batches.
      // Codex post-merge audit (afternoon) flagged that Promise.all over
      // ALL emitted tools is unsafe when stateful ones (place_split_trade,
      // update_sl, close_position, request_analyst_review) are present —
      // concurrent broker writes / DB writes / sub-LLM spawns could race.
      // Fix: split the batch by READ_ONLY_TOOLS membership. Read-only
      // blocks run concurrently via Promise.all; stateful blocks run
      // sequentially in the model's emission order. Results are concatenated
      // in original tool_use order (Anthropic matches by tool_use_id, but
      // preserved order helps log readability).
      const toolUseBlocks = response.content.filter(
        (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use',
      );

      const executeOne = async (
        block: Anthropic.Messages.ToolUseBlock,
      ): Promise<Anthropic.Messages.ToolResultBlockParam> => {
        console.log(`[ICT Agent] Calling tool: ${block.name}`);
        distinctTools.add(block.name);
        totalToolCalls += 1;
        let result: string;
        try {
          // _executeToolImpl is the test-seam-aware dispatcher; in
          // production it's the real executeTool. See the seam decl
          // below executeTool's body.
          result = await _executeToolImpl(
            block.name,
            block.input as Record<string, unknown>,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`[ICT Agent] Tool ${block.name} failed: ${message}`);
          result = JSON.stringify({ error: message, tool: block.name });
        }
        return {
          type: 'tool_result' as const,
          tool_use_id: block.id,
          content: result,
        };
      };

      const readOnlyBlocks = toolUseBlocks.filter((b) => READ_ONLY_TOOLS.has(b.name));
      const statefulBlocks = toolUseBlocks.filter((b) => !READ_ONLY_TOOLS.has(b.name));

      // Observability: log when a stateful tool appears alongside others
      // in a single turn. This was previously invisible — the model rarely
      // emits stateful + anything in one turn, but the race window matters
      // when it does. If we see this fire often, raise it as a prompt fix.
      if (statefulBlocks.length > 0 && toolUseBlocks.length > 1) {
        console.log(
          `[ICT Agent] Mixed batch detected: ${statefulBlocks.length} stateful + ${readOnlyBlocks.length} read-only tools in one turn. ` +
            `Stateful tools: ${statefulBlocks.map((b) => b.name).join(', ')}. ` +
            `Stateful will run sequentially after the read-only batch.`,
        );
      }

      // Run read-only batch concurrently (preserves the morning's parallel-
      // exec optimization for the 4-5-read case which is the common path).
      const readOnlyResults = await Promise.all(readOnlyBlocks.map(executeOne));
      // Run stateful sequentially, in emission order.
      const statefulResults: Anthropic.Messages.ToolResultBlockParam[] = [];
      for (const block of statefulBlocks) {
        statefulResults.push(await executeOne(block));
      }

      // Reconstruct results in the model's original tool_use_id order.
      const resultByToolUseId = new Map<string, Anthropic.Messages.ToolResultBlockParam>();
      for (const r of readOnlyResults) resultByToolUseId.set(r.tool_use_id, r);
      for (const r of statefulResults) resultByToolUseId.set(r.tool_use_id, r);
      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = toolUseBlocks.map(
        (b) => resultByToolUseId.get(b.id)!,
      );

      lastIterToolNames = toolUseBlocks.map((b) => b.name);

      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });
    }

    // 2026-05-09: explicit handler for stop_reasons other than end_turn/
    // tool_use (e.g. 'max_tokens', 'stop_sequence', 'pause_turn'). Pre-fix
    // the loop fell through with neither branch matching, silently spinning
    // until the cap fired. Now: log loudly, set lastStopReason for the
    // timeout log, and break out so we don't waste iterations.
    // NB: only `!== 'tool_use'` is needed because the `end_turn` branch
    // above always `break`s, so TS has already narrowed it away here —
    // adding `!== 'end_turn'` would be flagged TS2367 as unintentional.
    if (response.stop_reason !== 'tool_use') {
      console.warn(
        `[ICT Agent] Unexpected stop_reason '${response.stop_reason}' on iter ${i + 1}. ` +
          `Breaking loop to avoid wasted iterations.`,
      );
      lastStopReason = response.stop_reason;
      // Don't set cleanlyCompleted = true — this is an abnormal exit; the
      // timeout-log path will still fire to give us observability.
      break;
    }
  }

  // Codex P2 #18 (2026-04-28): if the loop exhausted maxIterations
  // without an end_turn, the agent ran out of room mid-reasoning. Loud
  // alert via console.error so ops can review pm2-err.log; the cycle
  // already completed (placed orders persist), but it's worth knowing
  // the agent was still mid-thought when the hammer dropped.
  // No Telegram alert here to avoid noise; pm2 log review covers it.
  // Codex final-review P2 (2026-04-29): only log the warning when the
  // loop exhausted iterations — pre-fix it fired on every clean
  // end_turn break too, polluting pm2-err.log.
  if (!cleanlyCompleted) {
    const lastTools = lastIterToolNames.join(',') || '(none)';
    const stopReasonNote =
      lastStopReason && lastStopReason !== 'tool_use'
        ? ` Last stop_reason: ${lastStopReason}.`
        : '';
    console.error(
      `[ICT Agent] CYCLE TIMED OUT after ${maxIterations} iterations without end_turn.` +
        stopReasonNote +
        ` Last iter tools: ${lastTools}. Total tool calls: ${totalToolCalls} ` +
        `across ${distinctTools.size} distinct tools. ` +
        `Decision may be incomplete. If this happens repeatedly, raise the cap or audit ` +
        `which tool the agent is looping on.`,
    );

    // Fire Telegram alert ONCE per UTC day to surface sustained timeouts
    // without spamming on a single bad-day run.
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
    if (lastIctTimeoutAlertDate !== today) {
      lastIctTimeoutAlertDate = today;
      const lastToolsForAlert = lastIterToolNames.join(',') || '(none)';
      alertSystemWarning(
        `⚠️ ICT cycle hit iteration cap (${maxIterations}). ` +
          `Last iter tools: ${lastToolsForAlert}. ${totalToolCalls} total tool calls. ` +
          `Decision may be incomplete. Check pm2-err.log for full context.`,
      ).catch(() => {
        /* alert failure non-blocking */
      });
    }
  }
}

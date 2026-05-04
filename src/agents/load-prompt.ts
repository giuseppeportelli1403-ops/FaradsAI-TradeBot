import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function loadPrompt(filename: string): string {
  const path = join(__dirname, '..', '..', 'prompts', filename);
  return readFileSync(path, 'utf-8');
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

/**
 * W1 (2026-04-28): build a small system-time block to append to every system
 * prompt. AutoHedge `workers.py:19-24` pattern — every agent gets the current
 * UTC time + day of week injected. Without this, the LLM uses training-data
 * baseline ("it's probably Monday") and hallucinates session state. Pure
 * function — caller supplies `now` so tests are deterministic.
 */
export function buildSystemTimeBlock(now: Date = new Date()): string {
  const utcIso = now.toISOString();
  const dayOfWeek = DAY_NAMES[now.getUTCDay()];
  return (
    `\n\n---\n\n` +
    `## CURRENT TIME\n\n` +
    `UTC: ${utcIso} (${dayOfWeek}). Decide based on this exact time — do not rely on training-data baseline assumptions about what session it is.\n` +
    `Kill zones (UTC): London Open 07:00–10:00, NY Open 13:00–16:00, London Close 16:00–17:00.\n`
  );
}

/**
 * Loads a prompt and appends the current-time block. Use for non-trade-gating
 * agents (Researcher, Reflection, EOD Journal). For trade-gating agents
 * (ICT, Analyst), use loadPromptWithDemoContext which composes time + demo
 * gates on top.
 */
export function loadPromptWithSystemTime(filename: string, now: Date = new Date()): string {
  return loadPrompt(filename) + buildSystemTimeBlock(now);
}

export function loadStrategy(filename: string): string {
  const path = join(__dirname, '..', '..', 'memory', filename);
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return `Strategy file ${filename} not found.`;
  }
}

// Tight-spread instrument tickers — match src/scanner/index.ts INSTRUMENT_UNIVERSE.
// Kept in sync with scanner by convention; drift is caught by the demo-context
// block which references them by name, so the agent will flag any mismatch
// against the ranked list it sees at runtime.
//
// Tight-spread instrument list per memory/strategy.md Section 4. Used to
// advertise to the LLM which symbols qualify for the Tier-3 R:R 1.5:1
// carve-out (default is 2:1).
//
// History:
//   - 2026-04-22: indices (US30/US100/US500/DE40) removed — each routed to
//     an unrelated ETF on Twelve Data Grow tier (now in TWELVE_DATA_UNAVAILABLE).
//   - 2026-05-04 (Phase C, audit Finding #10): equity tickers AAPL/MSFT/NVDA/
//     AMZN/GOOGL/META removed — they were never in INSTRUMENT_UNIVERSE
//     (src/scanner/index.ts) and Haiku reading them as "tight-spread"
//     candidates was a phantom signal. Universe is FX majors + GOLD only
//     for tight-spread. SILVER and OIL_CRUDE are medium-spread and not on
//     this list.
const TIGHT_SPREAD_TICKERS = [
  'EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD',
  'GOLD',
].join(', ');

const DEMO_RELAXED_GATES_CONTEXT = `

---

## DEMO-PHASE RELAXED GATES (DEMO_RELAXED_GATES=true is active)

The rule overrides below apply ONLY during the 2-week demo evaluation window
(2026-04-20 → 2026-05-04). They TEMPORARILY supersede the stricter defaults
documented above. Every other rule remains in force.

1. **R:R minimum — tight-spread symbols.** For trades on ${TIGHT_SPREAD_TICKERS},
   an R:R to TP2 of **>= 1.5:1** is acceptable (previously 2:1 for ICT).
   All other symbols keep their original R:R minima.

2. **Tier 3 bracket — spread-aware floor.** The scanner tags an
   instrument \`tier: 3\` when its composite score is at-or-above its
   spread-class floor and below 60:
     - **Tight-spread (${TIGHT_SPREAD_TICKERS}):** floor 40 → tier 3 = 40-59.
     - **Medium-spread (OIL_CRUDE, SILVER):** floor 45 → tier 3 = 45-59.
   You MAY take Tier 3 trades at **0.5% risk** (half of Tier 2's 1%). The
   Analyst Agent's 6-check is the load-bearing quality filter for
   borderline scores. Trust the scanner — anything it returns as tier 3
   is already past the spread-aware floor; you do not need to re-check
   the score against 40 vs 45 yourself. Tier 3 floor history: 50 → 45
   (2026-04-22) → 40 flat (Phase E 2026-05-04) → spread-aware (carve-out
   2026-05-04 after backtest showed OIL_CRUDE 40-44 dragged the run).

3. **(Retired 2026-04-29)** Earlier drafts of this block described an
   off-hours "kill-zone score bonus" that let strong setups clear Tier 2
   outside official kill zones. That mechanism was retired in the
   2026-04-29 score-rubric rebalance — kill zone is now a HARD GATE. The
   scanner returns no candidates outside London Open / NY Open / London
   Close UTC windows regardless of any score override. This bullet is kept
   as a tombstone so future readers don't reintroduce the off-hours path.

**NOT relaxed under any circumstance:**
- Daily 6% loss kill switch — still fires, still halts new trades.
- Weekly 10% loss kill switch — unchanged. Code-enforced 2026-05-04 (Phase A3).
- Split-position method — every trade is THREE legs (Position A + B + C)
  with TP1 triggering Positions B AND C SL-to-break-even moves.
- Max concurrent positions — unchanged.
- Live-trading opt-in gate — unchanged.

These overrides exist to gather more trade samples for evaluation. Quality
still matters. If a Tier 3 setup looks weak, SKIP IT.
`;

/**
 * Loads a prompt file and appends the demo-phase relaxed-gates context
 * when DEMO_RELAXED_GATES=true. Returns the unmodified prompt otherwise.
 *
 * Use this for agent system prompts that gate trade execution — currently
 * ict-agent.md and analyst-agent.md. Do NOT use for prompt files that have
 * nothing to do with trade gating (reflection, review, researcher) — for
 * those, loadPrompt directly is correct. (swing-agent.md was removed
 * 2026-04-23 with the Swing subsystem.)
 */
export function loadPromptWithDemoContext(filename: string, now: Date = new Date()): string {
  const baseWithTime = loadPromptWithSystemTime(filename, now);
  if (process.env.DEMO_RELAXED_GATES !== 'true') {
    return baseWithTime;
  }
  return baseWithTime + DEMO_RELAXED_GATES_CONTEXT;
}

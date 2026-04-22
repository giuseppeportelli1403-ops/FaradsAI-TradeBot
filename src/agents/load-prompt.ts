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

// Tight-spread instrument tickers — match src/scanner/index.ts INSTRUMENT_UNIVERSE.
// Kept in sync with scanner by convention; drift is caught by the demo-context
// block which references them by name, so the agent will flag any mismatch
// against the ranked list it sees at runtime.
//
// Indices (US30 / US100 / US500 / DE40) removed 2026-04-22 — each routes to
// an unrelated ETF on Twelve Data Grow tier and is now in
// TWELVE_DATA_UNAVAILABLE. Letting the LLM believe those are valid R:R 1.5:1
// candidates would be a back-door into place_order calls the scanner never
// sanity-checked. Re-add when a real index feed is wired.
const TIGHT_SPREAD_TICKERS = [
  'EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD',
  'GOLD',
  'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META',
].join(', ');

const DEMO_RELAXED_GATES_CONTEXT = `

---

## DEMO-PHASE RELAXED GATES (DEMO_RELAXED_GATES=true is active)

The rule overrides below apply ONLY during the 2-week demo evaluation window
(2026-04-20 → 2026-05-04). They TEMPORARILY supersede the stricter defaults
documented above. Every other rule remains in force.

1. **R:R minimum — tight-spread symbols.** For trades on ${TIGHT_SPREAD_TICKERS},
   an R:R to TP2 of **>= 1.5:1** is acceptable (previously 2:1 for ICT / 3:1
   for Swing). All other symbols keep their original R:R minima.

2. **Tier 3 bracket (composite score 45-59).** The scanner now returns
   instruments with score 45-59 tagged \`tier: 3\`. You MAY take Tier 3 trades
   at **0.5% risk** (half of Tier 2's 1%). Tier 3 trades are allowed only if
   bias is clear (clarity >= 10), news score is non-negative, and the
   Analyst Agent approves.

3. **Kill-zone score bonus.** Outside official kill zones (London Open /
   NY Open / London Close), the composite score bonus is +10 (was 0). This
   lets strong setups clear Tier 2 off-hours when every other factor is
   favourable. Kill-zone timing discipline still matters for entry *quality*,
   but it no longer hard-gates entry viability.

**NOT relaxed under any circumstance:**
- Daily 4% loss kill switch — still fires, still halts new trades.
- Weekly 8% loss kill switch — unchanged.
- Coordination lock — ICT and Swing may still NOT open simultaneous positions
  on the same instrument.
- Split-position method — every trade is still two legs (Position A + B),
  with TP1 triggering Position B's SL-to-break-even move.
- Max concurrent positions — unchanged.
- Live-trading opt-in gate — unchanged.

These overrides exist to gather more trade samples for evaluation. Quality
still matters. If a Tier 3 setup looks weak, SKIP IT.
`;

/**
 * Loads a prompt file and appends the demo-phase relaxed-gates context
 * when DEMO_RELAXED_GATES=true. Returns the unmodified prompt otherwise.
 *
 * Use this for agent system prompts (ict-agent.md, swing-agent.md,
 * analyst-agent.md). Do NOT use for prompt files that have nothing to do
 * with trade gating (reflection, review, researcher) — for those, loadPrompt
 * directly is correct.
 */
export function loadPromptWithDemoContext(filename: string): string {
  const base = loadPrompt(filename);
  if (process.env.DEMO_RELAXED_GATES !== 'true') {
    return base;
  }
  return base + DEMO_RELAXED_GATES_CONTEXT;
}

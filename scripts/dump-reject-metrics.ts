// Farad Reject Metrics — daily log scraper
//
// Post-processes /home/bot/trading-bot/data/pm2-out.log into a markdown
// dump at data/metrics/reject-YYYY-MM-DD.md for human review. Designed for
// observability without behavioral change: the script reads the log and
// writes markdown; it never touches the live trading path, never calls
// the broker, never writes to the DB.
//
// Spec: docs/superpowers/specs/2026-04-23-reject-metrics-design.md
// Plan: docs/superpowers/plans/2026-04-23-reject-metrics.md

// ==================== TYPES ====================

export type SkipCategory =
  | 'analyst_reject'       // priority 1
  | 'news_opposing'        // priority 2
  | 'no_trigger'           // priority 3
  | 'rr_fail'              // priority 4
  | 'bias_unclear'         // priority 5
  | 'score_too_low'        // priority 6
  | 'outside_kill_zone';   // priority 7

export type ExecuteCategory =
  | 'place_order_executed'
  | 'log_trade_attempted'
  | 'log_trade_failed'
  | 'ict_cycle_complete';

export type Category = SkipCategory | ExecuteCategory;

// ==================== CLASSIFICATION ====================

// Priority-ordered list. First match wins when a line matches multiple
// skip patterns. Execute categories come after — they're non-exclusive
// with skip categories (a line can only match one anyway).
const PATTERNS: Array<{ cat: Category; re: RegExp }> = [
  // Skip categories, priority 1 (highest) → 7 (lowest)
  { cat: 'analyst_reject',    re: /Analyst Decision: REJECT|Analyst.*REJECTED|REJECTED.*Score \d+\/100/ },
  { cat: 'news_opposing',     re: /opposing news|NEWS RISK OVERRIDE|news-opposing|disqualifier.*news|news-blind|PMI risk is a disqualifier/ },
  { cat: 'no_trigger',        re: /NO ENTRY TRIGGER|No trigger|NO VALID ENTRY LOCATION|not printed the confirmation trigger/i },
  { cat: 'rr_fail',           re: /R:R.*below.*minimum|R:R.*0\.\d+:1.*❌|R:R to TP2.*non-negotiable|fails.*Tier \d gate/ },
  { cat: 'bias_unclear',      re: /1H Bias NEUTRAL|1H Bias CONFLICTED|bias unclear|bias contradiction/ },
  { cat: 'score_too_low',     re: /Below.*Tier 3 threshold|Below.*Tier 3|Score \d+ \(Below/ },
  { cat: 'outside_kill_zone', re: /skipping ICT cycle.*outside kill zone|outside kill zone: outside/ },

  // Execute categories
  { cat: 'place_order_executed', re: /\[ICT Agent\] Calling tool: place_order/ },
  { cat: 'log_trade_failed',     re: /\[ICT Agent\] Tool log_trade failed/ },
  { cat: 'log_trade_attempted',  re: /\[ICT Agent\] Calling tool: log_trade/ },
  { cat: 'ict_cycle_complete',   re: /ICT Trading Agent[^.]*complete|\[Scheduler\][^I]*ICT Trading Agent complete/ },
];

/**
 * Classify a single log line. Returns the first matching Category in
 * priority order (skip cats highest priority first), or null if nothing
 * matches.
 */
export function classifyLine(line: string): Category | null {
  for (const { cat, re } of PATTERNS) {
    if (re.test(line)) return cat;
  }
  return null;
}

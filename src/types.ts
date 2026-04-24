// Shared TypeScript types for the BetterOpsAI Trading Bot

// ==================== CANDLE / PRICE DATA ====================

export interface Candle {
  datetime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type Timeframe = '15m' | '1h' | '4h' | '1d' | '1w';

// ==================== CAPITAL.COM ====================

export type Resolution =
  | 'MINUTE'
  | 'MINUTE_5'
  | 'MINUTE_15'
  | 'MINUTE_30'
  | 'HOUR'
  | 'HOUR_4'
  | 'DAY'
  | 'WEEK';

export interface CapitalAccount {
  accountId: string;
  accountName: string;
  accountType: string;
  preferred: boolean;
  balance: {
    balance: number;
    deposit: number;
    profitLoss: number;
    available: number;
  };
  currency: string;
}

export interface CapitalPosition {
  position: {
    dealId: string;
    dealReference: string;
    direction: 'BUY' | 'SELL';
    size: number;
    openLevel: number;
    stopLevel: number | null;
    profitLevel: number | null;
    trailingStop: boolean;
    trailingStopDistance: number | null;
    guaranteedStop: boolean;
    createdDateUTC: string;
    controlledRisk: boolean;
  };
  market: {
    instrumentName: string;
    epic: string;
    bid: number;
    offer: number;
    marketStatus: string;
  };
}

export interface OpenPositionParams {
  direction: 'BUY' | 'SELL';
  epic: string;
  size: number;
  stopLevel?: number;
  profitLevel?: number;
  stopDistance?: number;
  profitDistance?: number;
  trailingStop?: boolean;
  guaranteedStop?: boolean;
}

export interface UpdatePositionParams {
  stopLevel?: number;
  profitLevel?: number;
  stopDistance?: number;
  profitDistance?: number;
  trailingStop?: boolean;
}

export interface DealConfirmation {
  dealId: string;
  dealReference: string;
  dealStatus: 'ACCEPTED' | 'REJECTED';
  reason: string;
  status: 'OPEN' | 'AMENDED' | 'DELETED' | 'FULLY_CLOSED' | 'PARTIALLY_CLOSED';
  direction: 'BUY' | 'SELL';
  epic: string;
  size: number;
  level: number;
  stopLevel: number | null;
  profitLevel: number | null;
  affectedDeals: Array<{ dealId: string; status: string }>;
}

export interface CapitalCandle {
  snapshotTime: string;
  snapshotTimeUTC: string;
  openPrice: { bid: number; ask: number };
  highPrice: { bid: number; ask: number };
  lowPrice: { bid: number; ask: number };
  closePrice: { bid: number; ask: number };
  lastTradedVolume: number;
}

export interface Market {
  epic: string;
  instrumentName: string;
  instrumentType: string;
  marketStatus: string;
  bid: number;
  offer: number;
}

export interface MarketDetail {
  instrument: {
    epic: string;
    name: string;
    type: string;
    lotSize: number;
    currency: string;
  };
  dealingRules: {
    minDealSize: { value: number; unit: string };
    maxDealSize?: { value: number; unit: string };
    minStepDistance?: { value: number; unit: string };
    minControlledRiskStopDistance?: { value: number; unit: string };
    minNormalStopOrLimitDistance?: { value: number; unit: string };
  };
  snapshot: {
    marketStatus: string;
    bid: number;
    offer: number;
  };
}

export interface WorkingOrder {
  workingOrderData: {
    dealId: string;
    direction: 'BUY' | 'SELL';
    epic: string;
    orderType: 'LIMIT' | 'STOP';
    orderLevel: number;
    size: number;
    timeInForce: 'GOOD_TILL_CANCELLED' | 'GOOD_TILL_DATE';
  };
}

export interface CreateWorkingOrderParams {
  direction: 'BUY' | 'SELL';
  epic: string;
  size: number;
  level: number;
  type: 'LIMIT' | 'STOP';
  stopLevel?: number;
  profitLevel?: number;
  // Added 2026-04-23 (P1 limit orders) — optional fields that let
  // callers express auto-expiry and audit labels. Capital's
  // /api/v1/workingorders endpoint accepts these per their spec;
  // createWorkingOrder forwards the object verbatim as the POST body.
  timeInForce?: 'GOOD_TILL_CANCELLED' | 'GOOD_TILL_DATE';
  goodTillDate?: string;         // ISO-8601 seconds, UTC (e.g. "2026-04-24T18:45:00")
  guaranteedStop?: boolean;
  label?: string;
}

export interface UpdateWorkingOrderParams {
  level?: number;
  stopLevel?: number;
  profitLevel?: number;
}

export interface Activity {
  date: string;
  epic: string;
  dealId: string;
  activity: string;
  status: string;
  size: number;
  level: number;
}

export interface Transaction {
  date: string;
  reference: string;
  transactionType: string;
  size: number;
  currency: string;
}

export interface Sentiment {
  marketId: string;
  longPositionPercentage: number;
  shortPositionPercentage: number;
}

// ==================== TRADE RECORDS ====================

export type TradeStatus =
  | 'open'
  | 'tp1_hit'
  | 'tp2_hit'
  | 'complete'
  | 'sl_hit'
  // Added 2026-04-23: a trade that was closed by the agent BEFORE any TP/SL
  // trigger. Covers fill-slippage-invalidates-R:R, hard-manual-abort, schema-
  // sanitisation-of-unknown-status, etc. The specific reason goes into the
  // separate `closure_reason` column so the enum stays small and bounded.
  | 'closed_early';
/**
 * Strategy identifier for a trade record. 'SWING' is retained for backward
 * compatibility with historical trades in the DB and the Weekly Review Agent's
 * reporting path — the Swing Agent subsystem was removed on 2026-04-23 (cost/
 * yield not justified), so no NEW rows will be inserted with this tag, but
 * queries and reports over historical data continue to work unchanged. The
 * trades.strategy_tag CHECK constraint in src/database/index.ts still accepts
 * 'SWING' for the same reason.
 */
export type StrategyTag = 'ICT_INTRADAY' | 'SWING';
export type Direction = 'long' | 'short';

export interface TradeRecord {
  id: string;
  strategy_tag: StrategyTag;
  instrument: string;
  instrument_category: string;
  direction: Direction;
  setup_type: string;
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  tp3: number | null;                // NEW 2026-04-21: Leg C target; null on legacy 2-leg rows
  position_a_id: string;
  position_b_id: string;
  position_c_id: string | null;      // NEW: nullable for legacy 2-leg rows
  size_a: number;
  size_b: number;
  size_c: number | null;             // NEW: nullable for legacy 2-leg rows
  status: TradeStatus;
  pnl_a: number | null;
  pnl_b: number | null;
  pnl_c: number | null;              // NEW: Leg C P&L (only populated after C closes)
  pnl_total: number | null;
  composite_score: number;
  kill_zone: string;
  news_category: string;
  analyst_decision: string;
  opened_at: string;
  closed_at: string | null;
  reasoning: string;
  // Added 2026-04-23: free-text audit of why the trade ended when `status` is
  // 'closed_early'. For normal TP/SL exits, this stays null.
  closure_reason: string | null;
}

// ==================== LESSONS ====================

export interface Lesson {
  lesson_id: string;
  timestamp: string;
  strategy_tag: StrategyTag;
  instrument: string;
  instrument_category: string;
  direction: Direction;
  setup_type: string;
  kill_zone: string;
  news_category: string;
  news_description: string;
  composite_score: number;
  position_a_outcome: string;
  position_b_outcome: string;
  position_c_outcome: string | null;   // NEW 2026-04-21: null on legacy 2-leg lessons
  pnl_a_r: number;
  pnl_b_r: number;
  pnl_c_r: number | null;              // NEW: Leg C P&L in R units
  pnl_total_r: number;
  was_bias_correct: boolean;
  was_trigger_valid: boolean;
  was_news_correctly_weighted: boolean;
  was_split_execution_clean: boolean;
  analyst_decision: string;
  hold_duration: string;
  score_accuracy_notes: string;
  lesson: string;
  rule_suggestion: string;
}

// ==================== NEWS ====================

export interface NewsItem {
  title: string;
  source: string;
  published_at: string;
  sentiment_score: number;   // -1 to 1
  relevance_score: number;   // 0 to 1
  category: 'A' | 'B' | 'C';  // A=major, B=moderate, C=noise
  summary: string;
  // Added 2026-04-23 (news-resilience): age of this item at fetch time, in
  // minutes. 0 on fresh provider hits. Non-zero when served from the stale-cache
  // fallback that bridges news-provider quota exhaustion. The scoring layer in
  // src/news/index.ts dampens bearish aggregates when stale_minutes > 60 so
  // the bot doesn't trade INTO unseen bearish news during quota-degraded
  // windows.
  stale_minutes?: number;
}

// ==================== MARKET DATA ====================

export interface EconomicEvent {
  date: string;
  time: string;
  event: string;
  country: string;
  impact: 'high' | 'medium' | 'low';
  actual: string | null;
  estimate: string | null;
  previous: string | null;
  affected_instruments: string[];
}

export interface RegimeData {
  // VIX/DXY removed from the live feed path 2026-04-24 — Twelve Data
  // Grow tier doesn't serve them and the free-tier proxies were
  // misleading. Kept optional so historical ResearchBriefs persisted
  // to SQLite before the cutover still parse.
  vix?: number;
  vix_30d_avg?: number;
  vix_regime?: 'low' | 'normal' | 'elevated' | 'crisis';
  dxy?: number;
  dxy_direction?: 'rising' | 'falling' | 'flat';
  yields: {
    us2y: number;
    us10y: number;
    us30y: number;
  };
}

export interface SectorStrength {
  sector: string;
  performance_1d: number;
  performance_1w: number;
  performance_1m: number;
}

export interface CorrelationPair {
  instrument_a: string;
  instrument_b: string;
  correlation_30d: number;
  correlation_90d: number;
}

export interface ResearchBrief {
  brief_id: string;
  date: string;
  regime: RegimeData;
  themes: string[];
  events_calendar: EconomicEvent[];
  ict_shortlist: string[];
  /**
   * @deprecated Swing Agent removed 2026-04-23. New briefs no longer populate
   * this field. Kept optional so historical research_briefs JSON rows in the
   * DB continue to parse and the Weekly Review Agent can still surface past
   * swing_shortlist content when summarising the historical record.
   */
  swing_shortlist?: string[];
  warnings: string[];
}

// ==================== ANALYST ====================

export interface AnalystDecision {
  decision: 'APPROVE' | 'REJECT' | 'MODIFY';
  reason: string;
  modifications: Record<string, unknown>;
  confidence: number;
}

// ==================== RANKED INSTRUMENTS ====================

export interface RankedInstrument {
  ticker: string;
  name: string;
  composite_score: number;
  bias: 'bullish' | 'bearish' | 'neutral';
  tier: 1 | 2 | 3 | null;  // null if score < 65 (< 50 when DEMO_RELAXED_GATES=true). Tier 3 = 50-64 (demo only).
}

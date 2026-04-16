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

// ==================== TRADING 212 ====================

export interface T212Position {
  ticker: string;
  quantity: number;
  averagePrice: number;
  currentPrice: number;
  ppl: number;          // profit/loss
  fxPpl: number;
  initialFillDate: string;
}

export interface T212Balance {
  free: number;
  total: number;
  ppl: number;
  result: number;
  invested: number;
  pieCash: number;
  blocked: number;
}

export interface T212Instrument {
  ticker: string;
  type: string;
  currencyCode: string;
  name: string;
}

// ==================== TRADE RECORDS ====================

export type TradeStatus = 'open' | 'tp1_hit' | 'complete' | 'sl_hit';
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
  position_a_id: string;
  position_b_id: string;
  size_a: number;
  size_b: number;
  status: TradeStatus;
  pnl_a: number | null;
  pnl_b: number | null;
  pnl_total: number | null;
  composite_score: number;
  kill_zone: string;
  news_category: string;
  analyst_decision: string;
  opened_at: string;
  closed_at: string | null;
  reasoning: string;
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
  composite_score: number;
  position_a_outcome: string;
  position_b_outcome: string;
  pnl_a_r: number;
  pnl_b_r: number;
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
  vix: number;
  vix_30d_avg: number;
  vix_regime: 'low' | 'normal' | 'elevated' | 'crisis';
  dxy: number;
  dxy_direction: 'rising' | 'falling' | 'flat';
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
  swing_shortlist: string[];
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
  tier: 1 | 2 | null;  // null if score < 65
}

/**
 * TypeScript mirror of the state schema written by
 * strategies/intraday_equity/nifty50_vwap_rs.py (save_state).
 *
 * Keep in sync with that method. The Python side is the source of truth; these
 * types exist so the terminal fails at compile time rather than rendering
 * `undefined` when a field is renamed.
 */

export const STRATEGY_KEY = 'nifty50_vwap_rs';

/** The eight signal conditions, in display order. */
export const CONDITION_NAMES = [
  'above_vwap',
  'ema_stacked',
  'st_bull_5m',
  'adx_ok',
  'rs_day_ok',
  'rs_lb_ok',
  'not_stretched',
  'vol_ok',
] as const;

export type ConditionName = (typeof CONDITION_NAMES)[number];

/** Conditions that must ALL pass for a name to be tradeable. The rest only score. */
export const HARD_GATES: ConditionName[] = [
  'above_vwap',
  'st_bull_5m',
  'adx_ok',
  'rs_day_ok',
  'not_stretched',
];

/** Two-letter chips — the blotter has 8 of these per row and no space for words. */
export const CONDITION_LABELS: Record<ConditionName, string> = {
  above_vwap: 'VW',
  ema_stacked: 'EM',
  st_bull_5m: 'ST',
  adx_ok: 'AD',
  rs_day_ok: 'RD',
  rs_lb_ok: 'RL',
  not_stretched: 'NS',
  vol_ok: 'VO',
};

export const CONDITION_TOOLTIPS: Record<ConditionName, string> = {
  above_vwap: 'Price has a real edge over session VWAP (hard gate)',
  ema_stacked: 'EMA9 above EMA20 (soft — scores only)',
  st_bull_5m: '5-minute Supertrend is bullish (hard gate)',
  adx_ok: '5-minute ADX above the trend threshold (hard gate)',
  rs_day_ok: 'Outperforming NIFTY since the open (hard gate)',
  rs_lb_ok: 'Outperforming NIFTY over the lookback (soft — scores only)',
  not_stretched: 'Not over-extended from VWAP in ATR terms (hard gate)',
  vol_ok: 'Volume above its 20-bar average (soft — scores only)',
};

export type StrategyStatus =
  | 'INITIALIZING'
  | 'SCANNING'
  | 'RUNNING'
  | 'SQUARING_OFF'
  | 'STOPPED';

export interface TerminalCandidate {
  symbol: string;
  side: 'LONG' | 'SHORT';
  score: number;
  price: number;
  ltp: number;
  vwap: number;
  atr: number;
  sector: string;
  gated: boolean;
  conditions: Record<ConditionName, boolean>;
  blocked_by: ConditionName[];
  ts: string | null;
}

export interface TerminalPosition {
  symbol: string;
  security_id: string;
  side: 'LONG' | 'SHORT';
  qty: number;
  entry_price: number;
  entry_ts: string | null;
  ltp: number;
  stop: number;
  target: number;
  high_water: number;
  r_multiple: number;
  pnl: number;
  entry_score: number;
  sector: string;
}

export interface TerminalEvent {
  ts: string;
  level: 'INFO' | 'WARN' | 'ERROR';
  type: string;
  symbol: string;
  msg: string;
}

export interface TerminalOrder {
  ts: string;
  kind: 'ENTRY' | 'EXIT';
  symbol: string;
  side: string;
  qty: number;
  price: number;
  reason: string;
  dry_run: boolean;
  entry_price: number;
  stop: number;
  target: number;
  score: number;
}

export interface TerminalState {
  strategy: string;
  status: StrategyStatus;
  dry_run: boolean;
  mode: string;
  /** False until the backtest clears its expectancy gate. Surfaced in the header. */
  backtest_validated: boolean;
  as_of: string;
  pid?: number;
  last_update?: string;
  session: { entry_start: string; entry_cutoff: string; square_off: string };
  benchmark: { symbol: string; ltp: number; day_pct: number };
  risk: {
    max_positions: number;
    open: number;
    max_per_sector: number;
    risk_per_trade: number;
    max_daily_loss: number;
    daily_loss_used: number;
    target_profit: number;
    max_deployed: number;
    deployed: number;
    trades_today: number;
    max_trades: number;
  };
  /** `priced` is false when an open position has no LTP — the daily risk check is
   *  skipped in that state, so the UI must say so rather than imply a live mark. */
  pnl: { realized: number; unrealized: number; day: number; priced: boolean };
  positions: TerminalPosition[];
  candidates: TerminalCandidate[];
  watchlist: string[];
  cooldowns: Record<string, string>;
  blacklist: Record<string, string>;
  events: TerminalEvent[];
  equity_curve: { ts: string; day_pnl: number }[];
  halt_reason: string | null;
  last_poll: string | null;
  poll_lag_s: number | null;
  ws_healthy: boolean;
}

export interface TerminalPayload {
  success: boolean;
  running: boolean;
  /** null when the strategy has never run (no state file on disk). */
  state: TerminalState | null;
  orders: TerminalOrder[];
  /** Currency of the intraday bar store, for the DATA: chip. */
  store: { last: string | null; sessions: number; symbols: number } | null;
  error?: string;
}

export interface CandleBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface CandlePayload {
  success: boolean;
  symbol: string;
  interval: '1' | '5';
  updated_at: string | null;
  bars: CandleBar[];
  error?: string;
}

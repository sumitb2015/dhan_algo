// Shared response shapes for the /api/options/live-charts route (straddle / rolling straddle /
// strangle / custom strategy premium charts), mirroring scripts/tools/options_chart_fetch.py's
// JSON output field-for-field.

export interface ChartCandle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ChartSeriesPoint {
  time: string;
  value: number;
}

export type ChartIndicatorType = 'ema' | 'sma' | 'vwap' | 'bbands' | 'supertrend';

export interface ChartIndicatorRequest {
  type: ChartIndicatorType;
  params: Record<string, number>;
}

export interface ChartIndicatorSeries {
  id: string;
  group: string;
  type: ChartIndicatorType;
  label: string;
  series: ChartSeriesPoint[];
  last_value: number | null;
}

export interface StraddleExpiriesResponse {
  expiries: string[];
}

export interface StraddleStrike {
  strike: number;
  is_atm: boolean;
}

export interface StraddleStrikesResponse {
  spot: number;
  strikes: StraddleStrike[];
}

export interface StraddleCandle extends ChartCandle {
  ce: number | null;
  pe: number | null;
}

export interface StraddleChartResponse {
  expiry: string;
  strike: number;
  spot: number;
  interval: string;
  spot_series: ChartSeriesPoint[];
  candles: StraddleCandle[];
  indicators: ChartIndicatorSeries[];
  coverage_note: string;
}

export interface RollingStraddleCandle extends ChartCandle {
  strike: number;
  ce: number;
  pe: number;
  spot: number;
  synthetic_fut: number;
}

export interface RollingStraddleSwitch {
  time: string;
  from_strike: number | null;
  to_strike: number;
  straddle_price: number;
  ce: number;
  pe: number;
  synthetic_fut: number;
  spot: number;
}

export interface RollingStraddleChartResponse {
  expiry: string;
  spot: number;
  interval: string;
  candles: RollingStraddleCandle[];
  switches: RollingStraddleSwitch[];
  indicators: ChartIndicatorSeries[];
  coverage_note: string;
}

export interface StrangleChartResponse {
  expiry: string;
  ce_strike: number;
  pe_strike: number;
  ce_lots: number;
  pe_lots: number;
  spot: number;
  interval: string;
  spot_series: ChartSeriesPoint[];
  candles: ChartCandle[];
  indicators: ChartIndicatorSeries[];
  coverage_note: string;
}

export type OptionTypeId = 'CE' | 'PE';
export type OptionActionId = 'BUY' | 'SELL';

export interface StrategyLeg {
  option_type: OptionTypeId;
  action: OptionActionId;
  strike: number;
  lots: number;
}

export interface CustomStrategyChartResponse {
  expiry: string;
  legs: StrategyLeg[];
  spot: number;
  interval: string;
  net_credit: boolean;
  spot_series: ChartSeriesPoint[];
  candles: ChartCandle[];
  indicators: ChartIndicatorSeries[];
  coverage_note: string;
}

export const VALID_INTERVALS = ['1', '2', '3', '5'] as const;

// Chart poll cadence, shared by all four live-charts panels. Each poll spawns a python process
// (see /api/options/live-charts), so the off-hours cadence backs right off once the session that
// feeds the underlying has closed - see lib/marketHours.ts's isUnderlyingLive().
export const POLL_INTERVAL_MS = 10_000;
export const OFF_HOURS_POLL_INTERVAL_MS = 60_000;

/** True when two strikes responses describe the same chain (same strikes, same ATM). The panels
 * refresh strikes every 30s purely to track the ATM marker, and the response's `spot` moves on
 * every one of those - holding the previous object when the chain itself is unchanged stops the
 * 50-100 <option> nodes (and everything memoised off them) from being rebuilt each refresh. */
export function sameStrikeChain(
  prev: StraddleStrikesResponse | null,
  next: StraddleStrikesResponse,
): boolean {
  return (
    !!prev &&
    prev.strikes.length === next.strikes.length &&
    prev.strikes.every((s, i) => s.strike === next.strikes[i].strike && s.is_atm === next.strikes[i].is_atm)
  );
}

export const DEFAULT_INDICATORS: ChartIndicatorRequest[] = [
  { type: 'ema', params: { period: 20 } },
  { type: 'vwap', params: {} },
];

export const CHART_INDICATOR_CATALOG: {
  id: ChartIndicatorType;
  label: string;
  defaultParams: Record<string, number>;
  paramLabels: Record<string, string>;
}[] = [
  { id: 'ema', label: 'EMA', defaultParams: { period: 20 }, paramLabels: { period: 'Period' } },
  { id: 'sma', label: 'SMA', defaultParams: { period: 20 }, paramLabels: { period: 'Period' } },
  { id: 'vwap', label: 'VWAP', defaultParams: {}, paramLabels: {} },
  { id: 'bbands', label: 'Bollinger Bands', defaultParams: { period: 20, std_dev: 2 }, paramLabels: { period: 'Period', std_dev: 'Std Dev' } },
  { id: 'supertrend', label: 'Supertrend', defaultParams: { period: 10, multiplier: 3 }, paramLabels: { period: 'Period', multiplier: 'Multiplier' } },
];

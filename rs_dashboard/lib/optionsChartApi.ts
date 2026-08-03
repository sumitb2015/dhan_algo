import type {
  ChartIndicatorRequest,
  CustomStrategyChartResponse,
  RollingStraddleChartResponse,
  StraddleChartResponse,
  StraddleExpiriesResponse,
  StraddleStrikesResponse,
  StrangleChartResponse,
  StrategyLeg,
} from './optionsChartTypes';

interface Envelope<T> {
  success: boolean;
  data?: T;
  error?: string;
}

async function get<T>(params: Record<string, string>): Promise<T> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`/api/options/live-charts?${qs}`, { cache: 'no-store' });
  const json = (await res.json()) as Envelope<T>;
  if (!json.success || !json.data) throw new Error(json.error ?? `Failed to load ${params.kind}`);
  return json.data;
}

function indicatorsParam(indicators: ChartIndicatorRequest[]): string {
  return JSON.stringify(indicators);
}

export const optionsChartApi = {
  expiries: (underlying = 'NIFTY') => get<StraddleExpiriesResponse>({ kind: 'expiries', underlying }),

  strikes: (underlying: string, expiry: string) => get<StraddleStrikesResponse>({ kind: 'strikes', underlying, expiry }),

  straddle: (opts: { underlying?: string; expiry: string; strike: number; interval: string; days?: number; indicators: ChartIndicatorRequest[]; includeSpot?: boolean }) =>
    get<StraddleChartResponse>({
      kind: 'straddle',
      underlying: opts.underlying ?? 'NIFTY',
      expiry: opts.expiry,
      strike: String(opts.strike),
      interval: opts.interval,
      days: String(opts.days ?? 2),
      indicators: indicatorsParam(opts.indicators),
      include_spot: opts.includeSpot ? '1' : '0',
    }),

  rollingStraddle: (opts: { underlying?: string; expiry: string; interval: string; days?: number; indicators: ChartIndicatorRequest[] }) =>
    get<RollingStraddleChartResponse>({
      kind: 'rolling-straddle',
      underlying: opts.underlying ?? 'NIFTY',
      expiry: opts.expiry,
      interval: opts.interval,
      days: String(opts.days ?? 2),
      indicators: indicatorsParam(opts.indicators),
    }),

  strangle: (opts: {
    underlying?: string;
    expiry: string;
    ceStrike: number;
    peStrike: number;
    ceLots?: number;
    peLots?: number;
    interval: string;
    days?: number;
    indicators: ChartIndicatorRequest[];
    includeSpot?: boolean;
  }) =>
    get<StrangleChartResponse>({
      kind: 'strangle',
      underlying: opts.underlying ?? 'NIFTY',
      expiry: opts.expiry,
      ce_strike: String(opts.ceStrike),
      pe_strike: String(opts.peStrike),
      ce_lots: String(opts.ceLots ?? 1),
      pe_lots: String(opts.peLots ?? 1),
      interval: opts.interval,
      days: String(opts.days ?? 2),
      indicators: indicatorsParam(opts.indicators),
      include_spot: opts.includeSpot ? '1' : '0',
    }),

  strategy: (opts: { underlying?: string; expiry: string; legs: StrategyLeg[]; interval: string; days?: number; indicators: ChartIndicatorRequest[]; includeSpot?: boolean }) =>
    get<CustomStrategyChartResponse>({
      kind: 'strategy',
      underlying: opts.underlying ?? 'NIFTY',
      expiry: opts.expiry,
      legs: JSON.stringify(opts.legs),
      interval: opts.interval,
      days: String(opts.days ?? 2),
      indicators: indicatorsParam(opts.indicators),
      include_spot: opts.includeSpot ? '1' : '0',
    }),
};

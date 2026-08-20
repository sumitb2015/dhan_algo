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

async function get<T>(params: Record<string, string>, signal?: AbortSignal): Promise<T> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`/api/options/live-charts?${qs}`, { cache: 'no-store', signal });
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

  straddle: (opts: { underlying?: string; expiry: string; strike: number; interval: string; days?: number; indicators: ChartIndicatorRequest[]; includeSpot?: boolean }, signal?: AbortSignal) =>
    get<StraddleChartResponse>({
      kind: 'straddle',
      underlying: opts.underlying ?? 'NIFTY',
      expiry: opts.expiry,
      strike: String(opts.strike),
      interval: opts.interval,
      days: String(opts.days ?? 2),
      indicators: indicatorsParam(opts.indicators),
      include_spot: opts.includeSpot ? '1' : '0',
    }, signal),

  rollingStraddle: (opts: { underlying?: string; expiry: string; interval: string; days?: number; indicators: ChartIndicatorRequest[] }, signal?: AbortSignal) =>
    get<RollingStraddleChartResponse>({
      kind: 'rolling-straddle',
      underlying: opts.underlying ?? 'NIFTY',
      expiry: opts.expiry,
      interval: opts.interval,
      days: String(opts.days ?? 2),
      indicators: indicatorsParam(opts.indicators),
    }, signal),

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
  }, signal?: AbortSignal) =>
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
    }, signal),

  strategy: (opts: { underlying?: string; expiry: string; legs: StrategyLeg[]; interval: string; days?: number; indicators: ChartIndicatorRequest[]; includeSpot?: boolean }, signal?: AbortSignal) =>
    get<CustomStrategyChartResponse>({
      kind: 'strategy',
      underlying: opts.underlying ?? 'NIFTY',
      expiry: opts.expiry,
      legs: JSON.stringify(opts.legs),
      interval: opts.interval,
      days: String(opts.days ?? 2),
      indicators: indicatorsParam(opts.indicators),
      include_spot: opts.includeSpot ? '1' : '0',
    }, signal),
};

/** True for the DOMException fetch() raises when its AbortSignal fires - an intentional
 * cancellation, not something to surface as a chart error. */
export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

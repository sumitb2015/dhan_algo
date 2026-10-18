/** Backtest run bookkeeping shared by the runner, the API route and the panel (pure). */

import { r2 } from './risk.ts';
import type { AlgoConfig } from './types.ts';
import type { DayResult } from './simulator.ts';
import type { BtAudit } from './audit.ts';

export type BtWindow = 'week' | 'month' | 'db4' | '3months' | '6months' | '1year' | 'all' | 'custom';
export const BT_WINDOWS: BtWindow[] = ['week', 'month', 'db4', '3months', '6months', '1year', 'all', 'custom'];
const DAYS_BACK: Record<Exclude<BtWindow, 'all' | 'custom'>, number> = {
  week: 7,
  month: 30,
  db4: 28,
  '3months': 90,
  '6months': 180,
  '1year': 365,
};

export interface BtStore {
  version: 1;
  strategy: string;
  underlying: 'NIFTY';
  configKey: string;
  config: AlgoConfig;
  from: string;
  /** Last session of the range; null = rolling (catch-up appends new sessions). */
  to: string | null;
  window: BtWindow;
  updatedAt: string | null;
  days: Record<string, DayResult>;
  failures: Record<string, { at: string; error: string }>;
  audit?: BtAudit | null;
}

/** First session of a window ending at `latest` (the options DB's latest session). */
export function windowFrom(window: BtWindow, latest: string, earliest: string): string {
  if (window === 'all' || window === 'custom') return earliest;
  const d = new Date(`${latest}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - DAYS_BACK[window]);
  const iso = d.toISOString().slice(0, 10);
  return iso < earliest ? earliest : iso;
}

/** Session close plus a margin; before this, today is not backtestable. */
export const EOD_READY_HHMM = '15:35';

/** Every regular session from `from` through min(today, to); today only once the session is over. */
export function sessionsToHold(
  from: string,
  todayIst: string,
  nowHm: string,
  isRegular: (d: string) => boolean,
  to: string | null = null,
): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T00:00:00Z`);
  const todayOk = nowHm >= EOD_READY_HHMM;
  for (let i = 0; i < 4000; i++) {
    const iso = d.toISOString().slice(0, 10);
    if (iso > todayIst || (iso === todayIst && !todayOk) || (to && iso > to)) break;
    if (isRegular(iso)) out.push(iso);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

export interface BtSummary {
  days: number;
  tradingDays: number;
  trades: number;
  wins: number;
  winRate: number | null;
  gross: number;
  costs: number;
  net: number;
  avgPerDay: number | null;
  avgPerTrade: number | null;
  bestDay: { date: string; net: number } | null;
  worstDay: { date: string; net: number } | null;
  maxDrawdown: number;
  profitFactor: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  exitMix: Record<string, number>;
}

/** Totals over a set of days. Drawdown is on the cumulative daily net curve. */
export function summarize(days: DayResult[]): BtSummary {
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const trades = sorted.flatMap((d) => d.trades);
  const wins = trades.filter((t) => t.net > 0);
  const losses = trades.filter((t) => t.net <= 0);
  let cum = 0;
  let peak = 0;
  let maxDd = 0;
  for (const d of sorted) {
    cum += d.net;
    peak = Math.max(peak, cum);
    maxDd = Math.min(maxDd, cum - peak);
  }
  const grossWin = wins.reduce((a, t) => a + t.net, 0);
  const grossLoss = -losses.reduce((a, t) => a + t.net, 0);
  const exitMix: Record<string, number> = {};
  for (const t of trades) exitMix[t.exitKind] = (exitMix[t.exitKind] ?? 0) + 1;
  const byNet = [...sorted].sort((a, b) => a.net - b.net);
  const net = r2(sorted.reduce((a, d) => a + d.net, 0));
  return {
    days: sorted.length,
    tradingDays: sorted.filter((d) => d.trades.length > 0).length,
    trades: trades.length,
    wins: wins.length,
    winRate: trades.length ? (wins.length / trades.length) * 100 : null,
    gross: r2(sorted.reduce((a, d) => a + d.gross, 0)),
    costs: r2(sorted.reduce((a, d) => a + d.costs, 0)),
    net,
    avgPerDay: sorted.length ? r2(net / sorted.length) : null,
    avgPerTrade: trades.length ? r2(net / trades.length) : null,
    bestDay: byNet.length ? { date: byNet[byNet.length - 1].date, net: byNet[byNet.length - 1].net } : null,
    worstDay: byNet.length ? { date: byNet[0].date, net: byNet[0].net } : null,
    maxDrawdown: r2(maxDd),
    profitFactor: grossLoss > 0 ? r2(grossWin / grossLoss) : null,
    avgWin: wins.length ? r2(grossWin / wins.length) : null,
    avgLoss: losses.length ? r2(-grossLoss / losses.length) : null,
    exitMix,
  };
}

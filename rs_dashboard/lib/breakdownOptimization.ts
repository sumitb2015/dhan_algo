import type { BreakdownConfig } from './breakdownLedger';

/**
 * Snapshot of the 2026-10-18 settings grid search (not recomputed by the page). Every config was replayed through
 * simulateDay on the cached Dhan options-DB sessions with ₹0 brokerage (statutory charges still applied): tuned on the
 * first 83 sessions, checked on the last 41 it never saw, then stress-tested on all 124 at 1 pt slippage per fill.
 */
export interface OptStats {
  net: number;
  pf: number;
  dd: number;
  trades?: number;
  winDays?: string;
}

export interface OptCandidate {
  id: 'current' | 'recommended' | 'lowRisk';
  label: string;
  settings: Partial<BreakdownConfig>;
  train: OptStats;
  test: OptStats;
  stress: OptStats;
}

export const OPTIMIZATION_REPORT = {
  date: '2026-10-18',
  source: 'Dhan options DB (nifty_options.db)',
  train: { from: '2026-04-16', to: '2026-08-13', sessions: 83, slippagePts: 0.5 },
  test: { from: '2026-08-14', to: '2026-10-13', sessions: 41, slippagePts: 0.5 },
  stress: { sessions: 124, slippagePts: 1 },
  configsTested: 180,
  candidates: [
    {
      id: 'current',
      label: 'Previous rules',
      settings: { timeframe: 3, useSupertrend: true, stPeriod: 7, stMultiplier: 3, useVwap: true, useEma: false, slPct: 25, targetPct: 35, dailyLossLimit: 5000, maxSameSide: 2 },
      train: { net: 5_490, pf: 1.02, dd: 51_807 },
      test: { net: 119_000, pf: 2.18, dd: 20_000, winDays: '25/41' },
      stress: { net: 82_000, pf: 1.2, dd: 64_000, trades: 628, winDays: '62/124' },
    },
    {
      id: 'recommended',
      label: 'Recommended',
      settings: { timeframe: 1, useSupertrend: true, stPeriod: 7, stMultiplier: 1.5, useVwap: false, useEma: false, slPct: 20, targetPct: 35, dailyLossLimit: 8000, maxSameSide: 2 },
      train: { net: 259_000, pf: 1.97, dd: 31_000 },
      test: { net: 148_000, pf: 2.26, dd: 35_000, winDays: '26/41' },
      stress: { net: 363_000, pf: 1.92, dd: 37_000, trades: 595, winDays: '77/124' },
    },
    {
      id: 'lowRisk',
      label: 'Low-risk',
      settings: { timeframe: 1, useSupertrend: true, stPeriod: 7, stMultiplier: 1.25, useVwap: false, useEma: false, slPct: 20, targetPct: 35, dailyLossLimit: 8000, maxSameSide: 1 },
      train: { net: 164_000, pf: 1.75, dd: 9_000 },
      test: { net: 80_000, pf: 1.88, dd: 6_000, winDays: '30/41' },
      stress: { net: 212_000, pf: 1.65, dd: 10_000, trades: 487, winDays: '84/124' },
    },
  ] as OptCandidate[],
  /** Unchanged across all three candidates. */
  common: 'Trend AUTO · strikes ATM±10 · max open 2 · trail start 15%, step 2 / by 1 · entries 09:20–15:00 · EOD 15:15 · hard breaker on · recovery exit off',
  findings: [
    '1-minute bars beat 3m and 5m: across the stage-1 variants the average was +₹66k vs ≈₹0 (3m) and −₹15k (5m).',
    'Supertrend multiplier 1.5 beats 2 and 3 at every period tried (5, 7, 10); period 7 was best.',
    'A 35% target won at every stop-loss level; SL 20% gave the best profit factor and drawdown.',
    'Recovery exit ON lost ₹2.46L on the training days — keep it off.',
    'Strike window ±10 is needed: ±4, ±6 and ±8 all lost money.',
    'Starting entries at 09:30 or 09:45 instead of 09:20 cut profit sharply.',
  ],
  caveats: [
    'Six months of data only; Aug–Oct was a good stretch for every setting, so expect less in a bad month.',
    '1-minute signals are sensitive to fill quality: run in SIM first and compare live fills with the backtest.',
    'The Breeze DB was not used for validation: its sessions fall inside the training window.',
  ],
};

/** True when every tuned setting of `candidate` matches `config`. */
export function matchesCandidate(config: BreakdownConfig, candidate: OptCandidate): boolean {
  return Object.entries(candidate.settings).every(([k, v]) => (config as unknown as Record<string, unknown>)[k] === v);
}

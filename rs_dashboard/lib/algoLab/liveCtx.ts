/**
 * Builds the live AlgoCtx from the page's feeds — the same shape the simulator builds from the options DB, so a
 * strategy sees one world. Decision time is the start of the current minute; only CLOSED 1-minute bars are passed.
 *
 * Known live/backtest differences (documented in strategies/algo_lab/README.md): `ltp` is the current print here and
 * the last closed bar's close in the backtest; live 1-minute bars after the last backfill are built from LTP prints
 * (no volume, so VWAP ignores them).
 */

import { mergeBars, minuteStamp, type LiveMinutes } from '../bearishStrikes.ts';
import { closeBar } from './bars.ts';
import type { AlgoCtx, Bar, CtxContract, CtxOpen, OptType } from './types.ts';

export interface QuoteSide {
  ltp: number;
  oi?: number;
  volume?: number;
  prev_close?: number;
  oi_chg_pct?: number;
}

export interface LiveCtxInput {
  nowMs: number;
  underlying: string;
  expiry: string;
  lotSize: number;
  spot: number;
  strikes: Record<string, { ce?: QuoteSide; pe?: QuoteSide }>;
  strikeWindow: number;
  open: CtxOpen[];
  /** Backfilled 1-minute bars (previous session + today) per "24500CE". */
  apiBars: (key: string) => Bar[] | undefined;
  /** LTP-built minutes per "24500CE". */
  liveMinutes: (key: string) => LiveMinutes | undefined;
  /** Today's index 1-minute closes from the intraday API, plus LTP-built minutes of the spot. */
  spotCloses: [string, number][];
  spotLive: LiveMinutes;
}

const istMinuteMs = (nowMs: number) => Math.floor((nowMs + 5.5 * 3600_000) / 60_000) * 60_000;

export function buildLiveCtx(inp: LiveCtxInput): AlgoCtx | null {
  if (!(inp.spot > 0)) return null;
  const nowIstMs = istMinuteMs(inp.nowMs);
  const stamp = minuteStamp(nowIstMs); // "YYYY-MM-DD HH:MM:00" of the current (forming) minute
  const date = stamp.slice(0, 10);
  const hm = stamp.slice(11, 16);
  const strikes = Object.keys(inp.strikes)
    .map(Number)
    .filter((s) => Number.isFinite(s) && s > 0)
    .sort((a, b) => a - b);
  if (!strikes.length) return null;
  const diffs = strikes.slice(1).map((s, i) => s - strikes[i]).filter((d) => d > 0);
  const step = diffs.length ? Math.min(...diffs) : 50;
  const atm = strikes.reduce((a, b) => (Math.abs(b - inp.spot) < Math.abs(a - inp.spot) ? b : a), strikes[0]);
  const ai = strikes.indexOf(atm);
  const want = new Set<string>();
  for (const s of strikes.slice(Math.max(0, ai - inp.strikeWindow), ai + inp.strikeWindow + 1)) {
    want.add(`${s}CE`);
    want.add(`${s}PE`);
  }
  for (const o of inp.open) want.add(o.key);

  const contracts: Record<string, CtxContract> = {};
  for (const key of want) {
    const strike = Number(key.slice(0, -2));
    const option = key.slice(-2) as OptType;
    const row = inp.strikes[String(strike)];
    const q = option === 'CE' ? row?.ce : row?.pe;
    if (!q || !(q.ltp > 0)) continue;
    const merged = mergeBars(inp.apiBars(key) ?? [], inp.liveMinutes(key) ?? new Map());
    const bars1m = merged.filter((b) => b.t < stamp);
    const warmupBars = bars1m.filter((b) => b.t.slice(0, 10) < date).length;
    const oi = typeof q.oi === 'number' ? q.oi : null;
    const prevOi = oi != null && typeof q.oi_chg_pct === 'number' && q.oi_chg_pct > -100 ? oi / (1 + q.oi_chg_pct / 100) : null;
    contracts[key] = {
      key,
      strike,
      option,
      ltp: q.ltp,
      volume: q.volume ?? 0,
      oi,
      prevClose: typeof q.prev_close === 'number' && q.prev_close > 0 ? q.prev_close : null,
      prevOi,
      bars1m,
      warmupBars,
    };
  }

  // Spot: API closes, then LTP-built minutes after the last API minute; closed minutes only, close-only bars.
  const closes = new Map<string, number>(inp.spotCloses.filter(([t]) => t < hm));
  const lastApi = inp.spotCloses.length ? inp.spotCloses[inp.spotCloses.length - 1][0] : '';
  for (const [t, m] of inp.spotLive) {
    const thm = t.slice(11, 16);
    if (t.slice(0, 10) === date && thm < hm && thm > lastApi) closes.set(thm, m.c);
  }
  const spotBars1m = [...closes.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([t, c]) => closeBar(date, t, c));

  return {
    nowIstMs,
    date,
    hm,
    underlying: inp.underlying,
    expiry: inp.expiry,
    lotSize: inp.lotSize,
    step,
    spot: inp.spot,
    atm,
    spotBars1m,
    contracts,
    open: inp.open,
  };
}

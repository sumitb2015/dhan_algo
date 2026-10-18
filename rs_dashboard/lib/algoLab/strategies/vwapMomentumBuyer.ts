/**
 * VWAP Momentum Buyer — the Algo Lab's first strategy (spec: strategies/algo_lab/vwap_momentum_buyer.md).
 * UNVALIDATED: built to exercise the BUY path of the framework; backtest before any REAL use.
 *
 * Buys the option whose CLOSED candle has just moved above both its session VWAP and its EMA, on the side the
 * index trend favours (bullish -> CE, bearish -> PE). Exits: lock & trail stop, optional profit target, and a
 * "momentum lost" exit when the premium falls back below its EMA.
 */

import { closeMean, closedTfBars, dayOf, emaSmaSeeded, ewmLast, sessionVwap, todayOnly } from '../bars.ts';
import { initialStop, lockAndTrail, r2, targetHit, targetOf } from '../risk.ts';
import type { AlgoConfig, AlgoCtx, Bar, Candidate, CtxContract, ExitSignal, GateResult, StrategyDefinition } from '../types.ts';

const num = (c: AlgoConfig, k: string) => Number(c[k]);

interface Ind {
  close: number | null;
  ema: number | null;
  vwap: number | null;
  /** Consecutive closed bars (ending with the last) above both VWAP and EMA, counted on today's bars only. */
  ageAbove: number;
  lastIsToday: boolean;
}

// One evaluation per (bars array, timeframe, minute): scan and every manage() call of a minute share it.
const memo = new WeakMap<Bar[], { k: string; v: Ind }>();

function indicatorsOf(c: CtxContract, ctx: AlgoCtx, tf: number, emaPeriod: number): Ind {
  const k = `${tf}|${emaPeriod}|${ctx.nowIstMs}`;
  const hit = memo.get(c.bars1m);
  if (hit && hit.k === k) return hit.v;
  const bars = closedTfBars(c.bars1m, tf, ctx.nowIstMs);
  const ema = emaSmaSeeded(bars.map((b) => b.c), emaPeriod);
  const vw = sessionVwap(bars);
  const n = bars.length;
  const above = (i: number) => {
    const e = ema[i];
    const v = vw[i];
    return e != null && v != null && bars[i].c > e && bars[i].c > v;
  };
  let age = 0;
  for (let i = n - 1; i >= 0 && dayOf(bars[i]) === ctx.date && above(i); i--) age++;
  const v: Ind = {
    close: n ? bars[n - 1].c : null,
    ema: n ? ema[n - 1] : null,
    vwap: n ? vw[n - 1] : null,
    ageAbove: age,
    lastIsToday: n > 0 && dayOf(bars[n - 1]) === ctx.date,
  };
  memo.set(c.bars1m, { k, v });
  return v;
}

const pctAbove = (px: number, lvl: number | null) => (lvl != null && lvl > 0 ? ((px - lvl) / lvl) * 100 : null);

export const vwapMomentumBuyer: StrategyDefinition = {
  key: 'vwap_momentum_buyer',
  label: 'VWAP Momentum Buyer',
  description: 'Buys the option whose closed candle breaks above its VWAP and EMA, on the side the NIFTY trend favours.',
  docPath: 'strategies/algo_lab/vwap_momentum_buyer.md',
  side: 'BUY',
  underlyings: ['NIFTY'],
  status: 'UNVALIDATED',
  schema: [
    {
      key: 'trendMode',
      label: 'Index trend filter',
      group: 'Signal',
      kind: 'select',
      options: [
        { value: 'AUTO', label: 'Auto (bull → CE, bear → PE)' },
        { value: 'BYPASS', label: 'Off (both sides)' },
      ],
    },
    { key: 'emaPeriod', label: 'Option EMA period', group: 'Signal', kind: 'number', min: 5, max: 50, integer: true },
    { key: 'maxSignalAge', label: 'Max signal age', group: 'Signal', kind: 'number', min: 1, max: 5, integer: true, unit: 'bars' },
    { key: 'minPremium', label: 'Min premium', group: 'Signal', kind: 'number', min: 1, max: 500, unit: '₹' },
    { key: 'maxPremium', label: 'Max premium', group: 'Signal', kind: 'number', min: 5, max: 2000, unit: '₹' },
    { key: 'slPct', label: 'Initial stop', group: 'Exit', kind: 'number', min: 5, max: 60, unit: '%' },
    { key: 'targetPct', label: 'Profit target (0 = off)', group: 'Exit', kind: 'number', min: 0, max: 200, unit: '%' },
    { key: 'trailStartPct', label: 'Lock to cost at', group: 'Exit', kind: 'number', min: 0, max: 100, unit: '% gain' },
    { key: 'trailStepPts', label: 'Trail every', group: 'Exit', kind: 'number', min: 0.5, max: 50, step: 0.5, unit: 'pts' },
    { key: 'trailByPts', label: 'Trail by', group: 'Exit', kind: 'number', min: 0.5, max: 50, step: 0.5, unit: 'pts' },
    { key: 'recoveryExit', label: 'Exit when premium closes back below EMA', group: 'Exit', kind: 'boolean' },
  ],
  defaults: {
    timeframe: 5,
    strikeWindow: 4,
    trendMode: 'AUTO',
    emaPeriod: 20,
    maxSignalAge: 2,
    minPremium: 20,
    maxPremium: 300,
    slPct: 20,
    targetPct: 40,
    trailStartPct: 15,
    trailStepPts: 5,
    trailByPts: 2,
    recoveryExit: true,
  },

  warmupBars: (c) => num(c, 'emaPeriod') * c.timeframe,

  gate(ctx, c): GateResult {
    const today = todayOnly(ctx.spotBars1m, ctx.date);
    const tfBars = closedTfBars(today, c.timeframe, ctx.nowIstMs);
    const vwap = closeMean(today);
    const closes = tfBars.map((b) => b.c);
    const ema9 = ewmLast(closes, 9);
    const ema20 = ewmLast(closes, 20);
    const metrics = { spot: r2(ctx.spot), vwap: vwap && r2(vwap), ema9: ema9 && r2(ema9), ema20: ema20 && r2(ema20) };
    if (tfBars.length < 2 || vwap == null || ema9 == null || ema20 == null || !(ctx.spot > 0)) {
      return { bias: 'WARMING UP', tone: 'neutral', allowed: c.trendMode === 'BYPASS' ? ['CE', 'PE'] : [], detail: 'Waiting for closed index candles', metrics };
    }
    const bull = ctx.spot > vwap && ema9 > ema20;
    const bear = ctx.spot < vwap && ema9 < ema20;
    const bias = bull ? 'BULLISH' : bear ? 'BEARISH' : 'SIDEWAYS';
    if (c.trendMode === 'BYPASS') {
      return { bias, tone: bull ? 'bull' : bear ? 'bear' : 'neutral', allowed: ['CE', 'PE'], detail: 'Trend filter off: both sides', metrics };
    }
    if (bull) return { bias, tone: 'bull', allowed: ['CE'], detail: 'Spot above VWAP, EMA9 above EMA20: calls only', metrics };
    if (bear) return { bias, tone: 'bear', allowed: ['PE'], detail: 'Spot below VWAP, EMA9 below EMA20: puts only', metrics };
    return { bias, tone: 'neutral', allowed: [], detail: 'Spot and EMAs disagree: no new entries', metrics };
  },

  scan(ctx, c, gate): Candidate[] {
    const tf = c.timeframe;
    const emaP = num(c, 'emaPeriod');
    const maxAge = num(c, 'maxSignalAge');
    const out: Candidate[] = [];
    for (const k of Object.keys(ctx.contracts)) {
      const ct = ctx.contracts[k];
      const ind = indicatorsOf(ct, ctx, tf, emaP);
      const steps = ctx.step > 0 ? Math.round(Math.abs(ct.strike - ctx.atm) / ctx.step) : 0;
      const pe = pctAbove(ct.ltp, ind.ema);
      const pv = pctAbove(ct.ltp, ind.vwap);
      const strength = pe != null && pv != null ? (pe + pv) / 2 : null;

      let block: string | undefined;
      if (!gate.allowed.includes(ct.option)) block = `Trend gate: ${ct.option} not allowed`;
      else if (ind.ema == null || ind.vwap == null || !ind.lastIsToday) block = 'Indicators warming up';
      else if (ind.ageAbove === 0) block = 'Not above VWAP & EMA';
      else if (ind.ageAbove > maxAge) block = `Signal ${ind.ageAbove} bars old`;
      else if (!(ct.ltp >= num(c, 'minPremium') && ct.ltp <= num(c, 'maxPremium'))) block = 'Premium outside range';

      const fresh = ind.ageAbove > 0 && ind.ageAbove <= maxAge ? 50 * (1 - (ind.ageAbove - 1) / maxAge) : 0;
      const proximity = Math.max(0, 30 - 6 * steps);
      const str = strength != null && strength > 0 ? Math.min(20, strength * 4) : 0;
      out.push({
        key: k,
        strike: ct.strike,
        option: ct.option,
        ltp: ct.ltp,
        score: r2(fresh + proximity + str),
        eligible: !block,
        blockReason: block,
        cols: {
          ema: ind.ema != null ? r2(ind.ema) : null,
          vwap: ind.vwap != null ? r2(ind.vwap) : null,
          strength: strength != null ? r2(strength) : null,
          age: ind.ageAbove,
          steps,
        },
      });
    }
    return out.sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score);
  },

  onEntry(_cand, entry, c) {
    return { stop: initialStop('BUY', entry, num(c, 'slPct')), target: targetOf('BUY', entry, num(c, 'targetPct')) };
  },

  manage(pos, px, ctx, c) {
    const stop = lockAndTrail('BUY', pos.entryPrice, pos.best, pos.initialStop, num(c, 'trailStartPct'), num(c, 'trailStepPts'), num(c, 'trailByPts'));
    const exits: ExitSignal[] = [];
    if (targetHit('BUY', px, pos.target)) exits.push({ kind: 'TARGET', level: pos.target!, reason: `TARGET ₹${pos.target}` });
    const ct = ctx.contracts[pos.key];
    if (c.recoveryExit && ct) {
      const ema = indicatorsOf(ct, ctx, c.timeframe, num(c, 'emaPeriod')).ema;
      if (ema != null && px < ema) exits.push({ kind: 'MOMENTUM_LOST', level: r2(ema), reason: `Premium back below EMA ₹${ema.toFixed(1)}` });
    }
    return { stop, exits };
  },

  columns: {
    scanner: [
      { key: 'ema', label: 'EMA', fmt: 'num', digits: 1 },
      { key: 'vwap', label: 'VWAP', fmt: 'num', digits: 1 },
      { key: 'strength', label: '% above', fmt: 'pct', digits: 1 },
      { key: 'age', label: 'Age', fmt: 'int' },
      { key: 'steps', label: 'Strikes from ATM', fmt: 'int' },
    ],
  },
};

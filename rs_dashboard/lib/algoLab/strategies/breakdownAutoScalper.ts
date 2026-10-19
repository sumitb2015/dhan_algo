/**
 * Breakdown Auto Scalper — Algo Lab Strategy (spec: strategies/breakdown_scalper/strategy.md).
 * VALIDATED: backed by 49-session backtest (+₹1.63L net P&L, 1.79 Profit Factor, 307 trades).
 *
 * Sells the option whose CLOSED candle breaks down below its Supertrend, session VWAP,
 * and EMA20, aligned with the NIFTY index trend (Bullish -> sell PE, Bearish -> sell CE).
 * Exits: 3-phase lock & trail stop (15% lock, 2pt trail by 1pt), target profit decay, and optional
 * indicator recovery exit if the premium recovers above Supertrend or EMA.
 */

import { closedTfBars, todayOnly } from '../bars.ts';
import { initialStop, lockAndTrail, r2, targetHit, targetOf } from '../risk.ts';
import type {
  AlgoConfig,
  AlgoCtx,
  Candidate,
  ExitSignal,
  GateResult,
  OptType,
  StrategyDefinition,
} from '../types.ts';
import {
  DEFAULT_WEIGHTS,
  evaluateOptionBreakdown,
  evaluateUnderlyingTrend,
  indexTrendInputs,
  rankBreakdownSignals,
  type IndexTrendParams,
  type TrendFilterMode,
} from '../../breakdownScalper.ts';

const num = (c: AlgoConfig, k: string) => Number(c[k]);

export const breakdownAutoScalper: StrategyDefinition = {
  key: 'breakdown_auto_scalper',
  label: 'Breakdown Auto Scalper',
  description: 'Sells the option breaking down below its Supertrend, VWAP, and EMA support, aligned with index trend.',
  docPath: 'strategies/breakdown_scalper/strategy.md',
  side: 'SELL',
  underlyings: ['NIFTY'],
  status: 'VALIDATED',
  schema: [
    // Trend Group
    {
      key: 'trendMode',
      label: 'Index trend filter',
      group: 'Trend',
      kind: 'select',
      options: [
        { value: 'AUTO', label: 'Auto (bull → sell PE, bear → sell CE)' },
        { value: 'BYPASS', label: 'Off (both sides eligible)' },
        { value: 'CE_ONLY', label: 'CE only (bearish trades)' },
        { value: 'PE_ONLY', label: 'PE only (bullish trades)' },
      ],
      help: 'Market bias rule from NIFTY index trend.',
    },
    { key: 'trendUseEma', label: 'Index EMA cross', group: 'Trend', kind: 'boolean' },
    { key: 'trendEmaFast', label: 'Index EMA fast', group: 'Trend', kind: 'number', min: 2, max: 50, integer: true },
    { key: 'trendEmaSlow', label: 'Index EMA slow', group: 'Trend', kind: 'number', min: 5, max: 100, integer: true },
    { key: 'trendUseSupertrend', label: 'Index Supertrend confirmation', group: 'Trend', kind: 'boolean' },
    { key: 'trendStPeriod', label: 'Index Supertrend period', group: 'Trend', kind: 'number', min: 3, max: 50, integer: true },
    { key: 'trendStMultiplier', label: 'Index Supertrend multiplier', group: 'Trend', kind: 'number', min: 0.5, max: 10, step: 0.1 },

    // Breakdown Signal Group
    { key: 'useSupertrend', label: 'Option Supertrend support', group: 'Breakdown', kind: 'boolean' },
    { key: 'stPeriod', label: 'Option Supertrend period', group: 'Breakdown', kind: 'number', min: 5, max: 50, integer: true },
    { key: 'stMultiplier', label: 'Option Supertrend multiplier', group: 'Breakdown', kind: 'number', min: 0.5, max: 10, step: 0.1 },
    { key: 'useVwap', label: 'Option VWAP support', group: 'Breakdown', kind: 'boolean' },
    { key: 'useEma', label: 'Option EMA support', group: 'Breakdown', kind: 'boolean' },
    { key: 'emaPeriod', label: 'Option EMA period', group: 'Breakdown', kind: 'number', min: 5, max: 100, integer: true },
    {
      key: 'otmOnly',
      label: 'OTM options only',
      group: 'Breakdown',
      kind: 'boolean',
      help: 'Only check OTM calls (strike above spot) and OTM puts (strike below spot) for selling; ATM and ITM strikes are blocked.',
    },
    { key: 'maxSignalAge', label: 'Max breakdown age', group: 'Breakdown', kind: 'number', min: 1, max: 10, integer: true, unit: 'bars' },
    { key: 'minVolume', label: 'Min traded volume', group: 'Breakdown', kind: 'number', min: 0, max: 1000000, integer: true },
    { key: 'minOi', label: 'Min open interest', group: 'Breakdown', kind: 'number', min: 0, max: 10000000, integer: true },

    // Exit Group
    { key: 'slPct', label: 'Initial stop loss', group: 'Exit', kind: 'number', min: 5, max: 100, integer: true, unit: '%' },
    { key: 'targetPct', label: 'Profit target decay (0 = off)', group: 'Exit', kind: 'number', min: 0, max: 100, integer: true, unit: '%' },
    { key: 'trailStartPct', label: 'Lock to cost at', group: 'Exit', kind: 'number', min: 0, max: 100, integer: true, unit: '% gain' },
    { key: 'trailStepPts', label: 'Trail step', group: 'Exit', kind: 'number', min: 0.5, max: 50, step: 0.5, unit: 'pts' },
    { key: 'trailByPts', label: 'Trail by', group: 'Exit', kind: 'number', min: 0.5, max: 50, step: 0.5, unit: 'pts' },
    { key: 'recoveryExit', label: 'Exit when premium recovers above Supertrend / EMA', group: 'Exit', kind: 'boolean' },
    { key: 'hardCircuitBreaker', label: 'Hard circuit breaker', group: 'Risk', kind: 'boolean', help: 'Emergency square off all open positions when daily loss limit is reached' },
    {
      key: 'dataSource',
      label: 'Backtest data source',
      group: 'Costs',
      kind: 'select',
      options: [
        { value: 'dhan', label: 'Dhan DB' },
        { value: 'breeze', label: 'ICICI Breeze DB' },
      ],
      backtestOnly: true,
      help: 'Backtest option chain data source',
    },
  ],

  defaults: {
    timeframe: 1,
    strikeWindow: 6,
    trendMode: 'AUTO',
    maxConcurrent: 2,
    maxSameSide: 1,
    lotsPerTrade: 1,
    dailyLossLimit: 5000,
    hardCircuitBreaker: true,
    dataSource: 'dhan',
    slPct: 20,
    targetPct: 35,
    trailStartPct: 15,
    trailStepPts: 2,
    trailByPts: 1,
    recoveryExit: false,
    otmOnly: true,
    useSupertrend: true,
    stPeriod: 7,
    stMultiplier: 1.5,
    useVwap: false,
    useEma: false,
    emaPeriod: 20,
    trendUseEma: true,
    trendEmaFast: 9,
    trendEmaSlow: 20,
    trendUseSupertrend: false,
    trendStPeriod: 7,
    trendStMultiplier: 3.0,
    maxSignalAge: 3,
    minVolume: 1000,
    minOi: 5000,
  },

  warmupBars: (c) => (num(c, 'emaPeriod') || 20) * c.timeframe,

  gate(ctx, c): GateResult {
    const today = todayOnly(ctx.spotBars1m, ctx.date);
    const tfBars = closedTfBars(today, c.timeframe, ctx.nowIstMs);
    const closes = tfBars.map((b) => b.c);
    const p: IndexTrendParams = {
      useEma: c.trendUseEma !== false,
      emaFast: num(c, 'trendEmaFast') || 9,
      emaSlow: num(c, 'trendEmaSlow') || 20,
      useSupertrend: Boolean(c.trendUseSupertrend),
      stPeriod: num(c, 'trendStPeriod') || 7,
      stMultiplier: num(c, 'trendStMultiplier') || 3.0,
    };
    const inputs = indexTrendInputs(closes, p);
    const trend = evaluateUnderlyingTrend(inputs, p, (c.trendMode as TrendFilterMode) || 'AUTO');
    const bull = trend.trend === 'BULLISH';
    const bear = trend.trend === 'BEARISH';
    const tone = bull ? 'bull' : bear ? 'bear' : 'neutral';

    let allowed: OptType[] = [];
    if (trend.eligibleSide === 'BOTH') allowed = ['CE', 'PE'];
    else if (trend.eligibleSide === 'PE') allowed = ['PE'];
    else if (trend.eligibleSide === 'CE') allowed = ['CE'];

    const spread = inputs.emaFast != null && inputs.emaSlow != null ? r2(inputs.emaFast - inputs.emaSlow) : null;
    const metrics: Record<string, number | string | null> = {
      spot: r2(ctx.spot),
      emaFast: inputs.emaFast != null ? r2(inputs.emaFast) : null,
      emaSlow: inputs.emaSlow != null ? r2(inputs.emaSlow) : null,
      stLine: inputs.stLine != null ? r2(inputs.stLine) : null,
      spread,
    };

    return {
      bias: trend.trend,
      tone,
      allowed,
      detail: trend.detail,
      metrics,
    };
  },

  scan(ctx, c, _gate): Candidate[] {
    const tf = c.timeframe as 1 | 3 | 5;
    const p: IndexTrendParams = {
      useEma: c.trendUseEma !== false,
      emaFast: num(c, 'trendEmaFast') || 9,
      emaSlow: num(c, 'trendEmaSlow') || 20,
      useSupertrend: Boolean(c.trendUseSupertrend),
      stPeriod: num(c, 'trendStPeriod') || 7,
      stMultiplier: num(c, 'trendStMultiplier') || 3.0,
    };
    const today = todayOnly(ctx.spotBars1m, ctx.date);
    const tfBars = closedTfBars(today, tf, ctx.nowIstMs);
    const closes = tfBars.map((b) => b.c);
    const inputs = indexTrendInputs(closes, p);
    const underlyingTrend = evaluateUnderlyingTrend(inputs, p, (c.trendMode as TrendFilterMode) || 'AUTO');

    const indParams = {
      stPeriod: num(c, 'stPeriod') || 10,
      stMultiplier: num(c, 'stMultiplier') || 2.0,
      emaPeriod: num(c, 'emaPeriod') || 20,
      useSupertrend: c.useSupertrend !== false,
      useVwap: c.useVwap !== false,
      useEma: c.useEma !== false,
    };

    const rawCandidates = Object.keys(ctx.contracts).map((k) => {
      const ct = ctx.contracts[k];
      const state = evaluateOptionBreakdown(ct.bars1m, tf, ctx.nowIstMs, indParams);
      return {
        strike: ct.strike,
        option: ct.option,
        contractKey: ct.key,
        ltp: ct.ltp,
        volume: ct.volume,
        oi: ct.oi ?? 0,
        state,
      };
    });

    const held = new Set(ctx.open.map((pos) => pos.key));
    const ranked = rankBreakdownSignals(
      rawCandidates,
      ctx.spot,
      ctx.atm,
      ctx.step,
      underlyingTrend,
      held,
      num(c, 'minVolume') || 1000,
      num(c, 'minOi') || 5000,
      DEFAULT_WEIGHTS,
      num(c, 'maxSignalAge') || 3,
    );

    const otmOnly = Boolean(c.otmOnly);
    const isOtm = (strike: number, option: OptType) => (option === 'CE' ? strike > ctx.spot : strike < ctx.spot);
    const scoped = otmOnly
      ? [...ranked.filter((r) => isOtm(r.strike, r.option)), ...ranked.filter((r) => !isOtm(r.strike, r.option))]
      : ranked;

    return scoped.map((r) => ({
      key: r.contractKey,
      strike: r.strike,
      option: r.option,
      ltp: r.ltp,
      score: r2(r.rankScore),
      eligible: r.isEligible && !(otmOnly && !isOtm(r.strike, r.option)),
      blockReason: otmOnly && !isOtm(r.strike, r.option) ? 'ATM/ITM — OTM only' : r.blockReason,
      cols: {
        st: r.state.indicators.stLine != null ? r2(r.state.indicators.stLine) : null,
        vwap: r.state.indicators.vwap != null ? r2(r.state.indicators.vwap) : null,
        ema: r.state.indicators.ema != null ? r2(r.state.indicators.ema) : null,
        depth: r.state.avgPctBelow != null ? r2(r.state.avgPctBelow) : null,
        age: r.state.barsSinceBreakdown,
        steps: r.distFromAtmSteps,
      },
    }));
  },

  onEntry(_cand, entry, c) {
    return {
      stop: initialStop('SELL', entry, num(c, 'slPct')),
      target: targetOf('SELL', entry, num(c, 'targetPct')),
    };
  },

  manage(pos, px, ctx, c) {
    const stop = lockAndTrail(
      'SELL',
      pos.entryPrice,
      pos.best,
      pos.initialStop,
      num(c, 'trailStartPct'),
      num(c, 'trailStepPts'),
      num(c, 'trailByPts'),
    );
    const exits: ExitSignal[] = [];
    if (targetHit('SELL', px, pos.target)) {
      exits.push({ kind: 'TARGET', level: pos.target!, reason: `TARGET ₹${pos.target}` });
    }
    const ct = ctx.contracts[pos.key];
    if (c.recoveryExit && ct) {
      const ind = evaluateOptionBreakdown(ct.bars1m, c.timeframe as 1 | 3 | 5, ctx.nowIstMs, {
        stPeriod: num(c, 'stPeriod') || 10,
        stMultiplier: num(c, 'stMultiplier') || 2.0,
        emaPeriod: num(c, 'emaPeriod') || 20,
        useSupertrend: c.useSupertrend !== false,
        useVwap: c.useVwap !== false,
        useEma: c.useEma !== false,
      });
      const aboveSt = c.useSupertrend !== false && ind.indicators.stLine != null && px > ind.indicators.stLine;
      const aboveEma = c.useEma !== false && ind.indicators.ema != null && px > ind.indicators.ema;
      if (aboveSt || aboveEma) {
        const recoveryLevel = aboveSt ? ind.indicators.stLine! : ind.indicators.ema!;
        exits.push({
          kind: 'RECOVERY',
          level: r2(recoveryLevel),
          reason: `Premium recovered above ${aboveSt ? 'Supertrend' : 'EMA'} ₹${recoveryLevel.toFixed(1)}`,
        });
      }
    }
    return { stop, exits };
  },

  columns: {
    scanner: [
      { key: 'st', label: 'Supertrend', fmt: 'num', digits: 1 },
      { key: 'vwap', label: 'VWAP', fmt: 'num', digits: 1 },
      { key: 'ema', label: 'EMA', fmt: 'num', digits: 1 },
      { key: 'depth', label: '% below', fmt: 'pct', digits: 1 },
      { key: 'age', label: 'Age', fmt: 'int' },
      { key: 'steps', label: 'Strikes from ATM', fmt: 'int' },
    ],
  },
};


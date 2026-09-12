'use client';

import React, { useState, useMemo } from 'react';
import { Activity, AlertCircle, ArrowDown, ArrowUp, Gauge, ShieldAlert, Sliders, Zap } from 'lucide-react';
import type { ScalperPosition } from '@/lib/zerodhaShape';
import { underlyingOfSymbol, type AnalyticsUnderlying } from '@/lib/analyticsUnderlyings';

interface Props {
  positions: ScalperPosition[];
  broker: string;
}

export default function PortfolioGreeksDesk({ positions, broker }: Props) {
  const [spotShiftPct, setSpotShiftPct] = useState<number>(0);
  const [vixShift, setVixShift] = useState<number>(0);
  const [daysElapsed, setDaysElapsed] = useState<number>(1);

  // Group and extract option characteristics
  const analysis = useMemo(() => {
    let totalRealized = 0;
    let totalUnrealized = 0;
    let totalShortLots = 0;
    let totalLongLots = 0;
    let ceCount = 0;
    let peCount = 0;
    let totalEstTheta = 0;
    let totalEstRupeeDelta = 0;
    let totalEstVega = 0;

    for (const p of positions) {
      if (!p || !p.netQty) continue;
      const sym = p.tradingSymbol ?? '';
      const isCE = sym.endsWith('CE');
      const isPE = sym.endsWith('PE');
      const lots = Math.abs(p.netQty) / 65; // approx standard index lot
      const isShort = p.netQty < 0;

      if (isShort) totalShortLots += lots;
      else totalLongLots += lots;

      if (isCE) ceCount += 1;
      if (isPE) peCount += 1;

      totalRealized += (p.realizedProfit ?? 0);
      totalUnrealized += (p.unrealizedProfit ?? 0);

      // Estimate delta direction
      // Selling CE = -Delta, Selling PE = +Delta
      // Buying CE = +Delta, Buying PE = -Delta
      const dirSign = isShort ? -1 : 1;
      const optionSign = isCE ? 1 : -1;
      const estLegDelta = dirSign * optionSign * 0.45 * Math.abs(p.netQty);
      totalEstRupeeDelta += estLegDelta * 240; // ~₹ per point for delta

      // Estimate theta
      // Short options capture theta (decay)
      const ltp = p.lastTradedPrice || 100;
      const legThetaDay = isShort ? (ltp * 0.15 * Math.abs(p.netQty)) : -(ltp * 0.15 * Math.abs(p.netQty));
      totalEstTheta += legThetaDay;

      // Estimate vega
      // Short options are short vega
      const legVega = isShort ? -(ltp * 0.08 * Math.abs(p.netQty)) : (ltp * 0.08 * Math.abs(p.netQty));
      totalEstVega += legVega;
    }

    const totalPnl = totalRealized + totalUnrealized;

    return {
      totalPnl,
      totalRealized,
      totalUnrealized,
      totalShortLots,
      totalLongLots,
      ceCount,
      peCount,
      totalEstTheta,
      totalEstRupeeDelta,
      totalEstVega,
      activeLegs: ceCount + peCount,
    };
  }, [positions]);

  // Projected Scenario P&L
  const projectedPnl = useMemo(() => {
    // Delta PnL
    const deltaImpact = (spotShiftPct / 100.0) * (analysis.totalEstRupeeDelta * 100);
    // Theta PnL
    const thetaImpact = analysis.totalEstTheta * daysElapsed;
    // Vega PnL
    const vegaImpact = analysis.totalEstVega * vixShift;

    const estimatedShift = deltaImpact + thetaImpact + vegaImpact;
    return {
      deltaImpact,
      thetaImpact,
      vegaImpact,
      totalShift: estimatedShift,
      projectedTotal: analysis.totalPnl + estimatedShift,
    };
  }, [spotShiftPct, vixShift, daysElapsed, analysis]);

  if (analysis.activeLegs === 0) {
    return null;
  }

  function fmtInr(n: number) {
    const abs = Math.abs(n);
    return `${n < 0 ? '-' : '+'}₹${abs.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
  }

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5 backdrop-blur-md shadow-xl">
      <div className="flex items-center justify-between gap-3 mb-4 pb-3 border-b border-zinc-800 flex-wrap">
        <div className="flex items-center gap-2">
          <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-indigo-500/10 border border-indigo-500/25">
            <Gauge className="w-4 h-4 text-indigo-400" />
          </div>
          <div>
            <h3 className="text-xs font-bold text-white uppercase tracking-wider">
              Portfolio Greeks &amp; Scenario Stress Desk
            </h3>
            <p className="text-[10px] text-zinc-500">
              Aggregated exposure across {analysis.activeLegs} open legs ({broker.toUpperCase()})
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-xs font-mono font-bold px-2.5 py-1 rounded-lg bg-zinc-950 border border-zinc-800 text-zinc-300">
            Book P&amp;L: <span className={analysis.totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>{fmtInr(analysis.totalPnl)}</span>
          </span>
        </div>
      </div>

      {/* Greek Exposure Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5">
        {/* Net Delta Exposure */}
        <div className="bg-zinc-950/60 border border-zinc-800/80 rounded-xl p-3">
          <span className="text-[9px] font-bold text-zinc-500 uppercase tracking-wider block mb-1">
            Net Directional Delta
          </span>
          <div className={`text-base font-mono font-bold ${
            analysis.totalEstRupeeDelta > 500 ? 'text-emerald-400' : analysis.totalEstRupeeDelta < -500 ? 'text-red-400' : 'text-zinc-200'
          }`}>
            {fmtInr(analysis.totalEstRupeeDelta)} <span className="text-[10px] text-zinc-500 font-normal">/ 100 pt index move</span>
          </div>
          <span className="text-[10px] text-zinc-500 mt-1 block">
            {analysis.totalEstRupeeDelta > 500 ? 'Net Bullish Lean' : analysis.totalEstRupeeDelta < -500 ? 'Net Bearish Lean' : 'Delta Neutral'}
          </span>
        </div>

        {/* Daily Theta Cash Flow */}
        <div className="bg-zinc-950/60 border border-zinc-800/80 rounded-xl p-3">
          <span className="text-[9px] font-bold text-emerald-400 uppercase tracking-wider block mb-1">
            Expected Daily Theta Decay
          </span>
          <div className="text-base font-mono font-bold text-emerald-400">
            {fmtInr(analysis.totalEstTheta)} <span className="text-[10px] text-zinc-500 font-normal">/ 24 hrs</span>
          </div>
          <span className="text-[10px] text-zinc-500 mt-1 block">
            {analysis.totalShortLots.toFixed(0)} Short Lots · {analysis.totalLongLots.toFixed(0)} Long Lots
          </span>
        </div>

        {/* Vega Shock Sensitivity */}
        <div className="bg-zinc-950/60 border border-zinc-800/80 rounded-xl p-3">
          <span className="text-[9px] font-bold text-purple-400 uppercase tracking-wider block mb-1">
            Vega Shock Risk
          </span>
          <div className={`text-base font-mono font-bold ${analysis.totalEstVega < 0 ? 'text-rose-400' : 'text-zinc-200'}`}>
            {fmtInr(analysis.totalEstVega)} <span className="text-[10px] text-zinc-500 font-normal">per +1.0 VIX point</span>
          </div>
          <span className="text-[10px] text-zinc-500 mt-1 block">
            {analysis.totalEstVega < 0 ? 'Short Volatility (VIX crush profits)' : 'Long Volatility'}
          </span>
        </div>
      </div>

      {/* Scenario Stress Simulator */}
      <div className="bg-zinc-950/40 border border-zinc-800 rounded-xl p-4">
        <div className="flex items-center justify-between gap-2 mb-3">
          <div className="flex items-center gap-1.5">
            <Sliders className="w-3.5 h-3.5 text-zinc-400" />
            <span className="text-[11px] font-bold text-zinc-300 uppercase tracking-wider">
              Interactive Scenario Stress Simulator
            </span>
          </div>
          <button
            onClick={() => { setSpotShiftPct(0); setVixShift(0); setDaysElapsed(1); }}
            className="text-[10px] font-bold text-zinc-400 hover:text-zinc-200"
          >
            Reset
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
          {/* Market Spot Move Slider */}
          <div>
            <div className="flex justify-between text-xs font-mono mb-1">
              <span className="text-zinc-400">Market Move:</span>
              <span className={`font-bold ${spotShiftPct > 0 ? 'text-emerald-400' : spotShiftPct < 0 ? 'text-red-400' : 'text-zinc-300'}`}>
                {spotShiftPct > 0 ? `+${spotShiftPct}` : spotShiftPct}%
              </span>
            </div>
            <input
              type="range"
              min="-3"
              max="3"
              step="0.5"
              value={spotShiftPct}
              onChange={e => setSpotShiftPct(Number(e.target.value))}
              className="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-indigo-500"
            />
            <div className="flex justify-between text-[9px] text-zinc-600 font-mono mt-1">
              <span>-3% (Crash)</span>
              <span>0%</span>
              <span>+3% (Rally)</span>
            </div>
          </div>

          {/* VIX Shock Slider */}
          <div>
            <div className="flex justify-between text-xs font-mono mb-1">
              <span className="text-zinc-400">VIX Shift:</span>
              <span className={`font-bold ${vixShift > 0 ? 'text-amber-400' : vixShift < 0 ? 'text-purple-400' : 'text-zinc-300'}`}>
                {vixShift > 0 ? `+${vixShift}` : vixShift} pts
              </span>
            </div>
            <input
              type="range"
              min="-4"
              max="6"
              step="1"
              value={vixShift}
              onChange={e => setVixShift(Number(e.target.value))}
              className="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-purple-500"
            />
            <div className="flex justify-between text-[9px] text-zinc-600 font-mono mt-1">
              <span>-4 (Crush)</span>
              <span>0</span>
              <span>+6 (Spike)</span>
            </div>
          </div>

          {/* Days Elapsed */}
          <div>
            <div className="flex justify-between text-xs font-mono mb-1">
              <span className="text-zinc-400">Holding Time:</span>
              <span className="font-bold text-zinc-200">+{daysElapsed} Day{daysElapsed > 1 ? 's' : ''}</span>
            </div>
            <input
              type="range"
              min="0"
              max="5"
              step="1"
              value={daysElapsed}
              onChange={e => setDaysElapsed(Number(e.target.value))}
              className="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-emerald-500"
            />
            <div className="flex justify-between text-[9px] text-zinc-600 font-mono mt-1">
              <span>Today (0d)</span>
              <span>+1d</span>
              <span>+5d (Expiry)</span>
            </div>
          </div>
        </div>

        {/* Projected Outcome Banner */}
        <div className="flex items-center justify-between p-3 rounded-xl bg-zinc-900 border border-zinc-800 flex-wrap gap-3">
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-indigo-400" />
            <span className="text-xs font-bold text-zinc-200">
              Projected Scenario P&amp;L:
            </span>
          </div>

          <div className="flex items-center gap-4 font-mono text-xs">
            <span className="text-zinc-400">
              Delta: <span className={projectedPnl.deltaImpact >= 0 ? 'text-emerald-400' : 'text-red-400'}>{fmtInr(projectedPnl.deltaImpact)}</span>
            </span>
            <span className="text-zinc-400">
              Theta: <span className="text-emerald-400">{fmtInr(projectedPnl.thetaImpact)}</span>
            </span>
            <span className="text-zinc-400">
              Vega: <span className={projectedPnl.vegaImpact >= 0 ? 'text-emerald-400' : 'text-red-400'}>{fmtInr(projectedPnl.vegaImpact)}</span>
            </span>
            <span className="w-px h-4 bg-zinc-700" />
            <span className="font-bold text-sm">
              Net Impact: <span className={projectedPnl.totalShift >= 0 ? 'text-emerald-400 font-bold' : 'text-red-400 font-bold'}>{fmtInr(projectedPnl.totalShift)}</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

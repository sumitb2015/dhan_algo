'use client';

import { X, ChevronLeft, ChevronRight, Copy, Check } from 'lucide-react';
import type { Goal, ScatterPoint } from '@/lib/optionScatter3d';
import { CE_COLOR, PE_COLOR, SIGNAL_COLOR, fmtOi, sgn } from './shared';
import { BiasGauge } from './BiasGauge';

interface Props {
  point: ScatterPoint;
  goal: Goal;
  score: number | null;
  copied: boolean;
  onCopy: () => void;
  onNavigate: (dir: 'prev' | 'next') => void;
  onClose: () => void;
}

/** Pinned-contract card docked in the viewport's bottom-right corner. */
export function InspectorCard({ point, goal, score, copied, onCopy, onNavigate, onClose }: Props) {
  return (
          <div className="absolute bottom-4 right-4 z-20 w-84 bg-zinc-950/92 border border-zinc-700/80 backdrop-blur-lg rounded-2xl p-4 shadow-2xl text-xs space-y-3 animate-in fade-in slide-in-from-bottom-3 duration-200">
            <div className="flex items-center justify-between pb-2 border-b border-zinc-800">
              <div className="flex items-center gap-2">
                <span
                  className="px-2 py-0.5 rounded font-black text-xs text-oncolor"
                  style={{ backgroundColor: point.side === 'CE' ? CE_COLOR : PE_COLOR }}
                >
                  {point.strike} {point.side}
                </span>
                <span className="text-zinc-400 font-mono font-semibold">
                  ₹{point.ltp.toFixed(2)}
                </span>
                <span className={`font-mono text-[11px] font-bold ${point.priceChg >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {sgn(point.priceChg)}%
                </span>
              </div>
              <button
                onClick={onClose}
                aria-label="Close inspector"
                className="text-zinc-400 hover:text-white p-0.5 rounded-md hover:bg-zinc-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Moneyness & Delta Banner */}
            <div className="flex items-center justify-between text-[11px] bg-zinc-900/80 px-2.5 py-1.5 rounded-lg border border-zinc-800">
              <div className="flex items-center gap-1.5">
                <span className="text-zinc-500 font-bold uppercase">Moneyness:</span>
                <span className="text-zinc-200 font-semibold">{point.moneyness} ({sgn(point.distPct, 1)}%)</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-zinc-500 font-bold uppercase">Delta:</span>
                <span className="text-zinc-200 font-mono font-bold">
                  {point.delta !== null ? point.delta.toFixed(2) : '—'}
                </span>
              </div>
            </div>

            {/* 4-Box Metrics Grid */}
            <div className="grid grid-cols-2 gap-2 text-[11px]">
              <div className="bg-zinc-900/60 p-2 rounded-lg border border-zinc-800/80">
                <p className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider">Open Interest</p>
                <p className="text-zinc-100 font-mono font-bold text-xs mt-0.5">{fmtOi(point.oi)}</p>
                <p className={`text-[10px] font-mono mt-0.5 ${point.oiChg >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  Chg: {sgn(point.oiChg)}%
                </p>
              </div>

              <div className="bg-zinc-900/60 p-2 rounded-lg border border-zinc-800/80">
                <p className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider">Implied Vol</p>
                <p className="text-zinc-100 font-mono font-bold text-xs mt-0.5">{point.iv.toFixed(1)}%</p>
                <p className={`text-[10px] font-mono mt-0.5 ${point.ivResidual >= 0 ? 'text-amber-400' : 'text-sky-400'}`}>
                  Skew: {sgn(point.ivResidual)}% vs nbrs
                </p>
              </div>

              <div className="bg-zinc-900/60 p-2 rounded-lg border border-zinc-800/80">
                <p className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider">Volume</p>
                <p className="text-zinc-100 font-mono font-bold text-xs mt-0.5">
                  {point.volume > 0 ? fmtOi(point.volume) : '—'}
                </p>
              </div>

              <div className="bg-zinc-900/60 p-2 rounded-lg border border-zinc-800/80">
                <p className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider">Market Signal</p>
                <p className="font-semibold text-xs mt-0.5" style={{ color: SIGNAL_COLOR[point.signal] }}>
                  {point.signal}
                </p>
              </div>
            </div>

            <BiasGauge point={point} />

            {/* Score Progress Gauge */}
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[10px]">
                <span className="text-zinc-400 font-bold uppercase">
                  {goal === 'buy' ? 'Algorithmic Buy Score' : 'Algorithmic Sell Score'}
                </span>
                <span className="font-mono font-bold text-emerald-400">
                  {score ?? '—'}/100
                </span>
              </div>
              <div className="w-full bg-zinc-800 h-1.5 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-emerald-600 to-lime-400 rounded-full transition-all duration-300"
                  style={{ width: `${Math.min(100, Math.max(0, score ?? 0))}%` }}
                />
              </div>
            </div>

            {/* Strike Stepper & Quick Copy Actions */}
            <div className="flex items-center justify-between pt-1 gap-2 border-t border-zinc-800/80">
              <div className="flex items-center gap-1">
                <button
                  onClick={() => onNavigate('prev')}
                  className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-[11px] font-semibold flex items-center gap-0.5"
                >
                  <ChevronLeft className="w-3 h-3" /> Prev
                </button>
                <button
                  onClick={() => onNavigate('next')}
                  className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-[11px] font-semibold flex items-center gap-0.5"
                >
                  Next <ChevronRight className="w-3 h-3" />
                </button>
              </div>

              <button
                onClick={onCopy}
                className="px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white text-[11px] font-semibold flex items-center gap-1 transition-colors"
              >
                {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
  );
}

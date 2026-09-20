'use client';

import type { ScatterPoint } from '@/lib/optionScatter3d';
import { CE_COLOR, PE_COLOR, SIGNAL_COLOR, fmtOi, rgba, sgn } from './shared';
import { BiasGauge } from './BiasGauge';

/** Cursor-following tooltip card. Positioning is done by the parent (imperatively, no re-render). */
export function HoverCard({ point }: { point: ScatterPoint }) {
  return (
            <div className="w-72 bg-zinc-950/95 border border-zinc-700/90 backdrop-blur-xl rounded-xl p-3 shadow-2xl text-xs space-y-2.5 animate-in fade-in zoom-in-95 duration-100">
              {/* Header */}
              <div className="flex items-center justify-between pb-1.5 border-b border-zinc-800">
                <div className="flex items-center gap-1.5">
                  <span
                    className="px-2 py-0.5 rounded font-black text-xs text-oncolor shadow-sm"
                    style={{ backgroundColor: point.side === 'CE' ? CE_COLOR : PE_COLOR }}
                  >
                    {point.strike} {point.side}
                  </span>
                  <span className="text-zinc-300 font-mono font-bold">
                    ₹{point.ltp.toFixed(2)}
                  </span>
                </div>
                <span className={`font-mono text-xs font-bold ${point.priceChg >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {sgn(point.priceChg)}%
                </span>
              </div>

              {/* Moneyness & Delta strip */}
              <div className="flex items-center justify-between text-[11px] text-zinc-400 bg-zinc-900/80 px-2 py-1 rounded-md border border-zinc-800/80">
                <span>{point.moneyness} ({sgn(point.distPct, 1)}%)</span>
                <span>Δ: <strong className="text-zinc-200 font-mono">{point.delta !== null ? point.delta.toFixed(2) : '—'}</strong></span>
                <span>IV: <strong className="text-zinc-200 font-mono">{point.iv.toFixed(1)}%</strong></span>
              </div>

              {/* OI & Vol row */}
              <div className="grid grid-cols-2 gap-1.5 text-[11px]">
                <div className="bg-zinc-900/60 px-2 py-1 rounded border border-zinc-800/60">
                  <span className="text-[10px] text-zinc-500 font-bold uppercase">OI: </span>
                  <span className="text-zinc-200 font-mono font-bold">{fmtOi(point.oi)}</span>
                  <span className={`text-[10px] font-mono ml-1 ${point.oiChg >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    ({sgn(point.oiChg)}%)
                  </span>
                </div>
                <div className="bg-zinc-900/60 px-2 py-1 rounded border border-zinc-800/60">
                  <span className="text-[10px] text-zinc-500 font-bold uppercase">Vol: </span>
                  <span className="text-zinc-200 font-mono font-bold">{point.volume > 0 ? fmtOi(point.volume) : '—'}</span>
                </div>
              </div>

              {/* Signal Badge */}
              <div className="flex items-center justify-between text-[11px] pt-0.5">
                <span className="text-[10px] text-zinc-500 font-bold uppercase">Signal:</span>
                <span
                  className="font-bold text-[11px] px-2 py-0.5 rounded-full"
                  style={{
                    backgroundColor: rgba(SIGNAL_COLOR[point.signal], 0.15),
                    color: SIGNAL_COLOR[point.signal],
                  }}
                >
                  {point.signal}
                </span>
              </div>

              <BiasGauge point={point} />

              <div className="text-[10px] text-zinc-500 text-center pt-0.5 border-t border-zinc-900">
                Click point to pin in Inspector
              </div>
            </div>
  );
}

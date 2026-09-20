'use client';

import { directionalBias, type Goal, type ScatterPoint } from '@/lib/optionScatter3d';
import { CE_COLOR, PE_COLOR, SIGNAL_COLOR, fmtOi, sgn } from './shared';

interface Props {
  candidates: ScatterPoint[];
  goal: Goal;
  selected: string | null;
  sortCol: string;
  sortAsc: boolean;
  scoreOf: (p: ScatterPoint) => number | null;
  onSelect: (key: string) => void;
  onSort: (col: string) => void;
}

export function CandidatesTable({ candidates, goal, selected, sortCol, sortAsc, scoreOf, onSelect, onSort }: Props) {
  return (
      <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl overflow-hidden shadow-lg w-full min-w-0">
        <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-xs font-bold text-white flex items-center gap-2">
              Top Ranked {goal === 'buy' ? 'Buy' : 'Sell'} Opportunities
              <span className="text-[10px] font-normal text-zinc-400">
                ({candidates.length} strikes meeting criteria)
              </span>
            </h2>
            <p className="text-[10px] text-zinc-500 mt-0.5">
              {goal === 'buy'
                ? 'Rising premium + Fresh accumulation + Low IV residual vs neighbours · Δ within 0.20–0.70'
                : 'Bleeding premium + Fresh writer OI + Rich IV residual vs neighbours · Δ within 0.05–0.40'}
            </p>
          </div>

          <div className="text-[11px] text-zinc-400">
            Click any row to pin & target in 3D
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs tabular-nums">
            <thead>
              <tr className="bg-zinc-800">
                {[
                  { id: 'strike', label: 'Strike' },
                  { id: 'side', label: 'Side' },
                  { id: 'ltp', label: 'LTP' },
                  { id: 'priceChg', label: 'Price %' },
                  { id: 'oi', label: 'OI' },
                  { id: 'oiChg', label: 'OI %' },
                  { id: 'iv', label: 'IV %' },
                  { id: 'ivResidual', label: 'IV vs nbrs' },
                  { id: 'delta', label: 'Δ' },
                  { id: 'signal', label: 'Signal' },
                  { id: 'score', label: 'Quant Score' },
                ].map(h => (
                  <th
                    key={h.id}
                    onClick={() => onSort(h.id)}
                    className="px-3 py-2 text-left text-xs font-bold text-white whitespace-nowrap cursor-pointer hover:bg-zinc-700/60 transition-colors select-none"
                  >
                    <div className="flex items-center gap-1">
                      {h.label}
                      {sortCol === h.id && (
                        <span className="text-emerald-400 text-[10px]">{sortAsc ? '▲' : '▼'}</span>
                      )}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {candidates.map(p => {
                const isSel = selected === p.key;
                const sc = scoreOf(p);
                return (
                  <tr
                    key={p.key}
                    onClick={() => onSelect(p.key)}
                    className={`border-t border-zinc-800/80 cursor-pointer transition-colors ${
                      isSel ? 'bg-cyan-950/40 border-l-2 border-l-cyan-400' : 'hover:bg-zinc-800/50'
                    }`}
                  >
                    <td className="px-3 py-2 font-mono font-bold text-zinc-100">{p.strike}</td>
                    <td className="px-3 py-2 font-bold" style={{ color: p.side === 'CE' ? CE_COLOR : PE_COLOR }}>
                      {p.side}
                    </td>
                    <td className="px-3 py-2 font-mono text-zinc-200">₹{p.ltp.toFixed(2)}</td>
                    <td className={`px-3 py-2 font-mono font-semibold ${p.priceChg >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {sgn(p.priceChg)}%
                    </td>
                    <td className="px-3 py-2 font-mono text-zinc-300">{fmtOi(p.oi)}</td>
                    <td className={`px-3 py-2 font-mono ${p.oiChg >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {sgn(p.oiChg)}%
                    </td>
                    <td className="px-3 py-2 font-mono text-zinc-200">{p.iv.toFixed(1)}%</td>
                    <td className={`px-3 py-2 font-mono ${p.ivResidual >= 0 ? 'text-amber-400' : 'text-sky-400'}`}>
                      {sgn(p.ivResidual)}%
                    </td>
                    <td className="px-3 py-2 font-mono text-zinc-300">{p.delta !== null ? p.delta.toFixed(2) : '—'}</td>
                    <td className="px-3 py-2 font-semibold whitespace-nowrap">
                      <div className="flex items-center gap-1.5">
                        <span style={{ color: SIGNAL_COLOR[p.signal] }}>{p.signal}</span>
                        {(() => {
                          const b = directionalBias(p);
                          const bear = b.dir === 'bearish';
                          return (
                            <span
                              className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded ${bear ? 'bg-rose-500/15 text-rose-400' : 'bg-emerald-500/15 text-emerald-400'}`}
                              title={`${bear ? 'Bearish' : 'Bullish'} bias for the underlying`}
                            >
                              {bear ? 'Bear' : 'Bull'} {b.strength}%
                            </span>
                          );
                        })()}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-bold text-emerald-400 w-7">{sc ?? '—'}</span>
                        <div className="w-16 bg-zinc-800 h-1.5 rounded-full overflow-hidden hidden sm:block">
                          <div
                            className="h-full bg-emerald-500 rounded-full"
                            style={{ width: `${Math.min(100, Math.max(0, sc ?? 0))}%` }}
                          />
                        </div>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!candidates.length && (
                <tr>
                  <td colSpan={11} className="px-3 py-8 text-center text-zinc-500">
                    No candidates qualify under the active filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
  );
}

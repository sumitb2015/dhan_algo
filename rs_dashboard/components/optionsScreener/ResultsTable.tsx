'use client';

import { Info } from 'lucide-react';
import type { ResultRow } from '@/lib/optionsScreener';
import { FOCUS_RING, fmtCompact, fmtExpiry, fmtIstTime, fmtPct, fmtPrice, fmtSigned, fmtStrike, toneClass } from './format';

export interface SeenInfo {
  first: number;   // epoch seconds first seen
  isNew: boolean;  // not yet acknowledged
}

interface Props {
  rows: ResultRow[];
  seen: Record<string, SeenInfo>;
  windowLabel: string;
  timeLabel: string;
  highlightNew?: boolean;
  onOpen: (row: ResultRow) => void;
  emptyText: string;
}

export function MoneyChip({ money }: { money: string }) {
  const cls = money === 'ATM'
    ? 'bg-amber-500/10 text-amber-300 border-amber-500/30'
    : money.startsWith('ITM')
      ? 'bg-sky-500/10 text-sky-300 border-sky-500/30'
      : 'bg-zinc-800 text-zinc-300 border-zinc-700';
  return <span className={`px-1 py-px rounded border text-[9px] font-bold tracking-wide ${cls}`}>{money}</span>;
}

export function TypeChip({ t }: { t: 'CE' | 'PE' }) {
  return (
    <span className={`px-1 py-px rounded text-[9px] font-bold ${
      t === 'CE' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-red-500/15 text-red-300'
    }`}>
      {t}
    </span>
  );
}

export function contractLabel(r: Pick<ResultRow, 'u' | 'e' | 's'>): string {
  return `${r.u} ${fmtExpiry(r.e)} ${fmtStrike(r.s)}`;
}

export default function ResultsTable({ rows, seen, windowLabel, timeLabel, highlightNew, onOpen, emptyText }: Props) {
  if (rows.length === 0) {
    return <div className="px-4 py-8 text-center text-xs text-zinc-500">{emptyText}</div>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[680px] text-xs tabular-nums">
        <thead className="sticky top-0 z-10">
          <tr className="bg-zinc-800 text-left">
            <th className="px-3 py-1.5 text-xs font-bold text-white w-14">{timeLabel}</th>
            <th className="px-2 py-1.5 text-xs font-bold text-white">CONTRACT</th>
            <th className="px-2 py-1.5 text-xs font-bold text-white text-right whitespace-nowrap">PRICE · {windowLabel}</th>
            <th className="px-2 py-1.5 text-xs font-bold text-white text-right whitespace-nowrap">OI · Δ</th>
            <th className="px-2 py-1.5 text-xs font-bold text-white text-right whitespace-nowrap">VOL · RVOL</th>
            <th className="px-2 py-1.5 text-xs font-bold text-white text-right whitespace-nowrap">IV · Δ</th>
            <th className="px-2 py-1.5 w-8"><span className="sr-only">Details</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const s = seen[r.id];
            const isNew = highlightNew && s?.isNew;
            return (
              <tr
                key={r.id}
                onClick={() => onOpen(r)}
                className={`border-b border-zinc-800/70 cursor-pointer transition-colors ${
                  isNew ? 'bg-amber-500/10 hover:bg-amber-500/15' : 'hover:bg-zinc-900'
                } ${r.active ? '' : 'opacity-60'}`}
              >
                <td className={`px-3 py-1.5 font-mono text-zinc-400 ${isNew ? 'border-l-2 border-amber-400' : ''}`}>
                  <div className="flex items-center gap-1.5">
                    {fmtIstTime(s?.first ?? r.ts)}
                    {isNew && <span className="text-[9px] font-bold text-amber-300">NEW</span>}
                  </div>
                </td>
                <td className="px-2 py-1.5">
                  <div className="flex items-center gap-1.5 whitespace-nowrap">
                    <span className="font-bold text-zinc-100">{contractLabel(r)}</span>
                    <TypeChip t={r.t} />
                    <MoneyChip money={r.money} />
                    {r.tags.map((t) => (
                      <span key={t} className="px-1 py-px rounded bg-zinc-800 border border-zinc-700 text-[9px] font-bold text-zinc-300">
                        {t}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="px-2 py-1.5 text-right whitespace-nowrap">
                  <span className="text-zinc-100 font-semibold">{fmtPrice(r.ltp)}</span>{' '}
                  <span className={toneClass(r.pPct)}>{fmtPct(r.pPct)}</span>
                </td>
                <td className="px-2 py-1.5 text-right whitespace-nowrap">
                  <span className="text-zinc-200">{fmtCompact(r.oi)}</span>{' '}
                  <span className={toneClass(r.oiPct)}>{fmtPct(r.oiPct, 1)}</span>
                </td>
                <td className="px-2 py-1.5 text-right whitespace-nowrap">
                  <span className="text-zinc-200">{fmtCompact(r.winVol)}</span>{' '}
                  <span className="text-zinc-400">{r.rvol == null ? '—' : `${r.rvol.toFixed(1)}×`}</span>
                </td>
                <td className="px-2 py-1.5 text-right whitespace-nowrap">
                  {r.iv == null ? (
                    <span className="text-zinc-500" title="No IV: premium outside no-arbitrage bounds (deep ITM / stale print)">—</span>
                  ) : (
                    <>
                      <span className="text-zinc-200">{r.iv.toFixed(1)}</span>{' '}
                      <span className={toneClass(r.ivChg)}>{fmtSigned(r.ivChg)}</span>
                    </>
                  )}
                </td>
                <td className="px-2 py-1.5 text-right">
                  <button
                    type="button"
                    aria-label={`Details and trade ${contractLabel(r)} ${r.t}`}
                    title="Details & trade"
                    onClick={(e) => { e.stopPropagation(); onOpen(r); }}
                    className={`inline-flex items-center justify-center w-5 h-5 rounded-full border border-zinc-700 text-zinc-400 hover:text-zinc-100 hover:border-zinc-500 ${FOCUS_RING}`}
                  >
                    <Info className="w-3 h-3" />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

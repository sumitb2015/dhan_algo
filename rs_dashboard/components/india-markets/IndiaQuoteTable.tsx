'use client';

import { cn } from '@/lib/utils';
import type { IndiaRow } from '@/lib/indiaMarkets';
import { compact, pctText, signCls } from '@/components/us-markets/format';
import { inr } from './format';

interface Col { key: string; label: string; align: 'l' | 'r'; cell: (r: IndiaRow) => React.ReactNode }

function RangeBar({ pos }: { pos: number | null }) {
  if (pos == null) return <span className="text-zinc-500">–</span>;
  return (
    <span className="inline-block align-middle w-20 h-1.5 rounded-full bg-zinc-800 relative" title={`${Math.round(pos * 100)}% of the 52-week range`}>
      <span className="absolute top-1/2 -translate-y-1/2 h-2.5 w-1 rounded-sm bg-emerald-400" style={{ left: `calc(${pos * 100}% - 2px)` }} />
    </span>
  );
}

const COLS: Col[] = [
  { key: 'sym', label: 'Symbol', align: 'l', cell: r => (
    <span className="flex flex-col leading-tight">
      <span className="font-bold text-zinc-100">{r.symbol}</span>
      <span className="text-[10px] text-zinc-500 truncate max-w-[16rem]">{r.name}{r.industry ? ` · ${r.industry}` : ''}</span>
    </span>) },
  { key: 'ltp', label: 'LTP', align: 'r', cell: r => <span className={cn('font-semibold', signCls(r.change))}>{inr(r.ltp)}</span> },
  { key: 'chg', label: 'Chg', align: 'r', cell: r => <span className={signCls(r.change)}>{r.change == null ? '–' : (r.change > 0 ? '+' : '') + inr(r.change)}</span> },
  { key: 'pct', label: 'Chg %', align: 'r', cell: r => <span className={signCls(r.changePct)}>{pctText(r.changePct)}</span> },
  { key: 'open', label: 'Open', align: 'r', cell: r => inr(r.open) },
  { key: 'high', label: 'High', align: 'r', cell: r => inr(r.high) },
  { key: 'low', label: 'Low', align: 'r', cell: r => inr(r.low) },
  { key: 'vwap', label: 'VWAP', align: 'r', cell: r => <span className={r.ltp != null && r.vwap != null ? (r.ltp >= r.vwap ? 'text-emerald-400' : 'text-red-400') : ''}>{inr(r.vwap)}</span> },
  { key: 'prev', label: 'Prev close', align: 'r', cell: r => inr(r.prevClose) },
  { key: 'vol', label: 'Volume', align: 'r', cell: r => compact(r.volume) },
  { key: 'to', label: 'Turnover ₹Cr', align: 'r', cell: r => (r.turnoverCr == null ? '–' : r.turnoverCr.toLocaleString('en-IN', { maximumFractionDigits: 1 })) },
  { key: 'wk', label: '52-wk range', align: 'r', cell: r => (
    <span className="inline-flex items-center gap-2 justify-end">
      <span className="text-[10px] text-zinc-500">{inr(r.low52, 0)}</span><RangeBar pos={r.wk52Pos} /><span className="text-[10px] text-zinc-500">{inr(r.high52, 0)}</span>
    </span>) },
];

/** Constituent table for a drilled-down index or industry, sorted by % change (unquoted last). */
export default function IndiaQuoteTable({ rows }: { rows: readonly IndiaRow[] }) {
  const sorted = [...rows].sort((a, b) => (b.changePct ?? -Infinity) - (a.changePct ?? -Infinity));
  return (
    <div className="overflow-auto max-h-[32rem] rounded-lg border border-zinc-800">
      <table className="w-full text-xs tabular-nums">
        <thead className="sticky top-0 z-10">
          <tr>{COLS.map(c => <th key={c.key} scope="col" className={cn('px-3 py-2 text-xs font-bold text-white bg-zinc-800 whitespace-nowrap', c.align === 'r' ? 'text-right' : 'text-left')}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {sorted.map(r => (
            <tr key={r.id} className="border-t border-zinc-800 hover:bg-zinc-900">
              {COLS.map(c => <td key={c.key} className={cn('px-3 py-1.5 whitespace-nowrap text-zinc-200', c.align === 'r' ? 'text-right' : 'text-left')}>{c.cell(r)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

'use client';

import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { UsQuoteRow } from '@/lib/usStocks';
import { ageText, compact, signCls, usd } from './format';

interface Col { key: string; label: string; align: 'l' | 'r'; cell: (r: UsQuoteRow) => React.ReactNode }

function RangeBar({ pos }: { pos: number | null }) {
  if (pos == null) return <span className="text-zinc-500">–</span>;
  return (
    <span className="inline-block align-middle w-20 h-1.5 rounded-full bg-zinc-800 relative" title={`${Math.round(pos * 100)}% of the 52-week range`}>
      <span className="absolute top-1/2 -translate-y-1/2 h-2.5 w-1 rounded-sm bg-emerald-400" style={{ left: `calc(${pos * 100}% - 2px)` }} />
    </span>
  );
}

interface Props {
  rows: readonly UsQuoteRow[];
  /** Browser clock minus the server's timestamp, so "last trade" keeps ageing on a page that stopped receiving data. */
  clockSkewMs: number;
  /** Optional label per row (e.g. the sector), shown under the symbol. */
  tag?: (r: UsQuoteRow) => string | null;
  onRemove?: (r: UsQuoteRow) => void;
  busyKey?: string | null;
}

/** The quote table shared by the Watchlist tab and the dashboard's group drill-down. */
export default function UsQuoteTable({ rows, clockSkewMs, tag, onRemove, busyKey }: Props) {
  const columns: Col[] = [
    { key: 'sym', label: 'Symbol', align: 'l', cell: r => (
      <span className="flex flex-col leading-tight">
        <span className="font-bold text-zinc-100">{r.symbol}<span className="ml-2 text-[10px] font-medium text-zinc-500">{r.exchange}</span></span>
        <span className="text-[10px] text-zinc-500 truncate max-w-[16rem]">{r.name}{tag?.(r) ? ` · ${tag(r)}` : ''}</span>
      </span>) },
    { key: 'ltp', label: 'Last', align: 'r', cell: r => <span className={cn('font-semibold', signCls(r.change))}>{usd(r.ltp)}</span> },
    { key: 'chg', label: 'Chg', align: 'r', cell: r => <span className={signCls(r.change)}>{r.change == null ? '–' : (r.change > 0 ? '+' : '') + usd(r.change)}</span> },
    { key: 'pct', label: 'Chg %', align: 'r', cell: r => <span className={signCls(r.changePct)}>{r.changePct == null ? '–' : (r.changePct > 0 ? '+' : '') + r.changePct.toFixed(2) + '%'}</span> },
    { key: 'open', label: 'Open', align: 'r', cell: r => usd(r.open) },
    { key: 'high', label: 'High', align: 'r', cell: r => usd(r.high) },
    { key: 'low', label: 'Low', align: 'r', cell: r => usd(r.low) },
    { key: 'prev', label: 'Prev close', align: 'r', cell: r => usd(r.prevClose) },
    { key: 'vol', label: 'Volume', align: 'r', cell: r => compact(r.volume) },
    { key: 'wk', label: '52-wk range', align: 'r', cell: r => (
      <span className="inline-flex items-center gap-2 justify-end">
        <span className="text-[10px] text-zinc-500">{usd(r.wk52Low, 0)}</span><RangeBar pos={r.wk52Pos} /><span className="text-[10px] text-zinc-500">{usd(r.wk52High, 0)}</span>
      </span>) },
    { key: 'age', label: 'Last trade', align: 'r', cell: r => <span className="text-zinc-500">{r.tradeAgeMs == null ? '–' : ageText(r.tradeAgeMs + clockSkewMs)}</span> },
  ];
  if (onRemove) columns.push({ key: 'rm', label: '', align: 'r', cell: r => (
    <button onClick={() => onRemove(r)} disabled={busyKey === `rm-${r.id}`} aria-label={`Remove ${r.symbol}`}
      className="h-6 w-6 inline-flex items-center justify-center rounded text-zinc-500 hover:text-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60">
      <X className="h-3.5 w-3.5" aria-hidden="true" />
    </button>) });

  return (
    <div className="overflow-auto rounded-lg border border-zinc-800">
      <table className="w-full text-xs tabular-nums">
        <thead className="sticky top-0 z-10">
          <tr>{columns.map(c => <th key={c.key} scope="col" className={cn('px-3 py-2 text-xs font-bold text-white bg-zinc-800 whitespace-nowrap', c.align === 'r' ? 'text-right' : 'text-left')}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id} className="border-t border-zinc-800 hover:bg-zinc-900">
              {columns.map(c => <td key={c.key} className={cn('px-3 py-1.5 whitespace-nowrap text-zinc-200', c.align === 'r' ? 'text-right' : 'text-left')}>{c.cell(r)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

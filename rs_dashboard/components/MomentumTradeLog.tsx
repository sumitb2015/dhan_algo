'use client';

import React, { useMemo, useState } from 'react';
import { Download, TrendingDown, TrendingUp } from 'lucide-react';

export interface LogClosedTrade {
  symbol: string;
  industry: string;
  entry_date: string;
  exit_date: string;
  entry_price: number;
  exit_price: number;
  qty: number;
  invested: number;
  pnl: number;
  pnl_pct: number;
  cost: number;
  exit_reason: string;
  hold_days: number;
  rank_at_entry?: number;
  peak_gain_pct?: number;
}

export interface LogOpenHolding {
  symbol: string;
  industry: string;
  qty: number;
  entry_price: number;
  ltp: number;
  value: number;
  unrealised: number;
  unrealised_pct: number;
  hold_days: number;
  rank_at_entry: number;
}

interface Row {
  id: string;
  symbol: string;
  industry: string;
  entryDate: string;
  entryPrice: number;
  exitDate: string | null;
  exitPrice: number;
  qty: number;
  invested: number;
  pnl: number;
  pnlPct: number;
  hold: number;
  reason: string;
  rank: number | null;
  peak: number | null;
  cost: number | null;
  open: boolean;
}

type SortKey = 'entryDate' | 'symbol' | 'exitDate' | 'invested' | 'pnl' | 'pnlPct' | 'hold' | 'peak';

const REASON_LABEL: Record<string, string> = {
  stop: 'Stop-loss / trailing stop',
  rebalance: 'Rank rotation',
  rotation: 'Rank rotation',
  regime: 'Regime off (market below 200 SMA)',
  open: 'Still held at window end',
};

const reasonLabel = (r: string) => REASON_LABEL[r] ?? r.replace(/_/g, ' ');
const rupees = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;
const signed = (n: number) => `${n >= 0 ? '+' : '−'}₹${Math.abs(Math.round(n)).toLocaleString('en-IN')}`;
const price = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pnlColor = (n: number) => (n > 0 ? 'text-emerald-400' : n < 0 ? 'text-red-400' : 'text-zinc-400');

/** Calendar date minus whole days, as YYYY-MM-DD (UTC arithmetic so DST cannot shift the day). */
function minusDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) - days * 86_400_000);
  return t.toISOString().slice(0, 10);
}

const TH = ({ children, align = 'left', onClick, active, dir }: {
  children: React.ReactNode; align?: 'left' | 'right'; onClick?: () => void; active?: boolean; dir?: 1 | -1;
}) => (
  <th className={`text-xs font-bold text-white px-3 py-2 whitespace-nowrap ${align === 'right' ? 'text-right' : 'text-left'}`}>
    {onClick ? (
      <button type="button" onClick={onClick} className="cursor-pointer hover:text-emerald-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-500">
        {children}{active ? (dir === 1 ? ' ↑' : ' ↓') : ''}
      </button>
    ) : children}
  </th>
);

const TD = ({ children, align = 'left', className = '' }: { children: React.ReactNode; align?: 'left' | 'right'; className?: string }) => (
  <td className={`px-3 py-2 whitespace-nowrap ${align === 'right' ? 'text-right tabular-nums' : ''} ${className}`}>{children}</td>
);

type Filter = 'all' | 'wins' | 'losses' | 'open';

/** Every trade of the replayed window: closed trades plus positions still held on the last day. */
export default function MomentumTradeLog({ closed, open, endDate, windowLabel }: {
  closed: LogClosedTrade[];
  open: LogOpenHolding[];
  endDate: string;
  windowLabel: string;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const [sortKey, setSortKey] = useState<SortKey>('entryDate');
  const [dir, setDir] = useState<1 | -1>(1);

  const rows = useMemo<Row[]>(() => {
    const c: Row[] = closed.map((t, i) => ({
      id: `c-${i}`, symbol: t.symbol, industry: t.industry,
      entryDate: t.entry_date, entryPrice: t.entry_price, exitDate: t.exit_date, exitPrice: t.exit_price,
      qty: t.qty, invested: t.invested, pnl: t.pnl, pnlPct: t.pnl_pct, hold: t.hold_days,
      reason: t.exit_reason, rank: t.rank_at_entry ?? null, peak: t.peak_gain_pct ?? null, cost: t.cost, open: false,
    }));
    const o: Row[] = open.map((h, i) => ({
      id: `o-${i}`, symbol: h.symbol, industry: h.industry,
      entryDate: minusDays(endDate, h.hold_days), entryPrice: h.entry_price, exitDate: null, exitPrice: h.ltp,
      qty: h.qty, invested: h.entry_price * h.qty, pnl: h.unrealised, pnlPct: h.unrealised_pct, hold: h.hold_days,
      reason: 'open', rank: h.rank_at_entry ?? null, peak: null, cost: null, open: true,
    }));
    return [...c, ...o];
  }, [closed, open, endDate]);

  const shown = useMemo(() => {
    const f = rows.filter((r) =>
      filter === 'all' ? true : filter === 'open' ? r.open : filter === 'wins' ? !r.open && r.pnl > 0 : !r.open && r.pnl <= 0);
    const val = (r: Row): number | string => {
      if (sortKey === 'exitDate') return r.exitDate ?? '9999-12-31';
      if (sortKey === 'peak') return r.peak ?? -1e9;
      return r[sortKey] as number | string;
    };
    return [...f].sort((a, b) => {
      const x = val(a), y = val(b);
      const c = typeof x === 'string' ? x.localeCompare(y as string) : (x as number) - (y as number);
      return (c || a.entryDate.localeCompare(b.entryDate)) * dir;
    });
  }, [rows, filter, sortKey, dir]);

  const closedRows = rows.filter((r) => !r.open);
  const wins = closedRows.filter((r) => r.pnl > 0).length;
  const totalPnl = shown.reduce((s, r) => s + r.pnl, 0);
  const totalCost = shown.reduce((s, r) => s + (r.cost ?? 0), 0);
  const hasRank = rows.some((r) => r.rank !== null);
  const hasPeak = rows.some((r) => r.peak !== null);

  const sortBy = (k: SortKey) => {
    if (k === sortKey) setDir((d) => (d === 1 ? -1 : 1));
    else { setSortKey(k); setDir(k === 'entryDate' || k === 'symbol' || k === 'exitDate' ? 1 : -1); }
  };

  const downloadCsv = () => {
    const head = ['Symbol', 'Sector', 'Entry date', 'Entry price', 'Exit date', 'Exit / last price', 'Qty', 'Invested',
      'P&L', 'P&L %', 'Hold days', 'Exit reason', 'Rank at entry', 'Peak gain %', 'Costs', 'Status'];
    const q = (v: string | number | null) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = shown.map((r) => [r.symbol, r.industry, r.entryDate, r.entryPrice, r.exitDate ?? '', r.exitPrice, r.qty,
      r.invested, r.pnl, r.pnlPct, r.hold, reasonLabel(r.reason), r.rank, r.peak, r.cost, r.open ? 'open' : 'closed'].map(q).join(','));
    const blob = new Blob([[head.map(q).join(','), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `momentum_trades_${windowLabel.replace(/[^0-9A-Za-z]+/g, '_')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const pill = (f: Filter, label: string, n: number) => (
    <button
      key={f}
      type="button"
      onClick={() => setFilter(f)}
      className={`text-xs px-2.5 py-1 rounded border transition-colors cursor-pointer ${
        filter === f
          ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40 font-bold'
          : 'bg-zinc-800 text-zinc-400 border-zinc-700 hover:text-white hover:border-zinc-500'
      }`}
    >
      {label} ({n})
    </button>
  );

  return (
    <section className="rounded border border-zinc-800 bg-zinc-950" aria-label="Trade log">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-zinc-800">
        <div>
          <div className="text-xs font-bold text-zinc-100 uppercase tracking-wider">
            Trade log · {windowLabel}
          </div>
          <div className="text-xs text-zinc-500 mt-0.5">
            {closedRows.length} closed ({wins}W / {closedRows.length - wins}L) · {open.length} still open · every row is one buy → sell, filled at the next session&apos;s open
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {pill('all', 'All', rows.length)}
          {pill('wins', 'Winners', wins)}
          {pill('losses', 'Losers', closedRows.length - wins)}
          {pill('open', 'Open', open.length)}
          <button
            type="button"
            onClick={downloadCsv}
            disabled={shown.length === 0}
            aria-label="Download the shown trades as CSV"
            className="flex items-center gap-1 text-xs px-2.5 py-1 rounded border border-zinc-700 bg-zinc-800 text-zinc-300 hover:text-white hover:border-zinc-500 cursor-pointer disabled:opacity-50"
          >
            <Download size={12} /> CSV
          </button>
        </div>
      </div>
      <div className="overflow-x-auto max-h-[32rem] overflow-y-auto">
        <table className="w-full text-xs text-zinc-300">
          <thead className="bg-zinc-800 sticky top-0 z-10">
            <tr>
              <TH>#</TH>
              <TH onClick={() => sortBy('symbol')} active={sortKey === 'symbol'} dir={dir}>Symbol</TH>
              <TH>Sector</TH>
              <TH onClick={() => sortBy('entryDate')} active={sortKey === 'entryDate'} dir={dir}>Entry date</TH>
              <TH align="right">Entry ₹</TH>
              <TH onClick={() => sortBy('exitDate')} active={sortKey === 'exitDate'} dir={dir}>Exit date</TH>
              <TH align="right">Exit ₹</TH>
              <TH align="right">Qty</TH>
              <TH align="right" onClick={() => sortBy('invested')} active={sortKey === 'invested'} dir={dir}>Invested</TH>
              <TH align="right" onClick={() => sortBy('pnl')} active={sortKey === 'pnl'} dir={dir}>P&amp;L</TH>
              <TH align="right" onClick={() => sortBy('pnlPct')} active={sortKey === 'pnlPct'} dir={dir}>P&amp;L %</TH>
              <TH align="right" onClick={() => sortBy('hold')} active={sortKey === 'hold'} dir={dir}>Days</TH>
              <TH>Exit reason</TH>
              {hasRank && <TH align="right">Rank at entry</TH>}
              {hasPeak && <TH align="right" onClick={() => sortBy('peak')} active={sortKey === 'peak'} dir={dir}>Peak gain</TH>}
              <TH align="right">Costs</TH>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr><td colSpan={16} className="px-3 py-8 text-center text-zinc-500">No trades match this filter in the selected window</td></tr>
            )}
            {shown.map((r, i) => (
              <tr key={r.id} className="border-t border-zinc-800 hover:bg-zinc-900">
                <TD className="text-zinc-500">{i + 1}</TD>
                <TD className="font-bold text-zinc-100">{r.symbol}</TD>
                <TD className="text-zinc-400">{r.industry}</TD>
                <TD>{r.entryDate}</TD>
                <TD align="right">{price(r.entryPrice)}</TD>
                <TD className={r.open ? 'text-amber-400' : ''}>{r.exitDate ?? 'Open'}</TD>
                <TD align="right" className={r.open ? 'text-zinc-400' : ''}>{price(r.exitPrice)}{r.open ? ' (LTP)' : ''}</TD>
                <TD align="right">{r.qty.toLocaleString('en-IN')}</TD>
                <TD align="right">{rupees(r.invested)}</TD>
                <TD align="right" className={pnlColor(r.pnl)}>{signed(r.pnl)}</TD>
                <TD align="right" className={pnlColor(r.pnlPct)}>
                  <span className="inline-flex items-center gap-1">
                    {r.pnlPct >= 0 ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
                    {r.pnlPct >= 0 ? '+' : ''}{r.pnlPct.toFixed(2)}%
                  </span>
                </TD>
                <TD align="right" className="text-zinc-400">{r.hold}</TD>
                <TD><span className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300" title={r.reason}>{reasonLabel(r.reason)}</span></TD>
                {hasRank && <TD align="right" className="text-zinc-400">{r.rank ?? '—'}</TD>}
                {hasPeak && <TD align="right" className="text-zinc-400">{r.peak === null ? '—' : `${r.peak >= 0 ? '+' : ''}${r.peak.toFixed(1)}%`}</TD>}
                <TD align="right" className="text-zinc-500">{r.cost === null ? '—' : rupees(r.cost)}</TD>
              </tr>
            ))}
          </tbody>
          {shown.length > 0 && (
            <tfoot className="bg-zinc-800 sticky bottom-0">
              <tr className="border-t border-zinc-700 font-bold text-zinc-100">
                <TD className="text-zinc-300">{''}</TD>
                <TD className="text-zinc-300">Total ({shown.length})</TD>
                <TD>{''}</TD><TD>{''}</TD><TD>{''}</TD><TD>{''}</TD><TD>{''}</TD><TD>{''}</TD><TD>{''}</TD>
                <TD align="right" className={pnlColor(totalPnl)}>{signed(totalPnl)}</TD>
                <TD>{''}</TD><TD>{''}</TD><TD>{''}</TD>
                {hasRank && <TD>{''}</TD>}
                {hasPeak && <TD>{''}</TD>}
                <TD align="right" className="text-zinc-400">{rupees(totalCost)}</TD>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </section>
  );
}

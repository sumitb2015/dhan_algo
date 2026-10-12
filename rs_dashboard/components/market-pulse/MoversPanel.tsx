'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Building2, Loader2, RefreshCw, TrendingUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fmtAge } from '@/lib/marketStatus';
import { fmtLakh, fmtPct, fmtPrice } from '@/lib/futuresFormatters';
import { istDateIso } from '@/lib/nseHolidays';
import { isNseLive, lastNseSessionDate } from '@/lib/marketHours';
import {
  MOVER_CATEGORIES, MOVER_UNIVERSES, filterMinOi, moverExpiryMonths, type MoverMode, type MoverRow,
} from '@/lib/dhanAnalytics';
import type { CompanyTarget } from './CompanyInfoDrawer';

const POLL_MS = 10_000;
const CATEGORY_LABEL: Record<string, string> = {
  PRICE_GAINERS: 'Price gainers', PRICE_LOSERS: 'Price losers', HIGHEST_OI: 'Highest OI',
  OI_GAINERS: 'OI gainers', OI_LOSERS: 'OI losers', TOP_VOLUME: 'Top volume',
};
const MODE_ITEMS: { key: MoverMode; label: string }[] = [
  { key: 'equity', label: 'Stocks' }, { key: 'options', label: 'Options' }, { key: 'futures', label: 'Futures' },
];
const MIN_OI = [
  { v: 0, l: 'Any OI' }, { v: 10_000, l: 'OI ≥ 10K' }, { v: 100_000, l: 'OI ≥ 1L' }, { v: 1_000_000, l: 'OI ≥ 10L' },
];

const selectCls = 'h-8 rounded-md border border-zinc-800 bg-zinc-900 px-2 text-xs text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60';

function requestKey(mode: MoverMode, category: string, universe: string, expiry: string, limit: number): string {
  return mode === 'equity' ? `eq|${category}|${universe}|${limit}` : `${mode}|${category}|${expiry}|${limit}`;
}

interface Col { key: string; label: string; align: 'l' | 'r'; cell: (r: MoverRow, i: number) => React.ReactNode }

function signCls(v: number): string {
  return v > 0 ? 'text-emerald-400' : v < 0 ? 'text-red-400' : 'text-zinc-300';
}

function buildColumns(mode: MoverMode, onCompany: (r: MoverRow) => void): Col[] {
  const rank: Col = { key: 'rank', label: '#', align: 'l', cell: (_r, i) => <span className="text-zinc-500">{i + 1}</span> };
  const ltp: Col = { key: 'ltp', label: 'LTP', align: 'r', cell: r => fmtPrice(r.ltp) };
  const chg: Col = {
    key: 'chg', label: 'Chg %', align: 'r',
    cell: r => <span className={signCls(r.changePct)}>{fmtPct(r.changePct)}</span>,
  };
  const vol: Col = { key: 'vol', label: 'Volume', align: 'r', cell: r => fmtLakh(r.volume) };
  if (mode === 'equity') {
    return [
      rank,
      {
        key: 'sym', label: 'Stock', align: 'l',
        cell: r => (
          <span className="flex items-center gap-2">
            <span className="font-bold text-zinc-100">{r.symbol}</span>
            <span className="text-[10px] text-zinc-500 truncate max-w-[14rem]">{r.name}</span>
            <button onClick={() => onCompany(r)} aria-label={`Company info for ${r.symbol}`} title="Company info"
              className="h-5 w-5 flex items-center justify-center rounded text-zinc-500 hover:text-emerald-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60">
              <Building2 className="h-3 w-3" aria-hidden="true" />
            </button>
          </span>
        ),
      },
      ltp,
      { key: 'chgabs', label: 'Chg', align: 'r', cell: r => <span className={signCls(r.change)}>{(r.change > 0 ? '+' : '') + fmtPrice(r.change)}</span> },
      chg, vol,
      { key: 'val', label: 'Traded value', align: 'r', cell: r => `₹${fmtLakh(r.tradedValue)}` },
    ];
  }
  const contract: Col = {
    key: 'sym', label: 'Contract', align: 'l',
    cell: r => (
      <span className="flex items-center gap-2">
        <span className="font-bold text-zinc-100">{r.symbol}</span>
        {r.optionType && <span className={cn('text-[10px] font-bold', r.optionType === 'CE' ? 'text-emerald-400' : 'text-red-400')}>{r.optionType}</span>}
      </span>
    ),
  };
  const oi: Col = { key: 'oi', label: 'OI', align: 'r', cell: r => fmtLakh(r.openInterest) };
  const oiChg: Col = {
    key: 'oichg', label: 'OI chg %', align: 'r',
    cell: r => <span className={signCls(r.oiChangePct)}>{fmtPct(r.oiChangePct)}</span>,
  };
  const expiry: Col = { key: 'exp', label: 'Expiry', align: 'r', cell: r => <span className="text-zinc-400">{r.expiry ?? '–'}</span> };
  if (mode === 'futures') return [rank, contract, ltp, chg, vol, oi, oiChg, expiry];
  return [
    rank, contract, ltp, chg, vol, oi, oiChg,
    { key: 'pcr', label: 'Series PCR', align: 'r', cell: r => (r.pcr == null ? '–' : r.pcr.toFixed(2)) },
    expiry,
  ];
}

export default function MoversPanel({ active, onOpenCompany, onDataDate }: { active: boolean; onOpenCompany: (t: CompanyTarget) => void; onDataDate: (d: string | null) => void }) {
  const [mode, setMode] = useState<MoverMode>('equity');
  const [category, setCategory] = useState<string>('PRICE_GAINERS');
  const [universe, setUniverse] = useState<string>('NIFTY_500');
  const [limit, setLimit] = useState(20);
  const [minOi, setMinOi] = useState(0);
  const [monthIdx, setMonthIdx] = useState(0);
  const [rows, setRows] = useState<MoverRow[] | null>(null);
  const [loadedKey, setLoadedKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const seq = useRef(0);

  // Month choices come from the IST date; any date inside a month selects that month's monthly series.
  const months = useMemo(() => moverExpiryMonths(istDateIso(now)), [now]);
  const expiry = months[Math.min(monthIdx, months.length - 1)].expiry;

  // The request key names everything that changes the answer; rows render only when they match it, so a
  // mode switch never shows the previous mode's table under the new headers.
  const reqKey = requestKey(mode, category, universe, expiry, limit);

  const changeMode = (m: MoverMode) => {
    setMode(m);
    setCategory(MOVER_CATEGORIES[m][0]);
    setError(null);
  };

  const load = useCallback(async () => {
    const mine = ++seq.current;
    const isStale = () => mine !== seq.current;
    const key = requestKey(mode, category, universe, expiry, limit);
    setLoading(true);
    const qs = new URLSearchParams({ mode, category, limit: String(limit) });
    if (mode === 'equity') qs.set('universe', universe); else qs.set('expiry', expiry);
    try {
      const r = await fetch(`/api/dhan-movers?${qs}`);
      const j = await r.json().catch(() => null) as Record<string, unknown> | null;
      if (isStale()) return;
      if (!r.ok || !j || j.success !== true) { setError(String(j?.error ?? `HTTP ${r.status}`)); return; }
      setRows(j.rows as MoverRow[]);
      setLoadedKey(key);
      setError(null);
      setStale(j.stale === true);
      const at = typeof j.fetchedAt === 'number' ? j.fetchedAt : Date.now();
      setFetchedAt(at);
      // The payload carries no date. The ranking belongs to the last NSE session at fetch time (today once the market has opened,
      // otherwise the previous trading day), not to the date of the fetch: on a weekend 'today' would claim the data is current.
      onDataDate(lastNseSessionDate(at));
    } catch (e) {
      if (!isStale()) setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      if (!isStale()) setLoading(false);
    }
  }, [mode, category, universe, limit, expiry, onDataDate]);

  // Only the visible tab fetches (see NewsPanel).
  useEffect(() => {
    if (!active) return;
    const counter = seq;
    load();
    const t = setInterval(() => { if (!document.hidden) load(); }, POLL_MS);
    return () => { clearInterval(t); counter.current++; };
  }, [load, active]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(t);
  }, []);

  const matching = rows !== null && loadedKey === reqKey;
  const shown = useMemo(() => (matching && mode !== 'equity' ? filterMinOi(rows, minOi) : matching ? rows : []), [matching, rows, mode, minOi]);
  const openCompany = useCallback((r: MoverRow) => onOpenCompany({ securityId: r.securityId, exchangeSegment: 'NSE_EQ', label: r.name || r.symbol }), [onOpenCompany]);
  const columns = useMemo(() => buildColumns(mode, openCompany), [mode, openCompany]);
  const live = isNseLive(new Date(now));
  const dataAgeMs = fetchedAt ? now - fetchedAt : 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 flex-wrap">
        <div role="group" aria-label="Instrument group" className="flex items-center gap-1 bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg">
          {MODE_ITEMS.map(i => (
            <button key={i.key} onClick={() => changeMode(i.key)} aria-pressed={mode === i.key}
              className={cn('px-2.5 py-1 text-[11px] font-semibold rounded-md border transition-all',
                mode === i.key ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'text-zinc-500 hover:text-zinc-300 border-transparent')}>
              {i.label}
            </button>
          ))}
        </div>
        <label className="sr-only" htmlFor="mv-category">Ranking</label>
        <select id="mv-category" className={selectCls} value={category} onChange={e => setCategory(e.target.value)}>
          {MOVER_CATEGORIES[mode].map(c => <option key={c} value={c}>{CATEGORY_LABEL[c] ?? c}</option>)}
        </select>
        {mode === 'equity' ? (
          <>
            <label className="sr-only" htmlFor="mv-universe">Universe</label>
            <select id="mv-universe" className={selectCls} value={universe} onChange={e => setUniverse(e.target.value)}>
              {MOVER_UNIVERSES.map(u => <option key={u} value={u}>{u.replace(/_/g, ' ')}</option>)}
            </select>
          </>
        ) : (
          <>
            <label className="sr-only" htmlFor="mv-month">Series month</label>
            <select id="mv-month" className={selectCls} value={monthIdx} onChange={e => setMonthIdx(Number(e.target.value))}>
              {months.map((m, i) => <option key={m.expiry} value={i}>{m.label} (monthly)</option>)}
            </select>
            <label className="sr-only" htmlFor="mv-minoi">Minimum open interest</label>
            <select id="mv-minoi" className={selectCls} value={minOi} onChange={e => setMinOi(Number(e.target.value))}>
              {MIN_OI.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
            </select>
          </>
        )}
        <label className="sr-only" htmlFor="mv-limit">Rows</label>
        <select id="mv-limit" className={selectCls} value={limit} onChange={e => setLimit(Number(e.target.value))}>
          {[10, 20, 50, 100].map(n => <option key={n} value={n}>Top {n}</option>)}
        </select>
        <button onClick={load} aria-label="Refresh movers" title="Refresh"
          className="h-8 w-8 flex items-center justify-center rounded-md border border-zinc-800 bg-zinc-900 text-zinc-300 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60">
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} aria-hidden="true" />
        </button>
        <span className={cn('text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border',
          live ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' : 'text-zinc-400 bg-zinc-800 border-zinc-700')}>
          {live ? 'Live session' : 'Market closed · last session'}
        </span>
        {fetchedAt && <span className="text-[10px] text-zinc-500">updated {fmtAge(now, fetchedAt)}</span>}
      </div>

      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden="true" />
          <span>{error}{matching ? ' - showing the last loaded ranking.' : ''}</span>
        </div>
      )}
      {!error && (stale || (live && dataAgeMs > 60_000)) && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden="true" />
          <span>Ranking is {fetchedAt ? fmtAge(now, fetchedAt) : 'out of date'} - Dhan did not answer the last refresh.</span>
        </div>
      )}

      {!matching && !error && (
        <div className="flex flex-col items-center gap-2 py-16">
          <Loader2 className="h-6 w-6 animate-spin text-emerald-400" aria-hidden="true" />
          <p className="text-zinc-200 font-semibold text-sm">Loading ranking</p>
        </div>
      )}

      {matching && shown.length === 0 && (
        <div className="flex flex-col items-center gap-2 py-16 text-center">
          <TrendingUp className="h-6 w-6 text-zinc-600" aria-hidden="true" />
          <p className="text-sm text-zinc-400">
            {rows && rows.length > 0 ? 'No contract clears the minimum-OI filter - set it to Any OI.' : 'Dhan returned no instruments for this ranking.'}
          </p>
        </div>
      )}

      {matching && shown.length > 0 && (
        <div className="overflow-auto rounded-lg border border-zinc-800">
          <table className="w-full text-xs tabular-nums">
            <thead className="sticky top-0 z-10">
              <tr>
                {columns.map(c => (
                  <th key={c.key} scope="col" className={cn('px-3 py-2 text-xs font-bold text-white bg-zinc-800 whitespace-nowrap', c.align === 'r' ? 'text-right' : 'text-left')}>{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((r, i) => (
                <tr key={`${r.securityId}-${r.symbol}`} className="border-t border-zinc-800 hover:bg-zinc-900">
                  {columns.map(c => (
                    <td key={c.key} className={cn('px-3 py-1.5 whitespace-nowrap text-zinc-200', c.align === 'r' ? 'text-right' : 'text-left')}>{c.cell(r, i)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-[10px] text-zinc-500 leading-relaxed">
        Ranked by Dhan on the exchange feed (not from the CSV history). F&amp;O rankings cover the <strong className="text-zinc-300">monthly</strong> series
        only - Dhan maps any date in the month to the monthly expiry and never ranks weeklies. OI is in units, not lots. OI-gainer lists are
        ranked by % change, so thin contracts top them; use the OI filter to hide those.
      </p>
    </div>
  );
}

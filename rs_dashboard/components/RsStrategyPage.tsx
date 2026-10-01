'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChartNoAxesCombined, RefreshCw, Search, Activity, BookOpen } from 'lucide-react';
import NavBar from './NavBar';
import EquityOrderModal from './EquityOrderModal';
import RsStrategyGuide from './RsStrategyGuide';
import { cachedFetch, setCached } from '@/lib/clientCache';
import type { EquityHolding } from '@/lib/dhanEquityPortfolio';
import type { IndexInfo } from '@/lib/indexConstituents';
import { inRange, normalizeRange, parseBound, type PriceRange } from '@/lib/priceRange';
import type { Side } from '@/lib/equityOrder';
import { DEFAULT_PARAMS, type RsStrategyResponse, type RsStrategyStock, type RsSignal } from '@/lib/rsStrategyCore';

type Tab = 'BUY' | 'HOLD' | 'SELL' | 'ALL';
type SortKey = 'symbol' | 'held' | 'close' | 'change1D' | 'rs' | 'supertrend' | 'ema' | 'rsi' | 'distPct' | 'signal' | 'entryDate' | 'weekly' | 'daysInSignal';

// Strongest state first when sorting descending; a stock with no weekly signal sorts below everything.
const SIGNAL_RANK: Record<RsSignal, number> = { BUY: 3, HOLD: 2, WAIT: 1, SELL: 0 };

const DEFAULT_PERIOD = DEFAULT_PARAMS.period;
const TTL_MS = 5 * 60 * 1000;
const RSI_MIN = DEFAULT_PARAMS.rsiMin; // bullish condition: RSI(14) above 50
const DEFAULT_STRONG_RS = 0.1; // StockEdge's "strongly outperforming": RS above 0.1 (user-editable)
const DEFAULT_RISING_DAYS = 3; // StockEdge's "increasing RS": up for the last 3 sessions (user-editable)

const BADGE: Record<RsSignal, string> = {
  BUY: 'bg-emerald-500/10 border-emerald-500/25 text-emerald-400',
  HOLD: 'bg-sky-500/10 border-sky-500/25 text-sky-400',
  SELL: 'bg-red-500/10 border-red-500/25 text-red-400',
  WAIT: 'bg-zinc-800 border-zinc-700 text-zinc-400',
};
// HOLD is the internal/API value; the UI says "In Trend" because it describes the stock's trend state, not what the account owns.
const LABEL: Record<RsSignal, string> = { BUY: 'Buy', HOLD: 'In Trend', SELL: 'Sell', WAIT: 'Wait' };

const fmt = (n: number, d = 2) => n.toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
const signed = (n: number) => `${n > 0 ? '+' : ''}${fmt(n)}`;
const tone = (n: number) => (n > 0 ? 'text-emerald-400' : n < 0 ? 'text-red-400' : 'text-zinc-400');

/** RS drawn around a centre zero line, mirroring the indicator's zero line. Saturates at ±1.0. */
function RsBar({ value }: { value: number }) {
  const w = (Math.min(Math.abs(value), 1) / 2) * 100; // % of the full track on one side
  return (
    <div className="relative h-1.5 w-20 rounded-full bg-zinc-800" aria-hidden="true">
      <span className="absolute left-1/2 top-[-2px] bottom-[-2px] w-px bg-zinc-500" />
      <span
        className={`absolute top-0 bottom-0 rounded-full ${value >= 0 ? 'bg-emerald-400' : 'bg-red-400'}`}
        style={value >= 0 ? { left: '50%', width: `${w}%` } : { right: '50%', width: `${w}%` }}
      />
    </div>
  );
}

/**
 * A filter chip with an editable number: click the label to switch the filter on/off, type in the box
 * to change the threshold. The value commits on blur/Enter (never per keystroke), Escape reverts an
 * uncommitted edit, and committing a value switches the filter on.
 */
function ThresholdChip({ label, unit, tip, on, onToggle, value, onCommit, min, max, step, decimals }: {
  label: string; unit?: string; tip: string; on: boolean; onToggle: () => void;
  value: number; onCommit: (v: number) => void; min: number; max: number; step: number; decimals: number;
}) {
  const [draft, setDraft] = useState(value.toFixed(decimals));
  const [prev, setPrev] = useState(value);
  if (prev !== value) { setPrev(value); setDraft(value.toFixed(decimals)); } // follow an external change (derive during render, not in an effect)
  const commit = (raw: string) => {
    const n = parseFloat(raw);
    if (!Number.isFinite(n)) { setDraft(value.toFixed(decimals)); return; }
    const c = Math.min(max, Math.max(min, decimals === 0 ? Math.round(n) : n));
    setDraft(c.toFixed(decimals));
    onCommit(c);
  };
  return (
    <div
      title={tip}
      className={`flex items-stretch rounded-md border text-xs font-bold overflow-hidden focus-within:ring-2 focus-within:ring-emerald-500/50 ${
        on ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-400' : 'bg-zinc-900 border-zinc-800 text-zinc-400'
      }`}
    >
      <button type="button" onClick={onToggle} aria-pressed={on} className="pl-2.5 pr-1.5 py-1.5 hover:text-zinc-100 focus:outline-none focus-visible:underline">
        {label}
      </button>
      <input
        type="number"
        aria-label={`${label} value`}
        value={draft}
        min={min} max={max} step={step}
        inputMode="decimal"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') setDraft(value.toFixed(decimals));
        }}
        className="w-14 my-1 mr-1 px-1 rounded bg-zinc-950 border border-zinc-800 text-center font-mono text-zinc-100 focus:outline-none"
      />
      {unit && <span className="pr-2.5 py-1.5 text-zinc-500 font-normal">{unit}</span>}
    </div>
  );
}

/**
 * Price range: two optional boxes (empty = no limit on that side, so both empty = all prices).
 * Values commit on blur/Enter, never per keystroke; a reversed pair is swapped; Esc reverts.
 */
function PriceRangeChip({ value, onCommit }: { value: PriceRange; onCommit: (r: PriceRange) => void }) {
  const show = (n: number | null) => (n === null ? '' : String(n));
  const [min, setMin] = useState(show(value.min));
  const [max, setMax] = useState(show(value.max));
  const [prev, setPrev] = useState(value);
  if (prev !== value) { setPrev(value); setMin(show(value.min)); setMax(show(value.max)); } // follow an external change
  const active = value.min !== null || value.max !== null;
  const commit = (rawMin: string, rawMax: string) => {
    const r = normalizeRange(parseBound(rawMin), parseBound(rawMax));
    setMin(show(r.min)); setMax(show(r.max));
    onCommit(r);
  };
  const box = (label: string, v: string, set: (x: string) => void, committed: number | null) => (
    <input
      type="number"
      aria-label={label}
      placeholder={label === 'Minimum price' ? 'min' : 'max'}
      value={v}
      min={0}
      inputMode="decimal"
      onChange={(e) => set(e.target.value)}
      onBlur={(e) => commit(label === 'Minimum price' ? e.currentTarget.value : min, label === 'Maximum price' ? e.currentTarget.value : max)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') set(show(committed));
      }}
      className="w-20 my-1 px-1 rounded bg-zinc-950 border border-zinc-800 text-center font-mono text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
    />
  );
  return (
    <div
      title="Filter by latest price in ₹. Leave both boxes empty for all prices; fill one for 'at least' or 'at most'."
      className={`flex items-center gap-1.5 pl-2.5 pr-1.5 rounded-md border text-xs font-bold focus-within:ring-2 focus-within:ring-emerald-500/50 ${
        active ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-400' : 'bg-zinc-900 border-zinc-800 text-zinc-400'
      }`}
    >
      <span>Price ₹</span>
      {box('Minimum price', min, setMin, value.min)}
      <span className="font-normal text-zinc-500">to</span>
      {box('Maximum price', max, setMax, value.max)}
      {active && (
        <button type="button" aria-label="Clear price filter" onClick={() => onCommit({ min: null, max: null })} className="px-1 text-zinc-400 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 rounded">×</button>
      )}
    </div>
  );
}

/** True when the account owns any of the stock: a delivery holding or a long position today. */
function ownsAny(h: EquityHolding | undefined): boolean {
  return !!h && (h.totalQty > 0 || h.positions.some((p) => p.netQty > 0));
}

/** Delivery holding plus today's positions for one symbol. Quantities are shown separately, never summed. */
function HeldCell({ h, loaded }: { h: EquityHolding | undefined; loaded: boolean }) {
  if (!loaded) return <td className="px-3 py-2.5 text-right text-zinc-500">…</td>;
  const has = h && (h.totalQty > 0 || h.positions.length > 0);
  if (!h || !has) return <td className="px-3 py-2.5 text-right text-zinc-500">–</td>;
  return (
    <td className="px-3 py-2.5 text-right" title={h.totalQty > 0 && h.avgCost > 0 ? `Avg cost ₹${fmt(h.avgCost)}` : undefined}>
      {h.totalQty > 0 && <span className="text-zinc-100 font-bold">{h.totalQty.toLocaleString('en-IN')}</span>}
      {h.positions.map((p) => (
        <span key={p.product} className={`block text-[10px] ${p.netQty > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
          {p.product === 'INTRADAY' ? 'MIS' : p.product} {p.netQty > 0 ? '+' : ''}{p.netQty}
        </span>
      ))}
    </td>
  );
}

export default function RsStrategyPage({ guide = '' }: { guide?: string }) {
  const [period, setPeriod] = useState(DEFAULT_PERIOD);
  const [periodDraft, setPeriodDraft] = useState(String(DEFAULT_PERIOD));
  const [data, setData] = useState<RsStrategyResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rsiOn, setRsiOn] = useState(true); // BUY also needs RSI(14) > 50
  const [emaOn, setEmaOn] = useState(true); // BUY also needs close > EMA 200 (entry only; never blocks In Trend/Sell)
  const [strongOnly, setStrongOnly] = useState(false); // RS >= strongMin
  const [strongMin, setStrongMin] = useState(DEFAULT_STRONG_RS);
  const [risingOnly, setRisingOnly] = useState(false); // RS up for risingDays sessions in a row
  const [risingDays, setRisingDays] = useState(DEFAULT_RISING_DAYS);
  const [stackOnly, setStackOnly] = useState(false); // close > EMA20 > EMA50 > EMA100 > EMA200
  const [weeklyOnly, setWeeklyOnly] = useState(false); // weekly chart is also long (Buy or In Trend)
  // What the account already holds (Dhan holdings + today's NSE equity positions), keyed by symbol.
  const [holdings, setHoldings] = useState<Record<string, EquityHolding> | null>(null);
  const [holdingsError, setHoldingsError] = useState<string | null>(null);
  const [holdingsTick, setHoldingsTick] = useState(0); // bump to force a fresh read (after an order)
  const [heldOnly, setHeldOnly] = useState(false);
  const [order, setOrder] = useState<{ symbol: string; side: Side } | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);
  const [indices, setIndices] = useState<IndexInfo[] | null>(null);
  const [indicesError, setIndicesError] = useState<string | null>(null);
  const [indexKey, setIndexKey] = useState(''); // '' = all Nifty 500
  const [price, setPrice] = useState<PriceRange>({ min: null, max: null }); // null bound = no limit
  const [tab, setTab] = useState<Tab>('BUY');
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('rs');
  const [sortAsc, setSortAsc] = useState(false);

  // Monotonic sequence so a slow earlier response cannot overwrite a newer one (toggle RSI, change period).
  const seq = useRef(0);
  const load = useCallback(async (p: number, rsiMin: number, emaGate: boolean, refresh = false) => {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const base = `/api/rs-strategy?period=${p}&rsiMin=${rsiMin}&emaGate=${emaGate}`;
      type Resp = { success: boolean; data?: RsStrategyResponse; error?: string };
      let json: Resp;
      if (refresh) {
        json = await (await fetch(`${base}&refresh=true`)).json();
        if (json.success) setCached(base, json); // keep the session cache in step with the recalculation
      } else {
        json = await cachedFetch<Resp>(base, TTL_MS);
      }
      if (mine !== seq.current) return;
      if (!json.success || !json.data) throw new Error(json.error || 'Scan failed');
      setData(json.data);
    } catch (e) {
      if (mine === seq.current) setError(e instanceof Error ? e.message : 'Scan failed');
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => { load(period, rsiOn ? RSI_MIN : 0, emaOn); }, [period, rsiOn, emaOn, load]);

  // Holdings: read on mount, every 60 s while the tab is visible, and on demand after an order.
  // `cancelled` drops a reply that lands after a newer read started (polling-guards §4).
  useEffect(() => {
    let cancelled = false;
    const read = async (fresh: boolean) => {
      try {
        const res = await fetch(`/api/equity-order/holdings${fresh ? '?refresh=true' : ''}`);
        const json = await res.json();
        if (cancelled) return;
        if (!json.success) throw new Error(json.error || 'Holdings unavailable');
        setHoldings(json.data as Record<string, EquityHolding>);
        setHoldingsError(null);
      } catch (e) {
        if (!cancelled) setHoldingsError(e instanceof Error ? e.message : 'Holdings unavailable');
      }
    };
    void read(holdingsTick > 0);
    const id = setInterval(() => { if (!document.hidden) void read(false); }, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [holdingsTick]);

  // NSE index membership: static reference data, read once per session.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const json = await cachedFetch<{ success: boolean; data?: { indices: IndexInfo[] }; error?: string }>('/api/index-constituents', 60 * 60 * 1000);
        if (cancelled) return;
        if (!json.success || !json.data) throw new Error(json.error || 'Index lists unavailable');
        setIndices(json.data.indices);
      } catch (e) {
        if (!cancelled) setIndicesError(e instanceof Error ? e.message : 'Index lists unavailable');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const indexMembers = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const i of indices ?? []) m.set(i.key, new Set(i.symbols));
    return m;
  }, [indices]);

  // A fill can take a moment to show in Dhan's holdings/positions: read now, then again shortly after.
  const afterOrder = useCallback(() => {
    setHoldingsTick((t) => t + 1);
    setTimeout(() => setHoldingsTick((t) => t + 1), 4_000);
  }, []);

  // Commit the period on blur/Enter only, never per keystroke.
  const commitPeriod = () => {
    const n = parseInt(periodDraft, 10);
    const next = Number.isFinite(n) ? Math.min(250, Math.max(5, n)) : period;
    setPeriodDraft(String(next));
    if (next !== period) setPeriod(next);
  };

  const pickTab = (t: Tab) => {
    setTab(t);
    setSortKey('rs');
    setSortAsc(t === 'SELL'); // strongest first: highest RS for buys, lowest for sells
  };

  const handleSort = (k: SortKey) => {
    if (k === sortKey) setSortAsc(!sortAsc);
    else { setSortKey(k); setSortAsc(k === 'symbol'); }
  };

  // Everything except the tab: the tab counts are computed from this, so they follow the filters.
  const filtered = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    const members = indexKey ? indexMembers.get(indexKey) ?? null : null; // an unknown key behaves as "all" (the select shows no match)
    return data.stocks.filter(
      (s) => (!members || members.has(s.symbol)) &&
        inRange(s.close, price) &&
        (!strongOnly || s.rs >= strongMin) &&
        (!risingOnly || s.rsRisingDays >= risingDays) &&
        (!stackOnly || s.emaStack) &&
        (!weeklyOnly || s.weekly === 'BUY' || s.weekly === 'HOLD') &&
        (!heldOnly || (holdings?.[s.symbol]?.totalQty ?? 0) > 0 || (holdings?.[s.symbol]?.positions.length ?? 0) > 0) &&
        (!q || s.symbol.toLowerCase().includes(q)),
    );
  }, [data, query, indexKey, indexMembers, price, strongOnly, strongMin, risingOnly, risingDays, stackOnly, weeklyOnly, heldOnly, holdings]);

  const tabCounts = useMemo(() => {
    const c = { BUY: 0, HOLD: 0, SELL: 0, ALL: filtered.length };
    for (const s of filtered) if (s.signal in c) c[s.signal as 'BUY' | 'HOLD' | 'SELL']++;
    return c;
  }, [filtered]);

  const rows = useMemo(() => {
    const list = filtered.filter((s) => tab === 'ALL' || s.signal === tab);
    const dir = sortAsc ? 1 : -1;
    const value = (s: RsStrategyStock): number | string | null => {
      switch (sortKey) {
        case 'symbol': return s.symbol;
        case 'held': return holdings?.[s.symbol]?.totalQty ?? 0;
        case 'signal': return SIGNAL_RANK[s.signal];
        case 'weekly': return s.weekly ? SIGNAL_RANK[s.weekly] : null;
        case 'entryDate': return s.entryDate; // YYYY-MM-DD sorts as text; "-" (null) stays last
        default: return s[sortKey];
      }
    };
    return list.sort((a, b) => {
      const x = value(a), y = value(b);
      if (x === null || y === null) return x === y ? a.symbol.localeCompare(b.symbol) : x === null ? 1 : -1; // nulls always last
      const c = typeof x === 'string' ? x.localeCompare(y as string) : (x as number) - (y as number);
      return c !== 0 ? c * dir : a.symbol.localeCompare(b.symbol); // stable, predictable ties
    });
  }, [filtered, tab, sortKey, sortAsc, holdings]);

  const tabs: { id: Tab; label: string; n?: number }[] = [
    { id: 'BUY', label: 'Buy', n: data ? tabCounts.BUY : undefined },
    { id: 'HOLD', label: LABEL.HOLD, n: data ? tabCounts.HOLD : undefined },
    { id: 'SELL', label: 'Sell', n: data ? tabCounts.SELL : undefined },
    { id: 'ALL', label: 'All', n: data ? tabCounts.ALL : undefined },
  ];

  const th = (k: SortKey, label: string, align = 'text-right', title?: string) => (
    <th
      className={`px-3 py-3 ${align} whitespace-nowrap`}
      aria-sort={sortKey === k ? (sortAsc ? 'ascending' : 'descending') : 'none'}
    >
      <button
        onClick={() => handleSort(k)}
        title={title}
        className="font-bold hover:text-emerald-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 rounded"
      >
        {label}{sortKey === k ? (sortAsc ? ' ↑' : ' ↓') : <span className="text-zinc-500" aria-hidden="true"> ↕</span>}
      </button>
    </th>
  );

  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-white">
      <header className="sticky top-0 z-30 flex items-center justify-between gap-3 flex-wrap px-6 py-3 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg border shrink-0 bg-emerald-500/10 border-emerald-500/25">
            <ChartNoAxesCombined className="w-4 h-4 text-emerald-400" aria-hidden="true" />
          </div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] mb-0.5 text-emerald-400">Equity · Nifty 500</p>
            <h1 className="text-sm font-bold text-white tracking-tight leading-none">RS Strategy</h1>
            <p className="text-[10px] text-zinc-500 font-medium mt-1">
              Relative strength vs Nifty ({period}) with Supertrend (10, 2)
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <label className="flex items-center gap-1.5 text-xs text-zinc-400">
            RS period
            <input
              type="number"
              min={5}
              max={250}
              value={periodDraft}
              onChange={(e) => setPeriodDraft(e.target.value)}
              onBlur={commitPeriod}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              className="w-16 px-2 py-1 rounded-md bg-zinc-900 border border-zinc-800 text-xs font-mono text-zinc-100 focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
            />
          </label>
          {guide && (
            <button
              onClick={() => setGuideOpen(true)}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-zinc-800 bg-zinc-900 text-xs font-bold text-zinc-200 hover:bg-zinc-800 focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
            >
              <BookOpen className="w-3.5 h-3.5" aria-hidden="true" />
              Guide
            </button>
          )}
          <button
            onClick={() => load(period, rsiOn ? RSI_MIN : 0, emaOn, true)}
            disabled={loading}
            aria-label="Recalculate scan"
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-zinc-800 bg-zinc-900 text-xs font-bold text-zinc-200 hover:bg-zinc-800 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
            Recalculate
          </button>
          <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-amber-300 px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/20">
            DATA: {data?.dataDate || '—'}
          </span>
          <span className="w-px h-5 bg-zinc-800 shrink-0" />
          <NavBar />
        </div>
      </header>

      <main className="flex-1 flex flex-col gap-4 px-6 py-5 max-w-[1680px] w-full mx-auto">
        <p className="text-xs text-zinc-400 max-w-3xl leading-relaxed">
          <span className="text-emerald-400 font-bold">Buy</span> when RS is above zero, price is above the Supertrend
          {rsiOn ? ', RSI(14) is above 50' : ''}{emaOn ? ' and price is above the 200 EMA (entry only)' : ''}. <span className="text-sky-400 font-bold">In Trend</span> while a buy has
          weakened but not yet turned negative on both. <span className="text-red-400 font-bold">Sell</span> only when RS is
          below zero and price is below the Supertrend. <span className="font-bold text-zinc-300">Wait</span> means no buy yet.
          Signals use the latest daily close.
        </p>

        {holdingsError && (
          <p role="status" className="text-[11px] text-amber-300">
            Holdings unavailable ({holdingsError}). The Held column may be empty; the order window re-checks before any delivery sell.
          </p>
        )}

        {error && (
          <div role="alert" className="p-3.5 rounded-xl border border-red-800/60 bg-red-950/40 text-red-300 text-xs flex items-center justify-between gap-3">
            <span>{error}. Check that the dashboard data is synced, then recalculate.</span>
            <button onClick={() => load(period, rsiOn ? RSI_MIN : 0, emaOn, true)} className="font-bold underline">Retry</button>
          </div>
        )}

        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div role="tablist" className="flex items-center gap-1 p-1 rounded-lg bg-zinc-900 border border-zinc-800">
            {tabs.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => pickTab(t.id)}
                className={`px-3 py-1.5 rounded-md text-xs font-bold focus:outline-none focus:ring-2 focus:ring-emerald-500/50 ${
                  tab === t.id ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {t.label}
                <span className={`ml-1.5 font-mono ${t.id === 'BUY' ? 'text-emerald-400' : t.id === 'HOLD' ? 'text-sky-400' : t.id === 'SELL' ? 'text-red-400' : 'text-zinc-400'}`}>
                  {t.n ?? '–'}
                </span>
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
          <select
            aria-label="Index"
            value={indexKey}
            onChange={(e) => setIndexKey(e.target.value)}
            disabled={indices === null}
            title={indicesError ? `Index lists unavailable: ${indicesError}` : indexKey ? `NSE list downloaded ${indices?.find((i) => i.key === indexKey)?.downloaded}` : 'Show only the stocks in one NSE index'}
            className={`px-2.5 py-1.5 rounded-md border text-xs font-bold focus:outline-none focus:ring-2 focus:ring-emerald-500/50 disabled:opacity-50 ${
              indexKey ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-400' : 'bg-zinc-900 border-zinc-800 text-zinc-300'
            }`}
          >
            <option value="">All Nifty 500</option>
            {(indices ?? []).map((i) => (
              <option key={i.key} value={i.key}>{i.label} ({i.count}{i.count < i.total ? ` of ${i.total}` : ''})</option>
            ))}
          </select>
          <PriceRangeChip value={price} onCommit={(r) => setPrice(r)} />
          {([
            ['RSI > 50', rsiOn, setRsiOn, 'Require RSI(14) above 50 for a buy'],
            ['Above EMA 200', emaOn, setEmaOn, 'Require price above the 200-day EMA for a buy. Entry only: a stock you already hold is not sold for dipping under it'],
          ] as [string, boolean, (v: boolean) => void, string][]).map(([label, on, set, tip]) => (
            <button
              key={label}
              onClick={() => set(!on)}
              aria-pressed={on}
              title={tip}
              className={`px-2.5 py-1.5 rounded-md border text-xs font-bold focus:outline-none focus:ring-2 focus:ring-emerald-500/50 ${
                on ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-400' : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {label}
            </button>
          ))}
          <ThresholdChip
            label="RS ≥" tip="Only stocks whose RS is at least this value. 0.10 = outperforming Nifty by 10 points (StockEdge's 'strongly outperforming'). Edit the number to change it."
            on={strongOnly} onToggle={() => setStrongOnly(!strongOnly)}
            value={strongMin} onCommit={(v) => { setStrongMin(v); setStrongOnly(true); }}
            min={-1} max={10} step={0.05} decimals={2}
          />
          <ThresholdChip
            label="RS rising" unit="days" tip="Only stocks whose RS has risen for this many sessions in a row, ending today. 3 matches StockEdge's 'increasing RS'. Edit the number to change it."
            on={risingOnly} onToggle={() => setRisingOnly(!risingOnly)}
            value={risingDays} onCommit={(v) => { setRisingDays(v); setRisingOnly(true); }}
            min={1} max={30} step={1} decimals={0}
          />
          {([
            ['EMA stack', stackOnly, setStackOnly, 'A clean uptrend: price above EMA 20, which is above EMA 50, which is above EMA 100, which is above EMA 200. Needs 200 days of history.'],
            ['In portfolio', heldOnly, setHeldOnly, 'Only stocks you already hold or have a position in today'],
            ['Weekly long', weeklyOnly, setWeeklyOnly, 'Weekly chart (same RS and Supertrend rules) is also Buy or In Trend. Needs about 70 weeks of history'],
          ] as [string, boolean, (v: boolean) => void, string][]).map(([label, on, set, tip]) => (
            <button
              key={label}
              onClick={() => set(!on)}
              aria-pressed={on}
              title={tip}
              className={`px-2.5 py-1.5 rounded-md border text-xs font-bold focus:outline-none focus:ring-2 focus:ring-emerald-500/50 ${
                on ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-400' : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {label}
            </button>
          ))}
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2" aria-hidden="true" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search symbol"
              aria-label="Search symbol"
              className="w-52 pl-8 pr-2 py-1.5 rounded-md bg-zinc-900 border border-zinc-800 text-xs text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
            />
          </div>
          </div>
        </div>

        <section className="bg-zinc-900/60 border border-zinc-800 rounded-2xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left font-mono text-xs">
              <thead className="bg-zinc-800 text-xs font-bold text-white">
                <tr>
                  {th('symbol', 'Symbol', 'text-left')}
                  {th('held', 'Held')}
                  {th('close', 'Close')}
                  {th('change1D', '1D %')}
                  {th('rs', `RS-${period}`)}
                  {th('rs', 'RS vs 0', 'text-left', 'RS drawn around the zero line: right of the line is outperforming Nifty, left is lagging')}
                  {th('supertrend', 'Supertrend')}
                  {th('ema', `EMA ${data?.params.emaPeriod ?? 200}`)}
                  {th('rsi', 'RSI')}
                  {th('distPct', 'From ST %')}
                  {th('signal', 'Signal', 'text-center')}
                  {th('entryDate', 'Buy date', 'text-center')}
                  {th('weekly', 'Weekly', 'text-center')}
                  {th('daysInSignal', 'Bars', 'text-right', 'Daily bars the stock has been in its current state (a Buy and the In Trend that follows count together)')}
                  <th className="px-3 py-3 text-center sticky right-0 z-10 bg-zinc-800 border-l border-zinc-700">Trade</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/80 bg-zinc-950/60">
                {rows.map((s: RsStrategyStock) => (
                    <tr key={s.symbol} className="group hover:bg-zinc-900/70">
                      <td className="px-3 py-2.5 font-bold text-zinc-100">{s.symbol}</td>
                      <HeldCell h={holdings ? holdings[s.symbol] : undefined} loaded={holdings !== null} />
                      <td className="px-3 py-2.5 text-right text-zinc-200">{fmt(s.close)}</td>
                      <td className={`px-3 py-2.5 text-right ${tone(s.change1D)}`}>{signed(s.change1D)}</td>
                      <td className={`px-3 py-2.5 text-right font-bold ${tone(s.rs)}`}>{signed(s.rs)}</td>
                      <td className="px-3 py-2.5"><RsBar value={s.rs} /></td>
                      <td className="px-3 py-2.5 text-right text-zinc-300">{fmt(s.supertrend)}</td>
                      <td
                        className={`px-3 py-2.5 text-right ${s.ema === null ? 'text-zinc-500' : s.close > s.ema ? 'text-emerald-400' : 'text-red-400'}`}
                        title={s.ema === null ? 'Fewer than 200 days of history' : s.close > s.ema ? 'Price is above the 200 EMA' : 'Price is below the 200 EMA'}
                      >{s.ema === null ? '–' : fmt(s.ema)}</td>
                      <td className={`px-3 py-2.5 text-right ${s.rsi > 50 ? 'text-zinc-200' : 'text-zinc-400'}`}>{fmt(s.rsi, 0)}</td>
                      <td className={`px-3 py-2.5 text-right ${tone(s.distPct)}`}>{signed(s.distPct)}</td>
                      <td className="px-3 py-2.5 text-center">
                        <span className={`inline-block whitespace-nowrap px-2 py-0.5 rounded border text-[10px] font-bold ${BADGE[s.signal]}`}>
                          {LABEL[s.signal]}
                        </span>
                      </td>
                      <td
                        className={`px-3 py-2.5 text-center whitespace-nowrap ${s.entryDate ? 'text-zinc-200' : 'text-zinc-500'}`}
                        title={s.entryDate ? `The current buy triggered on ${s.entryDate}` : 'No active buy (Wait or Sell)'}
                      >{s.entryDate ?? '-'}</td>
                      <td className="px-3 py-2.5 text-center">
                        {s.weekly ? (
                          <span className={`inline-block whitespace-nowrap px-2 py-0.5 rounded border text-[10px] font-bold ${BADGE[s.weekly]}`}>{LABEL[s.weekly]}</span>
                        ) : (
                          <span className="text-zinc-500" title="Not enough weekly history">–</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right text-zinc-300">{s.daysInSignal}</td>
                      <td className="px-3 py-2.5 sticky right-0 bg-zinc-950 group-hover:bg-zinc-900 border-l border-zinc-800">
                        <div className="flex items-center justify-center gap-1">
                          <button
                            onClick={() => setOrder({ symbol: s.symbol, side: 'BUY' })}
                            aria-label={`Buy ${s.symbol}`}
                            className="px-2.5 py-1 rounded-md bg-emerald-600 hover:bg-emerald-500 text-oncolor text-[11px] font-bold focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50"
                          >Buy</button>
                          <button
                            onClick={() => setOrder({ symbol: s.symbol, side: 'SELL' })}
                            disabled={holdings !== null && !ownsAny(holdings[s.symbol])}
                            title={holdings !== null && !ownsAny(holdings[s.symbol]) ? `You hold no ${s.symbol}, so there is nothing to sell` : undefined}
                            aria-label={`Sell ${s.symbol}`}
                            className="px-2.5 py-1 rounded-md bg-red-600 hover:bg-red-500 text-oncolor text-[11px] font-bold focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500/50 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-red-600"
                          >Sell</button>
                        </div>
                      </td>
                    </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* Outside the scrolling table so the message is never pushed off-screen on a narrow window. */}
          {loading && !data ? (
            <p role="status" className="px-4 py-10 text-center text-sm text-zinc-400">
              <Activity className="w-4 h-4 inline mr-2 animate-spin text-emerald-400" aria-hidden="true" />
              Scanning Nifty 500…
            </p>
          ) : rows.length === 0 ? (
            <p role="status" className="px-4 py-10 text-center text-sm text-zinc-400">
              {data
                ? tab !== 'ALL' && filtered.length > 0 ? `None of the ${filtered.length} matching stock${filtered.length === 1 ? ' is' : 's are'} in the ${LABEL[tab]} state. Try another tab.`
                : query ? `No ${tab === 'ALL' ? '' : LABEL[tab] + ' '}symbols match “${query}”.` : strongOnly || risingOnly || stackOnly || weeklyOnly || heldOnly || indexKey || price.min !== null || price.max !== null ? 'No stocks match these filters. Turn one off to widen the list.' : `No stocks are in the ${tab === 'ALL' ? 'selected' : LABEL[tab]} state today.`
                : 'No scan results yet. Recalculate to run the scan.'}
            </p>
          ) : null}
        </section>
      </main>

      {guide && <RsStrategyGuide open={guideOpen} onClose={() => setGuideOpen(false)} markdown={guide} />}

      {order && (
        <EquityOrderModal
          key={`${order.symbol}:${order.side}`}
          symbol={order.symbol}
          side={order.side}
          onClose={() => setOrder(null)}
          onPlaced={afterOrder}
        />
      )}
    </div>
  );
}

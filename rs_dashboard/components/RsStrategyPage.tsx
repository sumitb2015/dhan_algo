'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChartNoAxesCombined, RefreshCw, Search, Activity } from 'lucide-react';
import NavBar from './NavBar';
import { cachedFetch, setCached } from '@/lib/clientCache';
import { DEFAULT_PARAMS, type RsStrategyResponse, type RsStrategyStock, type RsSignal } from '@/lib/rsStrategyCore';

type Tab = 'BUY' | 'HOLD' | 'SELL' | 'ALL';
type SortKey = 'symbol' | 'close' | 'change1D' | 'rs' | 'rsi' | 'distPct' | 'daysInSignal';

const DEFAULT_PERIOD = DEFAULT_PARAMS.period;
const TTL_MS = 5 * 60 * 1000;
const RSI_MIN = DEFAULT_PARAMS.rsiMin; // bullish condition: RSI(14) above 50
const STRONG_RS = 0.1; // StockEdge's "strongly outperforming": RS above 0.1

const BADGE: Record<RsSignal, string> = {
  BUY: 'bg-emerald-500/10 border-emerald-500/25 text-emerald-400',
  HOLD: 'bg-sky-500/10 border-sky-500/25 text-sky-400',
  SELL: 'bg-red-500/10 border-red-500/25 text-red-400',
  WAIT: 'bg-zinc-800 border-zinc-700 text-zinc-400',
};
const LABEL: Record<RsSignal, string> = { BUY: 'Buy', HOLD: 'Hold', SELL: 'Sell', WAIT: 'Wait' };

const fmt = (n: number, d = 2) => n.toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
const signed = (n: number) => `${n > 0 ? '+' : ''}${fmt(n)}`;
const tone = (n: number) => (n > 0 ? 'text-emerald-400' : n < 0 ? 'text-red-400' : 'text-zinc-400');

/** RS drawn around a centre zero line, mirroring the indicator's zero line. Saturates at ±1.0. */
function RsBar({ value }: { value: number }) {
  const w = (Math.min(Math.abs(value), 1) / 2) * 100; // % of the full track on one side
  return (
    <div className="relative h-1.5 w-28 rounded-full bg-zinc-800" aria-hidden="true">
      <span className="absolute left-1/2 top-[-2px] bottom-[-2px] w-px bg-zinc-500" />
      <span
        className={`absolute top-0 bottom-0 rounded-full ${value >= 0 ? 'bg-emerald-400' : 'bg-red-400'}`}
        style={value >= 0 ? { left: '50%', width: `${w}%` } : { right: '50%', width: `${w}%` }}
      />
    </div>
  );
}

export default function RsStrategyPage() {
  const [period, setPeriod] = useState(DEFAULT_PERIOD);
  const [periodDraft, setPeriodDraft] = useState(String(DEFAULT_PERIOD));
  const [data, setData] = useState<RsStrategyResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rsiOn, setRsiOn] = useState(true); // BUY also needs RSI(14) > 50
  const [strongOnly, setStrongOnly] = useState(false); // RS >= 10%
  const [risingOnly, setRisingOnly] = useState(false); // RS up 3 sessions in a row
  const [weeklyOnly, setWeeklyOnly] = useState(false); // weekly chart is also long (Buy or Hold)
  const [tab, setTab] = useState<Tab>('BUY');
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('rs');
  const [sortAsc, setSortAsc] = useState(false);

  // Monotonic sequence so a slow earlier response cannot overwrite a newer one (toggle RSI, change period).
  const seq = useRef(0);
  const load = useCallback(async (p: number, rsiMin: number, refresh = false) => {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const base = `/api/rs-strategy?period=${p}&rsiMin=${rsiMin}`;
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

  useEffect(() => { load(period, rsiOn ? RSI_MIN : 0); }, [period, rsiOn, load]);

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

  const rows = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    const list = data.stocks.filter(
      (s) => (tab === 'ALL' || s.signal === tab) &&
        (!strongOnly || s.rs >= STRONG_RS) &&
        (!risingOnly || s.rsRising) &&
        (!weeklyOnly || s.weekly === 'BUY' || s.weekly === 'HOLD') &&
        (!q || s.symbol.toLowerCase().includes(q)),
    );
    const dir = sortAsc ? 1 : -1;
    return list.sort((a, b) =>
      sortKey === 'symbol' ? a.symbol.localeCompare(b.symbol) * dir : (a[sortKey] - b[sortKey]) * dir,
    );
  }, [data, tab, query, sortKey, sortAsc, strongOnly, risingOnly, weeklyOnly]);

  const counts = data?.counts;
  const tabs: { id: Tab; label: string; n?: number }[] = [
    { id: 'BUY', label: 'Buy', n: counts?.buy },
    { id: 'HOLD', label: 'Hold', n: counts?.hold },
    { id: 'SELL', label: 'Sell', n: counts?.sell },
    { id: 'ALL', label: 'All', n: data?.totalScanned },
  ];

  const th = (k: SortKey, label: string, align = 'text-right') => (
    <th
      className={`px-4 py-3 ${align} whitespace-nowrap`}
      aria-sort={sortKey === k ? (sortAsc ? 'ascending' : 'descending') : 'none'}
    >
      <button
        onClick={() => handleSort(k)}
        className="font-bold hover:text-emerald-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 rounded"
      >
        {label}{sortKey === k ? (sortAsc ? ' ↑' : ' ↓') : ''}
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
          <button
            onClick={() => load(period, rsiOn ? RSI_MIN : 0, true)}
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
          {rsiOn ? ' and RSI(14) is above 50' : ''}. <span className="text-sky-400 font-bold">Hold</span> while a buy has
          weakened but not yet turned negative on both. <span className="text-red-400 font-bold">Sell</span> only when RS is
          below zero and price is below the Supertrend. <span className="font-bold text-zinc-300">Wait</span> means no buy yet.
          Signals use the latest daily close.
        </p>

        {error && (
          <div role="alert" className="p-3.5 rounded-xl border border-red-800/60 bg-red-950/40 text-red-300 text-xs flex items-center justify-between gap-3">
            <span>{error}. Check that the dashboard data is synced, then recalculate.</span>
            <button onClick={() => load(period, rsiOn ? RSI_MIN : 0, true)} className="font-bold underline">Retry</button>
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
          {([
            ['RSI > 50', rsiOn, setRsiOn, 'Require RSI(14) above 50 for a buy'],
            ['RS ≥ 0.10', strongOnly, setStrongOnly, 'Only stocks with RS of 0.10 or more (outperforming Nifty by 10 points)'],
            ['RS rising 3d', risingOnly, setRisingOnly, 'Only stocks whose RS rose three sessions in a row'],
            ['Weekly long', weeklyOnly, setWeeklyOnly, 'Weekly chart (same RS and Supertrend rules) is also Buy or Hold. Needs about 70 weeks of history'],
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
                  {th('close', 'Close')}
                  {th('change1D', '1D %')}
                  {th('rs', `RS-${period}`)}
                  <th className="px-4 py-3 text-left">RS vs zero</th>
                  <th className="px-4 py-3 text-right">Supertrend</th>
                  {th('rsi', 'RSI')}
                  {th('distPct', 'From ST %')}
                  <th className="px-4 py-3 text-center">Signal</th>
                  <th className="px-4 py-3 text-center">Weekly</th>
                  {th('daysInSignal', 'Bars in state')}
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/80 bg-zinc-950/60">
                {loading && !data ? (
                  <tr><td colSpan={11} className="px-4 py-10 text-center text-zinc-400">
                    <Activity className="w-4 h-4 inline mr-2 animate-spin text-emerald-400" aria-hidden="true" />
                    Scanning Nifty 500…
                  </td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={11} className="px-4 py-10 text-center text-zinc-400">
                    {data
                      ? query ? `No ${tab === 'ALL' ? '' : tab.toLowerCase() + ' '}symbols match “${query}”.` : strongOnly || risingOnly || weeklyOnly ? 'No stocks match these filters. Turn one off to widen the list.' : `No stocks are in the ${tab.toLowerCase()} state today.`
                      : 'No scan results yet. Recalculate to run the scan.'}
                  </td></tr>
                ) : (
                  rows.map((s: RsStrategyStock) => (
                    <tr key={s.symbol} className="hover:bg-zinc-900/70">
                      <td className="px-4 py-2.5 font-bold text-zinc-100">{s.symbol}</td>
                      <td className="px-4 py-2.5 text-right text-zinc-200">{fmt(s.close)}</td>
                      <td className={`px-4 py-2.5 text-right ${tone(s.change1D)}`}>{signed(s.change1D)}</td>
                      <td className={`px-4 py-2.5 text-right font-bold ${tone(s.rs)}`}>{signed(s.rs)}</td>
                      <td className="px-4 py-2.5"><RsBar value={s.rs} /></td>
                      <td className="px-4 py-2.5 text-right text-zinc-300">{fmt(s.supertrend)}</td>
                      <td className={`px-4 py-2.5 text-right ${s.rsi > 50 ? 'text-zinc-200' : 'text-zinc-400'}`}>{fmt(s.rsi, 0)}</td>
                      <td className={`px-4 py-2.5 text-right ${tone(s.distPct)}`}>{signed(s.distPct)}</td>
                      <td className="px-4 py-2.5 text-center">
                        <span className={`inline-block px-2 py-0.5 rounded border text-[10px] font-bold ${BADGE[s.signal]}`}>
                          {LABEL[s.signal]}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        {s.weekly ? (
                          <span className={`inline-block px-2 py-0.5 rounded border text-[10px] font-bold ${BADGE[s.weekly]}`}>{LABEL[s.weekly]}</span>
                        ) : (
                          <span className="text-zinc-500" title="Not enough weekly history">–</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right text-zinc-300">{s.daysInSignal}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, Loader2, Play, Scale, Square, X } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Cell, LabelList, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import NavBar from '@/components/NavBar';
import { DASH, PctPill, TD, TH, type SortDir } from '@/components/LiveTickerPanel';
import { cn } from '@/lib/utils';
import { ageText } from '@/components/us-markets/format';
import { inr, istDate } from '@/components/india-markets/format';
import { buildTotals, type ContributionResult, type ContributionRow, type TotalBar } from '@/lib/niftyContribution';

const POLL_MS = 2000;
const SAMPLE_MS = 10_000;       // one history point per 10 s, however fast the poll
const HISTORY_KEY = 'niftyContribHistory:';
const LINE_VARS = ['--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5'];
const LINE_DASH = ['', '6 3', '2 3'];

/** One moment of the session: the net total and every priced stock's points. Built client-side from the 2 s poll. */
interface Sample { t: number; net: number; p: Record<string, number> }

const lineColor = (i: number) => `var(${LINE_VARS[i % LINE_VARS.length]})`;
const lineDash = (i: number) => LINE_DASH[Math.floor(i / LINE_VARS.length) % LINE_DASH.length] || undefined;
const istTime = (t: number) => new Date(t).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });

type FeedState = 'live' | 'starting' | 'stale' | 'stopped';
interface FeedInfo { state: FeedState; updatedAt: number | null; ageMs: number | null }
interface Resp {
  success: boolean; error?: string; serverTime: number; weightsAsOf: string | null;
  feeds: { stocks: FeedInfo; indices: FeedInfo };
  nifty: { ltp: number; prevClose: number; change: number; changePct: number } | null;
  result: ContributionResult;
}

const FEED_UI: Record<FeedState, string> = {
  live: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
  starting: 'text-sky-300 bg-sky-500/10 border-sky-500/20',
  stale: 'text-amber-300 bg-amber-500/10 border-amber-500/20',
  stopped: 'text-zinc-400 bg-zinc-800 border-zinc-700',
};

/** The two existing bridges this page reads. Shared with other pages, so Stop says so. */
const FEEDS = [
  { key: 'stocks' as const, label: 'Stocks', route: '/api/daily-market', shared: 'the Daily Market and India Markets pages' },
  { key: 'indices' as const, label: 'Indices', route: '/api/live-indices', shared: 'Live Indices and the scalper Top Indices strip' },
];

const CONCENTRATION_UI = {
  narrow: { label: 'Narrow', cls: 'text-amber-300 bg-amber-500/10 border-amber-500/20', hint: 'A few heavyweights are carrying the move - these rallies/falls tend not to hold.' },
  moderate: { label: 'Moderate', cls: 'text-zinc-300 bg-zinc-800 border-zinc-700', hint: 'The move is shared by a fair number of stocks.' },
  broad: { label: 'Broad', cls: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20', hint: 'Many stocks are contributing - a more durable move.' },
} as const;

const pts = (v: number, d = 2) => `${v > 0 ? '+' : ''}${v.toFixed(d)}`;
const signCls = (v: number) => (v > 0 ? 'text-emerald-400' : v < 0 ? 'text-red-400' : 'text-zinc-400');

function Tile({ label, value, sub, valueCls, title }: { label: string; value: React.ReactNode; sub?: React.ReactNode; valueCls?: string; title?: string }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2" title={title}>
      <p className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">{label}</p>
      <p className={cn('text-lg font-bold font-mono tabular-nums leading-tight mt-0.5', valueCls ?? 'text-zinc-100')}>{value}</p>
      {sub != null && <p className="text-[11px] text-zinc-500 font-mono mt-0.5">{sub}</p>}
    </div>
  );
}

function BarTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: ContributionRow }> }) {
  const r = active ? payload?.[0]?.payload : undefined;
  if (!r) return null;
  return (
    <div style={{ background: 'var(--chart-tooltip-bg)', border: '1px solid var(--chart-tooltip-border)', color: 'var(--chart-tooltip-text)', borderRadius: 8, padding: '6px 10px', fontSize: 11 }}>
      <div className="font-bold">{r.symbol} <span className="font-normal">{r.name}</span></div>
      <div className="font-mono">{pts(r.points)} pts · {pts(r.changePct)}% · weight {r.weightPct.toFixed(2)}%</div>
      <div className="font-mono">LTP {inr(r.ltp)} (prev {inr(r.prevClose)})</div>
    </div>
  );
}

function TotalsTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: TotalBar }> }) {
  const b = active ? payload?.[0]?.payload : undefined;
  if (!b) return null;
  return (
    <div style={{ background: 'var(--chart-tooltip-bg)', border: '1px solid var(--chart-tooltip-border)', color: 'var(--chart-tooltip-text)', borderRadius: 8, padding: '6px 10px', fontSize: 11 }}>
      <div className="font-bold">{b.label} <span className="font-normal font-mono">{pts(b.value)} pts · {b.count} stock{b.count === 1 ? '' : 's'}</span></div>
      {b.top.map(t => <div key={t.symbol} className="font-mono">{t.symbol} {pts(t.points)}</div>)}
    </div>
  );
}

/** The bar's own value, printed past its tip (above a green bar, below a red one). Heights can be negative for a negative value. */
function TimelineTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ dataKey?: string | number; value?: number; color?: string }>; label?: number }) {
  if (!active || !payload?.length || label == null) return null;
  const rows = [...payload].filter(p => typeof p.value === 'number').sort((a, b) => (b.value as number) - (a.value as number));
  return (
    <div style={{ background: 'var(--chart-tooltip-bg)', border: '1px solid var(--chart-tooltip-border)', color: 'var(--chart-tooltip-text)', borderRadius: 8, padding: '6px 10px', fontSize: 11 }}>
      <div className="font-bold mb-0.5">{istTime(label)} IST</div>
      {rows.map(p => (
        <div key={String(p.dataKey)} className="font-mono flex justify-between gap-4">
          <span style={{ color: p.color }}>{p.dataKey === 'net' ? 'NET' : String(p.dataKey)}</span><span>{pts(p.value as number)}</span>
        </div>
      ))}
    </div>
  );
}

function TotalLabel({ x, y, width, height, value }: { x?: unknown; y?: unknown; width?: unknown; height?: unknown; value?: unknown }) {
  const [px, py, w, h, v] = [x, y, width, height, value].map(Number);
  if (![px, py, w, h, v].every(Number.isFinite)) return null;
  const top = Math.min(py, py + h), bottom = Math.max(py, py + h);
  return (
    <text x={px + w / 2} y={v >= 0 ? top - 8 : bottom + 18} textAnchor="middle" fontSize={16} fontWeight={700} fontFamily="ui-monospace, monospace"
      fill={v >= 0 ? 'var(--chart-pos)' : 'var(--chart-neg)'}>
      {pts(v)}
    </text>
  );
}

/** A horizontal bar's contribution, printed just past its tip (right of a green bar, left of a red one). */
function StockLabel({ x, y, width, height, value }: { x?: unknown; y?: unknown; width?: unknown; height?: unknown; value?: unknown }) {
  const [px, py, w, h, v] = [x, y, width, height, value].map(Number);
  if (![px, py, w, h, v].every(Number.isFinite)) return null;
  const tip = v >= 0 ? Math.max(px, px + w) : Math.min(px, px + w);
  return (
    <text x={v >= 0 ? tip + 5 : tip - 5} y={py + h / 2} dy={4} textAnchor={v >= 0 ? 'start' : 'end'} fontSize={11} fontWeight={700}
      fontFamily="ui-monospace, monospace" fill={v >= 0 ? 'var(--chart-pos)' : 'var(--chart-neg)'}>
      {pts(v)}
    </text>
  );
}

type SortKey ='points' | 'symbol' | 'changePct' | 'weightPct' | 'ltp';
type View = 'stock' | 'cumulative' | 'timeline';

export default function NiftyContribution() {
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [view, setView] = useState<View>('stock');
  const [topN, setTopN] = useState<10 | 15 | 0>(10); // 0 = all
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'points', dir: 'desc' });
  const [history, setHistory] = useState<Sample[]>([]);
  const [picked, setPicked] = useState<Set<string>>(() => new Set()); // stock overlays on the timeline; none until the user adds some
  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);
  const [showNet, setShowNet] = useState(true);
  const lastSample = useRef(0);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const r = await fetch('/api/nifty-contribution', { cache: 'no-store' });
      const j = await r.json().catch(() => null) as Resp | null;
      if (mine !== seq.current) return;
      if (!r.ok || !j?.success) { setError(j?.error ?? `HTTP ${r.status}`); return; }
      setData(j);
      setError(null);
    } catch (e) {
      if (mine === seq.current) setError(e instanceof Error ? e.message : 'Network error');
    }
  }, []);

  useEffect(() => {
    const counter = seq;
    const first = setTimeout(load, 0);
    const t = setInterval(() => { if (!document.hidden) load(); }, POLL_MS);
    const onVis = () => { if (!document.hidden) load(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearTimeout(first); clearInterval(t); document.removeEventListener('visibilitychange', onVis); counter.current++; };
  }, [load]);

  const control = async (route: string, action: 'start' | 'stop', key: string) => {
    setBusy(key);
    setNotice(null);
    try {
      const r = await fetch(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) });
      const j = await r.json().catch(() => null) as { success?: boolean; error?: string } | null;
      if (!r.ok || !j?.success) setNotice(j?.error ?? `HTTP ${r.status}`);
      await load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Network error');
    } finally { setBusy(null); }
  };

  const res = data?.result;

  // Restore today's history (the tab may have been reloaded). Storage can be blocked or full: the chart still works from memory.
  useEffect(() => {
    const id = setTimeout(() => {
      try {
        const raw = localStorage.getItem(HISTORY_KEY + istDate(Date.now()));
        const h = raw ? JSON.parse(raw) as Sample[] : [];
        if (Array.isArray(h) && h.length) { lastSample.current = h[h.length - 1].t; setHistory(h); }
      } catch { /* ignore */ }
    }, 0);
    return () => clearTimeout(id);
  }, []);

  // Record a point per SAMPLE_MS while the stock feed is live; a stale feed would only repeat the same quotes.
  useEffect(() => {
    if (!data || data.feeds.stocks.state !== 'live' || data.result.rows.length === 0) return;
    const t = data.serverTime;
    if (t - lastSample.current < SAMPLE_MS) return;
    lastSample.current = t;
    const p: Record<string, number> = {};
    for (const r of data.result.rows) p[r.symbol] = Math.round(r.points * 100) / 100;
    const sample: Sample = { t, net: Math.round(data.result.net * 100) / 100, p };
    setHistory(h => {
      const next = [...h, sample];
      try { localStorage.setItem(HISTORY_KEY + istDate(t), JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, [data]);

  const clearHistory = () => {
    lastSample.current = 0;
    setHistory([]);
    try { localStorage.removeItem(HISTORY_KEY + istDate(Date.now())); } catch { /* ignore */ }
  };

  const togglePick = (sym: string) => setPicked(prev => {
    const n = new Set(prev);
    if (n.has(sym)) n.delete(sym); else n.add(sym);
    return n;
  });
  const setGroup = (rows: ContributionRow[], on: boolean) => setPicked(prev => {
    const n = new Set(prev);
    for (const r of rows) { if (on) n.add(r.symbol); else n.delete(r.symbol); }
    return n;
  });

  // Close the stock menu on an outside click or Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [menuOpen]);
  const lineSymbols = useMemo(() => (res ? [...res.pullers, ...res.draggers].map(r => r.symbol).filter(s => picked.has(s)) : []), [res, picked]);
  // Colour follows the stock's place in the full chip order, so it does not change when others are toggled.
  const chipOrder = useMemo(() => (res ? [...res.pullers, ...res.draggers].map(r => r.symbol) : []), [res]);
  const timelineData = useMemo(() => (view === 'timeline' ? history.map(h => ({ t: h.t, net: h.net, ...h.p })) : []), [view, history]);
  const stocksFeed = data?.feeds.stocks;
  const indexFeed = data?.feeds.indices;
  const live = stocksFeed?.state === 'live' && indexFeed?.state === 'live';
  const dataDate = stocksFeed?.updatedAt != null ? istDate(stocksFeed.updatedAt) : null;

  // Chart: the biggest pullers on top, the biggest draggers at the bottom, optionally clipped to N each side.
  const chartRows = useMemo(() => {
    if (!res) return [];
    if (topN === 0) return res.rows;
    return [...res.pullers.slice(0, topN), ...res.draggers.slice(0, topN).reverse()];
  }, [res, topN]);

  // X-axis extent only ever widens (per Top-N choice), so the zero line stays put across live ticks.
  const axisRef = useRef<{ topN: number; lo: number; hi: number }>({ topN, lo: 0, hi: 0 });
  const axisDomain = useMemo<[number, number]>(() => {
    const a = axisRef.current;
    if (a.topN !== topN) { a.topN = topN; a.lo = 0; a.hi = 0; }
    let lo = 0, hi = 0;
    for (const r of chartRows) { lo = Math.min(lo, r.points); hi = Math.max(hi, r.points); }
    const step = Math.max(5, Math.ceil(Math.max(hi, -lo) / 4 / 5) * 5);
    const pad = (v: number) => Math.sign(v) * (Math.ceil(Math.abs(v) / step) * step + step * 0.6);
    a.lo = Math.min(a.lo, lo === 0 ? 0 : pad(lo));
    a.hi = Math.max(a.hi, hi === 0 ? 0 : pad(hi));
    return [a.lo, a.hi];
  }, [chartRows, topN]);

  const maxAbsPts = useMemo(() => Math.max(0.01, ...(res?.rows ?? []).map(r => Math.abs(r.points))), [res]);

  // Only worth building while its tab is open: the page re-renders on every 2 s poll.
  const totals = useMemo(() => (view === 'cumulative' && res ? buildTotals(res) : []), [view, res]);

  const tableRows = useMemo(() => {
    if (!res) return [];
    const { key, dir } = sort;
    const m = dir === 'asc' ? 1 : -1;
    return [...res.rows].sort((a, b) => key === 'symbol' ? m * a.symbol.localeCompare(b.symbol) : m * (a[key] - b[key]));
  }, [res, sort]);
  // Running total of Points down the rows as currently sorted (default sort: how the pullers build up, then the draggers give back).
  const cumPoints = useMemo(() => {
    let run = 0;
    return tableRows.map(r => (run += r.points));
  }, [tableRows]);
  const sortBy = (key: SortKey) => setSort(s => ({ key, dir: s.key === key && s.dir === 'desc' ? 'asc' : 'desc' }));
  const dirOf = (key: SortKey) => (sort.key === key ? sort.dir : null);

  const conc = res?.concentration ? CONCENTRATION_UI[res.concentration] : null;

  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-white">
      <div className="sticky top-0 z-30 flex items-center justify-between gap-3 flex-wrap px-6 py-3 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0 bg-sky-500/10 border border-sky-500/25">
            <Scale className="w-4 h-4 text-sky-400" aria-hidden="true" />
          </div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-sky-400 mb-0.5">Index · NIFTY 50</p>
            <h1 className="text-sm font-bold text-white tracking-tight leading-none">Nifty Contribution</h1>
            <p className="text-[10px] text-zinc-500 font-medium mt-1">Index points each stock is adding or removing right now, from Dhan&apos;s live feed. Watch-only - no orders.</p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {FEEDS.map(f => {
            const info = data?.feeds[f.key];
            const st = info?.state ?? 'stopped';
            const running = st !== 'stopped';
            return (
              <div key={f.key} className="flex items-center gap-1">
                <span className={cn('text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border', FEED_UI[st])}
                  title={info?.ageMs != null ? `Last update ${ageText(info.ageMs)} (at the last poll)` : 'No snapshot yet'}>
                  {f.label}: {st}
                </span>
                <button onClick={() => control(f.route, running ? 'stop' : 'start', f.key)} disabled={busy === f.key || !data}
                  aria-label={`${running ? 'Stop' : 'Start'} ${f.label.toLowerCase()} feed`}
                  title={running ? `Stop the ${f.label.toLowerCase()} feed - also stops it for ${f.shared}` : `Start the ${f.label.toLowerCase()} feed`}
                  className={cn('h-7 w-7 inline-flex items-center justify-center rounded-md border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 disabled:opacity-50',
                    running ? 'border-zinc-700 bg-zinc-900 text-zinc-300' : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400')}>
                  {busy === f.key ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : running ? <Square className="h-3.5 w-3.5" aria-hidden="true" /> : <Play className="h-3.5 w-3.5" aria-hidden="true" />}
                </button>
              </div>
            );
          })}
          <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-amber-300 px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/20">
            DATA: {dataDate ?? '—'}
          </span>
          <span className="w-px h-5 bg-zinc-800 shrink-0" />
          <NavBar />
        </div>
      </div>

      <div className="flex-1 flex flex-col gap-4 px-4 sm:px-6 py-5 max-w-[1680px] w-full mx-auto">
        {notice && (
          <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden="true" /><span>{notice}</span>
          </div>
        )}
        {error && (
          <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden="true" /><span>{error}{data ? ' - showing the last loaded data.' : ''}</span>
          </div>
        )}
        {data && !live && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden="true" />
            <span>
              Not fully live - these are the last saved quotes
              {stocksFeed?.ageMs != null && <> (stocks {ageText(stocksFeed.ageMs)})</>}
              {indexFeed?.ageMs != null && <> (index {ageText(indexFeed.ageMs)})</>}.
              {' '}Press ▶ next to a stopped feed. NSE cash hours are 09:15-15:30 IST.
            </span>
          </div>
        )}
        {/* Only when both feeds are live: with a stale stock feed the sum is 0 and the gap says nothing about the weights. */}
        {res?.residualFlag && live && (
          <div role="alert" className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden="true" />
            <span>
              The stock contributions sum to {pts(res.net)} but Nifty moved {data?.nifty ? pts(data.nifty.change) : '-'} - the weight snapshot
              (as of {data?.weightsAsOf ?? 'unknown'}) probably predates an index rebalance. Refresh it with <code className="font-mono">scripts/tools/refresh_nifty_weights.py</code>.
            </span>
          </div>
        )}
        {res && res.missing.length > 0 && (
          <div className="flex items-start gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs text-zinc-300">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-zinc-400" aria-hidden="true" />
            <span>No usable price yet for {res.missing.length} stock{res.missing.length > 1 ? 's' : ''}: {res.missing.join(', ')}. They are left out, not counted as zero.</span>
          </div>
        )}

        {!data && !error && (
          <div className="flex flex-col items-center gap-2 py-16">
            <Loader2 className="h-6 w-6 animate-spin text-emerald-400" aria-hidden="true" />
            <p className="text-zinc-200 font-semibold text-sm">Loading Nifty contribution</p>
          </div>
        )}

        {data && res && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-2">
              <Tile label="Nifty 50"
                value={data.nifty ? inr(data.nifty.ltp) : DASH}
                sub={data.nifty ? <span className={signCls(data.nifty.change)}>{pts(data.nifty.change)} ({pts(data.nifty.changePct)}%)</span> : 'no index quote'} />
              <Tile label="Net contribution" value={`${pts(res.net)} pts`} valueCls={signCls(res.net)}
                sub={<>
                  <span className="text-emerald-400">{res.pullers.length} up</span> · <span className="text-red-400">{res.draggers.length} down</span>
                  {res.residual != null ? ` · index diff ${pts(res.residual)}` : ' · no index to reconcile'}
                </>}
                title="Sum of every stock's points. The 'index diff' is this sum minus the index's own move." />
              <Tile label={`Pullers (${res.pullers.length})`} value={`${pts(res.positiveSum)} pts`} valueCls="text-emerald-400" />
              <Tile label={`Draggers (${res.draggers.length})`} value={`${pts(res.negativeSum)} pts`} valueCls="text-red-400" />
              <Tile label="Breadth of the move"
                value={conc ? <span className={cn('text-sm px-1.5 py-0.5 rounded border', conc.cls)}>{conc.label}</span> : DASH}
                sub={res.effectiveContributors != null ? `≈${res.effectiveContributors.toFixed(0)} effective stocks` : undefined}
                title={conc?.hint} />
              <Tile label="Weights as of" value={<span className="text-sm">{data.weightsAsOf ?? '—'}</span>}
                sub={`${res.rows.length}/50 priced`} title="Weight snapshot; carried forward with live prices." />
            </div>

            <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3" aria-label="Contribution by stock">
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="inline-flex rounded-md border border-zinc-700 overflow-hidden" role="tablist" aria-label="Chart view">
                  {([['stock', 'By stock'], ['cumulative', 'Cumulative'], ['timeline', 'Over time']] as const).map(([v, label]) => (
                    <button key={v} role="tab" aria-selected={view === v} onClick={() => setView(v)}
                      className={cn('px-3 py-1 text-[11px] font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60',
                        view === v ? 'bg-zinc-700 text-white' : 'bg-zinc-900 text-zinc-400 hover:text-zinc-200')}>
                      {label}
                    </button>
                  ))}
                </div>
                {view === 'stock' ? (
                  <div className="inline-flex rounded-md border border-zinc-700 overflow-hidden" role="group" aria-label="How many stocks to chart">
                    {([[10, 'Top 10'], [15, 'Top 15'], [0, 'All']] as const).map(([n, label]) => (
                      <button key={n} onClick={() => setTopN(n)} aria-pressed={topN === n}
                        className={cn('px-2.5 py-1 text-[11px] font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60',
                          topN === n ? 'bg-zinc-700 text-white' : 'bg-zinc-900 text-zinc-400 hover:text-zinc-200')}>
                        {label}
                      </button>
                    ))}
                  </div>
                ) : view === 'timeline' ? (
                  <div className="flex items-center gap-2 text-[11px] text-zinc-500">
                    <span>{history.length} point{history.length === 1 ? '' : 's'} today</span>
                    <button onClick={clearHistory} disabled={history.length === 0}
                      className="px-2 py-1 rounded-md border border-zinc-700 bg-zinc-900 text-zinc-300 font-bold hover:text-white disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60">
                      Clear
                    </button>
                  </div>
                ) : (
                  <p className="text-[11px] text-zinc-500">Everything the green side added, everything the red side took away, and what is left.</p>
                )}
              </div>
              {view === 'timeline' ? (
                <>
                  <div className="flex flex-wrap items-center gap-1.5 mb-2" role="group" aria-label="Lines to show">
                    <button onClick={() => setShowNet(v => !v)} aria-pressed={showNet}
                      className={cn('px-2 py-0.5 rounded border text-[11px] font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60',
                        showNet ? 'bg-zinc-700 text-white border-zinc-500' : 'bg-zinc-900 text-zinc-500 border-zinc-700')}>
                      NET
                    </button>
                    <div className="relative" ref={menuRef}>
                      <button onClick={() => setMenuOpen(o => !o)} aria-haspopup="listbox" aria-expanded={menuOpen}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-zinc-700 bg-zinc-900 text-[11px] font-bold text-zinc-300 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60">
                        Add stocks{picked.size > 0 ? ` (${picked.size})` : ''}
                        <ChevronDown className="h-3 w-3" aria-hidden="true" />
                      </button>
                      {menuOpen && (
                        <div className="absolute left-0 top-full mt-1 z-20 w-72 rounded-lg border border-zinc-700 bg-zinc-900 shadow-lg">
                          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search stock" aria-label="Search stocks" autoFocus
                            className="w-full rounded-t-lg border-b border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-500 focus:outline-none" />
                          <div className="max-h-72 overflow-y-auto py-1" role="listbox" aria-multiselectable="true">
                            {([['Pullers', res.pullers, 'text-emerald-400'], ['Draggers', res.draggers, 'text-red-400']] as const).map(([name, rows, cls]) => {
                              const q = query.trim().toLowerCase();
                              const shown = q ? rows.filter(r => r.symbol.toLowerCase().includes(q) || r.name.toLowerCase().includes(q)) : rows;
                              if (shown.length === 0) return null;
                              return (
                                <div key={name}>
                                  <div className="flex items-center gap-2 px-2 py-1">
                                    <span className={cn('text-[10px] font-bold uppercase tracking-wider', cls)}>{name} ({shown.length})</span>
                                    <button onClick={() => setGroup(shown, true)} className="text-[10px] text-zinc-400 hover:text-white underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60">all</button>
                                    <button onClick={() => setGroup(shown, false)} className="text-[10px] text-zinc-400 hover:text-white underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60">none</button>
                                  </div>
                                  {shown.map(r => {
                                    const on = picked.has(r.symbol);
                                    return (
                                      <label key={r.symbol} role="option" aria-selected={on} className="flex items-center gap-2 px-2 py-1 text-xs cursor-pointer hover:bg-zinc-800">
                                        <input type="checkbox" checked={on} onChange={() => togglePick(r.symbol)} className="accent-emerald-500" />
                                        <span className="font-mono font-bold text-zinc-100">{r.symbol}</span>
                                        <span className="truncate text-zinc-500 flex-1">{r.name}</span>
                                        <span className={cn('font-mono', signCls(r.points))}>{pts(r.points)}</span>
                                      </label>
                                    );
                                  })}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                    {lineSymbols.map(sym => (
                      <button key={sym} onClick={() => togglePick(sym)} aria-label={`Remove ${sym}`} title={`Remove ${sym}`}
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-zinc-500 bg-zinc-800 text-[11px] font-mono text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60">
                        <span className="inline-block w-2 h-2 rounded-full" style={{ background: lineColor(chipOrder.indexOf(sym)) }} />
                        {sym}
                        <X className="h-3 w-3 text-zinc-400" aria-hidden="true" />
                      </button>
                    ))}
                  </div>
                  {history.length < 2 ? (
                    <p className="py-10 text-center text-xs text-zinc-500" style={{ minHeight: 380 }}>
                      {live ? 'Collecting points - the line appears after a couple of samples (one every 10 s while this page is open).' : 'History is recorded only while both feeds are live and this page is open.'}
                    </p>
                  ) : (
                    <div style={{ height: 380 }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={timelineData} margin={{ top: 8, right: 24, bottom: 4, left: 8 }}>
                          <CartesianGrid strokeDasharray="3 3" />
                          <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={istTime} tick={{ fontSize: 11 }} />
                          <YAxis tickFormatter={(v: number) => pts(v, 0)} tick={{ fontSize: 11 }} width={48} />
                          <Tooltip content={<TimelineTooltip />} cursor={{ stroke: 'var(--chart-cursor-line)', strokeWidth: 1, strokeDasharray: '4 4' }} />
                          <ReferenceLine y={0} stroke="var(--chart-axis)" />
                          {lineSymbols.map(sym => {
                            const i = chipOrder.indexOf(sym);
                            return <Line key={sym} type="monotone" dataKey={sym} stroke={lineColor(i)} strokeDasharray={lineDash(i)} strokeWidth={1.5} dot={false} connectNulls isAnimationActive={false} />;
                          })}
                          {showNet && <Line type="monotone" dataKey="net" stroke="var(--chart-tooltip-text)" strokeWidth={3} dot={false} isAnimationActive={false} />}
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </>
              ) : view === 'cumulative' ? (
                totals.length === 0 ? (
                  <p className="py-10 text-center text-xs text-zinc-500">No priced stocks yet - start the stocks feed.</p>
                ) : (
                  <>
                    <div style={{ height: 340 }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={totals} margin={{ top: 28, right: 24, bottom: 8, left: 8 }}>
                          <XAxis dataKey="label" tickFormatter={(l: string) => (l === 'Net' ? 'Net' : `${l} (${totals.find(t => t.label === l)?.count ?? 0})`)} tick={{ fontSize: 12 }} />
                          {/* Axis hidden (every bar prints its own value). 25% headroom each way so a value printed past a bar's tip never meets the x labels. */}
                          <YAxis hide domain={[(min: number) => (Math.min(min, 0) < 0 ? Math.min(min, 0) * 1.25 - 12 : 0), (max: number) => Math.max(max, 0) * 1.25]} />
                          <Tooltip content={<TotalsTooltip />} cursor={{ fill: 'var(--chart-cursor-fill)', opacity: 0.5 }} />
                          <ReferenceLine y={0} stroke="var(--chart-axis)" />
                          <Bar dataKey="value" isAnimationActive={false} barSize={110}>
                            {totals.map(t => <Cell key={t.kind} fill={t.value >= 0 ? 'var(--chart-pos)' : 'var(--chart-neg)'} />)}
                            <LabelList dataKey="value" content={TotalLabel} />
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                    <div className="grid sm:grid-cols-2 gap-2 mt-1 text-[11px] font-mono">
                      {totals.filter(t => t.kind !== 'net').map(t => (
                        <p key={t.kind} className="text-zinc-400">
                          <span className={cn('font-bold', t.kind === 'pull' ? 'text-emerald-400' : 'text-red-400')}>{t.kind === 'pull' ? 'Top pullers' : 'Top draggers'}</span>
                          {' '}{t.top.map(x => `${x.symbol} ${pts(x.points)}`).join(' · ') || '—'}
                        </p>
                      ))}
                    </div>
                  </>
                )
              ) : chartRows.length === 0 ? (
                <p className="py-10 text-center text-xs text-zinc-500">No priced stocks yet - start the stocks feed.</p>
              ) : (
                <div style={{ height: chartRows.length * 22 + 36 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartRows} layout="vertical" margin={{ top: 4, right: 24, bottom: 4, left: 8 }}>
                      <XAxis type="number" domain={axisDomain} allowDataOverflow tickFormatter={(v: number) => pts(v, 0)} />
                      <YAxis type="category" dataKey="symbol" width={92} interval={0} tick={{ fontSize: 11 }} />
                      <Tooltip content={<BarTooltip />} cursor={{ fill: 'var(--chart-cursor-fill)', opacity: 0.5 }} />
                      <ReferenceLine x={0} stroke="var(--chart-axis)" />
                      <Bar dataKey="points" isAnimationActive={false} barSize={14}>
                        {chartRows.map(r => <Cell key={r.symbol} fill={r.points >= 0 ? 'var(--chart-pos)' : 'var(--chart-neg)'} />)}
                        <LabelList dataKey="points" content={StockLabel} />
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </section>

            <section className="rounded-lg border border-zinc-800 overflow-x-auto" aria-label="All Nifty 50 stocks">
              <table className="w-full text-xs">
                <thead>
                  <tr>
                    <TH>#</TH>
                    <TH sortDir={dirOf('symbol')} onClick={() => sortBy('symbol')}>Stock</TH>
                    <TH right sortDir={dirOf('ltp')} onClick={() => sortBy('ltp')}>LTP</TH>
                    <TH right sortDir={dirOf('changePct')} onClick={() => sortBy('changePct')}>Chg %</TH>
                    <TH right sortDir={dirOf('weightPct')} onClick={() => sortBy('weightPct')}>Weight</TH>
                    <TH right sortDir={dirOf('points')} onClick={() => sortBy('points')}>Points</TH>
                    <TH right>Cumulative</TH>
                  </tr>
                </thead>
                <tbody>
                  {tableRows.map((r, i) => (
                    <tr key={r.symbol} className="border-t border-zinc-800 hover:bg-zinc-900/60">
                      <TD className="text-zinc-500">{i + 1}</TD>
                      <TD className="text-zinc-100 font-sans"><span className="font-bold">{r.symbol}</span> <span className="text-zinc-500">{r.name}</span></TD>
                      <TD right className="text-zinc-300">{inr(r.ltp)}</TD>
                      <TD right><PctPill v={r.changePct} /></TD>
                      <TD right className="text-zinc-300">{r.weightPct.toFixed(2)}%</TD>
                      <TD right className="font-bold">
                        <span className="text-white inline-block min-w-[4.5rem] rounded px-1.5 py-0.5"
                          style={{ background: `color-mix(in srgb, ${r.points >= 0 ? 'var(--chart-pos)' : 'var(--chart-neg)'} ${Math.round(8 + 50 * Math.min(1, Math.abs(r.points) / maxAbsPts))}%, transparent)` }}>
                          {pts(r.points)}
                        </span>
                      </TD>
                      <TD right className={`font-bold ${cumPoints[i] >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{pts(cumPoints[i])}</TD>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </>
        )}
      </div>
    </div>
  );
}

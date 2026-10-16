'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, IndianRupee, Loader2, Play, Square, X } from 'lucide-react';
import NavBar from '@/components/NavBar';
import { cn } from '@/lib/utils';
import type { IndexCard, IndiaRow } from '@/lib/indiaMarkets';
import type { Breadth, GroupStat } from '@/lib/usDashboard';
import SectorBoard, { BreadthStrip } from '@/components/us-markets/SectorBoard';
import StockHeatmap from '@/components/us-markets/StockHeatmap';
import UsMovers from '@/components/us-markets/UsMovers';
import { ageText } from '@/components/us-markets/format';
import IndiaIndexStrip from './IndiaIndexStrip';
import IndiaQuoteTable from './IndiaQuoteTable';
import { inr, istDate } from './format';

const POLL_MS = 2000;

type FeedState = 'live' | 'starting' | 'stale' | 'stopped';
interface FeedInfo { state: FeedState; updatedAt: number | null; ageMs: number | null; hasAll?: boolean }
interface Resp {
  success: boolean; error?: string; serverTime: number;
  feeds: { stocks: FeedInfo; indices: FeedInfo };
  rows: IndiaRow[]; indices: IndexCard[]; broad: GroupStat[]; sectors: GroupStat[]; industries: GroupStat[];
  breadth: Breadth; gainers: IndiaRow[]; losers: IndiaRow[]; active: IndiaRow[];
}

const FEED_UI: Record<FeedState, string> = {
  live: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
  starting: 'text-sky-300 bg-sky-500/10 border-sky-500/20',
  stale: 'text-amber-300 bg-amber-500/10 border-amber-500/20',
  stopped: 'text-zinc-400 bg-zinc-800 border-zinc-700',
};

/** Start/stop for one of the two existing bridges. They are shared with other pages, so Stop says so. */
const FEEDS = [
  { key: 'stocks' as const, label: 'Stocks', route: '/api/daily-market', shared: 'the Daily Market page' },
  { key: 'indices' as const, label: 'Indices', route: '/api/live-indices', shared: 'Live Indices and the scalper Top Indices strip (it falls back to REST)' },
];

/** "12s ago" that keeps counting between polls. Owns its own 1 s clock, so only this text re-renders each second -
 *  not the 500-tile heatmap. `ageMs` was measured at `serverTime`. */
function Ago({ ageMs, serverTime }: { ageMs: number; serverTime: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <>{ageText(ageMs + Math.max(0, now - serverTime))}</>;
}

export default function IndiaMarkets() {
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const seq = useRef(0);
  const drillRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const r = await fetch('/api/india-markets', { cache: 'no-store' });
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

  const rows = useMemo(() => data?.rows ?? [], [data]);
  const bySymbol = useMemo(() => new Map(rows.map(r => [r.symbol, r])), [rows]);
  const stocksFeed = data?.feeds.stocks;
  const indexFeed = data?.feeds.indices;
  const stocksLive = stocksFeed?.state === 'live';
  const indicesLive = indexFeed?.state === 'live';
  const dataDate = stocksFeed?.updatedAt != null ? istDate(stocksFeed.updatedAt) : indexFeed?.updatedAt != null ? istDate(indexFeed.updatedAt) : null;

  const allGroups = useMemo(() => [...(data?.broad ?? []), ...(data?.sectors ?? []), ...(data?.industries ?? [])], [data]);
  const selGroup = allGroups.find(g => g.key === selected) ?? null;
  const selRows = selGroup ? selGroup.symbols.flatMap(s => bySymbol.get(s) ?? []) : [];
  const select = (key: string | null) => {
    setSelected(key);
    if (key) requestAnimationFrame(() => drillRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
  };
  const heatViews = useMemo(() => [
    { key: 'industry', label: 'Industries · 500', groups: data?.industries ?? [] },
    { key: 'sector', label: 'Sectoral indices', groups: data?.sectors ?? [] },
  ], [data]);

  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-white">
      <div className="sticky top-0 z-30 flex items-center justify-between gap-3 flex-wrap px-6 py-3 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0 bg-emerald-500/10 border border-emerald-500/25">
            <IndianRupee className="w-4 h-4 text-emerald-400" aria-hidden="true" />
          </div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-emerald-400 mb-0.5">NSE · Nifty 500 via Dhan</p>
            <h1 className="text-sm font-bold text-white tracking-tight leading-none">India Markets</h1>
            <p className="text-[10px] text-zinc-500 font-medium mt-1">Broad and sectoral indices, NSE industries and all Nifty 500 stocks from Dhan&apos;s live feed. Watch-only - no orders.</p>
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
        {data && (!stocksLive || !indicesLive) && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden="true" />
            <span>
              Not fully live:{!stocksLive && <> stocks are the last saved quotes{stocksFeed?.ageMs != null && <> (<Ago ageMs={stocksFeed.ageMs} serverTime={data.serverTime} />)</>};</>}
              {!indicesLive && <> indices are the last saved values{indexFeed?.ageMs != null && <> (<Ago ageMs={indexFeed.ageMs} serverTime={data.serverTime} />)</>};</>}
              {' '}press ▶ next to a stopped feed. NSE cash hours are 09:15-15:30 IST.
            </span>
          </div>
        )}
        {/* Separate from the banner above: an old bridge can be RUNNING and fresh (so "live") yet write no `indices` block. */}
        {data && indexFeed && indexFeed.state !== 'stopped' && !indexFeed.hasAll && (
          <div role="alert" className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden="true" />
            <span>The running indices feed is an older version that does not send the sectoral indices, so index cards show –. Stop it (■) and start it (▶) once.</span>
          </div>
        )}

        {!data && !error && (
          <div className="flex flex-col items-center gap-2 py-16">
            <Loader2 className="h-6 w-6 animate-spin text-emerald-400" aria-hidden="true" />
            <p className="text-zinc-200 font-semibold text-sm">Loading India Markets</p>
          </div>
        )}

        {data && (
          <>
            <IndiaIndexStrip cards={data.indices.filter(c => c.kind !== 'sector')} broad={data.broad} selected={selected} onSelect={select} live={indicesLive} />

            <div className="flex flex-col gap-2">
              <BreadthStrip b={data.breadth} />
              <SectorBoard title="Sectoral indices · NSE" groups={data.sectors} selected={selected} onSelect={select} />
            </div>

            <div ref={drillRef} className="scroll-mt-20">
              {selGroup && (
                <section className="flex flex-col gap-2" aria-label={`${selGroup.label} constituents`}>
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="text-xs font-bold text-zinc-100">
                      {selGroup.label}
                      <span className="ml-2 text-[11px] font-medium text-zinc-500">{selGroup.desc} · {selGroup.symbols.length} stocks · {selGroup.adv} up / {selGroup.dec} down</span>
                    </h2>
                    <button onClick={() => setSelected(null)} aria-label="Close constituents"
                      className="h-6 w-6 inline-flex items-center justify-center rounded text-zinc-500 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60">
                      <X className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>
                  <IndiaQuoteTable rows={selRows} />
                </section>
              )}
            </div>

            <SectorBoard title="Industries · NSE classification (all 500)" groups={data.industries} selected={selected} onSelect={select} />

            <div className="grid grid-cols-1 xl:grid-cols-[1fr_20rem] gap-4">
              <StockHeatmap rows={rows} views={heatViews} onSelect={select} fmtPrice={v => inr(v)} dense />
              <div className="flex flex-col gap-4">
                <UsMovers gainers={data.gainers} losers={data.losers} fmtPrice={v => inr(v)} />
                <section className="flex flex-col gap-1 rounded-lg border border-zinc-800 bg-zinc-950 p-3" aria-label="Most active">
                  <h3 className="text-[11px] font-bold uppercase tracking-wider text-zinc-300">Most active · turnover ₹Cr</h3>
                  <ul className="flex flex-col">
                    {data.active.map(r => (
                      <li key={r.id} className="flex items-center justify-between gap-2 py-1 border-t border-zinc-800 first:border-t-0 text-xs tabular-nums">
                        <span className="font-bold text-zinc-100">{r.symbol}</span>
                        <span className="text-zinc-300">{r.turnoverCr?.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</span>
                        <span className={cn(r.changePct == null ? 'text-zinc-300' : r.changePct > 0 ? 'text-emerald-400' : r.changePct < 0 ? 'text-red-400' : 'text-zinc-300')}>
                          {r.changePct == null ? '–' : `${r.changePct > 0 ? '+' : ''}${r.changePct.toFixed(2)}%`}
                        </span>
                      </li>
                    ))}
                    {data.active.length === 0 && <li className="text-[11px] text-zinc-500 py-2">None yet.</li>}
                  </ul>
                </section>
              </div>
            </div>

            <p className="text-[10px] text-zinc-500 leading-relaxed">
              Sector tiles lead with the NSE index&apos;s own move; &quot;med&quot; is the median of its constituents that are in the Nifty 500 (NSE&apos;s
              official lists in index_constituents/). Nifty Private Bank members are approximated as Nifty Bank minus PSU Bank. Industries are
              NSE&apos;s own classification of the Nifty 500. Prices are Dhan&apos;s live feed; change is against the previous close. Watch-only.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Loader2, Play, Scale, Square } from 'lucide-react';
import { Bar, BarChart, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import NavBar from '@/components/NavBar';
import { DASH, PctPill, TD, TH, type SortDir } from '@/components/LiveTickerPanel';
import { cn } from '@/lib/utils';
import { ageText } from '@/components/us-markets/format';
import { inr, istDate } from '@/components/india-markets/format';
import { buildWaterfall, type ContributionResult, type ContributionRow, type WaterfallBar } from '@/lib/niftyContribution';

const POLL_MS = 2000;

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

function WaterfallTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: WaterfallBar }> }) {
  const b = active ? payload?.[0]?.payload : undefined;
  if (!b) return null;
  return (
    <div style={{ background: 'var(--chart-tooltip-bg)', border: '1px solid var(--chart-tooltip-border)', color: 'var(--chart-tooltip-text)', borderRadius: 8, padding: '6px 10px', fontSize: 11 }}>
      <div className="font-bold">{b.symbol} {b.kind !== 'net' && <span className="font-normal">{b.name}</span>}</div>
      {b.kind === 'net'
        ? <div className="font-mono">Net {pts(b.end)} pts</div>
        : <div className="font-mono">{pts(b.points)} pts · running total {pts(b.start)} → {pts(b.end)}</div>}
    </div>
  );
}

type SortKey = 'points' | 'symbol' | 'changePct' | 'weightPct' | 'ltp';
type View = 'stock' | 'cumulative';

export default function NiftyContribution() {
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [view, setView] = useState<View>('stock');
  const [topN, setTopN] = useState<10 | 15 | 0>(10); // 0 = all
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'points', dir: 'desc' });
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

  // Only worth building while its tab is open: the page re-renders on every 2 s poll.
  const waterfall = useMemo(() => (view === 'cumulative' && res ? buildWaterfall(res.rows) : []), [view, res]);

  const tableRows = useMemo(() => {
    if (!res) return [];
    const { key, dir } = sort;
    const m = dir === 'asc' ? 1 : -1;
    return [...res.rows].sort((a, b) => key === 'symbol' ? m * a.symbol.localeCompare(b.symbol) : m * (a[key] - b[key]));
  }, [res, sort]);
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
                sub={res.residual != null ? `index diff ${pts(res.residual)}` : 'no index to reconcile'}
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
                  {([['stock', 'By stock'], ['cumulative', 'Cumulative']] as const).map(([v, label]) => (
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
                ) : (
                  <p className="text-[11px] text-zinc-500">All {res.rows.length} stocks, biggest puller first - the running total climbs to {pts(res.positiveSum)} then falls to the net {pts(res.net)}.</p>
                )}
              </div>
              {view === 'cumulative' ? (
                waterfall.length === 0 ? (
                  <p className="py-10 text-center text-xs text-zinc-500">No priced stocks yet - start the stocks feed.</p>
                ) : (
                  <div style={{ height: 380 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={waterfall} margin={{ top: 8, right: 16, bottom: 4, left: 8 }}>
                        <XAxis dataKey="symbol" interval={0} angle={-60} textAnchor="end" height={72} tick={{ fontSize: 10 }} />
                        <YAxis tickFormatter={(v: number) => pts(v, 0)} />
                        <Tooltip content={<WaterfallTooltip />} cursor={{ fill: 'var(--chart-cursor-fill)', opacity: 0.5 }} />
                        <ReferenceLine y={0} stroke="var(--chart-axis)" />
                        <Bar dataKey="range" isAnimationActive={false}>
                          {waterfall.map(b => (
                            // The closing NET bar takes its sign's colour like every other bar; the outline is what marks it as the total.
                            <Cell key={b.symbol} fill={b.points >= 0 ? 'var(--chart-pos)' : 'var(--chart-neg)'}
                              stroke={b.kind === 'net' ? 'var(--chart-tick)' : 'none'} strokeWidth={b.kind === 'net' ? 2 : 0} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )
              ) : chartRows.length === 0 ? (
                <p className="py-10 text-center text-xs text-zinc-500">No priced stocks yet - start the stocks feed.</p>
              ) : (
                <div style={{ height: chartRows.length * 22 + 36 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartRows} layout="vertical" margin={{ top: 4, right: 24, bottom: 4, left: 8 }}>
                      <XAxis type="number" tickFormatter={(v: number) => pts(v, 0)} />
                      <YAxis type="category" dataKey="symbol" width={92} interval={0} tick={{ fontSize: 11 }} />
                      <Tooltip content={<BarTooltip />} cursor={{ fill: 'var(--chart-cursor-fill)', opacity: 0.5 }} />
                      <ReferenceLine x={0} stroke="var(--chart-axis)" />
                      <Bar dataKey="points" isAnimationActive={false} barSize={14}>
                        {chartRows.map(r => <Cell key={r.symbol} fill={r.points >= 0 ? 'var(--chart-pos)' : 'var(--chart-neg)'} />)}
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
                      <TD right className={cn('font-bold', signCls(r.points))}>{pts(r.points)}</TD>
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

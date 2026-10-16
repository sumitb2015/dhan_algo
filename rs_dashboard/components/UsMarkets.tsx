'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Globe, Info, LayoutGrid, Loader2, Play, Plus, RotateCcw, Search, Square } from 'lucide-react';
import NavBar from '@/components/NavBar';
import { cn } from '@/lib/utils';
import type { BridgeHealth, BridgeStatus, UsInstrument, UsQuoteRow } from '@/lib/usStocks';
import UsQuoteTable from '@/components/us-markets/UsQuoteTable';
import UsDashboard from '@/components/us-markets/UsDashboard';
import { ageText, usDataDate } from '@/components/us-markets/format';

const POLL_MS = 1500;
const QUICK = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'SPY', 'QQQ'];

interface LiveResponse {
  success: boolean; error?: string;
  health: BridgeHealth; status: BridgeStatus | null; rows: UsQuoteRow[];
  quotesAgeMs: number | null; serverTime: number; max: number;
  universe?: { enabled: boolean; count: number; subscribeMax: number };
}

type Tab = 'dashboard' | 'watchlist';
const TAB_KEY = 'usMarkets.tab';

const HEALTH_UI: Record<BridgeHealth, { label: string; cls: string }> = {
  live: { label: 'Live feed', cls: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' },
  idle: { label: 'Feed idle · add a symbol', cls: 'text-zinc-300 bg-zinc-800 border-zinc-700' },
  reconnecting: { label: 'Reconnecting…', cls: 'text-amber-300 bg-amber-500/10 border-amber-500/20' },
  stale: { label: 'Feed stalled', cls: 'text-amber-300 bg-amber-500/10 border-amber-500/20' },
  stopped: { label: 'Feed stopped', cls: 'text-zinc-400 bg-zinc-800 border-zinc-700' },
  error: { label: 'Feed error', cls: 'text-red-400 bg-red-500/10 border-red-500/20' },
};

export default function UsMarkets() {
  const [data, setData] = useState<LiveResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState<string | null>(null);
  // An 'info' notice is a courtesy (e.g. "already on the list") and clears itself; an 'error' one stays until the next action.
  const [notice, setNotice] = useState<{ text: string; kind: 'info' | 'error' } | null>(null);
  const [q, setQ] = useState('');
  // Results are stored WITH the query they answer. Anything else could be a previous query's hits, and Enter must never add those.
  const [found, setFound] = useState<{ q: string; list: UsInstrument[] }>({ q: '', list: [] });
  const [searching, setSearching] = useState(false);
  const seq = useRef(0);
  const searchSeq = useRef(0);
  const [tab, setTabState] = useState<Tab>('dashboard');
  const [dashDate, setDashDate] = useState<string | null>(null);

  // The chosen tab is a per-viewer convenience; storage can throw (private mode), so it is optional.
  useEffect(() => {
    // Read after mount (the server render has no storage), deferred a tick so it is not a synchronous setState in the effect.
    const t = setTimeout(() => {
      try { const v = localStorage.getItem(TAB_KEY); if (v === 'watchlist' || v === 'dashboard') setTabState(v); } catch { /* no storage */ }
    }, 0);
    return () => clearTimeout(t);
  }, []);
  const setTab = (t: Tab) => { setTabState(t); try { localStorage.setItem(TAB_KEY, t); } catch { /* no storage */ } };

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const r = await fetch('/api/live-us', { cache: 'no-store' });
      const j = await r.json().catch(() => null) as LiveResponse | null;
      if (mine !== seq.current) return;
      if (!r.ok || !j || j.success !== true) { setError(j?.error ?? `HTTP ${r.status}`); return; }
      setData(j);
      setError(null);
    } catch (e) {
      if (mine === seq.current) setError(e instanceof Error ? e.message : 'Network error');
    }
  }, []);

  useEffect(() => {
    const counter = seq;
    load();
    const t = setInterval(() => { if (!document.hidden) load(); }, POLL_MS);
    return () => { clearInterval(t); counter.current++; };
  }, [load]);

  // A dead page produces no state updates, so "how old is this" needs its own clock.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Courtesy notices clear themselves; the timer is tied to the notice object so a newer message is never cleared early.
  useEffect(() => {
    if (!notice || notice.kind !== 'info') return;
    const t = setTimeout(() => setNotice(cur => (cur === notice ? null : cur)), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  // Debounced search with an out-of-order guard.
  useEffect(() => {
    const text = q.trim();
    const mine = ++searchSeq.current;
    if (!text) return;
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await fetch(`/api/live-us/search?q=${encodeURIComponent(text)}`);
        const j = await r.json().catch(() => null) as { success?: boolean; results?: UsInstrument[]; error?: string } | null;
        if (mine !== searchSeq.current) return;
        if (j?.success) setFound({ q: text, list: j.results ?? [] });
        else { setFound({ q: text, list: [] }); setNotice({ text: j?.error ?? 'Search failed', kind: 'error' }); }
      } catch {
        if (mine === searchSeq.current) setFound({ q: text, list: [] });   // settle the query so the dropdown cannot sit on "Searching…" forever
      } finally {
        if (mine === searchSeq.current) setSearching(false);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [q]);

  const post = useCallback(async (body: Record<string, unknown>, key: string): Promise<boolean> => {
    setBusy(key);
    setNotice(null);
    try {
      const r = await fetch('/api/live-us', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => null) as { success?: boolean; error?: string } | null;
      if (!r.ok || !j?.success) { setNotice({ text: j?.error ?? `HTTP ${r.status}`, kind: 'error' }); return false; }
      await load();
      return true;
    } catch (e) {
      setNotice({ text: e instanceof Error ? e.message : 'Network error', kind: 'error' });
      return false;
    } finally { setBusy(null); }
  }, [load]);

  const rows = useMemo(() => data?.rows ?? [], [data]);
  const queryText = q.trim();
  const results = found.q === queryText ? found.list : [];
  const resultsPending = queryText !== '' && found.q !== queryText;
  const have = useMemo(() => new Set(rows.map(r => r.id)), [rows]);
  const health = data?.health ?? 'stopped';
  // Quote age is judged against the browser clock on the server's timestamp, so a frozen page cannot look fresh.
  const snapshotAgeMs = data?.quotesAgeMs != null ? data.quotesAgeMs + (now - data.serverTime) : null;
  const live = health === 'live' && snapshotAgeMs != null && snapshotAgeMs < 15_000;

  const addInstrument = async (inst: UsInstrument) => {
    if (have.has(inst.id)) { setNotice({ text: `${inst.symbol} is already on the list`, kind: 'info' }); return; }
    if (await post({ action: 'add', id: inst.id }, `add-${inst.id}`)) setQ('');
  };
  const addQuick = async (sym: string) => {
    setBusy(`quick-${sym}`);
    try {
      const r = await fetch(`/api/live-us/search?q=${encodeURIComponent(sym)}`);
      const j = await r.json().catch(() => null) as { results?: UsInstrument[] } | null;
      const hit = j?.results?.find(x => x.symbol === sym);
      if (!hit) { setNotice({ text: `${sym} is not in Dhan's US instrument list`, kind: 'error' }); return; }
      await addInstrument(hit);
    } finally { setBusy(null); }
  };

  const watchDate = data ? usDataDate(rows, data.serverTime) : null;
  const dataDate = tab === 'dashboard' ? dashDate : watchDate;
  const universe = data?.universe;
  const universeOn = universe?.enabled === true;
  const canStart = health === 'stopped' || health === 'error';
  // `live` from the bridge is only believed while its quotes are fresh in this page's own clock.
  const uiHealth: BridgeHealth = health === 'live' && !live ? 'stale' : health;

  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-white">
      <div className="sticky top-0 z-30 flex items-center justify-between gap-3 flex-wrap px-6 py-3 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0 bg-sky-500/10 border border-sky-500/25">
            <Globe className="w-4 h-4 text-sky-400" aria-hidden="true" />
          </div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-sky-400 mb-0.5">Global · US stocks via Dhan</p>
            <h1 className="text-sm font-bold text-white tracking-tight leading-none">US Markets</h1>
            <p className="text-[10px] text-zinc-500 font-medium mt-1">Indices, GICS sectors and the AI stack from Dhan&apos;s Global Stocks feed. Prices in USD. Watch-only - no orders.</p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1 bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg" role="group" aria-label="View">
            {([['dashboard', 'Dashboard'], ['watchlist', 'Watchlist']] as const).map(([k, label]) => (
              <button key={k} onClick={() => setTab(k)} aria-pressed={tab === k}
                className={cn('px-2.5 py-1 text-[11px] font-semibold rounded-md border transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60',
                  tab === k ? 'bg-sky-500/10 text-sky-400 border-sky-500/20' : 'text-zinc-500 hover:text-zinc-300 border-transparent')}>
                {label}
              </button>
            ))}
          </div>
          <button onClick={() => post({ action: 'universe', enabled: !universeOn }, 'universe')} disabled={busy === 'universe' || !data} aria-pressed={universeOn}
            title={`Stream the dashboard's curated sector + AI universe (${universe?.count ?? 0} symbols) as well as your watchlist`}
            className={cn('h-8 px-3 inline-flex items-center gap-1.5 rounded-md border text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60 disabled:opacity-50',
              universeOn ? 'border-sky-500/30 bg-sky-500/10 text-sky-400' : 'border-zinc-700 bg-zinc-900 text-zinc-300')}>
            {busy === 'universe' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <LayoutGrid className="h-3.5 w-3.5" aria-hidden="true" />}
            Market universe {universeOn ? 'ON' : 'OFF'}
          </button>
          {data && universe && (
            <span className="text-[10px] text-zinc-500 tabular-nums" title={`The feed subscribes your watchlist plus the universe (shared symbols once), at most ${universe.subscribeMax}`}>
              {universeOn ? `${universe.count} universe + ` : ''}{rows.length} watchlist
            </span>
          )}
          <span className={cn('text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border', HEALTH_UI[uiHealth].cls)}>
            {HEALTH_UI[uiHealth].label}
          </span>
          {canStart ? (
            <button onClick={() => post({ action: 'start' }, 'start')} disabled={busy === 'start'}
              className="h-8 px-3 inline-flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 text-emerald-400 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 disabled:opacity-50">
              {busy === 'start' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Play className="h-3.5 w-3.5" aria-hidden="true" />}Start feed
            </button>
          ) : (
            <>
              {health === 'stale' && (
                <button onClick={() => post({ action: 'restart' }, 'restart')} disabled={busy === 'restart'}
                  className="h-8 px-3 inline-flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 text-amber-300 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 disabled:opacity-50">
                  {busy === 'restart' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />}Restart feed
                </button>
              )}
              <button onClick={() => post({ action: 'stop' }, 'stop')} disabled={busy === 'stop'}
                className="h-8 px-3 inline-flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-900 text-zinc-200 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 disabled:opacity-50">
                <Square className="h-3.5 w-3.5" aria-hidden="true" />Stop feed
              </button>
            </>
          )}
          <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-amber-300 px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/20">
            DATA: {dataDate ?? '—'}
          </span>
          <span className="w-px h-5 bg-zinc-800 shrink-0" />
          <NavBar />
        </div>
      </div>

      <div className="flex-1 flex flex-col gap-3 px-4 sm:px-6 py-5 max-w-[1680px] w-full mx-auto">
        {notice && tab === 'dashboard' && (
          <div role={notice.kind === 'error' ? 'alert' : 'status'} className={cn('flex items-start gap-2 rounded-lg border px-3 py-2 text-xs',
            notice.kind === 'error' ? 'border-red-500/30 bg-red-500/10 text-red-400' : 'border-zinc-700 bg-zinc-900 text-zinc-300')}>
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden="true" /><span>{notice.text}</span>
          </div>
        )}
        {data?.status?.error && (health === 'error' || health === 'stale') && tab === 'dashboard' && (
          <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden="true" /><span>Feed: {data.status.error}</span>
          </div>
        )}
        {tab === 'dashboard' && <UsDashboard onDataDate={setDashDate} universeOn={universeOn} />}
        {tab === 'watchlist' && (<>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500" aria-hidden="true" />
            <input value={q} onChange={e => setQ(e.target.value)} aria-label="Search US symbol or company"
              placeholder="Add a US symbol or company" onKeyDown={e => { if (e.key === 'Escape') setQ(''); if (e.key === 'Enter' && results[0]) addInstrument(results[0]); }}
              className="h-8 w-64 rounded-md border border-zinc-800 bg-zinc-900 pl-7 pr-2 text-xs text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60" />
            {q.trim() && (
              <ul className="absolute z-20 mt-1 w-96 max-h-72 overflow-auto rounded-lg border border-zinc-800 bg-zinc-900 shadow-lg">
                {(resultsPending || searching) && results.length === 0 && <li className="px-3 py-2 text-xs text-zinc-400">Searching…</li>}
                {!resultsPending && !searching && results.length === 0 && <li className="px-3 py-2 text-xs text-zinc-400">No US symbol or company matches &quot;{queryText}&quot;.</li>}
                {results.map(r => (
                  <li key={r.id}>
                    <button onClick={() => addInstrument(r)} disabled={have.has(r.id)}
                      className="w-full flex items-center justify-between gap-3 px-3 py-1.5 text-left hover:bg-zinc-800 disabled:opacity-50 focus-visible:outline-none focus-visible:bg-zinc-800">
                      <span className="min-w-0"><span className="text-xs font-bold text-zinc-100">{r.symbol}</span><span className="ml-2 text-[11px] text-zinc-400 truncate">{r.name}</span></span>
                      <span className="text-[10px] text-zinc-500 shrink-0">{have.has(r.id) ? 'added' : r.exchange}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="flex items-center gap-1 flex-wrap" role="group" aria-label="Quick add">
            {QUICK.map(s => (
              <button key={s} onClick={() => addQuick(s)} disabled={busy === `quick-${s}`}
                className="px-2 py-1 text-[11px] font-semibold rounded-md border border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-zinc-100 inline-flex items-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 disabled:opacity-50">
                <Plus className="h-3 w-3" aria-hidden="true" />{s}
              </button>
            ))}
          </div>
          {data && <span className="text-[10px] text-zinc-500">{rows.length}/{data.max} symbols</span>}
        </div>

        {notice && (notice.kind === 'info' ? (
          <div role="status" className="flex items-start gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs text-zinc-300">
            <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden="true" /><span>{notice.text}</span>
          </div>
        ) : (
          <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden="true" /><span>{notice.text}</span>
          </div>
        ))}
        {error && (
          <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden="true" /><span>{error}{data ? ' - showing the last loaded data.' : ''}</span>
          </div>
        )}
        {data?.status?.error && (health === 'error' || health === 'stale') && (
          <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden="true" /><span>Feed: {data.status.error}</span>
          </div>
        )}
        {data && rows.length > 0 && !live && health !== 'idle' && !error && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden="true" />
            <span>These are the last saved quotes{snapshotAgeMs != null ? `, ${ageText(snapshotAgeMs)}` : ''}, not live prices. {canStart ? 'Press Start feed.' : health === 'reconnecting' ? 'The feed is reconnecting.' : health === 'stale' ? 'The feed has stopped updating - try Restart feed.' : 'The feed has stopped updating.'}</span>
          </div>
        )}

        {!data && !error && (
          <div className="flex flex-col items-center gap-2 py-16">
            <Loader2 className="h-6 w-6 animate-spin text-emerald-400" aria-hidden="true" />
            <p className="text-zinc-200 font-semibold text-sm">Loading</p>
            <p className="text-[11px] text-zinc-500">The first load downloads Dhan&apos;s US instrument list (about 2 MB).</p>
          </div>
        )}

        {data && rows.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-16 text-center">
            <Globe className="h-6 w-6 text-zinc-600" aria-hidden="true" />
            <p className="text-sm text-zinc-400">No symbols yet. Search above or use a quick-add chip, then press Start feed.</p>
          </div>
        )}

        {rows.length > 0 && (
          <UsQuoteTable rows={rows} clockSkewMs={now - (data?.serverTime ?? now)} busyKey={busy}
            onRemove={r => post({ action: 'remove', id: r.id }, `rm-${r.id}`)} />
        )}

        <p className="text-[10px] text-zinc-500 leading-relaxed">
          Change is measured against Dhan&apos;s Previous Close packet. The feed&apos;s OHLC &quot;close&quot; field is ignored because it repeats the previous close.
          A dash means the feed has not sent that value yet (volume appears with the first trade). The trade packet carries no VWAP, open interest or bid/ask.
          Needs the Global Stocks feed enabled on your Dhan account (feed error 806 = not enabled).
        </p>
        </>)}
      </div>
    </div>
  );
}

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Globe, Loader2, Play, Plus, RotateCcw, Search, Square, X } from 'lucide-react';
import NavBar from '@/components/NavBar';
import { cn } from '@/lib/utils';
import type { BridgeHealth, BridgeStatus, UsInstrument, UsQuoteRow } from '@/lib/usStocks';

const POLL_MS = 1500;
const QUICK = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'SPY', 'QQQ'];

interface LiveResponse {
  success: boolean; error?: string;
  health: BridgeHealth; status: BridgeStatus | null; rows: UsQuoteRow[];
  quotesAgeMs: number | null; serverTime: number; max: number;
}

const HEALTH_UI: Record<BridgeHealth, { label: string; cls: string }> = {
  live: { label: 'Live feed', cls: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' },
  idle: { label: 'Feed idle · add a symbol', cls: 'text-zinc-300 bg-zinc-800 border-zinc-700' },
  reconnecting: { label: 'Reconnecting…', cls: 'text-amber-300 bg-amber-500/10 border-amber-500/20' },
  stale: { label: 'Feed stalled', cls: 'text-amber-300 bg-amber-500/10 border-amber-500/20' },
  stopped: { label: 'Feed stopped', cls: 'text-zinc-400 bg-zinc-800 border-zinc-700' },
  error: { label: 'Feed error', cls: 'text-red-400 bg-red-500/10 border-red-500/20' },
};

/** Seconds below a minute, then minutes/hours - a tick feed needs the seconds that fmtAge drops. */
function ageText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}

const usd = (v: number | null, dec = 2) => (v == null ? '–' : v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec }));
const compact = (v: number | null) => (v == null ? '–' : new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(v));
const signCls = (v: number | null) => (v == null || v === 0 ? 'text-zinc-300' : v > 0 ? 'text-emerald-400' : 'text-red-400');

/** The US trading date of the newest quote, in New York time - the date the numbers belong to. */
function usDataDate(rows: UsQuoteRow[], serverTime: number): string | null {
  let ageMin: number | null = null;
  for (const r of rows) if (r.tradeAgeMs != null && (ageMin == null || r.tradeAgeMs < ageMin)) ageMin = r.tradeAgeMs;
  if (ageMin == null) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(serverTime - ageMin);
}

interface Col { key: string; label: string; align: 'l' | 'r'; cell: (r: UsQuoteRow, i: number) => React.ReactNode }

function RangeBar({ pos }: { pos: number | null }) {
  if (pos == null) return <span className="text-zinc-500">–</span>;
  return (
    <span className="inline-block align-middle w-20 h-1.5 rounded-full bg-zinc-800 relative" title={`${Math.round(pos * 100)}% of the 52-week range`}>
      <span className="absolute top-1/2 -translate-y-1/2 h-2.5 w-1 rounded-sm bg-emerald-400" style={{ left: `calc(${pos * 100}% - 2px)` }} />
    </span>
  );
}

export default function UsMarkets() {
  const [data, setData] = useState<LiveResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [q, setQ] = useState('');
  // Results are stored WITH the query they answer. Anything else could be a previous query's hits, and Enter must never add those.
  const [found, setFound] = useState<{ q: string; list: UsInstrument[] }>({ q: '', list: [] });
  const [searching, setSearching] = useState(false);
  const seq = useRef(0);
  const searchSeq = useRef(0);

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
        else { setFound({ q: text, list: [] }); setNotice(j?.error ?? 'Search failed'); }
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
      if (!r.ok || !j?.success) { setNotice(j?.error ?? `HTTP ${r.status}`); return false; }
      await load();
      return true;
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Network error');
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
    if (have.has(inst.id)) { setNotice(`${inst.symbol} is already on the list`); return; }
    if (await post({ action: 'add', id: inst.id }, `add-${inst.id}`)) setQ('');
  };
  const addQuick = async (sym: string) => {
    setBusy(`quick-${sym}`);
    try {
      const r = await fetch(`/api/live-us/search?q=${encodeURIComponent(sym)}`);
      const j = await r.json().catch(() => null) as { results?: UsInstrument[] } | null;
      const hit = j?.results?.find(x => x.symbol === sym);
      if (!hit) { setNotice(`${sym} is not in Dhan's US instrument list`); return; }
      await addInstrument(hit);
    } finally { setBusy(null); }
  };

  const columns: Col[] = [
    { key: 'sym', label: 'Symbol', align: 'l', cell: r => (
      <span className="flex flex-col leading-tight">
        <span className="font-bold text-zinc-100">{r.symbol}<span className="ml-2 text-[10px] font-medium text-zinc-500">{r.exchange}</span></span>
        <span className="text-[10px] text-zinc-500 truncate max-w-[16rem]">{r.name}</span>
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
    { key: 'age', label: 'Last trade', align: 'r', cell: r => <span className="text-zinc-500">{r.tradeAgeMs == null ? '–' : ageText(r.tradeAgeMs + (now - (data?.serverTime ?? now)))}</span> },
    { key: 'rm', label: '', align: 'r', cell: r => (
      <button onClick={() => post({ action: 'remove', id: r.id }, `rm-${r.id}`)} disabled={busy === `rm-${r.id}`} aria-label={`Remove ${r.symbol}`}
        className="h-6 w-6 inline-flex items-center justify-center rounded text-zinc-500 hover:text-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60">
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>) },
  ];

  const dataDate = data ? usDataDate(rows, data.serverTime) : null;
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
            <p className="text-[10px] text-zinc-500 font-medium mt-1">Live US trade ticks from Dhan&apos;s Global Stocks feed. Prices in USD. Watch-only - no orders.</p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
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

      <div className="flex-1 flex flex-col gap-3 px-6 py-5 max-w-[1680px] w-full mx-auto">
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
          <div className="overflow-auto rounded-lg border border-zinc-800">
            <table className="w-full text-xs tabular-nums">
              <thead className="sticky top-0 z-10">
                <tr>{columns.map(c => <th key={c.key} scope="col" className={cn('px-3 py-2 text-xs font-bold text-white bg-zinc-800 whitespace-nowrap', c.align === 'r' ? 'text-right' : 'text-left')}>{c.label}</th>)}</tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.id} className="border-t border-zinc-800 hover:bg-zinc-900">
                    {columns.map(c => <td key={c.key} className={cn('px-3 py-1.5 whitespace-nowrap text-zinc-200', c.align === 'r' ? 'text-right' : 'text-left')}>{c.cell(r, i)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="text-[10px] text-zinc-500 leading-relaxed">
          Change is measured against Dhan&apos;s Previous Close packet. The feed&apos;s OHLC &quot;close&quot; field is ignored because it repeats the previous close.
          A dash means the feed has not sent that value yet (volume appears with the first trade). The trade packet carries no VWAP, open interest or bid/ask.
          Needs the Global Stocks feed enabled on your Dhan account (feed error 806 = not enabled).
        </p>
      </div>
    </div>
  );
}

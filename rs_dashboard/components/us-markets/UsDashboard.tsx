'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Loader2, X } from 'lucide-react';
import type { BridgeHealth } from '@/lib/usStocks';
import type { Breadth, DashRow, GroupStat, IndexLevel } from '@/lib/usDashboard';
import IndexStrip from './IndexStrip';
import SectorBoard, { BreadthStrip } from './SectorBoard';
import StockHeatmap from './StockHeatmap';
import UsMovers from './UsMovers';
import AiThemesPanel from './AiThemesPanel';
import UsQuoteTable from './UsQuoteTable';
import { ageText, usDataDate } from './format';

const POLL_MS = 1500;
const INDEX_POLL_MS = 60_000;

interface DashResponse {
  success: boolean; error?: string;
  health: BridgeHealth; quotesAgeMs: number | null; serverTime: number;
  universe: { enabled: boolean; count: number; subscribeMax: number; asOf: string };
  unresolved: string[];
  groups: GroupStat[]; rows: DashRow[]; breadth: Breadth; gainers: DashRow[]; losers: DashRow[];
}
interface IndicesResponse { success: boolean; error?: string; stale?: boolean; levels?: IndexLevel[] }

interface Props {
  /** Reports the New York date of the newest quote shown, for the header DATA chip. */
  onDataDate: (d: string | null) => void;
  universeOn: boolean;
}

/** Polls a URL while the tab is visible, with an out-of-order guard: a slow older response can never overwrite a newer one. */
function usePoll<T>(url: string, everyMs: number): { data: T | null; error: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const r = await fetch(url, { cache: 'no-store' });
      const j = await r.json().catch(() => null) as (T & { success?: boolean; error?: string }) | null;
      if (mine !== seq.current) return;
      if (!r.ok || !j || j.success !== true) { setError(j?.error ?? `HTTP ${r.status}`); return; }
      setData(j);
      setError(null);
    } catch (e) {
      if (mine === seq.current) setError(e instanceof Error ? e.message : 'Network error');
    }
  }, [url]);
  useEffect(() => {
    const counter = seq;
    const first = setTimeout(load, 0);
    const t = setInterval(() => { if (!document.hidden) load(); }, everyMs);
    const onVis = () => { if (!document.hidden) load(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearTimeout(first); clearInterval(t); document.removeEventListener('visibilitychange', onVis); counter.current++; };
  }, [load, everyMs]);
  return { data, error };
}

export default function UsDashboard({ onDataDate, universeOn }: Props) {
  const { data, error } = usePoll<DashResponse>('/api/live-us/dashboard', POLL_MS);
  const idx = usePoll<IndicesResponse>('/api/live-us/indices', INDEX_POLL_MS);
  const [now, setNow] = useState(() => Date.now());
  const [selected, setSelected] = useState<string | null>(null);
  const drillRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const rows = useMemo(() => data?.rows ?? [], [data]);
  const bySymbol = useMemo(() => new Map(rows.map(r => [r.symbol, r])), [rows]);
  const groups = useMemo(() => data?.groups ?? [], [data]);
  const sectors = groups.filter(g => g.kind === 'sector');
  const themes = groups.filter(g => g.kind === 'ai');
  const pick = (kind: 'index' | 'macro') => (groups.find(g => g.kind === kind)?.symbols ?? []).flatMap(s => bySymbol.get(s) ?? []);
  const skew = data ? now - data.serverTime : 0;
  const snapshotAgeMs = data?.quotesAgeMs != null ? data.quotesAgeMs + skew : null;
  const live = data?.health === 'live' && snapshotAgeMs != null && snapshotAgeMs < 15_000;

  const dataDate = data ? usDataDate(rows, data.serverTime) : null;
  useEffect(() => { onDataDate(dataDate); }, [dataDate, onDataDate]);

  const select = (key: string | null) => {
    setSelected(key);
    if (key) requestAnimationFrame(() => drillRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
  };
  const selGroup = groups.find(g => g.key === selected) ?? null;
  const selRows = selGroup ? [...(selGroup.etf ? [selGroup.etf] : []), ...selGroup.symbols].flatMap(s => bySymbol.get(s) ?? []) : [];
  const sectorLabel = useMemo(() => new Map(groups.filter(g => g.kind === 'sector').map(g => [g.key, g.label])), [groups]);

  if (!data && !error) {
    return (
      <div className="flex flex-col items-center gap-2 py-16">
        <Loader2 className="h-6 w-6 animate-spin text-sky-400" aria-hidden="true" />
        <p className="text-zinc-200 font-semibold text-sm">Loading the US market dashboard</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden="true" /><span>{error}{data ? ' - showing the last loaded data.' : ''}</span>
        </div>
      )}
      {data && !universeOn && (
        <div className="flex items-start gap-2 rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-xs text-sky-300">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden="true" />
          <span>The market universe is off, so only symbols on your watchlist update. Turn on <b>Market universe</b> in the header to stream all {rows.length} dashboard symbols.</span>
        </div>
      )}
      {data && universeOn && !live && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden="true" />
          <span>Not live: these are the last saved quotes{snapshotAgeMs != null ? `, ${ageText(snapshotAgeMs)}` : ''}. Start the feed in the header. US cash hours are 09:30-16:00 New York: 19:00-01:30 IST while the US is on daylight time, 20:00-02:30 IST in the US winter.</span>
        </div>
      )}
      {data && data.unresolved.length > 0 && (
        <p className="text-[10px] text-amber-300">Not on Dhan&apos;s US list, left out: {data.unresolved.join(', ')}</p>
      )}

      {data && (
        <>
          <IndexStrip levels={idx.data?.levels ?? null} levelsError={idx.error} levelsStale={!!idx.data?.stale}
            proxies={pick('index')} macro={pick('macro')} live={live} />

          <div className="flex flex-col gap-2">
            <BreadthStrip b={data.breadth} />
            <SectorBoard title="Sectors · GICS" groups={sectors} selected={selected} onSelect={select} />
          </div>

          <div ref={drillRef} className="scroll-mt-20">
            {selGroup && (
              <section className="flex flex-col gap-2" aria-label={`${selGroup.label} members`}>
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-xs font-bold text-zinc-100">{selGroup.label} <span className="ml-1 text-[11px] font-medium text-zinc-500">{selGroup.desc} · {selGroup.symbols.length} stocks{selGroup.etf ? ` + ${selGroup.etf}` : ''}</span></h2>
                  <button onClick={() => setSelected(null)} aria-label="Close group detail"
                    className="h-6 w-6 inline-flex items-center justify-center rounded text-zinc-500 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60">
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>
                <UsQuoteTable rows={selRows} clockSkewMs={skew}
                  tag={r => { const d = bySymbol.get(r.symbol); return d?.isEtf ? 'ETF' : d?.sector ? sectorLabel.get(d.sector) ?? null : null; }} />
              </section>
            )}
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-[1fr_20rem] gap-4">
            <StockHeatmap rows={rows} sectors={sectors} themes={themes} onSelect={select} />
            <UsMovers gainers={data.gainers} losers={data.losers} />
          </div>

          <AiThemesPanel themes={themes} rows={rows} selected={selected} onSelect={select} />

          <p className="text-[10px] text-zinc-500 leading-relaxed">
            Universe as of {data.universe.asOf}: the largest names per GICS sector (after the 2023 reclassification that moved Visa, Mastercard and PayPal to
            Financials) and AI themes as overlapping tags, so a stock keeps its sector. Sector tiles lead with the SPDR sector ETF&apos;s move; &quot;med&quot; is
            the median of the listed stocks. Index levels are from Yahoo Finance and may be delayed; everything else is Dhan&apos;s live US feed. Watch-only.
          </p>
        </>
      )}
    </div>
  );
}

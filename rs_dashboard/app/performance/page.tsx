'use client';

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import NavBar from '@/components/NavBar';
import { TrendingUp, RefreshCw, Search, ChevronUp, ChevronDown, Loader2, AlertCircle, AlertTriangle, Download, CheckCircle2, Square, History } from 'lucide-react';
import { NIFTY50_SET } from '@/lib/nifty50';
import type { MoverResult, MoversResponse } from '@/app/api/movers/route';
import type { IndexResult, IndicesResponse, IndexCategory } from '@/app/api/indices-performance/route';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function pctColor(v: number | null | undefined): string {
  if (v == null) return 'text-zinc-400';
  if (v > 0) return 'text-emerald-300';
  if (v < 0) return 'text-red-400';
  return 'text-zinc-300';
}

function pctFmt(v: number | null | undefined, decimals = 2): string {
  if (v == null) return '—';
  return (v >= 0 ? '+' : '') + v.toFixed(decimals) + '%';
}

function numFmt(v: number | null | undefined, decimals = 2): string {
  if (v == null || v === 0) return '—';
  return v.toFixed(decimals);
}

function rsiColor(v: number): string {
  if (v >= 70) return 'text-red-300';
  if (v <= 30) return 'text-emerald-300';
  return 'text-zinc-100';
}

function pctFrom(close: number, ma: number): number | null {
  if (!ma || ma === 0) return null;
  return ((close - ma) / ma) * 100;
}

// ─── Refresh status hook ─────────────────────────────────────────────────────

interface RefreshStatus {
  pid: number; phase: string; message: string;
  current: number; total: number; done: boolean; error: string | null;
}

function useRefreshStatus(active: boolean) {
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<RefreshStatus | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const poll = useCallback(async () => {
    try {
      const res = await fetch('/api/refresh');
      const json = await res.json();
      setRunning(json.running);
      setStatus(json.status ?? null);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (!active) return;
    poll();
    pollRef.current = setInterval(poll, 2000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [active, poll]);

  const trigger = useCallback(async (target: string) => {
    await fetch('/api/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target }),
    });
    await poll();
  }, [poll]);

  const stop = useCallback(async () => {
    await fetch('/api/refresh', { method: 'DELETE' });
    await poll();
  }, [poll]);

  return { running, status, trigger, stop };
}

// ─── Per-tab refresh banner ───────────────────────────────────────────────────

// Both the nifty50 and nifty500 tabs render per-stock rows from /api/movers
// (Daily_Historical_Data_Fresh/*.csv), so both need the 'stocks' refresh
// target — refreshing 'nifty50'/'nifty500-index' would only touch the
// unrelated aggregate index CSV that neither tab actually displays.
const TAB_TARGETS: Record<string, string> = {
  nifty50:  'stocks',
  nifty500: 'stocks',
  indices:  'indices',
};

const TAB_LABELS: Record<string, string> = {
  nifty50:  'Nifty 50 stocks',
  nifty500: 'Nifty 500 stocks',
  indices:  'Sector Indices',
};

function RefreshBanner({
  tab, running, status, onTrigger, onStop, onComplete,
}: {
  tab: string;
  running: boolean;
  status: RefreshStatus | null;
  onTrigger: (target: string) => void;
  onStop: () => void;
  onComplete: () => void;
}) {
  const target = TAB_TARGETS[tab];
  const label  = TAB_LABELS[tab];

  // Track whether a run completed *in this session* (not a stale status.json from a previous run)
  const wasRunningRef = useRef(false);
  const justCompletedRef = useRef(false);

  useEffect(() => {
    if (running) {
      wasRunningRef.current = true;
      justCompletedRef.current = false;
    }
    if (!running && wasRunningRef.current && status?.done) {
      justCompletedRef.current = true;
      wasRunningRef.current = false;
      onComplete();
    }
  }, [running, status?.done, onComplete]);

  const phaseMap: Record<string, string> = {
    nifty50: 'stocks', nifty500: 'stocks', indices: 'indices',
  };
  const myPhase = phaseMap[tab];
  const isMyPhase = status?.phase === myPhase;
  const pct = status && status.total > 0
    ? Math.round((status.current / status.total) * 100) : 0;

  // Running state — show progress
  if (running) {
    return (
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5 text-[11px] text-sky-400">
          <Loader2 className="h-3 w-3 animate-spin" />
          {isMyPhase && status && status.total > 0
            ? <span>{status.current}/{status.total} ({pct}%)</span>
            : <span>{isMyPhase ? `Fetching ${label}…` : `Running — phase: ${status?.phase ?? '…'}`}</span>}
        </div>
        <button
          onClick={onStop}
          className="flex items-center gap-1 text-[11px] text-red-400 hover:text-red-300 border border-red-500/25 bg-red-500/10 rounded-lg px-2 py-1 transition-all"
        >
          <Square className="h-2.5 w-2.5" /> Stop
        </button>
      </div>
    );
  }

  // Just finished in this session — show brief confirmation
  if (justCompletedRef.current && status?.done) {
    const hadError = status.phase === 'error';
    return (
      <div className="flex items-center gap-3">
        <span className={`flex items-center gap-1.5 text-[11px] font-semibold ${hadError ? 'text-red-400' : 'text-emerald-400'}`}>
          {hadError
            ? <><AlertCircle className="h-3.5 w-3.5" /> Refresh failed</>
            : <><CheckCircle2 className="h-3.5 w-3.5" /> Done — data reloaded</>}
        </span>
        <button
          onClick={() => { justCompletedRef.current = false; onTrigger(target); }}
          className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold rounded-lg border border-sky-500/25 bg-sky-500/10 text-sky-400 hover:bg-sky-500/15 transition-all"
        >
          <Download className="h-3 w-3" />
          Fetch again
        </button>
      </div>
    );
  }

  // Default: idle — always show the fetch button
  return (
    <button
      onClick={() => { justCompletedRef.current = false; onTrigger(target); }}
      className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold rounded-lg border border-sky-500/25 bg-sky-500/10 text-sky-400 hover:bg-sky-500/15 hover:border-sky-500/35 transition-all"
    >
      <Download className="h-3 w-3" />
      Fetch {label} data
    </button>
  );
}

// ─── One-time deep history backfill (stocks + indices, since e.g. 2019) ────────

interface BackfillStatus {
  pid: number; message: string; current: number; total: number; done: boolean; error: string | null;
}

function useBackfillStatus(target: 'stocks' | 'indices') {
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<BackfillStatus | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const poll = useCallback(async () => {
    try {
      const res = await fetch(`/api/backfill?target=${target}`);
      const json = await res.json();
      setRunning(json.running);
      setStatus(json.status ?? null);
    } catch { /* ignore */ }
  }, [target]);

  useEffect(() => {
    poll();
    pollRef.current = setInterval(poll, 2000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [poll]);

  const trigger = useCallback(async (startDate: string) => {
    await fetch('/api/backfill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target, startDate }),
    });
    await poll();
  }, [target, poll]);

  const stop = useCallback(async () => {
    await fetch(`/api/backfill?target=${target}`, { method: 'DELETE' });
    await poll();
  }, [target, poll]);

  return { running, status, trigger, stop };
}

function BackfillRow({
  label, startDate, running, status, onTrigger, onStop,
}: {
  label: string; startDate: string; running: boolean; status: BackfillStatus | null;
  onTrigger: (startDate: string) => void; onStop: () => void;
}) {
  const pct = status && status.total > 0 ? Math.round((status.current / status.total) * 100) : 0;

  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="text-xs font-semibold text-zinc-200 w-24 shrink-0">{label}</span>
      {running ? (
        <div className="flex items-center gap-2 flex-1 justify-end">
          <div className="flex items-center gap-1.5 text-[11px] text-sky-400">
            <Loader2 className="h-3 w-3 animate-spin" />
            {status && status.total > 0 ? <span>{status.current}/{status.total} ({pct}%)</span> : <span>Starting…</span>}
          </div>
          <button
            onClick={onStop}
            className="flex items-center gap-1 text-[11px] text-red-400 hover:text-red-300 border border-red-500/25 bg-red-500/10 rounded-lg px-2 py-1 transition-all"
          >
            <Square className="h-2.5 w-2.5" /> Stop
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2 flex-1 justify-end">
          {status?.done && (
            <span className={`text-[11px] ${status.error ? 'text-red-400' : 'text-emerald-400'}`}>
              {status.error ? 'Failed' : 'Done'}
            </span>
          )}
          <button
            onClick={() => onTrigger(startDate)}
            className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-semibold rounded-lg border border-sky-500/25 bg-sky-500/10 text-sky-400 hover:bg-sky-500/15 transition-all"
          >
            <Download className="h-3 w-3" /> Backfill
          </button>
        </div>
      )}
    </div>
  );
}

function BackfillPanel({ onComplete }: { onComplete: () => void }) {
  const [open, setOpen] = useState(false);
  const [startDate, setStartDate] = useState('2019-01-01');
  const stocksBackfill  = useBackfillStatus('stocks');
  const indicesBackfill = useBackfillStatus('indices');

  const anyRunning = stocksBackfill.running || indicesBackfill.running;
  const wasRunningRef = useRef(false);
  useEffect(() => {
    if (anyRunning) wasRunningRef.current = true;
    else if (wasRunningRef.current) { wasRunningRef.current = false; onComplete(); }
  }, [anyRunning, onComplete]);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-semibold rounded-lg border border-zinc-800 bg-zinc-900/40 text-zinc-300 hover:text-white hover:border-zinc-700 transition-all"
        title="One-time deep history backfill for stocks and indices — use this on a fresh install where the data folders are empty"
      >
        <History className="h-3.5 w-3.5" />
        Backfill history
        <ChevronDown className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-2 w-72 p-3 rounded-xl border border-zinc-800 bg-zinc-950 shadow-xl z-30">
          <p className="text-[10px] text-zinc-500 mb-2 leading-relaxed">
            Fetches full daily history back to the date below for all Nifty 500
            stocks and all indices, merging into existing CSVs. Only needed
            once (e.g. right after a fresh install).
          </p>
          <label className="flex items-center gap-2 mb-2.5 text-[11px] text-zinc-400">
            Since
            <input
              type="date"
              value={startDate}
              onChange={e => setStartDate(e.target.value)}
              className="flex-1 px-2 py-1 text-[11px] bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-200 focus:outline-none focus:border-zinc-600"
            />
          </label>
          <div className="divide-y divide-zinc-900">
            <BackfillRow
              label="Stocks" startDate={startDate}
              running={stocksBackfill.running} status={stocksBackfill.status}
              onTrigger={stocksBackfill.trigger} onStop={stocksBackfill.stop}
            />
            <BackfillRow
              label="Indices" startDate={startDate}
              running={indicesBackfill.running} status={indicesBackfill.status}
              onTrigger={indicesBackfill.trigger} onStop={indicesBackfill.stop}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Stock table ──────────────────────────────────────────────────────────────

type StockColKey =
  | 'symbol' | 'sector' | 'price'
  | '1d' | '1w' | '1m' | '3m' | '1y'
  | 'rsi'
  | 'high52w' | 'low52w' | 'from52wH' | 'from52wL'
  | 'from50dma' | 'from200dma';

interface StockCol {
  key: StockColKey;
  label: string;
  title?: string;
  align: 'left' | 'right';
  render: (row: MoverResult) => React.ReactNode;
  sortVal: (row: MoverResult) => number | string;
}

const STOCK_COLS: StockCol[] = [
  {
    key: 'symbol', label: 'Symbol', align: 'left',
    render: row => <span className="font-semibold text-zinc-100">{row.symbol}</span>,
    sortVal: row => row.symbol,
  },
  {
    key: 'sector', label: 'Sector', align: 'left',
    render: row => <span className="text-zinc-300 text-[11px]">{row.sector || '—'}</span>,
    sortVal: row => row.sector || '',
  },
  {
    key: 'price', label: 'Price', align: 'right',
    render: row => <span className="text-white">{numFmt(row.latestClose)}</span>,
    sortVal: row => row.latestClose,
  },
  {
    key: '1d', label: '1D %', align: 'right',
    render: row => <span className={pctColor(row.priceChange1D)}>{pctFmt(row.priceChange1D)}</span>,
    sortVal: row => row.priceChange1D,
  },
  {
    key: '1w', label: '1W %', align: 'right',
    render: row => <span className={pctColor(row.priceChange1W)}>{pctFmt(row.priceChange1W)}</span>,
    sortVal: row => row.priceChange1W,
  },
  {
    key: '1m', label: '1M %', align: 'right',
    render: row => <span className={pctColor(row.priceChange1M)}>{pctFmt(row.priceChange1M)}</span>,
    sortVal: row => row.priceChange1M,
  },
  {
    key: '3m', label: '3M %', align: 'right',
    render: row => <span className={pctColor(row.priceChange3M)}>{pctFmt(row.priceChange3M)}</span>,
    sortVal: row => row.priceChange3M,
  },
  {
    key: '1y', label: '1Y %', align: 'right',
    render: row => <span className={pctColor(row.priceChange1Y)}>{pctFmt(row.priceChange1Y)}</span>,
    sortVal: row => row.priceChange1Y,
  },
  {
    key: 'rsi', label: 'RSI 14', align: 'right',
    render: row => <span className={rsiColor(row.rsi14)}>{numFmt(row.rsi14, 1)}</span>,
    sortVal: row => row.rsi14,
  },
  {
    key: 'high52w', label: '52W High', align: 'right',
    render: row => <span className="text-zinc-200">{numFmt(row.high52W)}</span>,
    sortVal: row => row.high52W,
  },
  {
    key: 'low52w', label: '52W Low', align: 'right',
    render: row => <span className="text-zinc-200">{numFmt(row.low52W)}</span>,
    sortVal: row => row.low52W,
  },
  {
    key: 'from52wH', label: 'vs 52W Hi', title: '% from 52-week high (0 = at high)', align: 'right',
    render: row => <span className={pctColor(row.pctFrom52WHigh)}>{pctFmt(row.pctFrom52WHigh)}</span>,
    sortVal: row => row.pctFrom52WHigh,
  },
  {
    key: 'from52wL', label: 'vs 52W Lo', title: '% from 52-week low (higher = further from bottom)', align: 'right',
    render: row => <span className={pctColor(row.pctFrom52WLow)}>{pctFmt(row.pctFrom52WLow)}</span>,
    sortVal: row => row.pctFrom52WLow,
  },
  {
    key: 'from50dma', label: 'vs 50DMA', title: '% above/below 50-day moving average', align: 'right',
    render: row => { const v = pctFrom(row.latestClose, row.ma50); return <span className={pctColor(v)}>{pctFmt(v)}</span>; },
    sortVal: row => pctFrom(row.latestClose, row.ma50) ?? -9999,
  },
  {
    key: 'from200dma', label: 'vs 200DMA', title: '% above/below 200-day moving average', align: 'right',
    render: row => { const v = pctFrom(row.latestClose, row.ma200); return <span className={pctColor(v)}>{pctFmt(v)}</span>; },
    sortVal: row => pctFrom(row.latestClose, row.ma200) ?? -9999,
  },
];

type SortDir = 'asc' | 'desc';

function StockTable({ rows, search }: { rows: MoverResult[]; search: string }) {
  const [sortKey, setSortKey] = useState<StockColKey>('symbol');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? rows.filter(r => r.symbol.toLowerCase().includes(q) || (r.sector || '').toLowerCase().includes(q)) : rows;
  }, [rows, search]);

  const sorted = useMemo(() => {
    const col = STOCK_COLS.find(c => c.key === sortKey);
    if (!col) return filtered;
    return [...filtered].sort((a, b) => {
      const av = col.sortVal(a), bv = col.sortVal(b);
      const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [filtered, sortKey, sortDir]);

  const pages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const pageRows = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  useEffect(() => setPage(0), [search, sortKey, sortDir]);

  const handleSort = (key: StockColKey) => {
    if (key === sortKey) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir(key === 'symbol' || key === 'sector' ? 'asc' : 'desc'); }
  };

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-3 flex-wrap text-xs text-zinc-300">
        <span>{sorted.length} stocks</span>
        {pages > 1 && (
          <div className="flex items-center gap-2">
            <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0} className="px-2 py-1 rounded border border-zinc-700 bg-zinc-900 disabled:opacity-30 hover:border-zinc-500 text-zinc-200">‹</button>
            <span>{page + 1} / {pages}</span>
            <button onClick={() => setPage(p => Math.min(pages - 1, p + 1))} disabled={page >= pages - 1} className="px-2 py-1 rounded border border-zinc-700 bg-zinc-900 disabled:opacity-30 hover:border-zinc-500 text-zinc-200">›</button>
          </div>
        )}
      </div>
      <div className="overflow-x-auto rounded-xl border border-zinc-800/60">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-zinc-800 border-b border-zinc-700">
              {STOCK_COLS.map(col => (
                <th key={col.key} title={col.title} onClick={() => handleSort(col.key)}
                  className={`px-3 py-2 whitespace-nowrap cursor-pointer select-none text-xs font-bold text-white hover:text-zinc-200 transition-colors ${col.align === 'right' ? 'text-right' : 'text-left'}`}>
                  <span className="inline-flex items-center gap-1">
                    {sortKey === col.key && (sortDir === 'asc' ? <ChevronUp className="h-3 w-3 text-sky-400" /> : <ChevronDown className="h-3 w-3 text-sky-400" />)}
                    {col.label}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row, i) => (
              <tr key={row.symbol} className={`border-b border-zinc-900 hover:bg-zinc-900/50 transition-colors ${i % 2 === 0 ? '' : 'bg-zinc-950/30'}`}>
                {STOCK_COLS.map(col => (
                  <td key={col.key} className={`px-3 py-2 whitespace-nowrap ${col.align === 'right' ? 'text-right' : 'text-left'}`}>
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Indices table ────────────────────────────────────────────────────────────

type IdxColKey = 'label' | 'category' | 'price' | '1d' | '1w' | '1m' | '3m' | '1y' | 'rsi' | 'high52w' | 'low52w' | 'from52wH' | 'from52wL' | 'from50dma' | 'from200dma';

interface IdxCol {
  key: IdxColKey;
  label: string;
  title?: string;
  align: 'left' | 'right';
  render: (row: IndexResult) => React.ReactNode;
  sortVal: (row: IndexResult) => number | string;
}

const IDX_COLS: IdxCol[] = [
  {
    key: 'label', label: 'Index', align: 'left',
    render: row => (
      <span className="font-semibold text-zinc-100">
        {row.label}
        {!row.hasData && <span className="ml-1.5 text-[10px] text-amber-500 font-normal">no data</span>}
      </span>
    ),
    sortVal: row => row.label,
  },
  {
    key: 'category', label: 'Category', align: 'left',
    render: row => <span className="text-zinc-300 text-[11px]">{row.category}</span>,
    sortVal: row => row.category,
  },
  {
    key: 'price', label: 'Price', align: 'right',
    render: row => <span className="text-white">{row.hasData ? numFmt(row.latestClose, row.latestClose > 100 ? 2 : 4) : '—'}</span>,
    sortVal: row => row.latestClose,
  },
  {
    key: '1d', label: '1D %', align: 'right',
    render: row => <span className={pctColor(row.hasData ? row.priceChange1D : null)}>{row.hasData ? pctFmt(row.priceChange1D) : '—'}</span>,
    sortVal: row => row.priceChange1D,
  },
  {
    key: '1w', label: '1W %', align: 'right',
    render: row => <span className={pctColor(row.hasData ? row.priceChange1W : null)}>{row.hasData ? pctFmt(row.priceChange1W) : '—'}</span>,
    sortVal: row => row.priceChange1W,
  },
  {
    key: '1m', label: '1M %', align: 'right',
    render: row => <span className={pctColor(row.hasData ? row.priceChange1M : null)}>{row.hasData ? pctFmt(row.priceChange1M) : '—'}</span>,
    sortVal: row => row.priceChange1M,
  },
  {
    key: '3m', label: '3M %', align: 'right',
    render: row => <span className={pctColor(row.hasData ? row.priceChange3M : null)}>{row.hasData ? pctFmt(row.priceChange3M) : '—'}</span>,
    sortVal: row => row.priceChange3M,
  },
  {
    key: '1y', label: '1Y %', align: 'right',
    render: row => <span className={pctColor(row.hasData ? row.priceChange1Y : null)}>{row.hasData ? pctFmt(row.priceChange1Y) : '—'}</span>,
    sortVal: row => row.priceChange1Y,
  },
  {
    key: 'rsi', label: 'RSI 14', align: 'right',
    render: row => <span className={rsiColor(row.rsi14)}>{row.hasData ? numFmt(row.rsi14, 1) : '—'}</span>,
    sortVal: row => row.rsi14,
  },
  {
    key: 'high52w', label: '52W High', align: 'right',
    render: row => <span className="text-zinc-200">{row.hasData ? numFmt(row.high52W, row.high52W > 100 ? 2 : 4) : '—'}</span>,
    sortVal: row => row.high52W,
  },
  {
    key: 'low52w', label: '52W Low', align: 'right',
    render: row => <span className="text-zinc-200">{row.hasData ? numFmt(row.low52W, row.low52W > 100 ? 2 : 4) : '—'}</span>,
    sortVal: row => row.low52W,
  },
  {
    key: 'from52wH', label: 'vs 52W Hi', title: '% from 52-week high', align: 'right',
    render: row => <span className={pctColor(row.hasData ? row.pctFrom52WHigh : null)}>{row.hasData ? pctFmt(row.pctFrom52WHigh) : '—'}</span>,
    sortVal: row => row.pctFrom52WHigh,
  },
  {
    key: 'from52wL', label: 'vs 52W Lo', title: '% from 52-week low', align: 'right',
    render: row => <span className={pctColor(row.hasData ? row.pctFrom52WLow : null)}>{row.hasData ? pctFmt(row.pctFrom52WLow) : '—'}</span>,
    sortVal: row => row.pctFrom52WLow,
  },
  {
    key: 'from50dma', label: 'vs 50DMA', title: '% above/below 50-day MA', align: 'right',
    render: row => { const v = row.hasData ? pctFrom(row.latestClose, row.ma50) : null; return <span className={pctColor(v)}>{pctFmt(v)}</span>; },
    sortVal: row => pctFrom(row.latestClose, row.ma50) ?? -9999,
  },
  {
    key: 'from200dma', label: 'vs 200DMA', title: '% above/below 200-day MA', align: 'right',
    render: row => { const v = row.hasData ? pctFrom(row.latestClose, row.ma200) : null; return <span className={pctColor(v)}>{pctFmt(v)}</span>; },
    sortVal: row => pctFrom(row.latestClose, row.ma200) ?? -9999,
  },
];

const CATEGORIES: Array<IndexCategory | 'All'> = ['All', 'Broad Market', 'Sectoral', 'Volatility'];

function IndicesTable({ rows, search }: { rows: IndexResult[]; search: string }) {
  const [sortKey, setSortKey] = useState<IdxColKey>('category');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [catFilter, setCatFilter] = useState<IndexCategory | 'All'>('All');

  const filtered = useMemo(() => {
    let r = catFilter === 'All' ? rows : rows.filter(x => x.category === catFilter);
    const q = search.trim().toLowerCase();
    if (q) r = r.filter(x => x.label.toLowerCase().includes(q) || x.category.toLowerCase().includes(q));
    return r;
  }, [rows, catFilter, search]);

  const sorted = useMemo(() => {
    const col = IDX_COLS.find(c => c.key === sortKey);
    if (!col) return filtered;
    return [...filtered].sort((a, b) => {
      const av = col.sortVal(a), bv = col.sortVal(b);
      const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [filtered, sortKey, sortDir]);

  const handleSort = (key: IdxColKey) => {
    if (key === sortKey) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir(key === 'label' || key === 'category' ? 'asc' : 'desc'); }
  };

  const missingCount = rows.filter(r => !r.hasData).length;

  return (
    <div>
      {/* Category filter pills */}
      <div className="flex items-center gap-1.5 mb-4 flex-wrap">
        {CATEGORIES.map(cat => (
          <button
            key={cat}
            onClick={() => setCatFilter(cat)}
            className={`px-3 py-1 text-[11px] font-semibold rounded-lg border transition-all ${
              catFilter === cat
                ? 'bg-sky-500/15 border-sky-500/30 text-sky-400'
                : 'border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:text-white hover:border-zinc-700'
            }`}
          >
            {cat}
            {cat !== 'All' && (
              <span className="ml-1 opacity-60">{rows.filter(r => r.category === cat).length}</span>
            )}
          </button>
        ))}
        {missingCount > 0 && (
          <span className="ml-auto flex items-center gap-1 text-[11px] text-amber-500/80">
            <AlertTriangle className="h-3 w-3" />
            {missingCount} index{missingCount > 1 ? 'es' : ''} need data — use Fetch button above
          </span>
        )}
      </div>

      <div className="overflow-x-auto rounded-xl border border-zinc-800/60">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-zinc-800 border-b border-zinc-700">
              {IDX_COLS.map(col => (
                <th key={col.key} title={col.title} onClick={() => handleSort(col.key)}
                  className={`px-3 py-2 whitespace-nowrap cursor-pointer select-none text-xs font-bold text-white hover:text-zinc-200 transition-colors ${col.align === 'right' ? 'text-right' : 'text-left'}`}>
                  <span className="inline-flex items-center gap-1">
                    {sortKey === col.key && (sortDir === 'asc' ? <ChevronUp className="h-3 w-3 text-sky-400" /> : <ChevronDown className="h-3 w-3 text-sky-400" />)}
                    {col.label}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((row, i) => (
              <tr key={row.symbol} className={`border-b border-zinc-900 hover:bg-zinc-900/50 transition-colors ${i % 2 === 0 ? '' : 'bg-zinc-950/30'} ${!row.hasData ? 'opacity-40' : ''}`}>
                {IDX_COLS.map(col => (
                  <td key={col.key} className={`px-3 py-2 whitespace-nowrap ${col.align === 'right' ? 'text-right' : 'text-left'}`}>
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

type Tab = 'nifty50' | 'nifty500' | 'indices';

export default function PerformancePage() {
  const [stockData, setStockData] = useState<MoversResponse | null>(null);
  const [idxData, setIdxData] = useState<IndicesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('nifty50');
  const [search, setSearch] = useState('');

  const { running: refreshRunning, status: refreshStatus, trigger: triggerRefresh, stop: stopRefresh } = useRefreshStatus(true);

  const fetchData = useCallback(async (bust = false) => {
    setLoading(true);
    setError(null);
    try {
      if (tab === 'indices') {
        // Always bust on indices tab — TTL cache hides fresh CSVs after a refresh
        const res = await fetch('/api/indices-performance?bust=1');
        const json = await res.json();
        if (!json.success) throw new Error(json.error || 'API error');
        setIdxData(json.data as IndicesResponse);
      } else {
        const res = await fetch(`/api/movers?index=nifty500${bust ? '&bust=1' : ''}`);
        const json = await res.json();
        if (!json.success) throw new Error(json.error || 'API error');
        setStockData(json.data as MoversResponse);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, [tab]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const stockRows = useMemo(() => {
    if (!stockData?.allMovers) return [];
    if (tab === 'nifty50') return stockData.allMovers.filter(r => NIFTY50_SET.has(r.symbol));
    return stockData.allMovers;
  }, [stockData, tab]);

  const n50Count  = stockData?.allMovers ? stockData.allMovers.filter(r => NIFTY50_SET.has(r.symbol)).length : 0;
  const n500Count = stockData?.allMovers?.length ?? 0;
  const idxCount  = idxData?.indices.filter(r => r.hasData).length ?? 0;

  const dataDate = tab === 'indices' ? idxData?.dataDate : stockData?.dataDate;

  return (
    <div className="flex flex-col min-h-screen bg-black text-zinc-100">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="w-full border-b border-zinc-900 bg-zinc-950/60 backdrop-blur-md px-5 py-3 flex items-center gap-4 z-20 flex-wrap">
        <div className="flex items-center gap-3 shrink-0">
          <div className="h-9 w-9 rounded-xl bg-gradient-to-tr from-sky-600 to-cyan-400 flex items-center justify-center shadow-lg shadow-sky-500/10">
            <TrendingUp className="h-4.5 w-4.5 text-white" />
          </div>
          <div>
            <h1 className="text-base font-bold tracking-tight bg-gradient-to-r from-white via-zinc-200 to-zinc-500 bg-clip-text text-transparent leading-none">
              Performance Table
            </h1>
            <p className="text-[10px] text-zinc-400 font-medium mt-0.5">
              {dataDate ? `Data as of ${dataDate}` : 'Nifty 50 · Nifty 500 · Indices'}
            </p>
          </div>
        </div>

        <NavBar />

        <div className="flex items-center gap-2 ml-auto">
          <BackfillPanel onComplete={() => fetchData(true)} />
          <button
            onClick={() => fetchData(true)}
            disabled={loading}
            className="p-1.5 border border-zinc-800 rounded-lg bg-zinc-900/40 text-zinc-400 hover:text-white transition-all hover:border-zinc-700 disabled:opacity-40"
            title="Reload from disk (clears server cache)"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </header>

      {/* ── Body ───────────────────────────────────────────────────────────── */}
      <main className="flex-1 px-5 py-6 max-w-screen-2xl mx-auto w-full">

        {/* Controls row */}
        <div className="flex items-center justify-between gap-4 mb-5 flex-wrap">

          {/* Tab switcher */}
          <div className="flex items-center gap-1 p-1 bg-zinc-900/60 border border-zinc-800 rounded-xl">
            {([
              { key: 'nifty50',  label: 'Nifty 50',  count: n50Count },
              { key: 'nifty500', label: 'Nifty 500', count: n500Count },
              { key: 'indices',  label: 'Indices',   count: idxCount },
            ] as const).map(({ key, label, count }) => (
              <button
                key={key}
                onClick={() => { setTab(key); setSearch(''); }}
                className={`px-4 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                  tab === key
                    ? 'bg-sky-500/10 text-sky-400 border border-sky-500/20'
                    : 'text-zinc-300 hover:text-white'
                }`}
              >
                {label}
                {count > 0 && <span className="ml-1.5 text-[10px] opacity-60">{count}</span>}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-3 ml-auto">
            {/* Inline refresh banner */}
            <RefreshBanner
              tab={tab}
              running={refreshRunning}
              status={refreshStatus}
              onTrigger={triggerRefresh}
              onStop={stopRefresh}
              onComplete={() => fetchData(true)}
            />

            {/* Search */}
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500" />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder={tab === 'indices' ? 'Filter index or category…' : 'Filter symbol or sector…'}
                className="pl-8 pr-3 py-1.5 text-xs bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 w-52"
              />
            </div>
          </div>
        </div>

        {/* Stat pills — stocks only */}
        {tab !== 'indices' && stockData?.allMovers && !loading && (
          <div className="flex items-center gap-3 mb-4 flex-wrap">
            {(() => {
              const subset = tab === 'nifty50'
                ? stockData.allMovers.filter(r => NIFTY50_SET.has(r.symbol))
                : stockData.allMovers;
              const gainers     = subset.filter(r => r.priceChange1D > 0).length;
              const losers      = subset.filter(r => r.priceChange1D < 0).length;
              const aboveMA200  = subset.filter(r => r.aboveMa200).length;
              const aboveAllMAs = subset.filter(r => r.aboveMa20 && r.aboveMa50 && r.aboveMa200).length;
              return (
                <>
                  <span className="px-2.5 py-1 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[11px] font-semibold">↑ {gainers} up</span>
                  <span className="px-2.5 py-1 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-[11px] font-semibold">↓ {losers} down</span>
                  <span className="px-2.5 py-1 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-300 text-[11px] font-semibold">{aboveMA200} above 200DMA</span>
                  <span className="px-2.5 py-1 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-300 text-[11px] font-semibold">{aboveAllMAs} above all MAs</span>
                </>
              );
            })()}
          </div>
        )}

        {/* Stat pills — indices */}
        {tab === 'indices' && idxData && !loading && (
          <div className="flex items-center gap-3 mb-4 flex-wrap">
            {(() => {
              const with_data = idxData.indices.filter(r => r.hasData);
              const gainers    = with_data.filter(r => r.priceChange1D > 0).length;
              const losers     = with_data.filter(r => r.priceChange1D < 0).length;
              const above200   = with_data.filter(r => r.aboveMa200).length;
              return (
                <>
                  <span className="px-2.5 py-1 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[11px] font-semibold">↑ {gainers} up</span>
                  <span className="px-2.5 py-1 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-[11px] font-semibold">↓ {losers} down</span>
                  <span className="px-2.5 py-1 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-300 text-[11px] font-semibold">{above200} above 200DMA</span>
                </>
              );
            })()}
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-24 text-zinc-300 gap-2">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span className="text-sm">Computing performance metrics…</span>
          </div>
        ) : error ? (
          <div className="flex items-center justify-center py-24 text-red-400 gap-2">
            <AlertCircle className="h-5 w-5" />
            <span className="text-sm">{error}</span>
          </div>
        ) : tab === 'indices' ? (
          <IndicesTable rows={idxData?.indices ?? []} search={search} />
        ) : (
          <StockTable rows={stockRows} search={search} />
        )}
      </main>
    </div>
  );
}

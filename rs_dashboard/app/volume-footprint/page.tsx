'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import NavBar from '@/components/NavBar';
import FootprintSettings, {
  DEFAULT_CONFIG,
  type FootprintConfig,
} from '@/components/footprint/FootprintSettings';
import FootprintChart from '@/components/footprint/FootprintChart';
import FootprintTable, { fmtVol } from '@/components/footprint/FootprintTable';
import {
  buildFootprint,
  chartProfile,
  windowStats,
  balance,
  residual,
  priceWindow,
  resampleBars,
  suggestTickSize,
  type Bar,
} from '@/lib/volumeProfile';
import type { FootprintFetchResponse } from '@/app/api/volume-footprint/route';
import type { UniverseResponse, UniverseIndex } from '@/app/api/volume-footprint/universe/route';
import { isNseLive } from '@/lib/marketHours';
import { BarChart3, LayoutGrid, RefreshCw, Table as TableIcon } from 'lucide-react';

const STORAGE_KEY = 'volume-footprint-config';

/** Shared empty array: a fresh `[]` per render would be a new dependency identity and
 *  re-run every footprint memo on every render while nothing is loaded. */
const NO_BARS: Bar[] = [];

function Tile({
  label, value, sub, tone, wide,
}: {
  label: string; value: React.ReactNode; sub?: string; tone?: string;
  /** Paired levels ("VAH / VAL") need a smaller face or they clip at eight-across. */
  wide?: boolean;
}) {
  return (
    <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl px-3 py-2.5 flex flex-col justify-between min-w-0">
      <span className="text-[10px] uppercase tracking-wide text-zinc-400 font-medium truncate">{label}</span>
      <span className={`${wide ? 'text-xs' : 'text-base'} font-extrabold font-mono truncate ${tone ?? 'text-zinc-100'}`}>
        {value}
      </span>
      {sub && <span className="text-[10px] text-zinc-500 truncate">{sub}</span>}
    </div>
  );
}

/** Bars are stored WITH the symbol they belong to. Keeping them in a bare `bars` array let
 *  a slow or failed switch render the previous instrument's POC and value area under the
 *  new instrument's header — the levels looked authoritative and were simply wrong. */
interface LoadedBars {
  symbol: string;
  bars: Bar[];
  meta: FootprintFetchResponse;
}

export default function VolumeFootprintPage() {
  const [config, setConfig] = useState<FootprintConfig>(DEFAULT_CONFIG);
  const [loaded, setLoaded] = useState<LoadedBars | null>(null);
  const [indices, setIndices] = useState<UniverseIndex[]>([]);
  const [stocks, setStocks] = useState<string[]>([]);
  const [manualBusy, setManualBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  // Restore saved settings after mount — reading localStorage during render would break
  // hydration, since the server has no idea what the user last chose.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setConfig({ ...DEFAULT_CONFIG, ...JSON.parse(raw) });
    } catch {
      /* corrupt or unavailable storage just means defaults */
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    } catch {
      /* non-fatal */
    }
  }, [config]);

  const patch = useCallback((p: Partial<FootprintConfig>) => setConfig((c) => ({ ...c, ...p })), []);

  useEffect(() => {
    fetch('/api/volume-footprint/universe')
      .then((r) => r.json())
      .then((j: UniverseResponse) => {
        if (j.success) {
          setIndices(j.indices);
          setStocks(j.stocks);
        }
      })
      .catch(() => { /* the sidebar falls back to the current symbol alone */ });
  }, []);

  const { symbol, days } = config;

  // Nothing is set synchronously before the first await: the loading state is derived from
  // whether `loaded` matches the requested symbol, so this stays a pure side effect.
  //
  // Superseded requests MUST be aborted, not merely ignored. The mount fetch runs against
  // the default symbol, then the localStorage restore switches symbols and fires a second
  // fetch; whichever lands last wins `loaded`. When that was the stale one, its symbol no
  // longer matched the selection and the page sat on the loading spinner forever.
  const fetchBars = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch(
        `/api/volume-footprint?symbol=${encodeURIComponent(symbol)}&days=${days}`,
        { signal },
      );
      const json: FootprintFetchResponse = await res.json();
      if (json.success) {
        setLoaded({ symbol, bars: json.bars ?? [], meta: json });
        setError(null);
      } else {
        setError(json.error ?? 'Failed to load 1-minute bars');
      }
    } catch (e) {
      // An abort is this effect being superseded, not a failure to report.
      if (e instanceof DOMException && e.name === 'AbortError') return;
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [symbol, days]);

  useEffect(() => {
    const controller = new AbortController();
    fetchBars(controller.signal);
    return () => controller.abort();
  }, [fetchBars]);

  const refreshNow = useCallback(async () => {
    setManualBusy(true);
    try {
      await fetchBars();
    } finally {
      setManualBusy(false);
    }
  }, [fetchBars]);

  // Only the bars that belong to the symbol currently on screen are ever rendered. A
  // pending or failed switch shows the loading state, never the last instrument's levels.
  const current = loaded?.symbol === symbol ? loaded : null;
  const bars = current?.bars ?? NO_BARS;
  const meta = current?.meta ?? null;
  const initialLoading = !current && !error;

  // Only poll while the market is actually open — off-hours the bars cannot change, and
  // every poll is a Dhan REST call against a shared rate limit.
  useEffect(() => {
    if (!autoRefresh) return;
    const controller = new AbortController();
    const timer = setInterval(() => {
      if (isNseLive(new Date())) fetchBars(controller.signal);
    }, 10_000);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [autoRefresh, fetchBars]);

  // ── Derived: everything below recomputes on a slider move, with no refetch ──────────
  const tfBars = useMemo(() => resampleBars(bars, config.tfMinutes), [bars, config.tfMinutes]);

  const footprint = useMemo(
    () =>
      buildFootprint(bars, {
        tfMinutes: config.tfMinutes,
        tickSize: config.tickSize,
        engine: config.engine,
        valueAreaPct: config.valueAreaPct,
        imbalancePct: config.imbalancePct,
        volumeConcentration: config.volumeConcentration,
        // Cells are only ever read for the visible window, so expanding a tick ladder for
        // every column of a 10-session load would be thrown-away work.
        columnLimit: config.windowBars,
      }),
    [
      bars, config.tfMinutes, config.tickSize, config.engine,
      config.valueAreaPct, config.imbalancePct, config.volumeConcentration, config.windowBars,
    ],
  );

  const win = useMemo(
    () => windowStats(footprint.columns, config.windowBars, config.valueAreaPct),
    [footprint.columns, config.windowBars, config.valueAreaPct],
  );

  const chart = useMemo(
    () =>
      chartProfile(bars, {
        tfMinutes: config.tfMinutes,
        profilePeriod: config.profilePeriod,
        resolution: config.profileResolution,
        engine: config.engine,
        valueAreaPct: config.valueAreaPct,
      }),
    [bars, config.tfMinutes, config.profilePeriod, config.profileResolution, config.engine, config.valueAreaPct],
  );

  const bal = useMemo(() => balance(win, chart, config.balanceTiltPct), [win, chart, config.balanceTiltPct]);
  const res = useMemo(
    () => residual(footprint.columns, config.residualTolerancePpm),
    [footprint.columns, config.residualTolerancePpm],
  );

  const visibleColumns = useMemo(
    () => footprint.columns.filter((c) => c.cells.length > 0).slice(-config.windowBars),
    [footprint.columns, config.windowBars],
  );

  const lastColumn = visibleColumns[visibleColumns.length - 1];
  const lastPrice = lastColumn?.c ?? 0;

  const priceRows = useMemo(
    () => priceWindow(visibleColumns, lastPrice, footprint.effectiveTickSize, config.ticksAboveBelow),
    [visibleColumns, lastPrice, footprint.effectiveTickSize, config.ticksAboveBelow],
  );

  const suggestedTick = useMemo(
    () => (bars.length ? suggestTickSize(bars, config.tfMinutes) : 0),
    [bars, config.tfMinutes],
  );

  const dataDate = meta?.last_bar?.slice(0, 10) ?? '—';
  const buyLead = lastColumn && lastColumn.buy + lastColumn.sell > 0
    ? (lastColumn.buy / (lastColumn.buy + lastColumn.sell)) * 100
    : 0;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans flex flex-col">
      <NavBar />

      <div className="flex flex-1 min-h-0">
        <FootprintSettings
          config={config}
          onChange={patch}
          indices={indices}
          stocks={stocks}
          onRefresh={refreshNow}
          loading={manualBusy}
          suggestedTickSize={suggestedTick}
        />

        <main className="flex-1 min-w-0 p-4 flex flex-col gap-3">
          {/* HEADER */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-400">
                <BarChart3 className="w-5 h-5" />
              </div>
              <div>
                <h1 className="text-lg font-bold tracking-tight text-white">Volume Footprint</h1>
                <p className="text-xs text-zinc-400">
                  Estimated buy/sell volume by price for {config.symbol} · {config.tfMinutes}m ·{' '}
                  {config.engine === 'geometric' ? 'geometric' : 'intrabar'} engine
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 text-[11px]">
              <span className="px-2 py-1 rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-300 font-mono">
                DATA: {dataDate}
              </span>
              <span className="px-2 py-1 rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-400">
                source: {meta?.source ?? '—'}
              </span>
              <button
                onClick={() => setAutoRefresh(!autoRefresh)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border font-semibold transition ${
                  autoRefresh
                    ? 'bg-emerald-950 text-emerald-400 border-emerald-800'
                    : 'bg-zinc-950 text-zinc-500 border-zinc-800'
                }`}
              >
                <span className={`w-2 h-2 rounded-full ${autoRefresh ? 'bg-emerald-400 animate-pulse' : 'bg-zinc-600'}`} />
                {autoRefresh ? '10s Live' : 'Paused'}
              </button>
              <button
                onClick={() => patch({ showTable: !config.showTable })}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border font-semibold transition ${
                  config.showTable
                    ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                    : 'bg-zinc-950 text-zinc-300 border-zinc-800'
                }`}
              >
                {config.showTable ? <TableIcon className="w-3.5 h-3.5" /> : <LayoutGrid className="w-3.5 h-3.5" />}
                {config.showTable ? 'Footprint table' : 'Chart only'}
              </button>
            </div>
          </div>

          {error && (
            <div className="bg-rose-950/80 border border-rose-800 text-rose-200 p-3 rounded-xl text-xs flex items-center justify-between">
              <span>⚠️ {error}</span>
              <button onClick={refreshNow} className="underline font-bold hover:text-rose-100">Retry</button>
            </div>
          )}

          {meta?.api_error && (
            <div className="bg-amber-950/60 border border-amber-800 text-amber-200 p-2.5 rounded-xl text-[11px]">
              Dhan reported: {meta.api_error} — bars shown may be stale or incomplete.
            </div>
          )}

          {/* LIVE BAR STRIP */}
          <div className="bg-emerald-950/40 border border-emerald-900 rounded-lg px-3 py-1.5 text-[11px] font-mono text-emerald-200 flex flex-wrap items-center gap-x-4">
            <span className="font-bold text-emerald-300">Last bar</span>
            <span>Total {fmtVol((lastColumn?.buy ?? 0) + (lastColumn?.sell ?? 0))}</span>
            <span>Sell {fmtVol(lastColumn?.sell ?? 0)}</span>
            <span>Buy {fmtVol(lastColumn?.buy ?? 0)}</span>
            <span>
              {lastColumn
                ? `${buyLead >= 50 ? 'Buy' : 'Sell'} leads ${Math.max(buyLead, 100 - buyLead).toFixed(1)}%`
                : 'no bar yet'}
            </span>
            <span>price {lastPrice ? lastPrice.toFixed(2) : '—'}</span>
            <span className="text-emerald-400">{lastColumn ? lastColumn.t : '—'}</span>
          </div>

          {/* KPI STRIP */}
          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-2">
            <Tile label="Window vol" value={fmtVol(win.volume)} sub={`${config.windowBars} bars`} />
            <Tile
              label="Window Δ"
              value={`${win.delta >= 0 ? '+' : ''}${fmtVol(win.delta)}`}
              tone={win.delta >= 0 ? 'text-emerald-400' : 'text-rose-400'}
              sub="buy − sell"
            />
            <Tile label="W-POC" value={win.poc ? win.poc.toFixed(2) : '—'} sub="Footprint window" />
            <Tile
              label="W-VAH / W-VAL"
              wide
              value={
                win.vah ? (
                  <span className="flex flex-col leading-tight">
                    <span className="text-violet-300">{win.vah.toFixed(2)}</span>
                    <span className="text-violet-400">{win.val.toFixed(2)}</span>
                  </span>
                ) : '—'
              }
              sub={`${config.valueAreaPct}% value area`}
            />
            <Tile label="C-POC" value={chart.poc ? chart.poc.toFixed(2) : '—'} sub="Chart profile" />
            <Tile
              label="C-VAH / C-VAL"
              wide
              value={
                chart.vah ? (
                  <span className="flex flex-col leading-tight">
                    <span className="text-violet-300">{chart.vah.toFixed(2)}</span>
                    <span className="text-violet-400">{chart.val.toFixed(2)}</span>
                  </span>
                ) : '—'
              }
              sub="Lines on chart"
            />
            <Tile
              label="OVL"
              value={bal.ovl.toFixed(2)}
              tone={bal.balanced ? 'text-emerald-400' : 'text-amber-400'}
              sub={`${bal.balanced ? 'BALANCED' : 'IMBALANCED'} · tilt ${bal.tiltPct.toFixed(0)}%`}
            />
            <Tile
              label="Res"
              value={`${res.ppm.toFixed(2)} ppm`}
              tone={res.exact ? 'text-emerald-400' : 'text-rose-400'}
              sub={res.exact ? 'EXACT' : 'VOLUME LOST'}
            />
          </div>

          {/* CHART */}
          <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-2 h-[420px]">
            {initialLoading ? (
              <div className="h-full flex flex-col items-center justify-center gap-3 text-zinc-500">
                <RefreshCw className="w-6 h-6 animate-spin text-emerald-400" />
                <span className="text-xs font-medium">Loading 1-minute bars…</span>
              </div>
            ) : (
              <FootprintChart
                bars={tfBars}
                rows={chart.rows}
                chart={chart}
                window={win}
                windowBars={config.windowBars}
              />
            )}
          </div>

          {/* FOOTPRINT TABLE */}
          {config.showTable && (
            <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-3">
              <div className="flex items-baseline justify-between mb-2 gap-3 flex-wrap">
                <h2 className="text-sm font-bold text-zinc-200">Footprint window</h2>
                <p className="text-[11px] text-zinc-400">
                  Last {config.windowBars} bars, {config.ticksAboveBelow} ticks either side of{' '}
                  {lastPrice ? lastPrice.toFixed(2) : '—'}. Sell cells left, buy cells right.
                  Diagonal imbalance flags buy vs sell one tick below, and sell vs buy one tick above,
                  at {config.imbalancePct}%.
                  {footprint.coarsened && (
                    <span className="text-amber-400">
                      {' '}Tick coarsened to {footprint.effectiveTickSize.toFixed(4)} — the requested size
                      exceeded the per-column row cap.
                    </span>
                  )}
                </p>
              </div>
              {initialLoading ? (
                <div className="py-10 text-center text-xs text-zinc-500">Loading…</div>
              ) : (
                <FootprintTable
                  columns={visibleColumns}
                  priceRows={priceRows}
                  tickSize={footprint.effectiveTickSize}
                  window={win}
                  lastPrice={lastPrice}
                />
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between text-[11px] text-zinc-500 border-t border-zinc-800 pt-2">
            <span className="flex items-center gap-2">
              Updated <strong className="text-zinc-400 font-mono">{meta?.updated_at ?? '—'}</strong>
              {manualBusy && (
                <span className="flex items-center gap-1 text-emerald-400">
                  <RefreshCw className="w-3 h-3 animate-spin" /> updating…
                </span>
              )}
              {meta?.store_last && <span>· archive through {meta.store_last}</span>}
              <span>· {meta?.sessions ?? 0} sessions · {bars.length} 1-min bars</span>
            </span>
            <span>Buy/sell split estimated from Dhan OHLCV — no bid/ask tick history exists.</span>
          </div>
        </main>
      </div>
    </div>
  );
}

'use client';

// "Level chart" button + modal for the GEX pages: the index as a line, the GEX levels drawn across it as labelled price lines, and
// the per-strike call/put GEX as a profile on the right edge (like a volume profile), so the walls and the flip read against price.
// Candles come from /api/level-chart (Dhan intraday, the same source as the Level Chart page); levels and profile come from the page,
// so this component does no GEX maths of its own.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { LineChart, RefreshCw, X } from 'lucide-react';
import {
  createChart,
  LineSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  TickMarkType,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { useChartChrome } from '@/lib/chartTheme';
import { fmtGex } from '@/lib/gex';
import { fmtInterval } from './UpdateIntervalSlider';

export type LevelTone = 'call' | 'put' | 'flip' | 'pin' | 'em' | 'spot';
export interface GexChartLevel { key: string; label: string; price: number; tone: LevelTone }
export interface GexProfileRow { strike: number; ceGex: number; peGex: number }

interface Candle { time: string; close: number }

// Saturated data colours: fixed, they read on either ground and carry meaning (call red, put green, flip amber).
const TONE: Record<Exclude<LevelTone, 'spot'>, string> = {
  call: '#f87171',
  put: '#34d399',
  flip: '#fbbf24',
  pin: '#a78bfa',
  em: '#38bdf8',
};
const IST = 'Asia/Kolkata';
const PROFILE_W = 150;
const STRIKE_STEP = 50;

function formatIstTick(time: Time, kind: TickMarkType): string {
  const d = new Date((time as number) * 1000);
  if (kind === TickMarkType.DayOfMonth) return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: IST }).format(d);
  return new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: IST }).format(d);
}

const fmtPrice = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 2 });

interface OverlayRow { y: number; h: number; ce: number; pe: number; strike: number }

export default function GexLevelsButton({ levels, profile, spot, live, pollMs, symbol = 'NIFTY' }: {
  levels: GexChartLevel[];
  profile: GexProfileRow[];
  spot: number;
  /** Market open: poll for new candles. Closed: show the last session once. */
  live: boolean;
  /** Candle refresh gap while open and live: the page's update slider. */
  pollMs: number;
  symbol?: string;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Open the index chart with the GEX levels and per-strike GEX profile drawn on it"
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-zinc-700 bg-zinc-900 text-xs font-bold text-zinc-200 hover:bg-zinc-800 focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
      >
        <LineChart className="w-3.5 h-3.5 text-sky-400" aria-hidden="true" />
        Level chart
      </button>
      {open && createPortal(
        // Portalled to <body>: the sticky header's backdrop-blur makes it the containing block for `fixed` descendants.
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-oncolor-dark/60" onClick={() => setOpen(false)}>
          <div role="dialog" aria-modal="true" aria-label="GEX levels on the index chart"
            className="flex flex-col w-full max-w-[1500px] h-[88vh] rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl" onClick={e => e.stopPropagation()}>
            <LevelsChartBody levels={levels} profile={profile} spot={spot} live={live} pollMs={pollMs} symbol={symbol} onClose={() => setOpen(false)} />
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

function LevelsChartBody({ levels, profile, spot, live, pollMs, symbol, onClose }: {
  levels: GexChartLevel[]; profile: GexProfileRow[]; spot: number; live: boolean; pollMs: number; symbol: string; onClose: () => void;
}) {
  const chrome = useChartChrome();
  const wrapRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const linesRef = useRef<IPriceLine[]>([]);
  const hasFitRef = useRef(false);
  // Latest props for the chart callbacks that outlive a render (autoscale provider, overlay frame loop). Written in an effect,
  // never during render.
  const levelsRef = useRef(levels);
  const profileRef = useRef(profile);
  useEffect(() => { levelsRef.current = levels; profileRef.current = profile; }, [levels, profile]);

  const [candles, setCandles] = useState<Candle[]>([]);
  const [dataDate, setDataDate] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<OverlayRow[]>([]);
  const [plotW, setPlotW] = useState(0);

  const busy = useRef(false);
  const load = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const res = await fetch(`/api/level-chart?symbolType=index&symbol=${symbol}&chartInterval=5&levelInterval=15`);
      const j = await res.json() as { success: boolean; candles?: Candle[]; dataDate?: string; error?: string };
      if (!j.success || !j.candles?.length) { setError(j.error ?? 'No intraday candles returned'); return; }
      setCandles(j.candles);
      setDataDate(j.dataDate ?? j.candles[0].time.slice(0, 10));
      setError('');
    } catch (e) {
      setError(String(e));
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }, [symbol]);

  useEffect(() => {
    const first = setTimeout(() => { void load(); }, 0);
    return () => clearTimeout(first);
  }, [load]);
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => { if (!document.hidden) void load(); }, pollMs);
    return () => clearInterval(id);
  }, [live, pollMs, load]);

  // Chart lifetime: created once per open. Data, levels and theme are applied by separate effects so a poll never resets zoom.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const chart = createChart(el, {
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: chrome.textSecondary, fontFamily: 'ui-monospace, monospace', fontSize: 11 },
      grid: { vertLines: { color: chrome.gridline }, horzLines: { color: chrome.gridline } },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: chrome.baseline, labelBackgroundColor: chrome.textMuted }, horzLine: { color: chrome.baseline, labelBackgroundColor: chrome.textMuted } },
      rightPriceScale: { borderColor: chrome.baseline, scaleMargins: { top: 0.06, bottom: 0.06 } },
      timeScale: { borderColor: chrome.baseline, timeVisible: true, secondsVisible: false, tickMarkFormatter: formatIstTick, rightOffset: 4 },
      localization: { timeFormatter: (t: Time) => formatIstTick(t, TickMarkType.Time) },
      autoSize: true,
    });
    const series = chart.addSeries(LineSeries, {
      color: chrome.textSecondary,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      // Keep every level on screen: price lines do not take part in autoscale on their own.
      autoscaleInfoProvider: (orig: () => { priceRange: { minValue: number; maxValue: number }; margins?: { above: number; below: number } } | null) => {
        const r = orig();
        const ps = levelsRef.current.map(l => l.price).filter(p => p > 0);
        if (!r || !ps.length) return r;
        return { priceRange: { minValue: Math.min(r.priceRange.minValue, ...ps), maxValue: Math.max(r.priceRange.maxValue, ...ps) }, margins: r.margins };
      },
    });
    chartRef.current = chart;
    seriesRef.current = series;
    hasFitRef.current = false;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      linesRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- chrome is re-applied by its own effect; recreating on theme flip would drop zoom
  }, []);

  useEffect(() => {
    chartRef.current?.applyOptions({
      layout: { textColor: chrome.textSecondary },
      grid: { vertLines: { color: chrome.gridline }, horzLines: { color: chrome.gridline } },
      rightPriceScale: { borderColor: chrome.baseline },
      timeScale: { borderColor: chrome.baseline },
      crosshair: { vertLine: { color: chrome.baseline, labelBackgroundColor: chrome.textMuted }, horzLine: { color: chrome.baseline, labelBackgroundColor: chrome.textMuted } },
    });
    seriesRef.current?.applyOptions({ color: chrome.textSecondary });
  }, [chrome]);

  // Candles: real UTC epochs, shown in IST by the tick formatter.
  const points = useMemo(() => {
    const out: { time: UTCTimestamp; value: number }[] = [];
    let last = -1;
    for (const c of candles) {
      const t = Math.floor(Date.parse(c.time) / 1000);
      if (!Number.isFinite(t) || t <= last) continue; // strictly ascending, or setData throws
      last = t;
      out.push({ time: t as UTCTimestamp, value: c.close });
    }
    return out;
  }, [candles]);

  useEffect(() => {
    const series = seriesRef.current;
    const chart = chartRef.current;
    if (!series || !chart || !points.length) return;
    try { series.setData(points); } catch { /* a rejected frame costs a redraw, not the page */ }
    if (!hasFitRef.current) { chart.timeScale().fitContent(); hasFitRef.current = true; }
  }, [points]);

  // Levels as labelled price lines, rebuilt whenever they change.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    for (const l of linesRef.current) { try { series.removePriceLine(l); } catch { /* already gone */ } }
    linesRef.current = [];
    for (const l of levels) {
      if (!(l.price > 0)) continue;
      const color = l.tone === 'spot' ? chrome.textSecondary : TONE[l.tone];
      linesRef.current.push(series.createPriceLine({
        price: l.price,
        color,
        lineWidth: l.tone === 'spot' ? 1 : 2,
        lineStyle: l.tone === 'spot' ? LineStyle.Dotted : l.tone === 'em' ? LineStyle.SparseDotted : LineStyle.Dashed,
        axisLabelVisible: true,
        title: l.label,
      }));
    }
    // New levels can move the autoscale range: re-fit once the series has data.
    chartRef.current?.priceScale('right').applyOptions({ autoScale: true });
  }, [levels, chrome]);

  // Profile overlay: positions come from the series' own price-to-pixel mapping, re-read every frame so pan, zoom and resize
  // keep the bars on their strikes. State is written only when something moved.
  useEffect(() => {
    let raf = 0;
    let sig = '';
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const series = seriesRef.current;
      const chart = chartRef.current;
      const el = wrapRef.current;
      if (!series || !chart || !el) return;
      const h = el.clientHeight;
      const out: OverlayRow[] = [];
      for (const r of profileRef.current) {
        const y = series.priceToCoordinate(r.strike);
        const y2 = series.priceToCoordinate(r.strike + STRIKE_STEP);
        if (y == null || y2 == null || y < -20 || y > h + 20) continue;
        out.push({ y: y as number, h: Math.abs((y2 as number) - (y as number)), ce: r.ceGex, pe: -r.peGex, strike: r.strike });
      }
      const w = el.clientWidth - chart.priceScale('right').width();
      const next = `${Math.round(w)}|${out.map(o => `${Math.round(o.y)}:${Math.round(o.h)}:${o.ce}:${o.pe}`).join(',')}`;
      if (next === sig) return;
      sig = next;
      setRows(out);
      setPlotW(Math.round(w));
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const maxBar = useMemo(() => rows.reduce((m, r) => Math.max(m, r.ce, r.pe), 0) || 1, [rows]);
  const lastClose = points.length ? points[points.length - 1].value : 0;
  const shownSpot = spot > 0 ? spot : lastClose;

  return (
    <>
      <div className="flex items-start justify-between gap-4 px-5 py-3 border-b border-zinc-800">
        <div>
          <p className="text-[9px] font-bold text-sky-400 uppercase tracking-[0.18em] mb-0.5">Level chart</p>
          <h2 className="text-sm font-bold text-white tracking-tight">{symbol} · 5-minute line with GEX levels</h2>
          <p className="text-[11px] text-zinc-400 mt-1">
            {dataDate ? `Session ${dataDate}` : 'Loading…'}{live ? ` · refreshing every ${fmtInterval(Math.round(pollMs / 1000))}` : ' · market closed, last session'} · bars on the right are call (red) and put (green) GEX per strike
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => { setLoading(true); void load(); }} aria-label="Refresh candles" title="Refresh candles"
            className="p-1.5 rounded-md border border-zinc-800 bg-zinc-900 text-zinc-300 hover:bg-zinc-800 focus:outline-none focus:ring-2 focus:ring-emerald-500/50">
            <RefreshCw className="w-4 h-4" aria-hidden="true" />
          </button>
          <button onClick={() => chartRef.current?.timeScale().fitContent()} title="Fit the whole session"
            className="px-2.5 py-1.5 rounded-md border border-zinc-800 bg-zinc-900 text-xs font-bold text-zinc-300 hover:bg-zinc-800 focus:outline-none focus:ring-2 focus:ring-emerald-500/50">
            Fit
          </button>
          <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-md border border-zinc-800 bg-zinc-900 text-zinc-300 hover:bg-zinc-800 focus:outline-none focus:ring-2 focus:ring-emerald-500/50">
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="flex items-center gap-x-5 gap-y-1 flex-wrap px-5 py-2 border-b border-zinc-800 text-[11px]">
        {levels.filter(l => l.price > 0).map(l => (
          <span key={l.key} className="flex items-center gap-1.5">
            <span className="w-3 border-t-2 border-dashed" style={{ borderColor: l.tone === 'spot' ? chrome.textSecondary : TONE[l.tone] }} />
            <span className="text-zinc-400 font-bold uppercase tracking-widest text-[10px]">{l.label}</span>
            <span className="font-mono tabular-nums text-zinc-100 font-semibold">{fmtPrice(l.price)}</span>
            {shownSpot > 0 && l.tone !== 'spot' && (
              <span className="font-mono tabular-nums text-zinc-500">{l.price >= shownSpot ? '+' : '−'}{Math.abs(Math.round(l.price - shownSpot)).toLocaleString('en-IN')}</span>
            )}
          </span>
        ))}
      </div>

      <div className="relative flex-1 min-h-0">
        {error && (
          <div className="absolute inset-x-4 top-3 z-10 px-3 py-2 bg-red-900/20 border border-red-700/40 rounded-lg text-xs text-red-400">{error}</div>
        )}
        {loading && !candles.length && !error && (
          <div className="absolute inset-0 z-10 flex items-center justify-center gap-3">
            <div className="w-5 h-5 border-2 border-zinc-700 border-t-sky-400 rounded-full animate-spin" />
            <p className="text-sm text-zinc-400 font-medium">Loading {symbol} candles…</p>
          </div>
        )}
        <div ref={wrapRef} className="absolute inset-0" />
        {plotW > PROFILE_W && (
          <svg className="absolute top-0 left-0 h-full pointer-events-none" width={plotW} aria-hidden="true">
            {rows.map(r => {
              const bar = Math.max(1.5, Math.min(r.h * 0.42, 9));
              const wc = (r.ce / maxBar) * PROFILE_W;
              const wp = (r.pe / maxBar) * PROFILE_W;
              return (
                <g key={r.strike}>
                  <rect x={plotW - wc} y={r.y - bar} width={wc} height={bar} fill={TONE.call} fillOpacity={0.55} />
                  <rect x={plotW - wp} y={r.y} width={wp} height={bar} fill={TONE.put} fillOpacity={0.55} />
                </g>
              );
            })}
          </svg>
        )}
      </div>
      <p className="px-5 py-2 border-t border-zinc-800 text-[10px] text-zinc-500">
        Bar length is each strike&apos;s share of the largest call or put GEX in view ({fmtGex(maxBar)} at full length). Levels are the page&apos;s own: nothing here is recomputed.
        Candles are Dhan intraday for the last session; a level far from price can sit off-screen until you press Fit.
      </p>
    </>
  );
}

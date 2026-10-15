'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Sigma, AlertTriangle, SlidersHorizontal, X } from 'lucide-react';
import NavBar from './NavBar';
import IndexCompositeChart, { OVERLAY_PALETTE, type IndicatorSeries, type OverlaySeries } from './IndexCompositeChart';
import {
  activeComponents,
  buildComposite,
  defaultComponents,
  EXCLUDED_SYMBOLS,
  influenceShares,
  SCALE_SYMBOL,
  toCandles,
  toLineCloses,
  emaLine,
  vwapLine,
  type CompositeComponent,
  type CompositeMode,
  type IndicesHistory,
} from '@/lib/indexComposite';

// v2: every index on by default. The v1 key held a 2-index default that must not come back.
const STORAGE_KEY = 'indexComposite.v2';

const TIMEFRAMES = [
  { key: 'tick', label: 'Tick', sec: 0 },
  { key: '1m', label: '1m', sec: 60 },
  { key: '3m', label: '3m', sec: 180 },
  { key: '5m', label: '5m', sec: 300 },
] as const;
type TimeframeKey = (typeof TIMEFRAMES)[number]['key'];

const BRIDGE_INTERVALS = [5, 10, 20, 30, 60];

interface Saved {
  /** null until the first history arrives and seeds every index (or a saved list is restored). */
  components: CompositeComponent[] | null;
  mode: CompositeMode;
  timeframe: TimeframeKey;
  overlay: boolean;
  /** Two EMAs (9/20 by default, the scalpers' pair) and the session VWAP, drawn on the composite. */
  emaFast: Toggle;
  emaSlow: Toggle;
  vwap: boolean;
  /** The Indices settings panel; hidden by default so the chart gets the full width. */
  panel: boolean;
}
interface Toggle { on: boolean; period: number }
const DEFAULTS: Saved = {
  components: null, mode: 'equal', timeframe: '1m', overlay: true,
  emaFast: { on: true, period: 9 }, emaSlow: { on: true, period: 20 }, vwap: true, panel: false,
};

function loadToggle(t: Partial<Toggle> | undefined, fallback: Toggle): Toggle {
  const period = Number(t?.period);
  return { on: typeof t?.on === 'boolean' ? t.on : fallback.on, period: Number.isInteger(period) && period >= 2 && period <= 200 ? period : fallback.period };
}

function loadSaved(): Saved {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const p = JSON.parse(raw) as Partial<Saved>;
    return {
      components: Array.isArray(p.components)
        ? p.components.filter(c => typeof c?.symbol === 'string' && Number.isFinite(c?.weight))
        : null,
      mode: p.mode === 'sum' ? 'sum' : 'equal',
      timeframe: TIMEFRAMES.some(t => t.key === p.timeframe) ? (p.timeframe as TimeframeKey) : DEFAULTS.timeframe,
      overlay: p.overlay !== false,
      emaFast: loadToggle(p.emaFast, DEFAULTS.emaFast),
      emaSlow: loadToggle(p.emaSlow, DEFAULTS.emaSlow),
      vwap: p.vwap !== false,
      panel: p.panel === true,
    };
  } catch {
    return DEFAULTS;
  }
}

/** Saved rows in their saved order, plus any feed index the saved list lacks (added unticked). */
function mergeWithCatalogue(saved: CompositeComponent[], catalogue: string[]): CompositeComponent[] {
  const have = new Set(saved.map(c => c.symbol));
  const extra = defaultComponents(catalogue).filter(c => !have.has(c.symbol)).map(c => ({ ...c, enabled: false }));
  return [...saved, ...extra];
}

const fmt = (v: number, d = 2) => v.toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });

/** Number box that commits on blur/Enter only, so a half-typed "-" or "0." never redraws the chart (dhan-commit-on-blur). */
function NumberInput({ value, onCommit, ariaLabel, disabled, accept = Number.isFinite, className = 'w-14' }: {
  value: number; onCommit: (v: number) => void; ariaLabel: string; disabled?: boolean;
  accept?: (v: number) => boolean; className?: string;
}) {
  const [draft, setDraft] = useState(String(value));
  const [shown, setShown] = useState(value);
  if (shown !== value) { setShown(value); setDraft(String(value)); } // a preset/reset replaced the weight
  const commit = () => {
    const v = Number(draft);
    if (draft.trim() !== '' && accept(v)) onCommit(v);
    else setDraft(String(value));
  };
  return (
    <input
      aria-label={ariaLabel}
      inputMode="decimal"
      disabled={disabled}
      value={draft}
      onChange={e => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      className={`${className} px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-700 text-right font-mono text-xs text-white disabled:opacity-40 focus:outline-none focus:ring-2 focus:ring-sky-400`}
    />
  );
}

const isPeriod = (v: number) => Number.isInteger(v) && v >= 2 && v <= 200;

// Saturated data colours for the indicator lines (not themed). They are drawn 2px over the 1px overlays, VWAP dashed.
const EMA_FAST_COLOR = '#fbbf24';
const EMA_SLOW_COLOR = '#c084fc';
const VWAP_COLOR = '#f472b6';

type BridgeStatus = { status: string; subscribed?: number; last_update?: string };

const chipBtn = 'text-[11px] font-bold px-2 py-0.5 rounded border border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400';

export default function IndexCompositePage() {
  const [history, setHistory] = useState<IndicesHistory | null>(null);
  const [bridge, setBridge] = useState<BridgeStatus>({ status: 'UNKNOWN' });
  const [streamError, setStreamError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [bridgeInterval, setBridgeInterval] = useState<number | null>(null);
  const [saved, setSaved] = useState<Saved>(DEFAULTS);
  const [hydrated, setHydrated] = useState(false);
  const [hover, setHover] = useState<string | null>(null);

  // Read after mount, not in useState's initialiser: the server render has no localStorage.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time restore of stored weights
  useEffect(() => { setSaved(loadSaved()); setHydrated(true); }, []);
  useEffect(() => {
    if (!hydrated) return;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(saved)); } catch { /* private window */ }
  }, [saved, hydrated]);

  useEffect(() => {
    fetch('/api/live-indices').then(r => r.json()).then(j => {
      if (j?.settings?.interval) setBridgeInterval(Number(j.settings.interval));
    }).catch(() => {});
    const es = new EventSource('/api/live-indices/stream');
    es.onmessage = e => {
      try {
        const j = JSON.parse(e.data as string);
        if (!j.success) return;
        setStreamError(false);
        setBridge(j.status ?? { status: 'STOPPED' });
        if (j.history) setHistory(j.history);
      } catch { /* malformed frame: wait for the next one */ }
    };
    es.onerror = () => setStreamError(true);
    return () => es.close();
  }, []);

  const bridgeAction = useCallback(async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      await fetch('/api/live-indices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch { /* status arrives over the stream */ }
    finally { setBusy(false); }
  }, []);

  const changeInterval = useCallback(async (interval: number) => {
    setBridgeInterval(interval);
    await bridgeAction({ action: 'settings', interval });
  }, [bridgeAction]);

  const catalogue = useMemo(() => (history?.catalogue ?? []).filter(s => !EXCLUDED_SYMBOLS.has(s)), [history]);
  const { mode, timeframe, overlay } = saved;
  // Every feed index is a row; nothing saved yet → all of them, equal influence.
  const components = useMemo(
    () => (saved.components ? mergeWithCatalogue(saved.components, catalogue) : defaultComponents(catalogue)),
    [saved.components, catalogue],
  );
  const update = (patch: Partial<Saved>) => setSaved(s => ({ ...s, ...patch }));
  const setComponents = (next: CompositeComponent[]) => update({ components: next });
  const patchRow = (symbol: string, patch: Partial<CompositeComponent>) =>
    setComponents(components.map(c => (c.symbol === symbol ? { ...c, ...patch } : c)));
  const enableWhere = (pred: (c: CompositeComponent) => boolean) =>
    setComponents(components.map(c => ({ ...c, enabled: pred(c) })));

  const labelOf = (s: string) => history?.labels?.[s] ?? s;
  const categoryOf = (s: string) => history?.categories?.[s] ?? '';
  const colorOf = useMemo(() => {
    const m = new Map(catalogue.map((s, i) => [s, OVERLAY_PALETTE[i % OVERLAY_PALETTE.length]]));
    return (s: string) => m.get(s) ?? OVERLAY_PALETTE[0];
  }, [catalogue]);

  const result = useMemo(
    () => (history ? buildComposite(history, components, mode) : null),
    [history, components, mode],
  );
  const tf = TIMEFRAMES.find(t => t.key === timeframe) ?? TIMEFRAMES[1];
  const chartData = useMemo(
    () => (result ? (tf.sec ? toCandles(result.points, tf.sec) : result.points) : []),
    [result, tf.sec],
  );
  const showOverlay = overlay && mode === 'equal';
  const { emaFast, emaSlow, vwap } = saved;
  const indicatorSeries = useMemo<IndicatorSeries[]>(() => {
    const out: IndicatorSeries[] = [];
    if (emaFast.on) out.push({ id: 'emaFast', label: `EMA ${emaFast.period}`, color: EMA_FAST_COLOR, data: emaLine(chartData, emaFast.period) });
    if (emaSlow.on) out.push({ id: 'emaSlow', label: `EMA ${emaSlow.period}`, color: EMA_SLOW_COLOR, data: emaLine(chartData, emaSlow.period) });
    if (vwap) out.push({ id: 'vwap', label: 'VWAP', color: VWAP_COLOR, dashed: true, data: vwapLine(chartData) });
    return out;
  }, [chartData, emaFast, emaSlow, vwap]);
  const overlaySeries = useMemo<OverlaySeries[]>(() => {
    if (!result || !showOverlay) return [];
    return Object.entries(result.overlays).map(([symbol, pts]) => ({
      symbol,
      label: history?.labels?.[symbol] ?? symbol,
      color: colorOf(symbol),
      data: tf.sec ? toLineCloses(pts, tf.sec) : pts,
    }));
  }, [result, showOverlay, tf.sec, colorOf, history]);

  const active = activeComponents(components);
  const shares = mode === 'equal' ? influenceShares(components) : (() => {
    const gross = active.reduce((s, c) => s + Math.abs(c.weight * (result?.last[c.symbol] ?? 0)), 0);
    return Object.fromEntries(active.map(c => [c.symbol, gross ? (c.weight * (result?.last[c.symbol] ?? 0) / gross) * 100 : 0]));
  })();

  const points = result?.points ?? [];
  const lastValue = points.length ? points[points.length - 1].value : null;
  const firstValue = points.length ? points[0].value : null;
  const change = lastValue !== null && firstValue !== null ? lastValue - firstValue : null;
  const changePct = change !== null && firstValue ? (change / Math.abs(firstValue)) * 100 : null;

  const running = bridge.status === 'RUNNING' || bridge.status === 'STARTING';
  const chartKey = `${mode}-${timeframe}-${showOverlay}-${JSON.stringify(active)}`;
  const scaleLabel = mode === 'equal'
    ? (result?.scale !== undefined && active.some(c => c.symbol === SCALE_SYMBOL) ? 'Nifty-points scale' : 'base 100')
    : 'index points';

  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-white">
      <div className="sticky top-0 z-30 flex items-center justify-between gap-3 flex-wrap px-6 py-3 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0 bg-sky-500/10 border border-sky-500/25">
            <Sigma className="w-4 h-4 text-sky-400" />
          </div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-sky-400 mb-0.5">Scalping · Indices</p>
            <h1 className="text-sm font-bold text-white tracking-tight leading-none">Composite Index</h1>
            <p className="text-[10px] text-zinc-500 font-medium mt-1">Weighted composite of every live index from the indices WebSocket</p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`flex items-center gap-1.5 text-[10px] font-mono font-bold uppercase px-1.5 py-0.5 rounded border ${running ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10' : 'text-zinc-400 border-zinc-700 bg-zinc-900'}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${running ? 'bg-emerald-400 animate-pulse' : 'bg-zinc-500'}`} />
            Feed {bridge.status === 'UNKNOWN' ? '…' : bridge.status}
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => bridgeAction({ action: running ? 'stop' : 'start' })}
            className="text-xs font-bold px-2.5 py-1 rounded border border-zinc-700 bg-zinc-900 text-zinc-200 hover:bg-zinc-800 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
          >
            {running ? 'Stop feed' : 'Start feed'}
          </button>
          <label className="flex items-center gap-1 text-[10px] text-zinc-400 font-medium">
            Tick every
            <select
              aria-label="Bridge tick interval"
              value={bridgeInterval ?? ''}
              onChange={e => changeInterval(Number(e.target.value))}
              className="px-1.5 py-1 rounded bg-zinc-900 border border-zinc-700 text-xs text-white font-mono"
            >
              {bridgeInterval !== null && !BRIDGE_INTERVALS.includes(bridgeInterval) && <option value={bridgeInterval}>{bridgeInterval}s</option>}
              {bridgeInterval === null && <option value="">20s</option>}
              {BRIDGE_INTERVALS.map(s => <option key={s} value={s}>{s}s</option>)}
            </select>
          </label>
          <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-amber-300 px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/20">
            DATA: {result?.date ?? '—'}
          </span>
          <span className="w-px h-5 bg-zinc-800 shrink-0" />
          <NavBar />
        </div>
      </div>

      <div className="flex-1 flex flex-col lg:flex-row gap-4 px-6 py-5 max-w-[1680px] w-full mx-auto">
        {/* Chart */}
        <section className="flex-1 min-w-0 flex flex-col rounded-lg border border-zinc-800 bg-zinc-900/40">
          <div className="flex items-center justify-between gap-3 flex-wrap px-4 py-2.5 border-b border-zinc-800">
            <div className="flex items-baseline gap-3 flex-wrap">
              <span className="text-2xl font-mono font-bold text-white">{lastValue !== null ? fmt(lastValue) : '—'}</span>
              {change !== null && (
                <span className={`text-sm font-mono font-bold ${change >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {change >= 0 ? '+' : ''}{fmt(change)} ({changePct !== null ? `${changePct >= 0 ? '+' : ''}${fmt(changePct)}%` : '—'})
                </span>
              )}
              <span className="text-[10px] text-zinc-500">{active.length} indices · {scaleLabel} · since {result?.staleUntil ? result.staleUntil.slice(0, 5) : '09:15'}</span>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex rounded border border-zinc-700 overflow-hidden" role="group" aria-label="Weighting">
                {(['equal', 'sum'] as const).map(m => (
                  <button key={m} type="button" onClick={() => update({ mode: m })}
                    className={`px-2.5 py-1 text-xs font-bold ${mode === m ? 'bg-sky-500/20 text-sky-300' : 'bg-zinc-900 text-zinc-400 hover:text-zinc-200'}`}>
                    {m === 'equal' ? 'Equal %' : 'Σ Price'}
                  </button>
                ))}
              </div>
              <label className={`flex items-center gap-1.5 text-xs font-bold px-2 py-1 rounded border border-zinc-700 bg-zinc-900 ${mode === 'equal' ? 'text-zinc-300' : 'text-zinc-600'}`}
                title={mode === 'equal' ? undefined : 'Overlays need Equal % — in Σ Price the indices do not share a scale'}>
                <input type="checkbox" checked={showOverlay} disabled={mode !== 'equal'} onChange={e => update({ overlay: e.target.checked })} className="accent-sky-400" />
                Overlay indices
              </label>
              <div className="flex rounded border border-zinc-700 overflow-hidden" role="group" aria-label="Timeframe">
                {TIMEFRAMES.map(t => (
                  <button key={t.key} type="button" onClick={() => update({ timeframe: t.key })}
                    className={`px-2.5 py-1 text-xs font-bold ${timeframe === t.key ? 'bg-sky-500/20 text-sky-300' : 'bg-zinc-900 text-zinc-400 hover:text-zinc-200'}`}>
                    {t.label}
                  </button>
                ))}
              </div>
              <button type="button" onClick={() => update({ panel: !saved.panel })} aria-expanded={saved.panel} aria-controls="composite-indices-panel"
                title={saved.panel ? 'Hide the indices panel' : 'Choose indices and weights'}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded border text-xs font-bold ${saved.panel ? 'border-sky-500/40 bg-sky-500/20 text-sky-300' : 'border-zinc-700 bg-zinc-900 text-zinc-400 hover:text-zinc-200'}`}>
                <SlidersHorizontal className="w-3.5 h-3.5" /> Indices {active.length}/{components.length}
              </button>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap px-4 py-2 border-b border-zinc-800 text-xs">
            {([
              ['emaFast', emaFast, EMA_FAST_COLOR],
              ['emaSlow', emaSlow, EMA_SLOW_COLOR],
            ] as const).map(([key, t, color]) => {
              const series = indicatorSeries.find(i => i.id === key);
              const last = series?.data.length ? series.data[series.data.length - 1].value : null;
              return (
                <div key={key} className="flex items-center gap-1.5 px-2 py-1 rounded border border-zinc-700 bg-zinc-900">
                  <input type="checkbox" checked={t.on} aria-label={`Show EMA ${t.period}`} className="accent-sky-400"
                    onChange={e => update({ [key]: { ...t, on: e.target.checked } })} />
                  <span className="w-3 h-0.5 rounded" style={{ backgroundColor: color }} />
                  <span className="font-bold text-zinc-300">EMA</span>
                  <NumberInput value={t.period} ariaLabel={`EMA period (${key === 'emaFast' ? 'fast' : 'slow'})`} accept={isPeriod} className="w-10"
                    onCommit={v => update({ [key]: { ...t, period: v } })} />
                  <span className="font-mono text-zinc-400 min-w-[64px] text-right">{t.on && last !== null ? fmt(last) : '—'}</span>
                </div>
              );
            })}
            {(() => {
              const series = indicatorSeries.find(i => i.id === 'vwap');
              const last = series?.data.length ? series.data[series.data.length - 1].value : null;
              const above = last !== null && lastValue !== null ? lastValue >= last : null;
              return (
                <div className="flex items-center gap-1.5 px-2 py-1 rounded border border-zinc-700 bg-zinc-900"
                  title="Indices have no volume, so every bar is weighted equally: the running mean of typical price since the first live tick">
                  <input type="checkbox" checked={vwap} aria-label="Show VWAP" className="accent-sky-400" onChange={e => update({ vwap: e.target.checked })} />
                  <span className="w-3 border-t-2 border-dashed" style={{ borderColor: VWAP_COLOR }} />
                  <span className="font-bold text-zinc-300">VWAP</span>
                  <span className="font-mono text-zinc-400 min-w-[64px] text-right">{vwap && last !== null ? fmt(last) : '—'}</span>
                  {vwap && above !== null && (
                    <span className={`font-bold ${above ? 'text-emerald-400' : 'text-red-400'}`}>{above ? 'above' : 'below'}</span>
                  )}
                </div>
              );
            })()}
            <span className="text-[10px] text-zinc-500">on {tf.sec ? `${tf.label} closes` : 'ticks'} · VWAP equal-weighted (indices have no volume)</span>
          </div>

          {streamError && (
            <div className="mx-4 mt-3 flex items-center gap-2 text-xs text-amber-300 px-3 py-2 rounded border border-amber-500/30 bg-amber-500/10">
              <AlertTriangle className="w-3.5 h-3.5" /> Lost the live stream — reconnecting.
            </div>
          )}
          {result?.staleUntil && (
            <div className="mx-4 mt-3 flex items-center gap-2 text-xs text-amber-300 px-3 py-2 rounded border border-amber-500/30 bg-amber-500/10">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              <span>
                The feed had no live prices until {result.staleUntil.slice(0, 5)} (every index frozen), so the composite starts there
                and % moves are measured from that tick, not 09:15.
              </span>
            </div>
          )}
          {result && result.missing.length > 0 && (
            <div className="mx-4 mt-3 flex items-center gap-2 text-xs text-amber-300 px-3 py-2 rounded border border-amber-500/30 bg-amber-500/10">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              <span>
                No ticks for {result.missing.map(labelOf).join(', ')} — the composite is not drawn until every ticked index has a price.
                Untick it here, or enable it in Live → Normalized, which sets the feed&apos;s index selection.
              </span>
            </div>
          )}

          <div className="flex-1 relative min-h-[420px] p-2">
            {chartData.length > 0 ? (
              <IndexCompositeChart key={chartKey} data={chartData} kind={tf.sec ? 'candles' : 'line'} overlays={overlaySeries} indicators={indicatorSeries} highlight={hover} />
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-zinc-500">
                {!history
                  ? (bridge.status === 'UNKNOWN' ? 'Loading…' : 'No index history yet — start the feed.')
                  : active.length === 0
                    ? 'Tick at least one index with a non-zero influence.'
                    : 'No in-session ticks yet (the chart covers 09:15–15:30 IST).'}
              </div>
            )}
          </div>
          {tf.sec > 0 && bridgeInterval !== null && bridgeInterval * 3 > tf.sec && (
            <p className="px-4 pb-2 text-[10px] text-zinc-500">
              Each {tf.label} candle is built from ~{Math.max(1, Math.floor(tf.sec / bridgeInterval))} ticks at the current {bridgeInterval}s feed interval — lower it for truer highs/lows.
            </p>
          )}
        </section>

        {/* Components */}
        {saved.panel && (
        <aside id="composite-indices-panel" className="w-full lg:w-[400px] shrink-0 flex flex-col gap-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 lg:max-h-[calc(100vh-110px)] lg:sticky lg:top-[88px]">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-bold uppercase tracking-wider text-zinc-300">Indices · {active.length}/{components.length}</h2>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-zinc-500 font-mono">{mode === 'equal' ? 'S·Σ wᵢ·Pᵢ/Bᵢ / Σ|wᵢ|' : 'Σ wᵢ·Pᵢ'}</span>
              <button type="button" onClick={() => { update({ panel: false }); setHover(null); }} aria-label="Hide indices panel"
                className="p-1 rounded text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          <div className="flex flex-wrap gap-1.5">
            <button type="button" className={chipBtn} onClick={() => enableWhere(() => true)}>All</button>
            <button type="button" className={chipBtn} onClick={() => enableWhere(() => false)}>None</button>
            <button type="button" className={chipBtn} onClick={() => enableWhere(c => categoryOf(c.symbol) === 'Broad Market')}>Broad only</button>
            <button type="button" className={chipBtn} onClick={() => enableWhere(c => categoryOf(c.symbol) === 'Sectoral')}>Sectoral only</button>
            <button type="button" className={chipBtn} onClick={() => update({ components: defaultComponents(catalogue), mode: 'equal' })}>Reset (all equal)</button>
            <button type="button" className={chipBtn} onClick={() => update({
              mode: 'sum',
              components: components.map(c => ({ ...c, enabled: c.symbol === 'BANKNIFTY' || c.symbol === 'NIFTY', weight: c.symbol === 'NIFTY' ? -2 : 1 })),
            })}>Bank − 2·Nifty</button>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto rounded border border-zinc-800">
            <table className="w-full text-xs">
              <thead className="sticky top-0 z-10">
                <tr className="bg-zinc-800">
                  <th className="w-7 px-2 py-1.5"><span className="sr-only">Included</span></th>
                  <th className="text-left px-1 py-1.5 text-xs font-bold text-white">Index</th>
                  <th className="text-right px-1 py-1.5 text-xs font-bold text-white" title="Influence: 1 = normal, 2 = double, negative = short">Infl.</th>
                  <th className="text-right px-1 py-1.5 text-xs font-bold text-white">Share</th>
                  <th className="text-right px-2 py-1.5 text-xs font-bold text-white">LTP</th>
                </tr>
              </thead>
              <tbody>
                {components.map(c => {
                  const on = c.enabled !== false;
                  const ltp = result?.last[c.symbol];
                  const base = result?.bases[c.symbol];
                  const pct = ltp && base ? ((ltp - base) / base) * 100 : null;
                  const share = shares[c.symbol];
                  return (
                    <tr key={c.symbol}
                      onMouseEnter={() => setHover(c.symbol)} onMouseLeave={() => setHover(h => (h === c.symbol ? null : h))}
                      className={`border-b border-zinc-800 ${hover === c.symbol ? 'bg-zinc-800/60' : ''}`}>
                      <td className="px-2 py-1">
                        <input type="checkbox" checked={on} aria-label={`Include ${labelOf(c.symbol)}`}
                          onChange={e => patchRow(c.symbol, { enabled: e.target.checked })} className="accent-sky-400" />
                      </td>
                      <td className="px-1 py-1">
                        <div className="flex items-center gap-1.5">
                          {showOverlay && on && <span className="w-2.5 h-0.5 rounded shrink-0" style={{ backgroundColor: colorOf(c.symbol) }} />}
                          <span className={on ? 'text-zinc-200 font-medium' : 'text-zinc-500'}>{labelOf(c.symbol)}</span>
                        </div>
                        {pct !== null && (
                          <div className={`text-[10px] font-mono ${pct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{pct >= 0 ? '+' : ''}{fmt(pct)}%</div>
                        )}
                      </td>
                      <td className="px-1 py-1 text-right">
                        <NumberInput value={c.weight} ariaLabel={`Influence for ${labelOf(c.symbol)}`} disabled={!on} onCommit={v => patchRow(c.symbol, { weight: v })} />
                      </td>
                      <td className="px-1 py-1 text-right font-mono text-zinc-400">{share !== undefined ? `${fmt(share, 1)}%` : '—'}</td>
                      <td className="px-2 py-1 text-right font-mono text-zinc-300">{ltp ? fmt(ltp) : '—'}</td>
                    </tr>
                  );
                })}
                {components.length === 0 && (
                  <tr><td colSpan={5} className="px-2 py-3 text-center text-zinc-500">Waiting for the feed&apos;s index list…</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="text-[10px] leading-relaxed text-zinc-500 space-y-1">
            <p>
              <b className="text-zinc-400">How weights work.</b> Each ticked index has an influence (default 1); its share is
              influence ÷ total, so all {components.length || 25} equal = {fmt(100 / Math.max(1, components.length || 25), 1)}% each.
            </p>
            <p>
              <b className="text-zinc-400">Equal %</b> (default) averages each index&apos;s % move from its first tick after 09:15, so
              Realty (~₹830) counts as much as Nifty Next 50 (~₹69k). It is drawn in Nifty points: it opens at Nifty&apos;s level, and every
              overlay line is that index&apos;s % move on the same scale. <b className="text-zinc-400">Σ Price</b> adds raw points instead, where
              the high-priced indices dominate. Set 2 to double an index, untick to drop it, a negative number to short it.
              Saved in this browser.
            </p>
          </div>
        </aside>
        )}
      </div>
    </div>
  );
}

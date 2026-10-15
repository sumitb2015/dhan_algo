'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Sigma, Plus, Trash2, AlertTriangle } from 'lucide-react';
import NavBar from './NavBar';
import IndexCompositeChart from './IndexCompositeChart';
import {
  buildComposite,
  toCandles,
  type CompositeComponent,
  type CompositeMode,
  type IndicesHistory,
} from '@/lib/indexComposite';

const STORAGE_KEY = 'indexComposite.v1';
/** A volatility gauge, not a price: it has no meaning inside a weighted price sum. */
const EXCLUDED = new Set(['INDIA VIX']);

const PRESETS: { label: string; components: CompositeComponent[] }[] = [
  { label: 'Nifty + Bank', components: [{ symbol: 'NIFTY', weight: 1 }, { symbol: 'BANKNIFTY', weight: 1 }] },
  { label: 'Index trio', components: [{ symbol: 'NIFTY', weight: 1 }, { symbol: 'BANKNIFTY', weight: 1 }, { symbol: 'FINNIFTY', weight: 1 }] },
  { label: 'Bank − 2·Nifty', components: [{ symbol: 'BANKNIFTY', weight: 1 }, { symbol: 'NIFTY', weight: -2 }] },
];

const TIMEFRAMES = [
  { key: 'tick', label: 'Tick', sec: 0 },
  { key: '1m', label: '1m', sec: 60 },
  { key: '3m', label: '3m', sec: 180 },
  { key: '5m', label: '5m', sec: 300 },
] as const;
type TimeframeKey = (typeof TIMEFRAMES)[number]['key'];

const BRIDGE_INTERVALS = [5, 10, 20, 30, 60];

interface Saved { components: CompositeComponent[]; mode: CompositeMode; timeframe: TimeframeKey }
const DEFAULTS: Saved = { components: PRESETS[0].components, mode: 'sum', timeframe: '1m' };

function loadSaved(): Saved {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const p = JSON.parse(raw) as Partial<Saved>;
    return {
      components: Array.isArray(p.components) ? p.components.filter(c => typeof c?.symbol === 'string' && Number.isFinite(c?.weight)) : DEFAULTS.components,
      mode: p.mode === 'normalized' ? 'normalized' : 'sum',
      timeframe: TIMEFRAMES.some(t => t.key === p.timeframe) ? (p.timeframe as TimeframeKey) : DEFAULTS.timeframe,
    };
  } catch {
    return DEFAULTS;
  }
}

const fmt = (v: number, d = 2) => v.toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });

/** Weight box: commits on blur/Enter only, so a half-typed "-" or "0." never redraws the chart (dhan-commit-on-blur). */
function WeightInput({ value, onCommit, label }: { value: number; onCommit: (v: number) => void; label: string }) {
  const [draft, setDraft] = useState(String(value));
  const [shown, setShown] = useState(value);
  if (shown !== value) { setShown(value); setDraft(String(value)); } // a preset replaced the weight
  const commit = () => {
    const v = Number(draft);
    if (draft.trim() !== '' && Number.isFinite(v)) onCommit(v);
    else setDraft(String(value));
  };
  return (
    <input
      aria-label={`Weight for ${label}`}
      inputMode="decimal"
      value={draft}
      onChange={e => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      className="w-20 px-2 py-1 rounded bg-zinc-900 border border-zinc-700 text-right font-mono text-xs text-white focus:outline-none focus:ring-2 focus:ring-sky-400"
    />
  );
}

type BridgeStatus = { status: string; subscribed?: number; last_update?: string };

export default function IndexCompositePage() {
  const [history, setHistory] = useState<IndicesHistory | null>(null);
  const [bridge, setBridge] = useState<BridgeStatus>({ status: 'UNKNOWN' });
  const [streamError, setStreamError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [bridgeInterval, setBridgeInterval] = useState<number | null>(null);
  const [saved, setSaved] = useState<Saved>(DEFAULTS);
  const [hydrated, setHydrated] = useState(false);
  const [addSymbol, setAddSymbol] = useState('');

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

  const { components, mode, timeframe } = saved;
  const update = (patch: Partial<Saved>) => setSaved(s => ({ ...s, ...patch }));
  const setWeight = (symbol: string, weight: number) =>
    update({ components: components.map(c => (c.symbol === symbol ? { ...c, weight } : c)) });

  const catalogue = useMemo(() => (history?.catalogue ?? []).filter(s => !EXCLUDED.has(s)), [history]);
  const labelOf = (s: string) => history?.labels?.[s] ?? s;
  const addable = catalogue.filter(s => !components.some(c => c.symbol === s));

  const result = useMemo(
    () => (history ? buildComposite(history, components, mode) : null),
    [history, components, mode],
  );
  const tf = TIMEFRAMES.find(t => t.key === timeframe) ?? TIMEFRAMES[1];
  const chartData = useMemo(
    () => (result ? (tf.sec ? toCandles(result.points, tf.sec) : result.points) : []),
    [result, tf.sec],
  );

  const points = result?.points ?? [];
  const lastValue = points.length ? points[points.length - 1].value : null;
  const firstValue = points.length ? points[0].value : null;
  const change = lastValue !== null && firstValue !== null ? lastValue - firstValue : null;
  const changePct = change !== null && firstValue ? (change / Math.abs(firstValue)) * 100 : null;
  const grossContribution = components.reduce((s, c) => s + Math.abs(c.weight * (result?.last[c.symbol] ?? 0)), 0);

  const running = bridge.status === 'RUNNING' || bridge.status === 'STARTING';
  const chartKey = `${mode}-${timeframe}-${JSON.stringify(components)}`;

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
            <p className="text-[10px] text-zinc-500 font-medium mt-1">Weighted sum of live index prices from the indices WebSocket</p>
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
            <div className="flex items-baseline gap-3">
              <span className="text-2xl font-mono font-bold text-white">{lastValue !== null ? fmt(lastValue) : '—'}</span>
              {change !== null && (
                <span className={`text-sm font-mono font-bold ${change >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {change >= 0 ? '+' : ''}{fmt(change)} ({changePct !== null ? `${changePct >= 0 ? '+' : ''}${fmt(changePct)}%` : '—'})
                </span>
              )}
              <span className="text-[10px] text-zinc-500">since first session tick</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex rounded border border-zinc-700 overflow-hidden" role="group" aria-label="Composite mode">
                {(['sum', 'normalized'] as const).map(m => (
                  <button key={m} type="button" onClick={() => update({ mode: m })}
                    className={`px-2.5 py-1 text-xs font-bold ${mode === m ? 'bg-sky-500/20 text-sky-300' : 'bg-zinc-900 text-zinc-400 hover:text-zinc-200'}`}>
                    {m === 'sum' ? 'Σ w·Price' : 'Base 100'}
                  </button>
                ))}
              </div>
              <div className="flex rounded border border-zinc-700 overflow-hidden" role="group" aria-label="Timeframe">
                {TIMEFRAMES.map(t => (
                  <button key={t.key} type="button" onClick={() => update({ timeframe: t.key })}
                    className={`px-2.5 py-1 text-xs font-bold ${timeframe === t.key ? 'bg-sky-500/20 text-sky-300' : 'bg-zinc-900 text-zinc-400 hover:text-zinc-200'}`}>
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {streamError && (
            <div className="mx-4 mt-3 flex items-center gap-2 text-xs text-amber-300 px-3 py-2 rounded border border-amber-500/30 bg-amber-500/10">
              <AlertTriangle className="w-3.5 h-3.5" /> Lost the live stream — reconnecting.
            </div>
          )}
          {result && result.missing.length > 0 && (
            <div className="mx-4 mt-3 flex items-center gap-2 text-xs text-amber-300 px-3 py-2 rounded border border-amber-500/30 bg-amber-500/10">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              No ticks for {result.missing.map(labelOf).join(', ')} — the composite is not drawn until every weighted index has a price.
              Enable it in Live → Normalized, which sets the feed&apos;s index selection.
            </div>
          )}

          <div className="flex-1 relative min-h-[420px] p-2">
            {chartData.length > 0 ? (
              <IndexCompositeChart key={chartKey} data={chartData} kind={tf.sec ? 'candles' : 'line'} />
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-zinc-500">
                {!history
                  ? (bridge.status === 'UNKNOWN' ? 'Loading…' : 'No index history yet — start the feed.')
                  : components.every(c => !c.weight)
                    ? 'Add at least one index with a non-zero weight.'
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

        {/* Weights */}
        <aside className="w-full lg:w-[380px] shrink-0 flex flex-col gap-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-bold uppercase tracking-wider text-zinc-300">Components</h2>
            <span className="text-[10px] text-zinc-500 font-mono">{mode === 'sum' ? 'Σ wᵢ·Pᵢ' : '100·Σ wᵢ·Pᵢ/P₀ / Σ|wᵢ|'}</span>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map(p => (
              <button key={p.label} type="button" onClick={() => update({ components: p.components })}
                className="text-[11px] font-bold px-2 py-0.5 rounded border border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800">
                {p.label}
              </button>
            ))}
          </div>

          <table className="w-full text-xs">
            <thead>
              <tr className="bg-zinc-800">
                <th className="text-left px-2 py-1.5 text-xs font-bold text-white">Index</th>
                <th className="text-right px-2 py-1.5 text-xs font-bold text-white">Weight</th>
                <th className="text-right px-2 py-1.5 text-xs font-bold text-white">LTP</th>
                <th className="text-right px-2 py-1.5 text-xs font-bold text-white">Share</th>
                <th className="w-6" />
              </tr>
            </thead>
            <tbody>
              {components.map(c => {
                const ltp = result?.last[c.symbol];
                const base = result?.bases[c.symbol];
                const pct = ltp && base ? ((ltp - base) / base) * 100 : null;
                const share = ltp && grossContribution ? (Math.abs(c.weight * ltp) / grossContribution) * 100 : null;
                return (
                  <tr key={c.symbol} className="border-b border-zinc-800">
                    <td className="px-2 py-1.5">
                      <div className="text-zinc-200 font-medium">{labelOf(c.symbol)}</div>
                      {pct !== null && (
                        <div className={`text-[10px] font-mono ${pct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{pct >= 0 ? '+' : ''}{fmt(pct)}%</div>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-right"><WeightInput value={c.weight} label={labelOf(c.symbol)} onCommit={v => setWeight(c.symbol, v)} /></td>
                    <td className="px-2 py-1.5 text-right font-mono text-zinc-300">{ltp ? fmt(ltp) : '—'}</td>
                    <td className="px-2 py-1.5 text-right font-mono text-zinc-400">{share !== null ? `${fmt(share, 0)}%` : '—'}</td>
                    <td className="px-1 py-1.5 text-right">
                      <button type="button" aria-label={`Remove ${labelOf(c.symbol)}`}
                        onClick={() => update({ components: components.filter(x => x.symbol !== c.symbol) })}
                        className="p-1 rounded text-zinc-500 hover:text-red-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                );
              })}
              {components.length === 0 && (
                <tr><td colSpan={5} className="px-2 py-3 text-center text-zinc-500">No components — add an index below.</td></tr>
              )}
            </tbody>
          </table>

          <div className="flex items-center gap-2">
            <select aria-label="Index to add" value={addSymbol} onChange={e => setAddSymbol(e.target.value)}
              className="flex-1 min-w-0 px-2 py-1 rounded bg-zinc-900 border border-zinc-700 text-xs text-white">
              <option value="">{catalogue.length ? 'Add index…' : 'Feed not loaded'}</option>
              {addable.map(s => <option key={s} value={s}>{labelOf(s)}</option>)}
            </select>
            <button type="button" aria-label="Add index" disabled={!addSymbol}
              onClick={() => { update({ components: [...components, { symbol: addSymbol, weight: 1 }] }); setAddSymbol(''); }}
              className="p-1.5 rounded border border-zinc-700 bg-zinc-900 text-zinc-200 hover:bg-zinc-800 disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400">
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>

          <p className="text-[10px] leading-relaxed text-zinc-500">
            <b className="text-zinc-400">Σ w·Price</b> adds raw index points, so a high-priced index (Bank ≈ 55k) dominates a
            low-priced one unless you scale its weight. <b className="text-zinc-400">Base 100</b> weights each index&apos;s % move from its
            first session tick instead. Negative weights build a spread. Weights are saved in this browser.
          </p>
        </aside>
      </div>
    </div>
  );
}

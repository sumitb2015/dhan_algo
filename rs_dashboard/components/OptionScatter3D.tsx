'use client';

import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useChartChrome } from '@/lib/chartTheme';
import {
  buildPoints, clipRange, clamp, topByGoal,
  type OcEntry, type ScatterPoint, type Goal, type Signal,
} from '@/lib/optionScatter3d';

// Series colours (data colours are exempt from the chrome-token rule).
const CE_COLOR = '#3b82f6';
const PE_COLOR = '#c47f0a';
const SIGNAL_COLOR: Record<Signal, string> = {
  'Long buildup':   '#10b981',
  'Short buildup':  '#ef4444',
  'Short covering': '#38bdf8',
  'Long unwinding': '#a78bfa',
};
const SIGNALS = Object.keys(SIGNAL_COLOR) as Signal[];
const SCORE_SCALE: [number, string][] = [[0, '#3f3f46'], [0.5, '#0e9d6a'], [1, '#bbf7d0']];

type ColorMode = 'side' | 'signal' | 'score';

function fmtOi(n: number): string {
  if (n >= 1e7) return `${(n / 1e7).toFixed(2)}Cr`;
  if (n >= 1e5) return `${(n / 1e5).toFixed(2)}L`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}
const sgn = (v: number, d = 1) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}`;

interface Props {
  underlying: string;
  expiry: string;
  onMeta?: (m: { spot: number; updatedAt: number; count: number }) => void;
}

interface ChainRes {
  success: boolean;
  data?: { chain: { oc?: Record<string, OcEntry> }; spot: number };
  error?: string;
}

const POLL_MS = 15_000;

function Seg<T extends string>({ value, options, onChange }: {
  value: T; options: { v: T; label: string }[]; onChange: (v: T) => void;
}) {
  return (
    <div className="flex items-center gap-1 bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg">
      {options.map(o => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          className={`px-2.5 py-1 rounded-md text-[11px] font-bold transition-colors ${
            value === o.v ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:text-zinc-200'
          }`}
        >{o.label}</button>
      ))}
    </div>
  );
}

function Sel({ label, value, onChange, options }: {
  label: string; value: number; onChange: (v: number) => void; options: { v: number; label: string }[];
}) {
  return (
    <label className="flex items-center gap-1.5">
      <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest">{label}</span>
      <select
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-mono font-semibold
                   rounded-lg px-2 py-1.5 focus:outline-none focus:border-emerald-500 tabular-nums"
      >
        {options.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
      </select>
    </label>
  );
}

export default function OptionScatter3D({ underlying, expiry, onMeta }: Props) {
  const chrome = useChartChrome();
  const plotEl = useRef<HTMLDivElement>(null);
  const plotlyRef = useRef<typeof import('plotly.js-gl3d-dist-min').default | null>(null);
  const [plotlyReady, setPlotlyReady] = useState(false);

  const [oc, setOc] = useState<Record<string, OcEntry> | null>(null);
  const [spot, setSpot] = useState(0);
  const [error, setError] = useState('');

  const [goal, setGoal] = useState<Goal>('buy');
  const [colorMode, setColorMode] = useState<ColorMode>('signal');
  const [strikeWindow, setStrikeWindow] = useState(15);
  const [minOiPct, setMinOiPct] = useState(2);
  const [minLtp, setMinLtp] = useState(3);
  const [clip, setClip] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);

  // ── Load Plotly once, client-side only (it touches `window` on import) ──
  useEffect(() => {
    let alive = true;
    import('plotly.js-gl3d-dist-min').then(m => {
      if (!alive) return;
      plotlyRef.current = m.default;
      setPlotlyReady(true);
    }).catch(e => setError(`Failed to load 3D engine: ${String(e)}`));
    return () => { alive = false; };
  }, []);

  // ── Poll the chain. In-flight guard + sequence so a slow older response never
  //    overwrites a newer one, and a changed expiry drops the old chain. ──
  const seq = useRef(0);
  const inflight = useRef(false);
  const load = useCallback(async () => {
    if (!expiry || inflight.current) return;
    inflight.current = true;
    const mine = ++seq.current;
    try {
      const res = await fetch(`/api/options/chain?underlying=${underlying}&expiry=${expiry}`, { cache: 'no-store' });
      const j = await res.json() as ChainRes;
      if (mine !== seq.current) return;
      if (!j.success || !j.data?.chain?.oc) { setError(j.error ?? 'No chain data'); return; }
      setError('');
      setOc(j.data.chain.oc);
      if (j.data.spot > 0) setSpot(j.data.spot); // a transient 0 must not blank the plot
      onMeta?.({ spot: j.data.spot, updatedAt: Date.now(), count: Object.keys(j.data.chain.oc).length });
    } catch (e) {
      if (mine === seq.current) setError(String(e));
    } finally {
      inflight.current = false;
    }
  }, [underlying, expiry, onMeta]);

  useEffect(() => {
    // The page remounts this component (key) per underlying+expiry, so state and
    // refs start clean; nothing to reset here.
    const first = setTimeout(load, 0);
    const id = setInterval(() => { if (!document.hidden) load(); }, POLL_MS);
    return () => { clearTimeout(first); clearInterval(id); };
  }, [load]);

  const points = useMemo<ScatterPoint[]>(
    () => (oc ? buildPoints(oc, { spot, strikeWindow, minOiPct, minLtp }) : []),
    [oc, spot, strikeWindow, minOiPct, minLtp],
  );

  const top = useMemo(() => topByGoal(points, goal, 12), [points, goal]);

  const axes = useMemo(() => ({
    x: clipRange(points.map(p => p.priceChg), clip),
    y: clipRange(points.map(p => p.oiChg), clip),
    z: clipRange(points.map(p => p.iv), clip),
  }), [points, clip]);

  // ── Render / update the 3D scene ──
  useEffect(() => {
    const Plotly = plotlyRef.current;
    const el = plotEl.current;
    if (!plotlyReady || !Plotly || !el) return;

    const maxOi = Math.max(1, ...points.map(p => p.oi));
    const size = (p: ScatterPoint) => 4 + 12 * Math.sqrt(p.oi / maxOi);
    const X = (p: ScatterPoint) => clamp(p.priceChg, axes.x.lo, axes.x.hi);
    const Y = (p: ScatterPoint) => clamp(p.oiChg, axes.y.lo, axes.y.hi);
    const Z = (p: ScatterPoint) => clamp(p.iv, axes.z.lo, axes.z.hi);
    const score = (p: ScatterPoint) => (goal === 'buy' ? p.buyScore : p.sellScore);

    const hover = (p: ScatterPoint) =>
      `<b>${p.strike} ${p.side}</b>  ₹${p.ltp.toFixed(2)}<br>` +
      `Price ${sgn(p.priceChg)}%  ·  OI ${sgn(p.oiChg)}% (${fmtOi(p.oi)})<br>` +
      `IV ${p.iv.toFixed(1)}% (${sgn(p.ivResidual)} vs nbrs)` +
      (p.delta !== null ? `  ·  Δ ${p.delta.toFixed(2)}` : '') + `<br>` +
      `${p.signal}  ·  ${goal === 'buy' ? 'Buy' : 'Sell'} score ${score(p) ?? '—'}`;

    const mk = (list: ScatterPoint[], name: string, marker: Record<string, unknown>) => ({
      type: 'scatter3d', mode: 'markers', name,
      x: list.map(X), y: list.map(Y), z: list.map(Z),
      customdata: list.map(p => p.key),
      text: list.map(hover), hoverinfo: 'text',
      marker: { size: list.map(size), opacity: 0.88, line: { width: 0 }, ...marker },
    });

    let traces: unknown[];
    if (colorMode === 'side') {
      traces = [
        mk(points.filter(p => p.side === 'CE'), 'CE', { color: CE_COLOR }),
        mk(points.filter(p => p.side === 'PE'), 'PE', { color: PE_COLOR }),
      ];
    } else if (colorMode === 'signal') {
      traces = SIGNALS.map(s => mk(points.filter(p => p.signal === s), s, { color: SIGNAL_COLOR[s] }));
    } else {
      traces = [mk(points, `${goal === 'buy' ? 'Buy' : 'Sell'} score`, {
        color: points.map(p => score(p) ?? 0),
        cmin: 0, cmax: 100, colorscale: SCORE_SCALE,
        colorbar: {
          title: { text: `${goal === 'buy' ? 'Buy' : 'Sell'} score`, font: { color: chrome.textMuted, size: 11 } },
          tickfont: { color: chrome.textMuted, size: 10 }, len: 0.6, thickness: 10,
          outlinewidth: 0,
        },
      })];
    }

    const sel = points.find(p => p.key === selected);
    if (sel) {
      traces.push({
        type: 'scatter3d', mode: 'markers', name: 'Selected', showlegend: false, hoverinfo: 'skip',
        x: [X(sel)], y: [Y(sel)], z: [Z(sel)],
        marker: { size: size(sel) + 9, color: 'rgba(0,0,0,0)', line: { color: chrome.textSecondary, width: 3 } },
      });
    }

    const axis = (title: string, r: { lo: number; hi: number }) => ({
      title: { text: title, font: { color: chrome.textSecondary, size: 12 } },
      range: [r.lo - (r.hi - r.lo) * 0.04, r.hi + (r.hi - r.lo) * 0.04],
      color: chrome.textMuted,
      gridcolor: chrome.gridline, zerolinecolor: chrome.baseline, linecolor: chrome.baseline,
      backgroundcolor: 'rgba(0,0,0,0)', showbackground: false,
      tickfont: { color: chrome.textMuted, size: 10 },
    });

    const layout = {
      autosize: true,
      paper_bgcolor: 'rgba(0,0,0,0)',
      margin: { l: 0, r: 0, t: 0, b: 0 },
      uirevision: `${underlying}|${expiry}`, // keep the user's camera across live updates
      showlegend: colorMode !== 'score',
      legend: { font: { color: chrome.textSecondary, size: 11 }, bgcolor: 'rgba(0,0,0,0)', x: 0.01, y: 0.99 },
      hoverlabel: { bgcolor: chrome.surface, font: { color: chrome.textSecondary, size: 11 }, bordercolor: chrome.baseline },
      scene: {
        xaxis: axis('Price change %', axes.x),
        yaxis: axis('OI change %', axes.y),
        zaxis: axis('IV %', axes.z),
        aspectmode: 'cube',
        camera: { eye: { x: 1.6, y: -1.6, z: 0.9 } },
      },
    };

    Plotly.react(el, traces, layout, { responsive: true, displaylogo: false, modeBarButtonsToRemove: ['toImage'] })
      .then(() => {
        const g = el as unknown as { removeAllListeners?: (e: string) => void; on?: (e: string, cb: (d: { points?: { customdata?: string }[] }) => void) => void };
        g.removeAllListeners?.('plotly_click');
        g.on?.('plotly_click', d => {
          const key = d.points?.[0]?.customdata;
          if (key) setSelected(prev => (prev === key ? null : key));
        });
      });
  }, [plotlyReady, points, axes, colorMode, goal, selected, chrome, underlying, expiry]);

  useEffect(() => {
    const el = plotEl.current;
    const Plotly = plotlyRef.current;
    return () => { if (el && Plotly) Plotly.purge(el); };
  }, [plotlyReady]);

  const clippedTotal = axes.x.clipped + axes.y.clipped + axes.z.clipped;
  const scoreOf = (p: ScatterPoint) => (goal === 'buy' ? p.buyScore : p.sellScore);

  return (
    <>
      {/* Controls */}
      <div className="flex items-center gap-3 flex-wrap">
        <Seg value={goal} onChange={setGoal} options={[{ v: 'buy', label: 'Find BUYS' }, { v: 'sell', label: 'Find SELLS' }]} />
        <Seg value={colorMode} onChange={setColorMode}
             options={[{ v: 'signal', label: 'Colour: Signal' }, { v: 'side', label: 'CE / PE' }, { v: 'score', label: 'Score' }]} />
        <Sel label="Strikes ±" value={strikeWindow} onChange={setStrikeWindow}
             options={[{ v: 8, label: '8' }, { v: 15, label: '15' }, { v: 25, label: '25' }, { v: 0, label: 'All' }]} />
        <Sel label="Min OI" value={minOiPct} onChange={setMinOiPct}
             options={[{ v: 0, label: 'any' }, { v: 2, label: '≥2% of max' }, { v: 5, label: '≥5% of max' }, { v: 10, label: '≥10% of max' }]} />
        <Sel label="Min ₹" value={minLtp} onChange={setMinLtp}
             options={[{ v: 0, label: 'any' }, { v: 3, label: '3' }, { v: 5, label: '5' }, { v: 10, label: '10' }]} />
        <label className="flex items-center gap-1.5 text-[11px] text-zinc-400 font-semibold cursor-pointer">
          <input type="checkbox" checked={clip} onChange={e => setClip(e.target.checked)} className="accent-emerald-500" />
          Clip outliers
        </label>
        <span className="text-[11px] text-zinc-500 font-mono tabular-nums ml-auto">
          {points.length} points{clip && clippedTotal > 0 ? ` · ${clippedTotal} axis values clipped` : ''}
        </span>
      </div>

      {/* 3D chart */}
      <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-3 relative overflow-hidden">
        <div ref={plotEl} className="w-full" style={{ height: 560 }} />
        {!points.length && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-zinc-500 pointer-events-none">
            {error ? '' : oc ? 'No strikes pass the filters — loosen Min OI / Min ₹' : 'Loading chain…'}
          </div>
        )}
        <p className="text-[10px] text-zinc-500 mt-1 px-2">
          Drag to rotate · scroll to zoom · click a point to pin it · marker size = open interest
        </p>
      </div>

      {error && (
        <div className="px-3 py-2 bg-red-900/20 border border-red-700/40 rounded-lg text-xs text-red-400">{error}</div>
      )}

      {/* Ranked shortlist — the 3D cloud finds the region, the table gives the numbers */}
      <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl overflow-hidden">
        <div className="px-4 py-2.5 border-b border-zinc-800 flex items-baseline gap-2">
          <h2 className="text-xs font-bold text-white">Top {goal === 'buy' ? 'buy' : 'sell'} candidates</h2>
          <span className="text-[10px] text-zinc-500">
            {goal === 'buy'
              ? 'premium rising + fresh OI + IV cheap vs neighbours · |Δ| 0.20–0.70'
              : 'premium falling + fresh OI (writers) + IV rich vs neighbours · |Δ| 0.05–0.40'}
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs tabular-nums">
            <thead>
              <tr className="bg-zinc-800">
                {['Strike', 'Side', 'LTP', 'Price %', 'OI', 'OI %', 'IV %', 'IV vs nbrs', 'Δ', 'Signal', 'Score'].map(h => (
                  <th key={h} className="px-3 py-2 text-left text-xs font-bold text-white whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {top.map(p => (
                <tr
                  key={p.key}
                  onClick={() => setSelected(prev => (prev === p.key ? null : p.key))}
                  className={`border-t border-zinc-800 cursor-pointer hover:bg-zinc-800/60 ${selected === p.key ? 'bg-zinc-800' : ''}`}
                >
                  <td className="px-3 py-1.5 font-mono font-semibold text-zinc-100">{p.strike}</td>
                  <td className="px-3 py-1.5 font-bold" style={{ color: p.side === 'CE' ? CE_COLOR : PE_COLOR }}>{p.side}</td>
                  <td className="px-3 py-1.5 font-mono text-zinc-200">{p.ltp.toFixed(2)}</td>
                  <td className={`px-3 py-1.5 font-mono ${p.priceChg >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{sgn(p.priceChg)}</td>
                  <td className="px-3 py-1.5 font-mono text-zinc-300">{fmtOi(p.oi)}</td>
                  <td className={`px-3 py-1.5 font-mono ${p.oiChg >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{sgn(p.oiChg)}</td>
                  <td className="px-3 py-1.5 font-mono text-zinc-200">{p.iv.toFixed(1)}</td>
                  <td className={`px-3 py-1.5 font-mono ${p.ivResidual >= 0 ? 'text-amber-400' : 'text-sky-400'}`}>{sgn(p.ivResidual)}</td>
                  <td className="px-3 py-1.5 font-mono text-zinc-300">{p.delta !== null ? p.delta.toFixed(2) : '—'}</td>
                  <td className="px-3 py-1.5 font-semibold" style={{ color: SIGNAL_COLOR[p.signal] }}>{p.signal}</td>
                  <td className="px-3 py-1.5 font-mono font-bold text-zinc-100">{scoreOf(p)}</td>
                </tr>
              ))}
              {!top.length && (
                <tr><td colSpan={11} className="px-3 py-6 text-center text-zinc-500">No candidates pass the filters.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* How to read */}
      <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5 text-xs text-zinc-300 leading-relaxed grid gap-4 md:grid-cols-3">
        <div>
          <h3 className="font-bold text-white mb-1">Reading the cube</h3>
          <p>X = premium change vs yesterday&apos;s close, Y = OI change vs yesterday, Z = implied vol. Marker size is open interest, so a big dot is a strike that matters. Colour by <b>Signal</b> to see which corner each strike lives in.</p>
        </div>
        <div>
          <h3 className="font-bold text-white mb-1">Buying</h3>
          <p>Look for <span style={{ color: SIGNAL_COLOR['Long buildup'] }}>Long buildup</span> (price↑ OI↑) that sits <i>low</i> on Z relative to its neighbours — momentum with fresh longs and no IV premium to pay. Short covering (price↑ OI↓) is a weaker, non-sustainable move.</p>
        </div>
        <div>
          <h3 className="font-bold text-white mb-1">Selling</h3>
          <p>Look for <span style={{ color: SIGNAL_COLOR['Short buildup'] }}>Short buildup</span> (price↓ OI↑) sitting <i>high</i> on Z — writers piling in while IV is rich. Avoid selling into Long buildup: that is the market buying the option.</p>
        </div>
        <p className="md:col-span-3 text-zinc-500">
          Scores are percentile ranks within the strikes currently shown, not absolute probabilities — they rank ideas, they don&apos;t validate them. Percent changes on tiny bases are noise, hence the Min OI / Min ₹ filters. Confirm against the chain, spread and your own risk before trading.
        </p>
      </div>
    </>
  );
}

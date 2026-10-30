'use client';

import { createPortal } from 'react-dom';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Overlay, PanelModel } from '@/lib/straddlePnfModel';
import { layoutPanel, AXIS_W, PAD_TOP } from '@/lib/straddlePnfLayout';

// One straddle P&F chart: X (green) / O (red) glyphs on a visible box grid, VWAP or SMA10 line, a bar at the level every double
// top / double bottom broke, date dividers where a new session starts and a tag at the live price. Every column is drawn: the
// chart scrolls (it opens on the newest column) and the price axis stays pinned to the right edge while you pan.

const MIN_HEIGHT = 420;

export type PnfPanelProps = {
  title: string;
  strike: number;
  model: PanelModel;
  /** Live straddle price (open minute), or null before the first tick. */
  live: { ce: number; pe: number } | null;
  overlay: Overlay;
  stale: boolean;
  /** Set for a few seconds after a signal fires on this chart. */
  flash: 'buy' | 'sell' | null;
  error?: string;
  loading?: boolean;
  /** Minutes per chart bar and box size in %: only used to describe the chart in the header (defaults 1 and 0.5). */
  interval?: number;
  boxPct?: number;
  reversal?: number;
  /** Fill the height of the parent (a flex/grid cell) instead of the live page's fixed viewport-based height. */
  fill?: boolean;
  /** False for a futures chart: there are no CE / PE legs to show. */
  legs?: boolean;
  /** Bump to reset zoom and centre the chart on its newest column and latest price (the header's Re-center button). */
  resetTick?: number;
  /** When set, the title/price/summary strip is drawn there (the page's top header) in one compact row, and not above the chart. */
  headerSlot?: HTMLElement | null;
  /** The instrument's name for the header strip (the strip is shown without a card header, so the price needs a scrip beside it). */
  scrip?: string;
  /** Previous close from the live feed: the change's base when the loaded history holds no earlier session. */
  feedPrevClose?: number | null;
};

function useSize(): [React.RefObject<HTMLDivElement | null>, number, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 480, h: MIN_HEIGHT });
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) =>
      setSize({ w: Math.max(200, Math.floor(e.contentRect.width)), h: Math.max(MIN_HEIGHT, Math.floor(e.contentRect.height)) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size.w, size.h];
}

const fmt = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = (n: number) => `${n >= 0 ? '+' : '-'}${Math.abs(n).toFixed(2)}`;
const hhmm = (t: number) => new Date((t + 5.5 * 3600) * 1000).toISOString().slice(11, 16);

function sessionLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
  const mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  return `${wd} ${String(d.getUTCDate()).padStart(2, '0')} ${mo}`;
}

export default function PnfPanel({ title, strike, model, live, overlay, stale, flash, error, loading, fill, legs = true, resetTick = 0, headerSlot = null, scrip, feedPrevClose = null, interval = 1, boxPct = 0.5, reversal = 3 }: PnfPanelProps) {
  const [wrapRef, width, HEIGHT] = useSize();
  const { columns, box, signals, exits } = model;
  const liveValue = live ? live.ce + live.pe : null;
  const overlayLabel = overlay === 'vwap' ? 'VWAP' : 'SMA 10';
  const overlayNow = [...model.overlay].reverse().find(v => v !== null) ?? null;
  // Change is measured from yesterday's close; with no earlier session loaded it uses the feed's previous close, then the session open.
  const prevClose = model.prevClose ?? feedPrevClose;
  const changeBase = prevClose ?? model.sessionOpen;
  const changeLabel = prevClose ? 'vs prev close' : 'vs open';
  const change = liveValue !== null && changeBase ? liveValue - changeBase : null;
  const changePct = change !== null && changeBase ? (change / changeBase) * 100 : null;
  const lastSignal = signals.length ? signals[signals.length - 1] : null;

  const [zoom, setZoom] = useState(1);
  const L = layoutPanel(columns, box, liveValue, width, HEIGHT, zoom, true);
  const { cell, yMin, yMax, plotW, contentW, contentH, offsetX, padY, padR } = L;
  const yOf = (p: number) => padY + PAD_TOP + ((yMax - p) / box) * cell;
  const xOf = (j: number) => offsetX + j * cell;
  const vis = columns;
  const first = 0;
  const s = cell * 0.36;                       // glyph half-size
  const stroke = Math.max(1.2, Math.min(2.4, cell * 0.075)); // keeps X / O legible when zoomed, not heavy when small
  const gridId = `pnf-grid-${strike}`;
  const gridY = columns.length ? ((yOf(columns[0].low) % cell) + cell) % cell : 0; // a cell edge, so grid lines run along the box edges

  // Open on the newest column, centred on the latest price; keep following the newest column unless the user has panned away.
  const scrollRef = wrapRef;
  // Vertical start: when the whole price range fits the view, centre that block; otherwise centre the latest price.
  const topFor = (el: HTMLElement) => {
    const dataH = PAD_TOP + (L.rows) * cell;
    if (dataH <= el.clientHeight) return Math.max(0, padY - (el.clientHeight - dataH) / 2);
    return Math.max(0, yOf(lastY as number) - el.clientHeight / 2);
  };
  const stickRef = useRef(true);
  // The scroll position where the newest column sits against the axis (the empty room right of it is only for dragging).
  const stickLeft = (el: HTMLElement) => Math.max(0, el.scrollWidth - el.clientWidth - padR);
  // Until the user zooms or drags, the vertical position follows the layout (it changes when the panel is measured and as the range grows).
  const touchedRef = useRef(false);
  const centeredFor = useRef<number | null>(null);
  const lastY = liveValue ?? (columns.length ? (columns[columns.length - 1].low + columns[columns.length - 1].high) / 2 : null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || columns.length === 0) return;
    if (stickRef.current) el.scrollLeft = stickLeft(el);
    if (centeredFor.current !== strike) { touchedRef.current = false; centeredFor.current = strike; }
    if (!touchedRef.current && lastY !== null && box > 0) {
      el.scrollTop = topFor(el);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns.length, contentW, contentH, strike]);

  // TradingView-style controls (same as the options charts): wheel zooms around the cursor, drag pans freely, double-click or the
  // round-arrow button fits the chart back to the newest column, and − / + zoom around the view centre. No scrollbars.
  const pendingRef = useRef<{ left: number; top: number } | 'reset' | null>(null);
  const [scrollTick, setScrollTick] = useState(0);
  const zoomBy = (factor: number, ax?: number, ay?: number) => {
    const el = wrapRef.current;
    const next = Math.min(6, Math.max(0.3, +(zoom * factor).toFixed(3)));
    if (!el || next === zoom) return;
    const x = ax ?? el.clientWidth / 2;
    const y = ay ?? el.clientHeight / 2;
    // The column and price under the anchor stay under it: read them off the current layout, place them on the next one.
    const L2 = layoutPanel(columns, box, liveValue, width, HEIGHT, next, true);
    const j = (el.scrollLeft + x - offsetX) / cell;
    const u = (el.scrollTop + y - padY - PAD_TOP) / cell;
    pendingRef.current = { left: L2.offsetX + j * L2.cell - x, top: L2.padY + PAD_TOP + u * L2.cell - y };
    stickRef.current = false;
    touchedRef.current = true;
    setZoom(next);
  };
  const resetView = () => { touchedRef.current = false; pendingRef.current = 'reset'; stickRef.current = false; setZoom(1); setScrollTick(n => n + 1); };
  useLayoutEffect(() => {
    const el = wrapRef.current;
    const pending = pendingRef.current;
    if (!el || !pending) return;
    pendingRef.current = null;
    if (pending === 'reset') {
      // Centre the newest column (the plot is the view minus the pinned axis) and the latest price.
      el.scrollLeft = Math.max(0, xOf(columns.length - 0.5) - (el.clientWidth - AXIS_W) / 2);
      if (lastY !== null && box > 0) el.scrollTop = topFor(el);
    } else {
      el.scrollLeft = pending.left;
      el.scrollTop = pending.top;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, scrollTick]);
  const seenReset = useRef(resetTick);
  useEffect(() => {
    if (seenReset.current === resetTick) return;   // mount (and StrictMode's second mount) is not a reset request
    seenReset.current = resetTick;
    resetView();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetTick]);
  const zoomRef = useRef(zoomBy);
  zoomRef.current = zoomBy;
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomRef.current(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [wrapRef]);
  const dragRef = useRef<{ x: number; y: number; l: number; t: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const lastEntryId = [...signals].reverse().find(g => g.kind === 'DOUBLE_BOTTOM_SELL' && g.belowVwap)?.id;
  const ring = flash === 'buy' ? 'ring-2 ring-emerald-400' : flash === 'sell' ? 'ring-2 ring-red-400' : '';

  const overlayPts = vis
    .map((c, j) => ({ v: model.overlay[first + j], x: xOf(j) + cell / 2 }))
    .filter(p => p.v !== null)
    .map(p => `${p.x},${yOf(p.v as number)}`)
    .join(' ');

  const tickEvery = Math.max(1, Math.round(((yMax - yMin) / box) / 9));

  return (
    <section
      data-testid="pnf-panel"
      data-strike={strike}
      className={`min-w-0 rounded-lg border border-zinc-800 bg-zinc-900 flex flex-col ${fill ? 'h-full min-h-0' : ''} ${ring}`}
    >
      {headerSlot ? createPortal(
        <div className="flex items-center gap-3 min-w-0" aria-label={`${title} summary`}>
          <div className="flex items-baseline gap-2 shrink-0">
            <span data-testid="pnf-scrip" className="text-xs font-bold tracking-tight text-zinc-100">{scrip ?? title}</span>
            {stale && <span className="text-[10px] font-bold uppercase tracking-wider text-amber-300">Stale</span>}
            <span className="text-lg font-bold font-mono text-white leading-none">{liveValue !== null ? fmt(liveValue) : '—'}</span>
            {change !== null && changePct !== null && (
              <span data-testid="pnf-vs-open" className={`text-[11px] font-bold font-mono ${change >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {signed(change)} ({signed(changePct)}%) <span className="font-medium text-zinc-500">{changeLabel}</span>
              </span>
            )}
          </div>
          <span className="w-px h-4 bg-zinc-800 shrink-0" />
          <span className="text-[10px] font-mono text-zinc-400 truncate">
            {legs && <>CE {live ? fmt(live.ce) : '—'} · PE {live ? fmt(live.pe) : '—'} ·{' '}</>}
            <span data-testid="pnf-overlay-legend" className={overlay === 'vwap' ? 'text-amber-300' : 'text-zinc-300'}>
              {overlayLabel}{overlayNow !== null ? ` ${fmt(overlayNow)}` : ''}
            </span>
          </span>
          <span data-testid="pnf-box-info" className="text-[10px] font-mono text-zinc-500 truncate">
            {box > 0 ? `Box ${box.toFixed(2)} (${boxPct}% of ${model.anchor.toFixed(2)}) · ${reversal}-box · ${columns.length} cols` : 'Box —'}
          </span>
          {lastSignal && (
            <span data-testid="pnf-last-signal"
                  className={`shrink-0 text-[10px] font-bold font-mono px-1.5 py-0.5 rounded border ${
                    lastSignal.kind === 'DOUBLE_BOTTOM_SELL'
                      ? 'text-red-400 border-red-500/30 bg-red-500/10'
                      : 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10'}`}>
              {lastSignal.kind === 'DOUBLE_BOTTOM_SELL' ? '▼ DB sell' : '▲ DT buy'} {hhmm(lastSignal.t)}
            </span>
          )}
        </div>,
        headerSlot,
      ) : (
      <div className="px-3 pt-2 pb-1 border-b border-zinc-800">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-xs font-bold text-zinc-100 truncate">{title}</h2>
          <div className="flex items-center gap-2">
            {stale && <span className="text-[10px] font-bold uppercase tracking-wider text-amber-300">Stale</span>}
            <div className="flex flex-col items-end">
              <span className="text-lg font-bold font-mono text-white leading-none">{liveValue !== null ? fmt(liveValue) : '—'}</span>
              {change !== null && changePct !== null && (
                <span data-testid="pnf-vs-open" className={`mt-0.5 text-[10px] font-mono ${change >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {signed(change)} ({signed(changePct)}%) vs open
                </span>
              )}
            </div>
          </div>
        </div>
        <p className="text-[10px] font-mono text-zinc-400 mt-1 truncate">
          {legs && <>CE {live ? fmt(live.ce) : '—'} · PE {live ? fmt(live.pe) : '—'} ·{' '}</>}
          <span data-testid="pnf-overlay-legend" className={overlay === 'vwap' ? 'text-amber-300' : 'text-zinc-300'}>
            {overlayLabel}{overlayNow !== null ? ` ${fmt(overlayNow)}` : ''}
          </span>
        </p>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <p data-testid="pnf-box-info" className="text-[10px] font-mono text-zinc-500 truncate">
            {box > 0 ? `Box ${box.toFixed(2)} (${boxPct}% of ${model.anchor.toFixed(2)}) · ${reversal}-box · ${columns.length} cols` : 'Box —'}
          </p>
          {lastSignal && (
            <span data-testid="pnf-last-signal"
                  className={`shrink-0 text-[10px] font-bold font-mono px-1.5 py-0.5 rounded border ${
                    lastSignal.kind === 'DOUBLE_BOTTOM_SELL'
                      ? 'text-red-400 border-red-500/30 bg-red-500/10'
                      : 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10'}`}>
              {lastSignal.kind === 'DOUBLE_BOTTOM_SELL' ? '▼ DB sell' : '▲ DT buy'} {hhmm(lastSignal.t)}
            </span>
          )}
        </div>
      </div>
      )}

      <div className={`relative ${fill ? 'flex-1 min-h-0 flex flex-col' : ''}`}>
      <div
        ref={wrapRef}
        data-testid="pnf-scroll"
        role="region"
        aria-label={`${title} chart, scrollable`}
        tabIndex={0}
        onPointerDown={e => {
          if (e.button !== 0) return;
          touchedRef.current = true;
          const el = e.currentTarget;
          dragRef.current = { x: e.clientX, y: e.clientY, l: el.scrollLeft, t: el.scrollTop };
          el.setPointerCapture(e.pointerId);
          setDragging(true);
        }}
        onPointerMove={e => {
          const d = dragRef.current;
          if (!d) return;
          e.currentTarget.scrollLeft = d.l - (e.clientX - d.x);
          e.currentTarget.scrollTop = d.t - (e.clientY - d.y);
        }}
        onPointerUp={() => { dragRef.current = null; setDragging(false); }}
        onPointerCancel={() => { dragRef.current = null; setDragging(false); }}
        onDoubleClick={resetView}
        onScroll={e => { const el = e.currentTarget; stickRef.current = el.scrollLeft >= stickLeft(el) - 30; }}
        className={`relative overflow-auto select-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${dragging ? 'cursor-grabbing' : 'cursor-grab'} ${fill ? 'flex-1 min-h-0' : ''}`}
        style={fill ? { minHeight: 200 } : { height: 'calc(100vh - 215px)', minHeight: MIN_HEIGHT }}
      >
        {error ? (
          <p className="p-3 text-xs text-red-400">{error}</p>
        ) : loading ? (
          <p className="p-3 text-xs text-zinc-400">Loading…</p>
        ) : columns.length === 0 ? (
          <p className="p-3 text-xs text-zinc-400">{`Building chart — the first column needs a ${boxPct}% move${interval > 1 ? ` on closed ${interval}-minute bars` : ''}.`}</p>
        ) : (
          <div className="flex" style={{ width: contentW, height: contentH }}>
            <svg width={plotW} height={contentH} className="block shrink-0" role="img" aria-label={`${title} point and figure chart`}>
              <defs>
                <pattern id={gridId} x={offsetX} y={gridY} width={cell} height={cell} patternUnits="userSpaceOnUse">
                  <path d={`M${cell} 0V${cell}M0 ${cell}H${cell}`} fill="none" strokeWidth={1} className="stroke-zinc-800" />
                </pattern>
              </defs>
              <rect data-testid="pnf-grid" x={0} y={0} width={plotW} height={contentH} fill={`url(#${gridId})`} />

              {/* session dividers; a date is written only where it has room, so narrow sessions never print over each other */}
              {(() => {
                let lastLabelX = -Infinity;
                return vis.map((c, j) => {
                  const prev = columns[first + j - 1];
                  if (prev && prev.session === c.session) return null;   // the first column opens the first session, which is labelled too
                  const x = xOf(j);
                  const label = x - lastLabelX >= 64;
                  if (label) lastLabelX = x;
                  return (
                    <g key={`d${j}`}>
                      <line x1={x} x2={x} y1={padY + PAD_TOP - 6} y2={contentH} className="stroke-zinc-600" strokeDasharray="2 3" />
                      {label && <text x={x + 3} y={padY + PAD_TOP - 9} className="fill-zinc-500 font-mono" fontSize={9}>{sessionLabel(c.session)}</text>}
                    </g>
                  );
                });
              })()}

              {/* X / O glyphs */}
              {vis.map((c, j) =>
                Array.from({ length: c.boxes }, (_, k) => {
                  const cx = xOf(j) + cell / 2;
                  const cy = yOf(c.low + (k + 0.5) * box);
                  return c.dir === 'X' ? (
                    <path key={`${j}-${k}`} d={`M${cx - s} ${cy - s}L${cx + s} ${cy + s}M${cx + s} ${cy - s}L${cx - s} ${cy + s}`}
                          className="stroke-emerald-400" strokeWidth={stroke} strokeLinecap="round" fill="none" />
                  ) : (
                    <circle key={`${j}-${k}`} cx={cx} cy={cy} r={s} className="stroke-red-400" strokeWidth={stroke} fill="none" />
                  );
                }),
              )}

              {/* VWAP / SMA10: one continuous line across the loaded sessions */}
              {overlayPts && (
                <polyline points={overlayPts} fill="none" strokeWidth={1.8}
                          className={overlay === 'vwap' ? 'stroke-amber-300' : 'stroke-zinc-500'} />
              )}

              {/* exit cue: first bar of a green X column trading above VWAP */}
              {exits.length > 0 && (
                <text data-testid="pnf-exit" x={xOf(exits[exits.length - 1].col) + cell / 2} y={yOf(columns[exits[exits.length - 1].col].high) - 4}
                      textAnchor="middle" className="fill-emerald-400 font-mono" fontSize={8}>EXIT</text>
              )}

              {/* double top buy / double bottom sell: a horizontal support/resistance line across from the previous swing extreme
                  to the breaking column, with a circle marker at the breakout/breakdown level */}
              {signals.map(g => {
                const sell = g.kind === 'DOUBLE_BOTTOM_SELL';
                const entry = sell && g.belowVwap;
                const levelPrice = sell ? columns[g.col - 2].low : columns[g.col - 2].high;
                const y = yOf(levelPrice);
                const x1 = xOf(g.col - 2);
                const x2 = xOf(g.col) + cell + 6;
                const cx = xOf(g.col) + cell / 2;
                const strokeCls = sell ? 'stroke-red-400' : 'stroke-emerald-400';
                return (
                  <g key={g.id} data-testid="pnf-signal" data-kind={g.kind} data-col={g.col} data-entry={entry ? '1' : '0'}>
                    {/* The horizontal support/resistance level line */}
                    <line x1={x1} x2={x2} y1={y} y2={y} strokeWidth={entry ? 2.5 : 1.8} strokeDasharray={entry ? undefined : '4 2'}
                          className={strokeCls} strokeLinecap="round" />
                    {g.id === lastEntryId && (
                      <g>
                        <rect x={cx - 16} y={y + 8} width={32} height={12} rx={2} className="fill-red-500/20 stroke stroke-red-500/40" />
                        <text x={cx} y={y + 17} textAnchor="middle" className="fill-red-400 font-mono font-bold" fontSize={8}>ENTRY</text>
                      </g>
                    )}
                  </g>
                );
              })}

              {/* live price line */}
              {liveValue !== null && (
                <line x1={0} x2={plotW} y1={yOf(liveValue)} y2={yOf(liveValue)} className="stroke-zinc-500" strokeDasharray="3 3" />
              )}
            </svg>

            {/* price axis: sticky, so it stays at the panel's right edge while the chart is panned */}
            <svg width={AXIS_W} height={contentH} className="block shrink-0 sticky right-0 bg-zinc-900" aria-hidden="true">
              <g data-testid="pnf-axis">
                {Array.from({ length: Math.floor((yMax - yMin) / box) + 1 }, (_, i) => i)
                  .filter(i => i % tickEvery === 0)
                  .filter(i => liveValue === null || Math.abs(yOf(yMin + i * box) - yOf(liveValue)) > 13)
                  .map(i => {
                    const p = yMin + i * box;
                    return <text key={`t${i}`} x={6} y={yOf(p) + 3} className="fill-zinc-500 font-mono" fontSize={9}>{fmt(p)}</text>;
                  })}
              </g>
              {liveValue !== null && (
                <g>
                  <rect x={2} y={yOf(liveValue) - 7} width={AXIS_W - 4} height={14} rx={2} className="fill-amber-300" />
                  <text x={6} y={yOf(liveValue) + 3} className="fill-black font-mono" fontSize={9} fontWeight={700}>{fmt(liveValue)}</text>
                </g>
              )}
            </svg>
          </div>
        )}
      </div>
      <div data-testid="pnf-zoom" data-zoom={zoom} className="absolute bottom-1.5 left-1/2 -translate-x-1/2 flex items-center gap-1 z-10">
        {([['Zoom out', '−', () => zoomBy(0.7)], ['Reset zoom and centre the chart', '↺', resetView], ['Zoom in', '+', () => zoomBy(1 / 0.7)]] as const).map(([label, glyph, run]) => (
          <button key={label} type="button" onClick={run} title={label} aria-label={label === 'Zoom out' || label === 'Zoom in' ? label : 'Fit chart to panel'}
                  className="flex items-center justify-center w-6 h-6 rounded-full text-xs bg-zinc-900 border border-zinc-700 text-zinc-100 hover:bg-zinc-800">{glyph}</button>
        ))}
      </div>
      </div>
    </section>
  );
}

'use client';

import { useEffect, useRef, useState } from 'react';
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
  /** Fill the height of the parent (a flex/grid cell) instead of the live page's fixed viewport-based height. */
  fill?: boolean;
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

function sessionLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
  const mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  return `${wd} ${String(d.getUTCDate()).padStart(2, '0')} ${mo}`;
}

export default function PnfPanel({ title, strike, model, live, overlay, stale, flash, error, loading, fill }: PnfPanelProps) {
  const [wrapRef, width, HEIGHT] = useSize();
  const { columns, box, signals, exits } = model;
  const liveValue = live ? live.ce + live.pe : null;
  const overlayLabel = overlay === 'vwap' ? 'VWAP' : 'SMA 10';
  const overlayNow = [...model.overlay].reverse().find(v => v !== null) ?? null;

  const L = layoutPanel(columns, box, liveValue, width, HEIGHT);
  const { cell, yMin, yMax, plotW, contentW, contentH, offsetX } = L;
  const yOf = (p: number) => PAD_TOP + ((yMax - p) / box) * cell;
  const xOf = (j: number) => offsetX + j * cell;
  const vis = columns;
  const first = 0;
  const s = cell * 0.34;
  const gridId = `pnf-grid-${strike}`;
  const gridY = columns.length ? ((yOf(columns[0].low) % cell) + cell) % cell : 0; // a cell edge, so grid lines run along the box edges

  // Open on the newest column, centred on the latest price; keep following the newest column unless the user has panned away.
  const scrollRef = wrapRef;
  const stickRef = useRef(true);
  const centeredFor = useRef<number | null>(null);
  const lastY = liveValue ?? (columns.length ? (columns[columns.length - 1].low + columns[columns.length - 1].high) / 2 : null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || columns.length === 0) return;
    if (stickRef.current) el.scrollLeft = el.scrollWidth;
    if (centeredFor.current !== strike && lastY !== null && box > 0) {
      el.scrollTop = Math.max(0, yOf(lastY) - el.clientHeight / 2);
      centeredFor.current = strike;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns.length, contentW, contentH, strike]);

  const lastEntryId = [...signals].reverse().find(g => g.kind === 'DOUBLE_BOTTOM_SELL' && g.belowVwap)?.id;
  const ring = flash === 'buy' ? 'ring-2 ring-emerald-400' : flash === 'sell' ? 'ring-2 ring-red-400' : '';

  const overlaySegments: string[] = [];
  let currentSeg: string[] = [];
  let currentSession = '';
  vis.forEach((c, j) => {
    const v = model.overlay[first + j];
    const seg = model.overlaySession[first + j]; // the session the value belongs to, so a column spanning midnight cannot draw a vertical streak
    if (seg !== currentSession) {
      if (currentSeg.length > 0) overlaySegments.push(currentSeg.join(' '));
      currentSeg = [];
      currentSession = seg;
    }
    if (v !== null) {
      currentSeg.push(`${xOf(j) + cell / 2},${yOf(v)}`);
    }
  });
  if (currentSeg.length > 0) overlaySegments.push(currentSeg.join(' '));

  const tickEvery = Math.max(1, Math.round(((yMax - yMin) / box) / 9));

  return (
    <section
      data-testid="pnf-panel"
      data-strike={strike}
      className={`min-w-0 rounded-lg border border-zinc-800 bg-zinc-900 flex flex-col ${fill ? 'h-full min-h-0' : ''} ${ring}`}
    >
      <div className="px-3 pt-2 pb-1 border-b border-zinc-800">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-xs font-bold text-zinc-100 truncate">{title}</h2>
          <div className="flex items-center gap-2">
            {stale && <span className="text-[10px] font-bold uppercase tracking-wider text-amber-300">Stale</span>}
            <span className="text-lg font-bold font-mono text-white leading-none">{liveValue !== null ? fmt(liveValue) : '—'}</span>
          </div>
        </div>
        <p className="text-[10px] font-mono text-zinc-400 mt-1 truncate">
          CE {live ? fmt(live.ce) : '—'} · PE {live ? fmt(live.pe) : '—'} ·{' '}
          <span data-testid="pnf-overlay-legend" className={overlay === 'vwap' ? 'text-amber-300' : 'text-zinc-300'}>
            {overlayLabel}{overlayNow !== null ? ` ${fmt(overlayNow)}` : ''}
          </span>
        </p>
        <p className="text-[10px] font-mono text-zinc-500 mt-0.5 truncate">
          {box > 0 ? `Box ${box.toFixed(2)} (0.5% of ${model.anchor.toFixed(2)}) · 3-box · ${columns.length} cols` : 'Box —'}
        </p>
      </div>

      <div
        ref={wrapRef}
        data-testid="pnf-scroll"
        role="region"
        aria-label={`${title} chart, scrollable`}
        tabIndex={0}
        onScroll={e => { const el = e.currentTarget; stickRef.current = el.scrollLeft + el.clientWidth >= el.scrollWidth - 30; }}
        className={`relative overflow-auto ${fill ? 'flex-1 min-h-0' : ''}`}
        style={fill ? { minHeight: 200 } : { height: 'calc(100vh - 215px)', minHeight: MIN_HEIGHT }}
      >
        {error ? (
          <p className="p-3 text-xs text-red-400">{error}</p>
        ) : loading ? (
          <p className="p-3 text-xs text-zinc-400">Loading…</p>
        ) : columns.length === 0 ? (
          <p className="p-3 text-xs text-zinc-400">Building chart — the first column needs a 0.5% move.</p>
        ) : (
          <div className="flex" style={{ width: contentW, height: contentH }}>
            <svg width={plotW} height={contentH} className="block shrink-0" role="img" aria-label={`${title} point and figure chart`}>
              <defs>
                <pattern id={gridId} x={offsetX} y={gridY} width={cell} height={cell} patternUnits="userSpaceOnUse">
                  <path d={`M${cell} 0V${cell}M0 ${cell}H${cell}`} fill="none" strokeWidth={1} className="stroke-zinc-800" />
                </pattern>
              </defs>
              <rect data-testid="pnf-grid" x={0} y={0} width={plotW} height={contentH} fill={`url(#${gridId})`} />

              {/* session dividers */}
              {vis.map((c, j) => {
                const prev = columns[first + j - 1];
                if (!prev || prev.session === c.session) return null;
                return (
                  <g key={`d${j}`}>
                    <line x1={xOf(j)} x2={xOf(j)} y1={PAD_TOP - 6} y2={contentH} className="stroke-zinc-600" strokeDasharray="2 3" />
                    <text x={xOf(j) + 3} y={PAD_TOP - 9} className="fill-zinc-500 font-mono" fontSize={9}>{sessionLabel(c.session)}</text>
                  </g>
                );
              })}

              {/* X / O glyphs */}
              {vis.map((c, j) =>
                Array.from({ length: c.boxes }, (_, k) => {
                  const cx = xOf(j) + cell / 2;
                  const cy = yOf(c.low + (k + 0.5) * box);
                  return c.dir === 'X' ? (
                    <path key={`${j}-${k}`} d={`M${cx - s} ${cy - s}L${cx + s} ${cy + s}M${cx + s} ${cy - s}L${cx - s} ${cy + s}`}
                          className="stroke-emerald-400" strokeWidth={1.4} fill="none" />
                  ) : (
                    <circle key={`${j}-${k}`} cx={cx} cy={cy} r={s} className="stroke-red-400" strokeWidth={1.4} fill="none" />
                  );
                }),
              )}

              {/* VWAP / SMA10 (segmented per session so it never crosses day boundaries) */}
              {overlaySegments.map((pts, i) => (
                <polyline key={`ov-${i}`} points={pts} fill="none" strokeWidth={1.8}
                          className={overlay === 'vwap' ? 'stroke-amber-300' : 'stroke-zinc-500'} />
              ))}

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
                const fillCls = sell ? 'fill-red-400' : 'fill-emerald-400';
                return (
                  <g key={g.id} data-testid="pnf-signal" data-kind={g.kind} data-col={g.col} data-entry={entry ? '1' : '0'}>
                    {/* The horizontal support/resistance level line */}
                    <line x1={x1} x2={x2} y1={y} y2={y} strokeWidth={entry ? 2.5 : 1.8} strokeDasharray={entry ? undefined : '4 2'}
                          className={strokeCls} strokeLinecap="round" />
                    {/* Circle marker at the breakout/breakdown level */}
                    <circle cx={cx} cy={y} r={Math.max(3, s * 0.9)} className={`${fillCls} opacity-25`} />
                    <circle cx={cx} cy={y} r={Math.max(3, s * 0.9)} fill="none" strokeWidth={1.5} className={strokeCls} />
                    <circle cx={cx} cy={y} r={1.5} className={fillCls} />
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
                  .filter(i => liveValue === null || Math.abs(yOf(yMin + i * box) - yOf(liveValue)) > 10)
                  .map(i => {
                    const p = yMin + i * box;
                    return <text key={`t${i}`} x={6} y={yOf(p) + 3} className="fill-zinc-500 font-mono" fontSize={9}>{fmt(p)}</text>;
                  })}
              </g>
              {liveValue !== null && (
                <g>
                  <rect x={2} y={yOf(liveValue) - 7} width={AXIS_W - 4} height={14} rx={2} className="fill-amber-300" />
                  <text x={6} y={yOf(liveValue) + 3} className="fill-oncolor-dark font-mono" fontSize={9} fontWeight={700}>{fmt(liveValue)}</text>
                </g>
              )}
            </svg>
          </div>
        )}
      </div>
    </section>
  );
}

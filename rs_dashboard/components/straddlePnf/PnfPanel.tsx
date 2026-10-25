'use client';

import { useEffect, useRef, useState } from 'react';
import type { Overlay, PanelModel } from '@/lib/straddlePnfModel';

// One straddle P&F chart: X (green) / O (red) glyphs on a fixed box grid, VWAP or SMA10 line, a bar above the two columns
// before every double top / double bottom, date dividers where a new session starts and a tag at the live price.

const MIN_HEIGHT = 420;
const PAD_TOP = 22;
const AXIS_W = 58;
const MAX_CELL = 14;
const MIN_CELL = 5;

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

export default function PnfPanel({ title, strike, model, live, overlay, stale, flash, error, loading }: PnfPanelProps) {
  const [wrapRef, width, HEIGHT] = useSize();
  const { columns, box, signals, exits } = model;
  const liveValue = live ? live.ce + live.pe : null;
  const overlayLabel = overlay === 'vwap' ? 'VWAP' : 'SMA 10';
  const overlayNow = [...model.overlay].reverse().find(v => v !== null) ?? null;

  // Pick the cell size so the visible columns' price range fits the height, then how many columns fit the width.
  let cell = 12;
  let first = 0;
  let yMin = 0;
  let yMax = 0;
  if (columns.length && box > 0) {
    for (let pass = 0; pass < 2; pass++) {
      first = Math.max(0, columns.length - Math.floor((width - AXIS_W) / cell));
      const vis = columns.slice(first);
      yMin = Math.min(...vis.map(c => c.low), liveValue ?? Infinity);
      yMax = Math.max(...vis.map(c => c.high), liveValue ?? -Infinity);
      const rows = Math.ceil((yMax - yMin) / box) + 3;
      cell = Math.max(MIN_CELL, Math.min(MAX_CELL, Math.floor((HEIGHT - PAD_TOP) / rows)));
    }
    yMin -= box;
    yMax += 2 * box;
  }
  const yOf = (p: number) => PAD_TOP + ((yMax - p) / box) * cell;
  const xOf = (j: number) => j * cell;
  const vis = columns.slice(first);
  const plotW = Math.max(cell, vis.length * cell);
  const svgW = plotW + AXIS_W;
  const s = cell * 0.34;

  const lastEntryId = [...signals].reverse().find(g => g.kind === 'DOUBLE_BOTTOM_SELL' && g.belowVwap && g.col - 2 >= first)?.id;
  const ring = flash === 'buy' ? 'ring-2 ring-emerald-400' : flash === 'sell' ? 'ring-2 ring-red-400' : '';

  const overlayPts = vis
    .map((c, j) => ({ v: model.overlay[first + j], x: xOf(j) + cell / 2, c }))
    .filter(p => p.v !== null)
    .map(p => `${p.x},${yOf(p.v as number)}`)
    .join(' ');

  const tickEvery = Math.max(1, Math.round(((yMax - yMin) / box) / 9));

  return (
    <section
      data-testid="pnf-panel"
      data-strike={strike}
      className={`min-w-0 rounded-lg border border-zinc-800 bg-zinc-900 flex flex-col ${ring}`}
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
          {box > 0 ? `Box ${box.toFixed(2)} (0.5%) · 3-box · ${columns.length} cols` : 'Box —'}
        </p>
      </div>

      <div ref={wrapRef} className="relative overflow-hidden" style={{ height: 'calc(100vh - 215px)', minHeight: MIN_HEIGHT }}>
        {error ? (
          <p className="p-3 text-xs text-red-400">{error}</p>
        ) : loading ? (
          <p className="p-3 text-xs text-zinc-400">Loading…</p>
        ) : columns.length === 0 ? (
          <p className="p-3 text-xs text-zinc-400">Building chart — the first column needs a 0.5% move.</p>
        ) : (
          <svg width={svgW} height={HEIGHT} className="block" role="img" aria-label={`${title} point and figure chart`}>
            {/* session dividers */}
            {vis.map((c, j) => {
              const prev = columns[first + j - 1];
              if (!prev || prev.session === c.session) return null;
              return (
                <g key={`d${j}`}>
                  <line x1={xOf(j)} x2={xOf(j)} y1={PAD_TOP - 6} y2={HEIGHT} className="stroke-zinc-600" strokeDasharray="2 3" />
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

            {/* VWAP / SMA10 */}
            {overlayPts && (
              <polyline points={overlayPts} fill="none" strokeWidth={1.6}
                        className={overlay === 'vwap' ? 'stroke-amber-300' : 'stroke-zinc-500'} />
            )}

            {/* exit cue: first bar of a green X column trading above VWAP */}
            {exits.length > 0 && exits[exits.length - 1].col >= first && (
              <text data-testid="pnf-exit" x={xOf(exits[exits.length - 1].col - first) + cell / 2} y={yOf(columns[exits[exits.length - 1].col].high) - 4}
                    textAnchor="middle" className="fill-emerald-400 font-mono" fontSize={8}>EXIT</text>
            )}

            {/* double top buy / double bottom sell: a bar above the two columns before the signal column */}
            {signals.filter(g => g.col - 2 >= first).map(g => {
              const a = g.col - 2 - first;
              const top = Math.max(columns[g.col - 2].high, columns[g.col - 1].high);
              const sell = g.kind === 'DOUBLE_BOTTOM_SELL';
              const h = sell && g.belowVwap ? 5 : 3;
              return (
                <g key={g.id}>
                  <rect data-testid="pnf-signal" data-kind={g.kind} data-col={g.col} data-entry={sell && g.belowVwap ? '1' : '0'}
                        x={xOf(a)} y={yOf(top) - h - 3} width={cell * 2} height={h} rx={1}
                        className={sell ? 'fill-red-400' : 'fill-emerald-400'} />
                  {g.id === lastEntryId && (
                    <text x={xOf(a) + cell} y={yOf(top) - h - 6} textAnchor="middle" className="fill-red-400 font-mono" fontSize={8}>ENTRY</text>
                  )}
                </g>
              );
            })}

            {/* right axis */}
            {Array.from({ length: Math.floor((yMax - yMin) / box) + 1 }, (_, i) => i)
              .filter(i => i % tickEvery === 0)
              .filter(i => liveValue === null || Math.abs(yOf(yMin + i * box) - yOf(liveValue)) > 10)
              .map(i => {
                const p = yMin + i * box;
                return <text key={`t${i}`} x={plotW + 6} y={yOf(p) + 3} className="fill-zinc-500 font-mono" fontSize={9}>{fmt(p)}</text>;
              })}

            {/* live value tag */}
            {liveValue !== null && (
              <g>
                <line x1={0} x2={plotW} y1={yOf(liveValue)} y2={yOf(liveValue)} className="stroke-zinc-500" strokeDasharray="3 3" />
                <rect x={plotW + 2} y={yOf(liveValue) - 7} width={AXIS_W - 4} height={14} rx={2} className="fill-amber-300" />
                <text x={plotW + 6} y={yOf(liveValue) + 3} className="fill-oncolor-dark font-mono" fontSize={9} fontWeight={700}>{fmt(liveValue)}</text>
              </g>
            )}
          </svg>
        )}
      </div>
    </section>
  );
}

'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Maximize2, X, LayoutGrid, Square } from 'lucide-react';
import PayoffDiagram, { modelToDiagramProps, type StrikeMarker } from '@/components/strategy/PayoffDiagram';
import { buildPayoffModel, type PayoffModel, type PayoffLegInput } from '@/lib/optionsPayoff';
import { calculateTimeToExpiryYears } from '@/lib/optionsPricing';
import { FOCUS_RING } from '@/components/Scalper';

/** One live strategy's inputs for the chart view (built by MultiLegFocus from the same data the row uses). */
export interface PayoffChartItem {
  id: string;
  label: string;
  underlying: string;
  expiry: string;
  spot: number;
  legs: PayoffLegInput[];
  strikes: StrikeMarker[];
  margin?: number;
  atmIv?: number;
  step: number;
  /** Strategy P&L in rupees for the card header. */
  pnl: number | null;
}

const FALLBACK_IV = 0.15;
const money = (v: number) => `${v < 0 ? '−' : v > 0 ? '+' : ''}₹${Math.round(Math.abs(v)).toLocaleString('en-IN')}`;

function useModel(item: PayoffChartItem | undefined, days: number, ivShift: number): PayoffModel | null {
  const key = item ? JSON.stringify([item.legs, item.spot, item.margin, item.atmIv, item.step, days, ivShift]) : '';
  return useMemo(() => {
    if (!item || !(item.spot > 0) || item.legs.length === 0) return null;
    try {
      return buildPayoffModel({
        legs: item.legs, spot: item.spot, margin: item.margin || undefined, atmIv: item.atmIv || undefined,
        fallbackIv: FALLBACK_IV, strikeStep: item.step || 50, sim: { days, ivShift },
      });
    } catch {
      return null;
    }
    // Keyed on the leg VALUES (the item object is rebuilt every parent render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

function ChartBody({ item, height, interactive }: { item: PayoffChartItem; height: number; interactive: boolean }) {
  const [days, setDays] = useState(0);
  const [ivShift, setIvShift] = useState(0);
  const model = useModel(item, days, ivShift);
  const maxDays = useMemo(() => {
    const exp = item.legs.map(l => l.expiry).filter(Boolean).sort()[0] || item.expiry;
    return Math.max(0.1, Math.round(calculateTimeToExpiryYears(exp) * 365 * 10) / 10);
  }, [item.legs, item.expiry]);
  if (!model || model.points.length < 2) {
    return <p className="text-xs text-zinc-500 text-center py-10">Waiting for live prices to draw the payoff curve…</p>;
  }
  return (
    <PayoffDiagram
      title=""
      {...modelToDiagramProps(model)}
      currentSpot={item.spot}
      strikes={item.strikes}
      height={height}
      {...(interactive ? { targetDays: days, maxDays, onTargetDaysChange: setDays, ivShift, onIvShiftChange: setIvShift } : {})}
    />
  );
}

function PnlChip({ pnl }: { pnl: number | null }) {
  if (pnl == null) return null;
  return <span className={`font-mono font-bold tabular-nums text-xs ${pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{money(pnl)}</span>;
}

export default function PayoffChartsView({ items }: { items: PayoffChartItem[] }) {
  const [mode, setMode] = useState<'grid' | 'single'>('grid');
  const [focusId, setFocusId] = useState<string | null>(null);
  const [full, setFull] = useState(false);

  const idx = Math.max(0, items.findIndex(i => i.id === focusId));
  const current = items[idx];
  const go = (d: number) => {
    if (items.length === 0) return;
    setFocusId(items[(idx + d + items.length) % items.length].id);
  };
  const open = (id: string, fullscreen: boolean) => { setFocusId(id); setMode('single'); setFull(fullscreen); };

  useEffect(() => {
    if (mode !== 'single') return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'ArrowRight') go(1);
      else if (e.key === 'Escape' && full) setFull(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, full, idx, items]);

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-2 border border-zinc-800/60 rounded-xl bg-zinc-900/20">
        <p className="text-sm font-semibold text-zinc-300">No live strategies to chart</p>
        <p className="text-xs text-zinc-500">Open or draft legs with a live price show up here.</p>
      </div>
    );
  }

  const nav = (compact: boolean) => (
    <div className="flex items-center gap-2">
      <button type="button" onClick={() => go(-1)} aria-label="Previous strategy" className={`h-8 w-8 flex items-center justify-center rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-300 hover:text-white ${FOCUS_RING}`}>
        <ChevronLeft className="w-4 h-4" />
      </button>
      <span className="text-xs font-mono tabular-nums text-zinc-400 min-w-[3.5rem] text-center">{idx + 1} / {items.length}</span>
      <button type="button" onClick={() => go(1)} aria-label="Next strategy" className={`h-8 w-8 flex items-center justify-center rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-300 hover:text-white ${FOCUS_RING}`}>
        <ChevronRight className="w-4 h-4" />
      </button>
      {!compact && <span className="text-[10px] text-zinc-500 hidden md:inline">← → keys</span>}
    </div>
  );

  const title = current && (
    <div className="flex items-center gap-2 min-w-0">
      <span className="text-sm font-bold text-zinc-100 truncate">{current.label}</span>
      <span className="text-[11px] font-mono text-zinc-500">{current.underlying} · {current.expiry}</span>
      <PnlChip pnl={current.pnl} />
    </div>
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="inline-flex rounded-lg border border-zinc-700 overflow-hidden" role="group" aria-label="Chart layout">
          <button type="button" onClick={() => { setMode('grid'); setFull(false); }} aria-pressed={mode === 'grid'}
            className={`h-8 px-3 inline-flex items-center gap-1.5 text-xs font-bold ${mode === 'grid' ? 'bg-zinc-700 text-white' : 'bg-zinc-900 text-zinc-400 hover:text-white'} ${FOCUS_RING}`}>
            <LayoutGrid className="w-3.5 h-3.5" /> All (2 per row)
          </button>
          <button type="button" onClick={() => { if (!focusId) setFocusId(items[0].id); setMode('single'); }} aria-pressed={mode === 'single'}
            className={`h-8 px-3 inline-flex items-center gap-1.5 text-xs font-bold ${mode === 'single' ? 'bg-zinc-700 text-white' : 'bg-zinc-900 text-zinc-400 hover:text-white'} ${FOCUS_RING}`}>
            <Square className="w-3.5 h-3.5" /> Single
          </button>
        </div>
        {mode === 'single' && (
          <div className="flex items-center gap-3 flex-wrap">
            {title}
            {nav(false)}
            <button type="button" onClick={() => setFull(true)} aria-label="Full screen" title="Full screen"
              className={`h-8 w-8 flex items-center justify-center rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-300 hover:text-white ${FOCUS_RING}`}>
              <Maximize2 className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>

      {mode === 'grid' ? (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
          {items.map(it => (
            <div key={it.id} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3 flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-xs font-bold text-zinc-100 truncate">{it.label}</span>
                  <span className="text-[11px] font-mono text-zinc-500 shrink-0">{it.underlying} · {it.expiry}</span>
                  <PnlChip pnl={it.pnl} />
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button type="button" onClick={() => open(it.id, false)} className={`h-7 px-2 text-[11px] font-bold rounded-md border border-zinc-700 bg-zinc-900 text-zinc-300 hover:text-white ${FOCUS_RING}`}>Single</button>
                  <button type="button" onClick={() => open(it.id, true)} aria-label={`Full screen ${it.label}`} title="Full screen"
                    className={`h-7 w-7 flex items-center justify-center rounded-md border border-zinc-700 bg-zinc-900 text-zinc-300 hover:text-white ${FOCUS_RING}`}>
                    <Maximize2 className="w-3 h-3" />
                  </button>
                </div>
              </div>
              <ChartBody item={it} height={260} interactive={false} />
            </div>
          ))}
        </div>
      ) : current && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
          <ChartBody key={current.id} item={current} height={460} interactive />
        </div>
      )}

      {full && current && typeof document !== 'undefined' && createPortal(
        <div className="fixed inset-0 z-[60] bg-zinc-950 p-4 md:p-6 flex flex-col gap-3 overflow-auto" role="dialog" aria-label="Payoff full screen">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            {title}
            <div className="flex items-center gap-3">
              {nav(false)}
              <button type="button" onClick={() => setFull(false)} aria-label="Close full screen"
                className={`h-8 w-8 flex items-center justify-center rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-300 hover:text-white ${FOCUS_RING}`}>
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
          <div className="flex-1 min-h-0">
            <ChartBody key={current.id} item={current} height={Math.max(420, (typeof window !== 'undefined' ? window.innerHeight : 800) - 260)} interactive />
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

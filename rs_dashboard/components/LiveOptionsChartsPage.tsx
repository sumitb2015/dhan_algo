'use client';

import { useEffect, useRef, useState } from 'react';
import { StraddlePanel } from '@/components/StraddlePanel';
import { RollingStraddlePanel } from '@/components/RollingStraddlePanel';
import { StranglePanel } from '@/components/StranglePanel';
import { StrategyPanel } from '@/components/StrategyPanel';
import { type ChartUnderlying } from '@/lib/underlyings';

const LAYOUTS = [1, 2] as const;
type LayoutCount = (typeof LAYOUTS)[number];

const SPREAD_TYPES = ['straddle', 'rolling_straddle', 'strangle', 'strategy'] as const;
type SpreadType = (typeof SPREAD_TYPES)[number];

const SPREAD_LABELS: Record<SpreadType, string> = {
  straddle: 'Straddle',
  rolling_straddle: 'Rolling Straddle',
  strangle: 'Strangle',
  strategy: 'Strategy',
};

/** Live options premium charts (straddle / rolling straddle / strangle / custom multi-leg
 * strategy), ported from dhanHQ_skills' straddle-chart page. Each panel independently fetches
 * combined CE+PE candles via /api/options/live-charts, which spawns
 * scripts/tools/options_chart_fetch.py per request - no persistent backend process, matching
 * this dashboard's spawn-per-request convention. */
export default function LiveOptionsChartsPage() {
  const [spreadType, setSpreadType] = useState<SpreadType>('straddle');
  const [layoutCount, setLayoutCount] = useState<LayoutCount>(1);
  // Per-panel underlying, owned here rather than inside the panels so the selection survives a
  // spread-type switch (which unmounts and remounts every panel).
  const [underlyings, setUnderlyings] = useState<ChartUnderlying[]>(['NIFTY', 'BANKNIFTY']);

  function setUnderlyingAt(index: number, next: ChartUnderlying) {
    setUnderlyings((prev) => prev.map((u, i) => (i === index ? next : u)));
  }

  const gridRef = useRef<HTMLDivElement>(null);
  const [gridHeight, setGridHeight] = useState(560);

  useEffect(() => {
    function updateHeight() {
      const top = gridRef.current?.getBoundingClientRect().top;
      if (top == null) return;
      setGridHeight(Math.max(360, Math.round(window.innerHeight - top - 24)));
    }
    updateHeight();
    window.addEventListener('resize', updateHeight);
    return () => window.removeEventListener('resize', updateHeight);
  }, []);

  const { cols, rows } = layoutCount === 2 ? { cols: 2, rows: 1 } : { cols: 1, rows: 1 };
  // en-CA gives YYYY-MM-DD; IST rather than toISOString()'s UTC, which reads as yesterday
  // for anyone loading the page before 05:30 IST.
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="sticky top-0 z-30 bg-zinc-900 border-b border-zinc-800 -mx-3 px-3 py-3 flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-bold text-white whitespace-nowrap">Live {SPREAD_LABELS[spreadType]} Chart</h1>
        <span className="text-xs font-mono bg-zinc-800 text-zinc-400 px-2 py-0.5 rounded">DATA: {today}</span>
        <span className="w-px self-stretch bg-zinc-700" />
        <div className="flex gap-1">
          {SPREAD_TYPES.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setSpreadType(t)}
              className={`px-3 py-1 text-sm font-semibold rounded ${spreadType === t ? 'bg-sky-600 text-white' : 'border border-zinc-700 bg-zinc-800 text-zinc-300'}`}
            >
              {SPREAD_LABELS[t]}
            </button>
          ))}
        </div>
        <span className="w-px self-stretch bg-zinc-700" />
        <span className="text-xs text-zinc-500 uppercase tracking-wide">Layout</span>
        <div className="flex gap-1">
          {LAYOUTS.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setLayoutCount(n)}
              className={`px-3 py-1 text-sm font-semibold rounded ${layoutCount === n ? 'bg-sky-600 text-white' : 'border border-zinc-700 bg-zinc-800 text-zinc-300'}`}
            >
              {n}
            </button>
          ))}
        </div>
      </div>

      <div
        ref={gridRef}
        className="grid gap-3"
        style={{ height: gridHeight, gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}
      >
        {Array.from({ length: layoutCount }, (_, i) => {
          // Keying the panel on its underlying remounts it on a switch. That IS the reset: expiry,
          // strike and legs are all meaningless once the underlying changes (25,000 is not a
          // SENSEX or a crude strike), and one remount beats four bespoke reset effects.
          // `key` is passed separately, not through the spread — React rejects a spread that
          // carries one.
          const key = `${i}-${underlyings[i]}`;
          const panelProps = {
            underlying: underlyings[i],
            onUnderlyingChange: (u: ChartUnderlying) => setUnderlyingAt(i, u),
          };
          return (
            <div key={i} className="min-h-0 min-w-0">
              {spreadType === 'straddle' ? (
                <StraddlePanel key={key} {...panelProps} />
              ) : spreadType === 'rolling_straddle' ? (
                <RollingStraddlePanel key={key} {...panelProps} />
              ) : spreadType === 'strangle' ? (
                <StranglePanel key={key} {...panelProps} />
              ) : (
                <StrategyPanel key={key} {...panelProps} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

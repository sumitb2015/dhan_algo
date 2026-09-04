'use client';

/**
 * Strike × date P&L grid. Reuses buildHeatmapGrid() from lib/optionsStrategy.ts —
 * the same engine the Option Strats analyzer uses — so the two pages cannot drift.
 */

import React, { useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { buildHeatmapGrid } from '@/lib/optionsStrategy';
import { legExpiries, type PositionLeg } from '@/lib/positionLegs';
import { fmtExpiryShort } from '@/components/crudeoil/format';

interface Props {
  legs: PositionLeg[];
  spot: number;
  strikeStep: number;
  /** The expiry the grid runs out to — the latest expiry in the book. */
  expiry: string;
}

const RANGE_OPTIONS = [0.02, 0.04, 0.06] as const;
const IV_OPTIONS = [
  { label: 'IV -20%', value: 0.8 },
  { label: 'Live IV', value: 1.0 },
  { label: 'IV +20%', value: 1.2 },
] as const;

function cellColor(pnl: number, maxAbs: number): string {
  if (maxAbs <= 0) return 'transparent';
  const t = Math.min(1, Math.abs(pnl) / maxAbs);
  // Alpha-only ramp keeps the two hues distinguishable for red-green colour
  // vision differences: sign is also carried by the text prefix in each cell.
  return pnl >= 0 ? `rgba(16,185,129,${(t * 0.55).toFixed(3)})` : `rgba(239,68,68,${(t * 0.55).toFixed(3)})`;
}

function fmtCell(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '+';
  if (abs >= 100_000) return `${sign}${(abs / 100_000).toFixed(1)}L`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}K`;
  return `${sign}${abs.toFixed(0)}`;
}

export default function PnlTableTab({ legs, spot, strikeStep, expiry }: Props) {
  const [rangePct, setRangePct] = useState<number>(0.04);
  const [ivMultiplier, setIvMultiplier] = useState<number>(1);

  // buildHeatmapGrid() settles EVERY leg intrinsically only on its single final
  // `expiry` column and Black-Scholes-prices all of them identically on every
  // earlier column — it has no notion of a leg's own expiry. For a book with
  // legs on different dates that would settle an already-expired-by-then leg
  // too late and keep time value alive on it too long. Rather than silently
  // mispricing, refuse to build the grid and say why; the expiry filter chips
  // already let the user narrow to one expiry to see this view.
  const distinctExpiries = useMemo(() => legExpiries(legs), [legs]);
  const multiExpiry = distinctExpiries.length > 1;

  const grid = useMemo(() => {
    if (!legs.length || !expiry || multiExpiry) return null;
    // lotSize is 1: quantities are already absolute contracts (see lib/positionLegs.ts).
    return buildHeatmapGrid(legs, spot, 1, expiry, rangePct, ivMultiplier, strikeStep);
  }, [legs, spot, expiry, rangePct, ivMultiplier, strikeStep, multiExpiry]);

  const maxAbs = useMemo(
    () => (grid ? Math.max(...grid.cells.flat().map(Math.abs), 1) : 1),
    [grid],
  );

  if (multiExpiry) {
    return (
      <div className="flex items-start gap-2 rounded border border-amber-800 bg-amber-950 px-3 py-3 text-xs text-amber-300">
        <AlertTriangle className="mt-px h-4 w-4 shrink-0" />
        <span>
          This book spans {distinctExpiries.length} expiries ({distinctExpiries.map(fmtExpiryShort).join(', ')}).
          The P&amp;L grid prices a single expiry at a time — use the Expiry filter on the left to pick one.
        </span>
      </div>
    );
  }

  if (!grid) {
    return <p className="py-10 text-center text-xs text-zinc-500">No open legs to build a P&amp;L grid from.</p>;
  }

  return (
    <div className="space-y-3.5">
      <div className="flex flex-wrap items-center gap-4 rounded-xl border border-zinc-800/80 bg-zinc-950/60 p-3 shadow-inner">
        <div className="flex items-center gap-1.5">
          <span className="text-[9.5px] font-bold uppercase tracking-wider text-zinc-400">Range</span>
          {RANGE_OPTIONS.map((r) => (
            <button key={r} type="button" onClick={() => setRangePct(r)}
              className={cn(
                'rounded-lg border px-2 py-0.5 font-mono text-[10px] font-bold transition-all shadow-sm',
                rangePct === r
                  ? 'border-sky-500/50 bg-sky-500/20 text-sky-200'
                  : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200',
              )}>
              ±{(r * 100).toFixed(0)}%
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[9.5px] font-bold uppercase tracking-wider text-zinc-400">Vol</span>
          {IV_OPTIONS.map((o) => (
            <button key={o.label} type="button" onClick={() => setIvMultiplier(o.value)}
              className={cn(
                'rounded-lg border px-2 py-0.5 font-mono text-[10px] font-bold transition-all shadow-sm',
                ivMultiplier === o.value
                  ? 'border-violet-500/50 bg-violet-500/20 text-violet-200'
                  : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200',
              )}>
              {o.label}
            </button>
          ))}
        </div>
        <span className="text-[10.5px] text-zinc-400">
          Priced to <strong className="text-zinc-200">{fmtExpiryShort(expiry)}</strong>. Final column settles intrinsically; earlier columns use live IV{ivMultiplier !== 1 ? ` (${ivMultiplier}×)` : ''}.
        </span>
      </div>

      <div className="max-h-[520px] overflow-auto rounded-xl border border-zinc-800/80 bg-zinc-950/40 shadow-inner">
        <table className="w-full border-collapse">
          <thead className="sticky top-0 z-10">
            <tr className="border-b border-zinc-800">
              <th className="sticky left-0 z-20 bg-zinc-800 px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-white">Spot</th>
              {grid.dates.map((d) => (
                <th key={d} className="bg-zinc-800 px-2.5 py-2 text-[10px] font-bold uppercase tracking-wider text-white whitespace-nowrap text-center">
                  {fmtExpiryShort(d)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-850/60">
            {grid.rows.map((rowSpot, ri) => {
              const isNearSpot = Math.abs(rowSpot - spot) <= strikeStep / 2;
              return (
                <tr key={rowSpot} className="transition-colors hover:bg-zinc-800/30">
                  <td className={cn(
                    'sticky left-0 z-10 border-r border-zinc-800/80 px-3 py-1 font-mono text-xs font-bold tabular-nums',
                    isNearSpot ? 'bg-sky-950 text-sky-300 border-l-2 border-l-sky-400' : 'bg-zinc-900 text-zinc-300',
                  )}>
                    {rowSpot.toLocaleString('en-IN')}
                  </td>
                  {grid.cells[ri].map((pnl, ci) => (
                    <td key={ci}
                      style={{ backgroundColor: cellColor(pnl, maxAbs) }}
                      className={cn(
                        'px-2 py-1 text-center font-mono text-[10.5px] font-medium tabular-nums',
                        pnl >= 0 ? 'text-emerald-200' : 'text-red-200',
                      )}>
                      {fmtCell(pnl)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

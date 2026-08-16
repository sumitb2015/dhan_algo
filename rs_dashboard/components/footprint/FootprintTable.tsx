'use client';

import React, { useMemo } from 'react';
import type { FootprintColumn, ValueArea } from '@/lib/volumeProfile';

interface Props {
  columns: FootprintColumn[];
  /** Tick prices to render, descending (highest first). */
  priceRows: number[];
  tickSize: number;
  window: ValueArea;
  lastPrice: number;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-08-14 14:15:00" → "14 Aug 14:15", by string surgery — no Date, no timezone. */
function colLabel(t: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(t);
  if (!m) return t;
  const [, , mo, d, hh, mm] = m;
  return `${Number(d)} ${MONTHS[Number(mo) - 1]} ${hh}:${mm}`;
}

export function fmtVol(v: number): string {
  if (!Number.isFinite(v) || v === 0) return '0';
  const abs = Math.abs(v);
  if (abs >= 1e7) return `${(v / 1e7).toFixed(1)}Cr`;
  if (abs >= 1e5) return `${(v / 1e5).toFixed(1)}L`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(0);
}

/** Heat intensity 0–1 of a cell against the loudest cell on screen. */
function heat(value: number, max: number): number {
  if (max <= 0 || value <= 0) return 0;
  // Square root keeps mid-sized cells visible; linear scaling washes them out whenever a
  // single climax bar dominates the window.
  return Math.min(Math.sqrt(value / max), 1);
}

export default function FootprintTable({ columns, priceRows, tickSize, window: win, lastPrice }: Props) {
  const half = tickSize / 2;

  // Index each column's cells by tick so row lookup is O(1) rather than a scan per cell.
  const maps = useMemo(
    () =>
      columns.map((col) => {
        const m = new Map<number, FootprintColumn['cells'][number]>();
        for (const cell of col.cells) m.set(Math.round(cell.price / tickSize), cell);
        return m;
      }),
    [columns, tickSize],
  );

  const maxCell = useMemo(() => {
    let max = 0;
    for (const [i, col] of columns.entries()) {
      void col;
      for (const price of priceRows) {
        const cell = maps[i].get(Math.round(price / tickSize));
        if (cell) max = Math.max(max, cell.buy, cell.sell);
      }
    }
    return max;
  }, [columns, maps, priceRows, tickSize]);

  const rowTotals = useMemo(
    () =>
      priceRows.map((price) => {
        const tick = Math.round(price / tickSize);
        let buy = 0;
        let sell = 0;
        for (const m of maps) {
          const cell = m.get(tick);
          if (cell) {
            buy += cell.buy;
            sell += cell.sell;
          }
        }
        return { buy, sell, total: buy + sell };
      }),
    [maps, priceRows, tickSize],
  );

  const colTotals = columns.map((c) => c.buy + c.sell);
  const grandTotal = colTotals.reduce((s, v) => s + v, 0);
  const lastTick = Math.round(lastPrice / tickSize);

  // The rendered rows are a narrow slice around the last price, so the per-bar totals below
  // are much larger than the cells above them add up to. Stating the visible share stops
  // that gap from reading as arithmetic that does not tie out.
  const visibleTotal = rowTotals.reduce((s, r) => s + r.total, 0);
  const visibleShare = grandTotal > 0 ? (visibleTotal / grandTotal) * 100 : 0;

  if (columns.length === 0 || priceRows.length === 0) {
    return <div className="py-10 text-center text-xs text-zinc-500">No footprint cells in range.</div>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[11px] font-mono border-collapse">
        <thead className="bg-zinc-800">
          <tr>
            <th className="text-xs font-bold text-white px-2 py-1.5 text-left sticky left-0 bg-zinc-800 z-10">
              Price
            </th>
            {columns.map((c) => (
              <th key={c.t} className="text-xs font-bold text-white px-2 py-1.5 text-center whitespace-nowrap">
                {colLabel(c.t)}
              </th>
            ))}
            <th className="text-xs font-bold text-white px-2 py-1.5 text-center">Sum</th>
            <th className="text-xs font-bold text-white px-2 py-1.5 text-left">Metrics</th>
          </tr>
        </thead>
        <tbody>
          {priceRows.map((price, ri) => {
            const tick = Math.round(price / tickSize);
            const isPoc = Math.abs(price - win.poc) < half;
            const isVah = Math.abs(price - win.vah) < half;
            const isVal = Math.abs(price - win.val) < half;
            const isLast = tick === lastTick;
            const inValue = price >= win.val - half && price <= win.vah + half;

            const anyBuyImb = maps.some((m) => m.get(tick)?.buyImb);
            const anySellImb = maps.some((m) => m.get(tick)?.sellImb);

            return (
              <tr key={price} className={inValue ? 'bg-zinc-900/60' : ''}>
                <td
                  className={`px-2 py-1 text-right sticky left-0 z-10 font-semibold ${
                    isLast ? 'bg-blue-600 text-white' : 'bg-zinc-950 text-zinc-300'
                  }`}
                >
                  {price.toFixed(2)}
                </td>

                {columns.map((col, ci) => {
                  const cell = maps[ci].get(tick);
                  if (!cell || cell.total === 0) {
                    return (
                      <td key={col.t} className="px-2 py-1 text-center text-zinc-600 border-l border-zinc-900">
                        0
                      </td>
                    );
                  }
                  const sellA = heat(cell.sell, maxCell);
                  const buyA = heat(cell.buy, maxCell);
                  return (
                    <td key={col.t} className="p-0 border-l border-zinc-900">
                      <div className="flex">
                        <span
                          className="flex-1 px-1.5 py-1 text-right text-zinc-200"
                          style={{ backgroundColor: `rgba(248, 113, 113, ${sellA * 0.55})` }}
                        >
                          {fmtVol(cell.sell)}
                          {cell.sellImb && <span className="text-rose-300 font-bold"> ▼</span>}
                        </span>
                        <span
                          className="flex-1 px-1.5 py-1 text-right text-zinc-200"
                          style={{ backgroundColor: `rgba(52, 211, 153, ${buyA * 0.55})` }}
                        >
                          {fmtVol(cell.buy)}
                          {cell.buyImb && <span className="text-emerald-300 font-bold"> ▲</span>}
                        </span>
                      </div>
                    </td>
                  );
                })}

                <td className="px-2 py-1 text-right text-zinc-200 border-l border-zinc-800 font-semibold">
                  {fmtVol(rowTotals[ri].total)}
                </td>

                <td className="px-2 py-1 text-left whitespace-nowrap border-l border-zinc-800">
                  <span className="flex items-center gap-1.5">
                    {isPoc && <span className="text-sky-400 font-bold">● POC</span>}
                    {isVah && <span className="text-violet-400 font-bold">▲ VAH</span>}
                    {isVal && <span className="text-violet-400 font-bold">▼ VAL</span>}
                    {anyBuyImb && <span className="text-emerald-400 font-bold">B IMB</span>}
                    {anySellImb && <span className="text-rose-400 font-bold">S IMB</span>}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot className="border-t border-zinc-700">
          <tr className="bg-zinc-900">
            <td className="px-2 py-1.5 text-left font-bold text-zinc-300 sticky left-0 bg-zinc-900 z-10">
              Bar total
            </td>
            {columns.map((col, ci) => (
              <td key={col.t} className="px-2 py-1.5 text-center border-l border-zinc-900">
                <span className="text-zinc-200 font-semibold">{fmtVol(colTotals[ci])}</span>
                <span className={`ml-1.5 font-semibold ${col.delta >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {col.delta >= 0 ? '+' : ''}{fmtVol(col.delta)}
                </span>
              </td>
            ))}
            <td className="px-2 py-1.5 text-right font-bold text-zinc-200 border-l border-zinc-800">
              {fmtVol(grandTotal)}
            </td>
            <td className="px-2 py-1.5 text-left text-zinc-400 border-l border-zinc-800 whitespace-nowrap">
              full bar incl. rows off-screen · visible {visibleShare.toFixed(1)}%
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

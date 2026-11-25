'use client';

import React, { useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  feedState, sortRows, weightedPull,
  type WatchRow, type WatchSortKey,
} from '@/lib/indexScalperMarketWatch';
import { ageLabel } from '@/lib/useLiveTickerPoll';
import { TH, TD, PctPill, fmtPrice, DASH, type SortDir } from '../LiveTickerPanel';
import { useDraggable } from './useDraggable';

const DEFAULT_DIR: Record<WatchSortKey, SortDir> = { name: 'asc', ltp: 'desc', changePct: 'desc', weight: 'desc' };

/** A small draggable watch-only window: Top Indices or Top 10 Stocks. Rows come pre-built from live WebSocket ticks. */
export default function MarketWatchWindow({ kind, rows, updatedAt, flash, now, initial, onClose }: {
  kind: 'indices' | 'stocks';
  rows: WatchRow[];
  updatedAt: string | null;
  /** Up / down flash keyed by row key. */
  flash: Record<string, 'up' | 'down'>;
  now: number;
  initial: { x: number; y: number };
  onClose: () => void;
}) {
  const { pos, handle } = useDraggable(initial);
  const [sort, setSort] = useState<{ key: WatchSortKey; dir: SortDir }>({ key: 'changePct', dir: 'desc' });
  const toggle = (key: WatchSortKey) =>
    setSort(s => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: DEFAULT_DIR[key] }));
  const sorted = useMemo(() => sortRows(rows, sort.key, sort.dir), [rows, sort]);
  const { state, ageMs } = feedState(updatedAt, now);
  const stocks = kind === 'stocks';
  const pull = stocks ? weightedPull(rows) : null;
  const title = stocks ? 'Top 10 Stocks' : 'Top Indices';
  const at = updatedAt ? new Date(updatedAt).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false }) : null;
  const sd = (k: WatchSortKey) => (sort.key === k ? sort.dir : null);

  return (
    <div style={{ left: pos.x, top: pos.y }} data-testid={`market-watch-${kind}`} role="dialog" aria-label={title}
      className="fixed z-40 w-[360px] max-w-[calc(100vw-16px)] rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl select-none">
      <div {...handle} className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-zinc-800 cursor-move">
        <span className="flex items-center gap-2 text-sm font-bold text-white">
          {title}
          <span data-testid={`market-watch-${kind}-state`}
            title={state === 'LIVE' ? 'Dhan WebSocket ticks (market data hub), pushed as they change'
              : state === 'STALE' ? 'No new tick: market closed, or the bridge stopped. Prices may be old.'
              : 'Waiting for the first tick (the bridge is starting)'}
            className={cn('px-1.5 py-px rounded border text-[10px] font-bold',
              state === 'LIVE' ? 'border-emerald-500/40 text-emerald-400'
                : state === 'STALE' ? 'border-amber-500/40 text-amber-300'
                : 'border-zinc-700 text-zinc-500')}>
            {state === 'STALE' ? `STALE ${ageLabel(ageMs)}` : state === 'OFF' ? 'STARTING' : 'LIVE'}
          </span>
        </span>
        <span className="flex items-center gap-2">
          {at && <span className="text-[11px] text-zinc-500 tabular-nums">{at}</span>}
          <button type="button" onClick={onClose} aria-label={`Close ${title}`} title="Close"
            className="w-6 h-6 inline-flex items-center justify-center rounded text-zinc-400 hover:text-white hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60">
            <X className="w-4 h-4" />
          </button>
        </span>
      </div>
      <div className={cn('max-h-[60vh] overflow-auto', state !== 'LIVE' && 'opacity-60')}>
        <table className="w-full text-[12px]">
          <thead className="sticky top-0">
            <tr>
              <TH sortDir={sd('name')} onClick={() => toggle('name')}>{stocks ? 'Stock' : 'Index'}</TH>
              <TH right sortDir={sd('ltp')} onClick={() => toggle('ltp')}>LTP</TH>
              <TH right>Chg</TH>
              <TH right sortDir={sd('changePct')} onClick={() => toggle('changePct')}>Chg%</TH>
              {stocks && <TH right sortDir={sd('weight')} onClick={() => toggle('weight')}>Wt%</TH>}
            </tr>
          </thead>
          <tbody>
            {sorted.map(r => {
              const f = flash[r.key];
              const range = r.high !== null && r.low !== null ? `Day H ${fmtPrice(r.high)} · L ${fmtPrice(r.low)}` : undefined;
              return (
                <tr key={r.key} title={range} className="border-b border-zinc-800/60 last:border-0 hover:bg-zinc-800/30">
                  <TD><span className="text-zinc-200 font-semibold whitespace-nowrap">{r.name}</span></TD>
                  <TD right className={cn('tabular-nums transition-colors',
                    f === 'up' ? 'text-emerald-300' : f === 'down' ? 'text-red-300' : 'text-zinc-200')}>
                    {r.ltp !== null ? fmtPrice(r.ltp) : DASH}
                  </TD>
                  <TD right className={cn('tabular-nums',
                    r.change === null ? '' : r.change > 0 ? 'text-emerald-400' : r.change < 0 ? 'text-red-400' : 'text-zinc-500')}>
                    {r.change !== null ? `${r.change > 0 ? '+' : ''}${fmtPrice(r.change)}` : DASH}
                  </TD>
                  <TD right><PctPill v={r.changePct} /></TD>
                  {stocks && <TD right className="text-zinc-500 tabular-nums">{r.weight?.toFixed(2)}</TD>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {pull && (
        <div className="flex items-center justify-between px-3 py-1.5 border-t border-zinc-800 text-[11px] text-zinc-400"
          title="Sum of weight × change over these stocks: how much of NIFTY's % move they account for">
          <span>Weighted pull on NIFTY{pull.priced < rows.length ? ` (${pull.priced}/${rows.length} priced)` : ''}</span>
          <PctPill v={pull.pct} />
        </div>
      )}
    </div>
  );
}

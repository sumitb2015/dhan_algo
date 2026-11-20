'use client';

import { useMemo } from 'react';
import type { GbState, GhostTrade } from '@/lib/gearbox';
import { gbEvents } from '@/lib/gearboxBars';
import type { GbLog } from '@/lib/gearboxLedger';
import { istClock } from '@/lib/istTime';
import { cn } from '@/lib/utils';

// Trip log: one cell per closed bar (height = gear, colour = mode), then the event log — the road's events (mode changes, setups,
// shift-ups, the ghost's trades) merged with this ledger's own log lines (orders, refusals), newest first.

const CELLS = 75;
const GEAR: Record<1 | -1, string[]> = {
  1: ['bg-emerald-200', 'bg-emerald-300', 'bg-emerald-400', 'bg-emerald-600', 'bg-emerald-700'],
  [-1]: ['bg-red-200', 'bg-red-300', 'bg-red-400', 'bg-red-600', 'bg-red-700'],
};
const TONE: Record<string, string> = {
  info: 'text-zinc-300', good: 'text-emerald-400', bad: 'text-red-400', hot: 'text-orange-400 font-bold',
  warn: 'text-amber-400', error: 'text-red-400', trade: 'text-zinc-100 font-semibold',
};

export function TripLog({ states, ghost, log, tf }: { states: GbState[]; ghost: GhostTrade[]; log: GbLog[]; tf: number }) {
  const from = Math.max(0, states.length - CELLS);
  const s = states[states.length - 1];
  const lines = useMemo(() => {
    const road = gbEvents(states, ghost, from).map(e => ({ at: e.t * 1000, msg: e.msg, tone: e.tone }));
    const own = log.slice(-30).map(l => ({ at: l.at, msg: l.msg, tone: l.level }));
    return [...road, ...own].sort((a, b) => b.at - a.at).slice(0, 8);
  }, [states, ghost, from, log]);
  return (
    <div>
      <div className="flex justify-between text-xs text-zinc-400">
        <span>Trip log · gear by bar (last {CELLS} closed {tf}-min bars)</span>
        <span>{!s ? '' : s.mode === 0 ? 'N' : s.mode > 0 ? '▲ up' : '▼ down'}</span>
      </div>
      <div className="mt-1 flex h-10 items-end gap-0.5" data-testid="gb-cells">
        {states.slice(from).map(q => (
          <i key={q.t} title={`${istClock(q.t * 1000).slice(0, 5)} · gear ${q.gear || 'N'}`}
            className={cn('min-h-[3px] flex-1 rounded-t-sm', q.mode ? GEAR[q.mode][q.gear - 1] : 'bg-zinc-500')}
            style={{ height: `${q.mode ? q.gear * 20 : 12}%` }} />
        ))}
      </div>
      <ul className="mt-3 text-sm" data-testid="gb-events">
        {lines.map((l, i) => (
          <li key={`${l.at}-${i}`} className="border-t border-zinc-800 py-1">
            <em className="mr-2 not-italic tabular-nums text-zinc-500">{istClock(l.at).slice(0, 5)}</em>
            <span className={TONE[l.tone] ?? 'text-zinc-300'}>{l.msg}</span>
          </li>
        ))}
        {!lines.length && <li className="border-t border-zinc-800 py-1 text-zinc-500">No events yet</li>}
      </ul>
    </div>
  );
}

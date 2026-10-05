import React from 'react';

export type DeskTone = 'neutral' | 'up' | 'down';

export const deskTone = (n: number): 'up' | 'down' => (n >= 0 ? 'up' : 'down');

/** One figure in the Algo Desk command strip (shared by /strategies and /strategies-plus).
 *  Module scope on purpose: the pages re-render on a 2s poll, so a component defined inside
 *  a page would remount every tick. */
export default function DeskFigure({
  label, value, tone = 'neutral', hint, big,
}: {
  label: string; value: React.ReactNode; tone?: DeskTone; hint?: string; big?: boolean;
}) {
  return (
    <div className="flex flex-col justify-center gap-1 py-3 pr-8 mr-8 border-r border-zinc-800" title={hint}>
      <span className="text-xs text-zinc-400">{label}</span>
      <span className={`font-bold tabular-nums leading-none ${big ? 'text-2xl' : 'text-lg'} ${
        tone === 'up' ? 'text-emerald-400' : tone === 'down' ? 'text-red-400' : 'text-zinc-100'
      }`}>{value}</span>
    </div>
  );
}

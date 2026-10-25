'use client';

export type LogEntry = {
  id: string;
  /** Epoch seconds of the bar that broke the previous top / bottom. */
  t: number;
  strike: number;
  kind: 'DOUBLE_TOP_BUY' | 'DOUBLE_BOTTOM_SELL';
  price: number;
  belowVwap: boolean;
};

const hhmmss = (t: number) =>
  new Date((t + 5.5 * 3600) * 1000).toISOString().slice(11, 19);

export default function AlertLog({ entries }: { entries: LogEntry[] }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 w-full max-w-md">
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800">
        <h2 className="text-xs font-bold text-zinc-100">Alert log</h2>
        <span className="text-[10px] font-mono text-zinc-500">last {entries.length} of 30</span>
      </div>
      {entries.length === 0 ? (
        <p className="px-3 py-3 text-xs text-zinc-400">No alerts yet. Signals fire when a 1-min bar closes through the previous top or bottom.</p>
      ) : (
        <ul className="max-h-72 overflow-y-auto divide-y divide-zinc-800">
          {entries.map(e => {
            const sell = e.kind === 'DOUBLE_BOTTOM_SELL';
            return (
              <li key={e.id} data-testid="pnf-log-row" className="flex items-center gap-2 px-3 py-1.5 text-xs font-mono">
                <span className="text-zinc-400">{hhmmss(e.t)}</span>
                <span className="text-zinc-200">{e.strike}</span>
                <span className={sell ? 'text-red-400 font-bold' : 'text-emerald-400 font-bold'}>{sell ? 'DB sell' : 'DT buy'}</span>
                {sell && e.belowVwap && <span className="text-[10px] text-amber-300">entry zone</span>}
                <span className="ml-auto text-zinc-300">{e.price.toFixed(2)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

'use client';

import type { DashRow } from '@/lib/usDashboard';
import { pctText, signCls, usd } from './format';

function List({ title, rows }: { title: string; rows: DashRow[] }) {
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-[11px] font-bold uppercase tracking-wider text-zinc-300">{title}</h3>
      {rows.length === 0 && <p className="text-[11px] text-zinc-500 py-2">None yet.</p>}
      <ul className="flex flex-col">
        {rows.map(r => (
          <li key={r.id} className="flex items-center justify-between gap-2 py-1 border-t border-zinc-800 first:border-t-0 text-xs tabular-nums">
            <span className="min-w-0 flex flex-col leading-tight">
              <span className="font-bold text-zinc-100">{r.symbol}</span>
              <span className="text-[10px] text-zinc-500 truncate max-w-[9rem]">{r.name}</span>
            </span>
            <span className="text-zinc-300">{usd(r.ltp)}</span>
            <span className={signCls(r.changePct)}>{pctText(r.changePct)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Top gainers and losers among the universe's single stocks (ETFs excluded). */
export default function UsMovers({ gainers, losers }: { gainers: DashRow[]; losers: DashRow[] }) {
  return (
    <section className="flex flex-col gap-4 rounded-lg border border-zinc-800 bg-zinc-950 p-3" aria-label="Movers">
      <List title="Top gainers" rows={gainers} />
      <List title="Top losers" rows={losers} />
    </section>
  );
}

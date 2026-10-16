'use client';

import { cn } from '@/lib/utils';
import type { IndexLevel, DashRow } from '@/lib/usDashboard';
import { INDEX_PROXY_LABEL } from '@/lib/usUniverse';
import { pctText, signCls, usd } from './format';

interface Props {
  levels: IndexLevel[] | null;
  levelsError: string | null;
  levelsStale: boolean;
  proxies: DashRow[];
  macro: DashRow[];
  live: boolean;
}

function ProxyChip({ r, live }: { r: DashRow; live: boolean }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 min-w-0" title={r.name}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-bold text-zinc-100">{r.symbol}</span>
        <span className={cn('text-[11px] font-semibold tabular-nums', signCls(r.changePct))}>{pctText(r.changePct)}</span>
      </div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] text-zinc-500 truncate">{INDEX_PROXY_LABEL[r.symbol] ?? r.name}</span>
        <span className={cn('text-[10px] tabular-nums', live ? 'text-zinc-300' : 'text-zinc-500')}>{usd(r.ltp)}</span>
      </div>
    </div>
  );
}

/** Real index levels (Yahoo, delayed) above the live Dhan ETF proxies. The two are labelled apart: never mixed in one number. */
export default function IndexStrip({ levels, levelsError, levelsStale, proxies, macro, live }: Props) {
  return (
    <section className="flex flex-col gap-2" aria-label="US indices">
      <div className="flex items-center gap-2">
        <h2 className="text-[11px] font-bold uppercase tracking-wider text-zinc-300">Indices</h2>
        <span className="text-[10px] font-semibold text-zinc-500 px-1.5 py-0.5 rounded border border-zinc-800 bg-zinc-900"
          title="Index levels come from Yahoo Finance and can be delayed. They are not from Dhan.">Yahoo · delayed{levelsStale ? ' · stale' : ''}</span>
        {levelsError && <span className="text-[10px] text-amber-300">{levelsError}</span>}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-2">
        {(levels ?? []).map(l => (
          <div key={l.symbol} className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[11px] font-bold text-zinc-300">{l.name}</span>
              <span className="text-[10px] text-zinc-500">{l.symbol}</span>
            </div>
            <div className="mt-1 text-lg font-bold tabular-nums text-zinc-100 leading-none">{usd(l.price)}</div>
            <div className={cn('mt-1 text-[11px] font-semibold tabular-nums', signCls(l.change))}>
              {l.change == null ? '–' : `${l.change > 0 ? '+' : ''}${usd(l.change)}`} <span className="ml-1">{pctText(l.changePct)}</span>
            </div>
          </div>
        ))}
        {levels == null && !levelsError && Array.from({ length: 6 }, (_, i) => <div key={i} className="h-[74px] rounded-lg border border-zinc-800 bg-zinc-900 animate-pulse" />)}
      </div>
      <div className="flex items-center gap-2 mt-1">
        <h2 className="text-[11px] font-bold uppercase tracking-wider text-zinc-300">Index ETFs &amp; macro</h2>
        <span className="text-[10px] font-semibold text-zinc-500">Dhan feed{live ? ' · live' : ' · last saved'}</span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
        {proxies.map(r => <ProxyChip key={r.id} r={r} live={live} />)}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
        {macro.map(r => <ProxyChip key={r.id} r={r} live={live} />)}
      </div>
    </section>
  );
}

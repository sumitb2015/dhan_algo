'use client';

import { useEffect } from 'react';
import { cn } from '@/lib/utils';
import { useLiveTickerPoll, isStale, ageOf, ageLabel } from '@/lib/useLiveTickerPoll';
import { PctPill, fmtPrice } from '@/components/LiveTickerPanel';

interface Quote { ltp: number; change_pct: number | null }
interface IndicesResponse { updated_at?: string; quotes?: Record<string, Quote> }

// Module scope: useLiveTickerPoll needs a stable identity.
const pickLtps = (d: IndicesResponse): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const k of ['NIFTY', 'VIX']) {
    const v = d?.quotes?.[k]?.ltp;
    if (typeof v === 'number') out[k] = v;
  }
  return out;
};

function Chip({ label, q, flash, dim }: { label: string; q?: Quote; flash?: 'up' | 'down'; dim: boolean }) {
  const has = !!q && q.ltp > 0;
  return (
    <span className={cn(
      'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-zinc-900 border border-zinc-800 transition-colors',
      flash === 'up' && 'border-emerald-500/60', flash === 'down' && 'border-red-500/60', dim && 'opacity-60',
    )}>
      <span className="text-[10px] font-bold uppercase tracking-wide text-zinc-400">{label}</span>
      <span className="text-xs font-mono font-bold text-zinc-100 tabular-nums">{has ? fmtPrice(q!.ltp) : '—'}</span>
      {has && <PctPill v={q!.change_pct} />}
    </span>
  );
}

/** Nifty 50 and India VIX with % change vs the previous close, for the page header. Same feed as the
 *  Advanced Scalper's Top Indices (/api/scalper/top-indices); greyed with an age badge when it goes stale. */
export function HeaderIndexChips() {
  // Same idempotent start the Advanced Scalper does: the indices bridge feeds this route's NSE rows, and
  // without it the snapshot is yesterday's. Never stopped from here (other pages share it).
  useEffect(() => {
    fetch('/api/live-indices', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'start' }),
    }).catch(() => {});
  }, []);
  const { data, flash, now } = useLiveTickerPoll<IndicesResponse>('/api/scalper/top-indices', pickLtps);
  const tickMs = data?.updated_at ? new Date(data.updated_at).getTime() : NaN;
  const stale = !!data && isStale(tickMs, now);
  return (
    <div className="flex items-center gap-1.5" title={stale ? `Index feed is ${ageLabel(ageOf(tickMs, now))} old` : 'Live, vs previous close'}>
      <Chip label="Nifty" q={data?.quotes?.NIFTY} flash={flash.NIFTY} dim={stale} />
      <Chip label="VIX" q={data?.quotes?.VIX} flash={flash.VIX} dim={stale} />
      {stale && <span className="text-[10px] font-bold text-amber-300">{ageLabel(ageOf(tickMs, now))} old</span>}
    </div>
  );
}

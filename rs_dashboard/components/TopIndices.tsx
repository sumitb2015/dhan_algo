'use client';

// Compact live table of the 10 headline indices (Nifty, Bank Nifty, Sensex, the
// main sectorals and India VIX) with % change vs yesterday's close, for the
// Advanced Scalper page. Sits beside the Top 10 Weight panel: that one shows
// which heavyweight stocks are moving, this one shows which sectors are.
//
// Data comes from /api/scalper/top-indices, which pulls last_price + ohlc.close
// in one batched Dhan call (plus Kite for Sensex, which Dhan does not serve).
// See that route for why the live_indices_ws.py bridge is deliberately not used
// here — it has no prev_close, so it cannot express "% vs yesterday's close".

import React, { useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { useLiveTickerPoll, isStale, ageOf, ageLabel } from '@/lib/useLiveTickerPoll';
import { TickerPanel, TH, TD, PctPill, fmtPrice, DASH, type SortDir } from './LiveTickerPanel';

type SortKey = 'label' | 'ltp' | 'change_pct';
/** Column default direction on first click — text ascending, numbers descending. */
const DEFAULT_DIR: Record<SortKey, SortDir> = { label: 'asc', ltp: 'desc', change_pct: 'desc' };

interface IndexQuote {
  ltp: number;
  prev_close: number;
  change_pct: number | null;
  source: string;
}

interface IndicesResponse {
  success: boolean;
  updated_at: string;
  order: { key: string; label: string }[];
  quotes: Record<string, IndexQuote>;
  count: number;
  errors: string[];
}

interface Row {
  key: string;
  label: string;
  quote: IndexQuote | null;
}

// Module scope keeps this referentially stable, as useLiveTickerPoll requires.
function pickLtps(d: IndicesResponse): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, q] of Object.entries(d?.quotes ?? {})) {
    if (typeof q?.ltp === 'number') out[k] = q.ltp;
  }
  return out;
}

export default function TopIndices({ className }: { className?: string }) {
  const { data, flash, now } = useLiveTickerPoll<IndicesResponse>('/api/scalper/top-indices', pickLtps);

  const tickMs = data?.updated_at ? new Date(data.updated_at).getTime() : NaN;
  const stale = isStale(tickMs, now);
  const ageMs = ageOf(tickMs, now);

  // Defaults to % change, descending — the panel's original behavior — until
  // the user clicks a header.
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'change_pct', dir: 'desc' });
  const toggleSort = (key: SortKey) =>
    setSort(s => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: DEFAULT_DIR[key] }));

  const rows = useMemo<Row[]>(() => {
    // The route returns its definition order, so labels and membership live in
    // one place (the route) rather than being duplicated here.
    const order = data?.order ?? [];
    const quotes = data?.quotes ?? {};
    const joined: Row[] = order.map(o => ({ ...o, quote: quotes[o.key] ?? null }));
    const dirMul = sort.dir === 'asc' ? 1 : -1;
    const value = (r: Row): number | string | null => {
      switch (sort.key) {
        case 'label': return r.label;
        case 'ltp': return r.quote && r.quote.ltp > 0 ? r.quote.ltp : null;
        case 'change_pct': return r.quote?.change_pct ?? null;
      }
    };
    // Rows with no value for the sorted column sort last regardless of
    // direction — "unknown" is not "flat".
    return joined.sort((a, b) => {
      const av = value(a);
      const bv = value(b);
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      if (typeof av === 'string' && typeof bv === 'string') return dirMul * av.localeCompare(bv);
      return dirMul * ((av as number) - (bv as number));
    });
  }, [data, sort]);

  // This panel talks to a REST route rather than a background bridge, so there
  // is no process status to report.
  //
  // Freshness alone is NOT a sufficient health signal here, which is the subtle
  // part: the route stamps a fresh `updated_at` on every response even when both
  // upstream providers returned nothing, so a total outage would otherwise show
  // a green "live" dot above ten empty rows. Row count is therefore part of the
  // status: none at all is an ERROR, some missing is a WARN.
  const missing = data ? data.order.length - data.count : 0;
  const empty = !!data && data.count === 0;
  const status = !data ? 'STARTING'
    : stale ? 'STALE'
    : empty ? 'ERROR'
    : missing > 0 ? 'WARN'
    : 'LIVE';
  const statusLabel = !data
    ? 'loading…'
    : stale ? `STALE ${ageLabel(ageMs)}`
    : empty ? 'no data'
    : missing > 0 ? `${missing} missing`
    : new Date(data.updated_at).toLocaleTimeString('en-IN', { hour12: false });
  // Upstream failure detail is otherwise invisible — surface it on hover rather
  // than leaving the user to guess why rows are blank.
  const statusTitle = data?.errors?.length ? data.errors.join(' | ') : undefined;

  return (
    <TickerPanel
      title="Top 10 Indices"
      status={status}
      statusLabel={statusLabel}
      statusTitle={statusTitle}
      dimBody={stale}
      className={className}
      head={
        <tr>
          <TH sortDir={sort.key === 'label' ? sort.dir : null} onClick={() => toggleSort('label')}>Index</TH>
          <TH right sortDir={sort.key === 'ltp' ? sort.dir : null} onClick={() => toggleSort('ltp')}>LTP</TH>
          <TH right sortDir={sort.key === 'change_pct' ? sort.dir : null} onClick={() => toggleSort('change_pct')}>Chg%</TH>
        </tr>
      }
    >
      {rows.map(r => {
        const f = flash[r.key];
        return (
          <tr key={r.key} className="border-b border-zinc-800/60 last:border-0 hover:bg-zinc-800/30">
            <TD><span className="text-zinc-200 font-semibold whitespace-nowrap">{r.label}</span></TD>
            <TD right className={cn('tabular-nums transition-colors',
              f === 'up' ? 'text-emerald-300' : f === 'down' ? 'text-red-300' : 'text-zinc-300')}>
              {r.quote && r.quote.ltp > 0 ? fmtPrice(r.quote.ltp) : DASH}
            </TD>
            <TD right><PctPill v={r.quote?.change_pct ?? null} /></TD>
          </tr>
        );
      })}
    </TickerPanel>
  );
}

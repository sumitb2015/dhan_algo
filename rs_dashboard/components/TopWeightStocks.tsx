'use client';

// Compact live table of the 10 heaviest NIFTY constituents, for the Advanced
// Scalper page. These names carry ~53% of the index, so at a glance it answers
// "is the heavy stuff actually pulling the index my way?" without leaving the
// order-entry screen.
//
// Data comes from the existing equity bridge, which already computes % change
// against yesterday's close: scripts/tools/live_equity_ws.py streams all 50
// NIFTY constituents over Dhan's WebSocket and rewrites
// debug/live_equity_quotes.json every 2s, including prev_close/change/change_pct
// per symbol. GET /api/live-equity returns that verbatim, so there is no
// separate prev-close fetch and no recomputation here — we display the feed's
// own change_pct.

import React, { useMemo } from 'react';
import { cn } from '@/lib/utils';
import { NIFTY_TOP10_BY_WEIGHT } from '@/lib/nifty50';
import { useLiveTickerPoll, isStale, ageOf, ageLabel } from '@/lib/useLiveTickerPoll';
import { TickerPanel, TH, TD, PctPill, fmtPrice, DASH } from './LiveTickerPanel';

interface LiveQuote {
  ltp: number;
  open: number;
  high: number;
  low: number;
  prev_close: number;
  volume: number;
  change: number;
  change_pct: number;
}

interface EquityResponse {
  success: boolean;
  status?: { status?: 'STARTING' | 'RUNNING' | 'STOPPED' | 'ERROR'; pid?: number };
  quotes: { updated_at: string | null; count: number; quotes: Record<string, LiveQuote> };
}

interface Row {
  symbol: string;
  name: string;
  weight: number;
  /** null when the feed has no quote for this symbol yet (pre-open, or the
   *  bridge is still resolving security IDs) — rendered as a dash, never 0. */
  quote: LiveQuote | null;
}

// Module scope keeps this referentially stable, as useLiveTickerPoll requires —
// an inline arrow would rebuild the poll loop on every render.
function pickLtps(d: EquityResponse): Record<string, number> {
  const q = d?.quotes?.quotes ?? {};
  const out: Record<string, number> = {};
  for (const { symbol } of NIFTY_TOP10_BY_WEIGHT) {
    const ltp = q[symbol]?.ltp;
    if (typeof ltp === 'number') out[symbol] = ltp;
  }
  return out;
}

export default function TopWeightStocks({ className }: { className?: string }) {
  const { data, flash, now } = useLiveTickerPoll<EquityResponse>('/api/live-equity', pickLtps);

  const tickMs = data?.quotes?.updated_at ? new Date(data.quotes.updated_at).getTime() : NaN;
  const stale = isStale(tickMs, now);
  const ageMs = ageOf(tickMs, now);

  const rows = useMemo<Row[]>(() => {
    const q = data?.quotes?.quotes ?? {};
    const joined: Row[] = NIFTY_TOP10_BY_WEIGHT.map(w => ({ ...w, quote: q[w.symbol] ?? null }));
    // Live-sorted by % change, descending. Symbols without a quote sort last
    // rather than being treated as 0%, which would park them mid-table and
    // read as "flat" when the truth is "unknown".
    return joined.sort((a, b) => {
      const av = a.quote ? a.quote.change_pct : null;
      const bv = b.quote ? b.quote.change_pct : null;
      if (av === null && bv === null) return b.weight - a.weight;
      if (av === null) return 1;
      if (bv === null) return -1;
      return bv - av;
    });
  }, [data]);

  const rawStatus = data?.status?.status ?? 'STOPPED';
  // How many of our ten rows the feed can actually price. A bridge that is
  // RUNNING but has not resolved security ids yet (or has lost its
  // subscription) reports healthy while serving nothing, so an all-empty table
  // must not sit under a green "live" dot.
  const priced = data
    ? NIFTY_TOP10_BY_WEIGHT.filter(w => (data.quotes?.quotes?.[w.symbol]?.ltp ?? 0) > 0).length
    : 0;
  // Precedence: STOPPED is the most precise message and wins; then staleness;
  // then "running but serving nothing"; then a partial feed.
  const status = rawStatus === 'STOPPED' ? 'STOPPED'
    : stale ? 'STALE'
    : !data ? rawStatus
    : priced === 0 ? 'ERROR'
    : priced < NIFTY_TOP10_BY_WEIGHT.length ? 'WARN'
    : rawStatus;

  return (
    <TickerPanel
      title="Top 10 Weight"
      status={status}
      statusLabel={
        status === 'RUNNING' ? new Date(tickMs).toLocaleTimeString('en-IN', { hour12: false })
          : status === 'STARTING' ? 'starting…'
          : status === 'STALE' ? `STALE ${ageLabel(ageMs)}`
          : status === 'ERROR' ? 'no data'
          : status === 'WARN' ? `${NIFTY_TOP10_BY_WEIGHT.length - priced} missing`
          : status
      }
      dimBody={stale}
      className={className}
      head={<tr><TH>Stock</TH><TH right>LTP</TH><TH right>Chg%</TH><TH right>Wt%</TH></tr>}
    >
      {rows.map(r => {
        const f = flash[r.symbol];
        // prev_close of 0 would make any % meaningless — show unknown rather
        // than a fabricated 0.00%.
        const pct = r.quote && r.quote.prev_close > 0 ? r.quote.change_pct : null;
        return (
          <tr key={r.symbol} className="border-b border-zinc-800/60 last:border-0 hover:bg-zinc-800/30">
            <TD><span className="text-zinc-200 font-semibold">{r.name}</span></TD>
            <TD right className={cn('tabular-nums transition-colors',
              f === 'up' ? 'text-emerald-300' : f === 'down' ? 'text-red-300' : 'text-zinc-300')}>
              {r.quote && r.quote.ltp > 0 ? fmtPrice(r.quote.ltp) : DASH}
            </TD>
            <TD right><PctPill v={pct} /></TD>
            <TD right className="text-zinc-500 tabular-nums">{r.weight.toFixed(2)}</TD>
          </tr>
        );
      })}
    </TickerPanel>
  );
}

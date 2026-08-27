'use client';

import React from 'react';
import { AlertCircle, Loader2, Minus, Plus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { fmtPnl, pctColor } from './format';

function Metric({ label, value, cls = 'text-zinc-200' }: { label: string; value: string; cls?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">{label}</span>
      <span className={`text-xs font-semibold tabular-nums ${cls}`}>{value}</span>
    </div>
  );
}

/**
 * Full-width strip that replaces the old sticky "Trade Ticket" / "Crude P&L"
 * sidebar cards — two recessed clusters (ticket sizing, live P&L + Exit All)
 * in one row, so the chain below gets the full page width instead of
 * competing with a 360px rail.
 */
export default function TradeTicketBar({
  lots,
  lotSize,
  setLots,
  brokerLabel,
  loading,
  totalRealized,
  totalUnrealized,
  totalPnl,
  openCount,
  exitingAll,
  onExitAll,
}: {
  lots: number;
  lotSize: number;
  setLots: React.Dispatch<React.SetStateAction<number>>;
  brokerLabel: string;
  loading: boolean;
  totalRealized: number;
  totalUnrealized: number;
  totalPnl: number;
  openCount: number;
  exitingAll: boolean;
  onExitAll: () => void;
}) {
  return (
    <div className="flex flex-wrap items-stretch gap-3 rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2.5">
      {/* Ticket cluster */}
      <div className="flex flex-wrap items-center gap-4 rounded-lg border border-zinc-800/60 bg-zinc-950/40 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Lots</span>
          <div className="flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-950 p-0.5">
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Decrease lots"
              disabled={lots <= 1}
              onClick={() => setLots(prev => Math.max(1, prev - 1))}
            >
              <Minus />
            </Button>
            <span className="w-8 text-center text-sm font-bold tabular-nums text-zinc-100">{lots}</span>
            <Button size="icon-xs" variant="ghost" aria-label="Increase lots" onClick={() => setLots(prev => prev + 1)}>
              <Plus />
            </Button>
          </div>
        </div>
        <Separator orientation="vertical" className="h-8 bg-zinc-800" />
        <Metric label="Order Qty" value={`${lots * lotSize} qty`} />
        <Metric label="Routing" value={brokerLabel} />
      </div>

      {/* P&L cluster */}
      <div className="flex min-w-[280px] flex-1 flex-wrap items-center gap-4 rounded-lg border border-zinc-800/60 bg-zinc-950/40 px-3 py-2">
        {/* Loading and "confirmed zero" must never look identical — a slow first
            fetch showing "Open 0" reads as "no positions" when it may just not
            have loaded yet. */}
        <div className={`text-lg font-bold tabular-nums ${loading ? 'text-zinc-600' : pctColor(totalPnl)}`}>
          {loading ? '—' : fmtPnl(totalPnl)}
        </div>
        <Metric label="Realized"   value={loading ? '—' : fmtPnl(totalRealized)}   cls={loading ? 'text-zinc-600' : pctColor(totalRealized)} />
        <Metric label="Unrealized" value={loading ? '—' : fmtPnl(totalUnrealized)} cls={loading ? 'text-zinc-600' : pctColor(totalUnrealized)} />
        <Metric label="Open"       value={loading ? '—' : String(openCount)} />
        <Button
          variant="destructive"
          size="sm"
          className="ml-auto"
          disabled={exitingAll || openCount === 0}
          onClick={onExitAll}
        >
          {exitingAll ? <Loader2 className="animate-spin" /> : <AlertCircle />}
          Exit All ({openCount})
        </Button>
      </div>
    </div>
  );
}

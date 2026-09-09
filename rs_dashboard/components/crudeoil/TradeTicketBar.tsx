'use client';

import React from 'react';
import { AlertTriangle, Loader2, Minus, Plus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { fmtPnl, pctColor } from './format';

function Metric({
  label,
  value,
  cls = 'text-zinc-200',
}: {
  label: string;
  value: React.ReactNode;
  cls?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[9px] font-bold uppercase tracking-[0.16em] text-zinc-500 font-mono">{label}</span>
      <span className={`text-xs font-mono font-bold tabular-nums ${cls}`}>{value}</span>
    </div>
  );
}

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
    <div className="flex flex-wrap items-stretch justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-950/70 p-2.5 shadow-sm backdrop-blur">
      {/* Ticket Sizing Cluster */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-800/80 bg-zinc-900/60 px-3.5 py-2">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-400 font-mono">LOTS</span>
          <div className="flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-950 p-0.5">
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Decrease lots"
              disabled={lots <= 1}
              onClick={() => setLots(prev => Math.max(1, prev - 1))}
              className="text-zinc-400 hover:text-amber-400 hover:bg-zinc-800"
            >
              <Minus className="h-3 w-3" />
            </Button>
            <span className="w-8 text-center text-sm font-bold font-mono tabular-nums text-white">{lots}</span>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Increase lots"
              onClick={() => setLots(prev => prev + 1)}
              className="text-zinc-400 hover:text-amber-400 hover:bg-zinc-800"
            >
              <Plus className="h-3 w-3" />
            </Button>
          </div>
        </div>

        <div className="h-7 w-px bg-zinc-800" />

        <Metric
          label="ORDER QTY"
          value={<span className="text-zinc-200">{lots * lotSize} <span className="text-zinc-500 font-normal">BBL</span></span>}
        />

        <div className="h-7 w-px bg-zinc-800" />

        <Metric
          label="ROUTING"
          value={
            <span className="inline-flex items-center gap-1.5 text-amber-300">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              {brokerLabel.toUpperCase()}
            </span>
          }
        />
      </div>

      {/* P&L & Exit Cluster */}
      <div className="flex min-w-[280px] flex-1 flex-wrap items-center justify-between gap-4 rounded-lg border border-zinc-800/80 bg-zinc-900/60 px-3.5 py-2">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex flex-col">
            <span className="text-[9px] font-bold uppercase tracking-[0.16em] text-zinc-500 font-mono">NET MTM</span>
            <span className={`text-base font-bold font-mono tabular-nums leading-none mt-0.5 ${loading ? 'text-zinc-600' : pctColor(totalPnl)}`}>
              {loading ? '—' : fmtPnl(totalPnl)}
            </span>
          </div>

          <div className="h-7 w-px bg-zinc-800 hidden sm:block" />

          <Metric
            label="REALIZED"
            value={loading ? '—' : fmtPnl(totalRealized)}
            cls={loading ? 'text-zinc-600' : pctColor(totalRealized)}
          />
          <Metric
            label="UNREALIZED"
            value={loading ? '—' : fmtPnl(totalUnrealized)}
            cls={loading ? 'text-zinc-600' : pctColor(totalUnrealized)}
          />
          <Metric
            label="OPEN SCRIPS"
            value={loading ? '—' : `${openCount} POSITION${openCount === 1 ? '' : 'S'}`}
            cls={openCount > 0 ? 'text-amber-400' : 'text-zinc-400'}
          />
        </div>

        <Button
          variant="destructive"
          size="sm"
          disabled={exitingAll || openCount === 0}
          onClick={onExitAll}
          className="font-mono text-xs font-bold uppercase tracking-wider h-8 px-3 border border-red-500/40 bg-red-500/20 text-red-300 hover:bg-red-500/30 hover:border-red-400 transition-all cursor-pointer"
        >
          {exitingAll ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
          ) : (
            <AlertTriangle className="h-3.5 w-3.5 mr-1.5 text-red-400" />
          )}
          EXIT ALL ({openCount})
        </Button>
      </div>
    </div>
  );
}

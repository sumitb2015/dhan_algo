'use client';

import React from 'react';
import { cn } from '@/lib/utils';
import type { CoveredCallTradeRow } from '@/app/api/nifty-covered-call/state/route';

export interface LiveLegRow {
  id: string;
  leg: 'FUTURE' | 'CALL';
  strike?: number;
  side: 'BUY' | 'SELL';
  quantity: number;
  entryPrice: number;
  ltp: number | null;
  target: number | null;
  stopLoss: number | null;
  trailingSlFloor: number | null;
  livePnl: number;
}

function pnlClass(v: number) {
  return v > 0 ? 'text-emerald-400' : v < 0 ? 'text-rose-400' : 'text-zinc-300';
}

export default function TradeSheet({
  liveLegs,
  history,
}: {
  liveLegs: LiveLegRow[];
  history: CoveredCallTradeRow[];
}) {
  return (
    <div className="bg-zinc-950/40 border border-zinc-800/60 rounded-xl overflow-hidden">
      <div className="px-3 py-2 text-xs font-bold text-zinc-100 uppercase tracking-wide border-b border-zinc-800/60">
        Trade Sheet
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-xs font-bold text-white bg-zinc-800">
              <th className="px-2 py-1.5 text-left">Leg</th>
              <th className="px-2 py-1.5 text-left">Side</th>
              <th className="px-2 py-1.5 text-right">Qty</th>
              <th className="px-2 py-1.5 text-right">Entry</th>
              <th className="px-2 py-1.5 text-right">LTP</th>
              <th className="px-2 py-1.5 text-right">Target</th>
              <th className="px-2 py-1.5 text-right">SL</th>
              <th className="px-2 py-1.5 text-right">Trail Floor</th>
              <th className="px-2 py-1.5 text-right">Live P&amp;L</th>
            </tr>
          </thead>
          <tbody>
            {liveLegs.length === 0 && (
              <tr>
                <td colSpan={9} className="px-2 py-4 text-center text-zinc-500">
                  No open legs
                </td>
              </tr>
            )}
            {liveLegs.map((row, i) => (
              <tr key={row.id} className={cn('border-t border-zinc-800/60', i % 2 === 1 && 'bg-zinc-900/20')}>
                <td className="px-2 py-1.5 text-zinc-200">
                  {row.leg === 'FUTURE' ? 'NIFTY FUT' : `${row.strike} CE`}
                </td>
                <td className={cn('px-2 py-1.5 font-bold', row.side === 'SELL' ? 'text-rose-400' : 'text-emerald-400')}>
                  {row.side}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums text-zinc-300">{row.quantity}</td>
                <td className="px-2 py-1.5 text-right tabular-nums text-zinc-300">{row.entryPrice.toFixed(2)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums text-zinc-300">{row.ltp?.toFixed(2) ?? '—'}</td>
                <td className="px-2 py-1.5 text-right tabular-nums text-zinc-400">{row.target?.toFixed(2) ?? '—'}</td>
                <td className="px-2 py-1.5 text-right tabular-nums text-zinc-400">{row.stopLoss?.toFixed(2) ?? '—'}</td>
                <td className="px-2 py-1.5 text-right tabular-nums text-zinc-400">{row.trailingSlFloor?.toFixed(2) ?? '—'}</td>
                <td className={cn('px-2 py-1.5 text-right tabular-nums font-bold', pnlClass(row.livePnl))}>
                  {row.livePnl.toFixed(0)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="px-3 py-2 text-xs font-bold text-zinc-100 uppercase tracking-wide border-t border-zinc-800/60">
        History
      </div>
      <div className="overflow-x-auto max-h-64 overflow-y-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-xs font-bold text-white bg-zinc-800 sticky top-0">
              <th className="px-2 py-1.5 text-left">Time</th>
              <th className="px-2 py-1.5 text-left">Leg</th>
              <th className="px-2 py-1.5 text-left">Action</th>
              <th className="px-2 py-1.5 text-left">Side</th>
              <th className="px-2 py-1.5 text-right">Qty</th>
              <th className="px-2 py-1.5 text-right">Price</th>
              <th className="px-2 py-1.5 text-right">Realized P&amp;L</th>
            </tr>
          </thead>
          <tbody>
            {history.length === 0 && (
              <tr>
                <td colSpan={7} className="px-2 py-4 text-center text-zinc-500">
                  No trades logged yet
                </td>
              </tr>
            )}
            {[...history].reverse().map((t, i) => (
              <tr key={t.id} className={cn('border-t border-zinc-800/60', i % 2 === 1 && 'bg-zinc-900/20')}>
                <td className="px-2 py-1.5 text-zinc-400">{new Date(t.ts).toLocaleTimeString('en-IN', { hour12: false })}</td>
                <td className="px-2 py-1.5 text-zinc-200">{t.leg === 'FUTURE' ? 'NIFTY FUT' : `${t.strike ?? ''} CE`}</td>
                <td className="px-2 py-1.5 text-zinc-300">{t.action}</td>
                <td className={cn('px-2 py-1.5 font-bold', t.side === 'SELL' ? 'text-rose-400' : 'text-emerald-400')}>{t.side}</td>
                <td className="px-2 py-1.5 text-right tabular-nums text-zinc-300">{t.quantity}</td>
                <td className="px-2 py-1.5 text-right tabular-nums text-zinc-300">{t.price.toFixed(2)}</td>
                <td className={cn('px-2 py-1.5 text-right tabular-nums font-bold', t.realizedPnl != null ? pnlClass(t.realizedPnl) : 'text-zinc-600')}>
                  {t.realizedPnl != null ? t.realizedPnl.toFixed(0) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

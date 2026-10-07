'use client';

import React from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { TradeSummary } from '@/lib/coveredCallEngine';

const fmtInt = (v: number) => Math.round(v).toLocaleString('en-IN');
const signed = (v: number) => `${v >= 0 ? '+' : '−'}₹${fmtInt(Math.abs(v))}`;
const tone = (v: number | null) => (v == null ? 'text-zinc-600' : v > 0 ? 'text-emerald-400' : v < 0 ? 'text-rose-400' : 'text-zinc-300');
const dateOf = (ts: number) => new Date(ts).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit', timeZone: 'Asia/Kolkata' });
const TH = 'px-3 py-2 text-xs font-bold text-white bg-zinc-800 whitespace-nowrap';
const STATUS_CLS: Record<string, string> = {
  OPEN: 'border-cyan-500/40 bg-cyan-500/10 text-cyan-400',
  PARTIAL: 'border-amber-500/40 bg-amber-500/10 text-amber-400',
  CLOSED: 'border-zinc-700 bg-zinc-800/60 text-zinc-400',
  'CLOSE-ONLY': 'border-zinc-700 bg-zinc-800/60 text-zinc-400',
};

/** Every call written against NIFTYBEES on this desk, with its buy-backs and P&L. Read-only. */
export default function TradesPnlModal({ isOpen, onClose, summary }: { isOpen: boolean; onClose: () => void; summary: TradeSummary }) {
  if (!isOpen) return null;
  const { rows } = summary;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-5 bg-oncolor-dark/70 backdrop-blur-sm" onClick={onClose}>
      <div
        role="dialog"
        aria-label="Covered call trades P&L"
        className="relative w-full max-w-5xl max-h-[88vh] flex flex-col bg-zinc-950 border border-zinc-700/80 rounded-2xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-800 bg-zinc-900/90 shrink-0">
          <div>
            <h2 className="text-sm font-bold text-zinc-100">Calls written against NIFTYBEES</h2>
            <p className="text-xs text-zinc-500">{rows.length} trade{rows.length === 1 ? '' : 's'} on this desk · open legs marked to the live premium</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 px-5 py-3 border-b border-zinc-800">
          {[
            ['Total P&L', summary.total, true],
            ['Realised', summary.realized, true],
            ['Open MTM', summary.openMtm, true],
          ].map(([l, v, s]) => (
            <div key={l as string}>
              <div className="text-[10px] uppercase font-bold tracking-wide text-zinc-500">{l as string}</div>
              <div className={cn('font-mono text-base font-bold', tone(v as number))}>{s ? signed(v as number) : fmtInt(v as number)}</div>
            </div>
          ))}
          <div>
            <div className="text-[10px] uppercase font-bold tracking-wide text-zinc-500">Win rate (closed)</div>
            <div className="font-mono text-base font-bold text-zinc-100">{summary.closedCount ? `${summary.wins}/${summary.closedCount}` : '—'}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase font-bold tracking-wide text-zinc-500">Avg days held (closed)</div>
            <div className="font-mono text-base font-bold text-zinc-100">{summary.avgDaysClosed != null ? summary.avgDaysClosed.toFixed(1) : '—'}</div>
          </div>
        </div>

        <div className="overflow-auto">
          {rows.length === 0 ? (
            <p className="px-5 py-10 text-sm text-zinc-500 text-center">No calls written on this desk yet.</p>
          ) : (
            <table className="w-full text-xs font-mono">
              <thead className="sticky top-0">
                <tr>
                  <th className={cn(TH, 'text-left')}>Sold</th>
                  <th className={cn(TH, 'text-left')}>Contract</th>
                  <th className={cn(TH, 'text-right')}>Units</th>
                  <th className={cn(TH, 'text-right')}>Sold at</th>
                  <th className={cn(TH, 'text-right')}>Bought back</th>
                  <th className={cn(TH, 'text-right')}>Days</th>
                  <th className={cn(TH, 'text-right')}>Realised</th>
                  <th className={cn(TH, 'text-right')}>Open MTM</th>
                  <th className={cn(TH, 'text-right')}>P&L</th>
                  <th className={cn(TH, 'text-center')}>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t border-zinc-800/70 hover:bg-zinc-900/60">
                    <td className="px-3 py-2 text-zinc-300 whitespace-nowrap">{dateOf(r.ts)}</td>
                    <td className="px-3 py-2 text-zinc-100 whitespace-nowrap">{r.strike} CE · {r.expiry}</td>
                    <td className="px-3 py-2 text-right text-zinc-300">{fmtInt(r.units)}{r.openUnits > 0 && r.openUnits < r.units ? ` (${fmtInt(r.openUnits)} open)` : ''}</td>
                    <td className="px-3 py-2 text-right text-zinc-300">{r.entryPrice > 0 ? r.entryPrice.toFixed(2) : '—'}</td>
                    <td className="px-3 py-2 text-right text-zinc-300">{r.exitPrice != null ? r.exitPrice.toFixed(2) : '—'}</td>
                    <td className="px-3 py-2 text-right text-zinc-400">{r.status === 'CLOSE-ONLY' ? '—' : r.daysHeld.toFixed(1)}</td>
                    <td className={cn('px-3 py-2 text-right', tone(r.closedUnits > 0 ? r.realized : null))}>{r.closedUnits > 0 ? signed(r.realized) : '—'}</td>
                    <td className={cn('px-3 py-2 text-right', tone(r.openMtm))}>{r.openMtm != null ? signed(r.openMtm) : r.openUnits > 0 ? 'unpriced' : '—'}</td>
                    <td className={cn('px-3 py-2 text-right font-bold', tone(r.total))}>{signed(r.total)}</td>
                    <td className="px-3 py-2 text-center">
                      <span className={cn('inline-flex px-2 py-0.5 rounded-full text-[10px] font-bold border', STATUS_CLS[r.status])}>{r.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <p className="px-5 py-2 text-[11px] text-zinc-500 border-t border-zinc-800">
          Option P&L only, before brokerage and taxes. Rows come from the desk ledger, so calls placed outside this tool appear only after Sync or Adopt.
        </p>
      </div>
    </div>
  );
}

'use client';

import React from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import type { CallTrade } from '@/lib/coveredCallEngine';

export interface OpenCallRow {
  id: string;
  strike: number;
  expiry: string;
  dte: number;
  units: number;
  /** Units the ledger holds before the down-only broker reconcile. */
  ledgerUnits: number;
  entryPrice: number;
  ltp: number | null;
  mtm: number | null;
  delta: number | null;
  theta: number | null;
  deltaEstimated: boolean;
}

function pnlClass(v: number | null | undefined) {
  return v == null ? 'text-zinc-600' : v > 0 ? 'text-emerald-400' : v < 0 ? 'text-rose-400' : 'text-zinc-300';
}
const fmt0 = (v: number | null | undefined) => (v == null ? '—' : Math.round(v).toLocaleString('en-IN'));

const TH = 'px-2 py-1.5 text-xs font-bold text-white';

export default function TradeSheet({
  rows,
  history,
  lotSize,
  busy,
  rollTarget,
  onBuyBack,
  onRoll,
  onSyncLedger,
}: {
  rows: OpenCallRow[];
  history: CallTrade[];
  lotSize: number;
  busy: boolean;
  rollTarget: { strike: number; expiry: string } | null;
  onBuyBack: (row: OpenCallRow) => void;
  onRoll: (row: OpenCallRow) => void;
  onSyncLedger: (row: OpenCallRow) => void;
}) {
  return (
    <div className="bg-zinc-950/40 border border-zinc-800/60 rounded-xl overflow-hidden">
      <div className="px-3 py-2 text-xs font-bold text-zinc-100 uppercase tracking-wide border-b border-zinc-800/60">
        Calls Written
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-zinc-800">
              <th className={cn(TH, 'text-left')}>Contract</th>
              <th className={cn(TH, 'text-right')}>DTE</th>
              <th className={cn(TH, 'text-right')}>Units</th>
              <th className={cn(TH, 'text-right')}>Sold @</th>
              <th className={cn(TH, 'text-right')}>LTP</th>
              <th className={cn(TH, 'text-right')}>Decay</th>
              <th className={cn(TH, 'text-right')}>MTM ₹</th>
              <th className={cn(TH, 'text-right')}>Δ</th>
              <th className={cn(TH, 'text-right')}>Θ ₹/day</th>
              <th className={cn(TH, 'text-right')}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={10} className="px-2 py-4 text-center text-zinc-500">
                  No calls written from this desk — use Write Call, or Adopt an existing short below.
                </td>
              </tr>
            )}
            {rows.map((r, i) => {
              const decay = r.ltp != null && r.entryPrice > 0 ? (1 - r.ltp / r.entryPrice) * 100 : null;
              const drift = r.units < r.ledgerUnits;
              return (
                <tr key={r.id} className={cn('border-t border-zinc-800/60', i % 2 === 1 && 'bg-zinc-900/20')}>
                  <td className="px-2 py-1.5 text-zinc-200 font-mono whitespace-nowrap">
                    {r.strike} CE <span className="text-zinc-500">{r.expiry}</span>
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-zinc-300">{r.dte.toFixed(1)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-zinc-300 whitespace-nowrap">
                    {r.units}
                    {lotSize > 0 && <span className="text-zinc-500"> ({(r.units / lotSize).toFixed(r.units % lotSize ? 2 : 0)}L)</span>}
                    {drift && (
                      <span className="ml-1 text-amber-300" title={`Ledger holds ${r.ledgerUnits}; broker shows only ${r.units} short`}>
                        ⚠ {r.ledgerUnits}
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-zinc-300">{r.entryPrice.toFixed(2)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-zinc-300">{r.ltp?.toFixed(2) ?? '—'}</td>
                  <td className={cn('px-2 py-1.5 text-right tabular-nums', pnlClass(decay))}>{decay == null ? '—' : `${decay.toFixed(0)}%`}</td>
                  <td className={cn('px-2 py-1.5 text-right tabular-nums font-bold', pnlClass(r.mtm))}>{fmt0(r.mtm)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-zinc-300" title={r.deltaEstimated ? 'Black-Scholes estimate — chain had no Greeks' : undefined}>
                    {r.delta == null ? '—' : r.delta.toFixed(2)}{r.deltaEstimated && <span className="text-amber-300">*</span>}
                  </td>
                  <td className={cn('px-2 py-1.5 text-right tabular-nums', pnlClass(r.theta))}>{fmt0(r.theta)}</td>
                  <td className="px-2 py-1.5 text-right whitespace-nowrap">
                    <div className="inline-flex gap-1">
                      {drift && (
                        <Button size="xs" variant="outline" disabled={busy} onClick={() => onSyncLedger(r)}
                          className="bg-amber-500/20 border-amber-500/40 text-amber-300 font-bold hover:bg-amber-500/30 hover:text-amber-200">
                          SYNC
                        </Button>
                      )}
                      {rollTarget && r.units > 0 && (rollTarget.strike !== r.strike || rollTarget.expiry !== r.expiry) && (
                        <Button size="xs" variant="outline" disabled={busy} onClick={() => onRoll(r)}
                          title="Buy this call back, then write the Write Call panel's strike/expiry for the same units"
                          className="bg-sky-500/20 border-sky-500/40 text-sky-300 font-bold hover:bg-sky-500/30 hover:text-sky-200">
                          ROLL → {rollTarget.strike}
                        </Button>
                      )}
                      {r.units > 0 && (
                        <Button size="xs" variant="outline" disabled={busy} onClick={() => onBuyBack(r)}
                          className="bg-emerald-500/20 border-emerald-500/40 text-emerald-300 font-bold hover:bg-emerald-500/30 hover:text-emerald-200">
                          BUY BACK
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="px-3 py-2 text-xs font-bold text-zinc-100 uppercase tracking-wide border-t border-zinc-800/60">
        Call Ledger
      </div>
      <div className="overflow-x-auto max-h-64 overflow-y-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-zinc-800 sticky top-0">
              <th className={cn(TH, 'text-left')}>Time</th>
              <th className={cn(TH, 'text-left')}>Contract</th>
              <th className={cn(TH, 'text-left')}>Action</th>
              <th className={cn(TH, 'text-right')}>Units</th>
              <th className={cn(TH, 'text-right')}>Price</th>
              <th className={cn(TH, 'text-right')}>Realized ₹</th>
              <th className={cn(TH, 'text-left')}>Note</th>
            </tr>
          </thead>
          <tbody>
            {history.length === 0 && (
              <tr>
                <td colSpan={7} className="px-2 py-4 text-center text-zinc-500">No call trades logged yet</td>
              </tr>
            )}
            {[...history].reverse().map((t, i) => (
              <tr key={t.id} className={cn('border-t border-zinc-800/60', i % 2 === 1 && 'bg-zinc-900/20')}>
                <td className="px-2 py-1.5 text-zinc-400 whitespace-nowrap">
                  {new Date(t.ts).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })}
                </td>
                <td className="px-2 py-1.5 text-zinc-200 font-mono whitespace-nowrap">{t.strike} CE <span className="text-zinc-500">{t.expiry}</span></td>
                <td className={cn('px-2 py-1.5 font-bold', t.action === 'BUY_CLOSE' ? 'text-emerald-400' : 'text-rose-400')}>
                  {t.action === 'SELL_OPEN' ? 'SELL' : t.action === 'BUY_CLOSE' ? 'BUY BACK' : 'ADOPT'}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums text-zinc-300">{t.units}</td>
                <td className="px-2 py-1.5 text-right tabular-nums text-zinc-300">{t.price.toFixed(2)}</td>
                <td className={cn('px-2 py-1.5 text-right tabular-nums font-bold', pnlClass(t.realizedPnl))}>{fmt0(t.realizedPnl)}</td>
                <td className="px-2 py-1.5 text-zinc-500 truncate max-w-[220px]" title={t.note}>{t.note ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

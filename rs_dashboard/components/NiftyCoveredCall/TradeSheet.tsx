'use client';

import React, { useState } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Layers, History, ArrowRightLeft, CheckCircle2 } from 'lucide-react';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
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

const TH = 'px-3 py-2 text-xs font-bold text-white';

function HeaderTip({ label, tip, align = 'left' }: { label: string; tip: string; align?: 'left' | 'right' | 'center' }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className={cn('cursor-help inline-flex items-center gap-0.5 border-b border-dotted border-zinc-600 hover:border-zinc-300 transition-colors', align === 'right' && 'justify-end')}>
            {label}
          </span>
        }
      />
      <TooltipContent className="max-w-xs text-xs p-2 bg-zinc-900 border border-zinc-700 text-zinc-200 shadow-xl rounded-lg leading-relaxed z-50">
        {tip}
      </TooltipContent>
    </Tooltip>
  );
}

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
  rollTarget: { strike: number; expiry: string; basis: string } | null;
  onBuyBack: (row: OpenCallRow) => void;
  onRoll: (row: OpenCallRow) => void;
  onSyncLedger: (row: OpenCallRow) => void;
}) {
  const [activeTab, setActiveTab] = useState<'open' | 'history'>('open');

  return (
    <div className="bg-zinc-950/40 border border-zinc-800/60 rounded-xl overflow-hidden shadow-sm">
      {/* Tab Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800 bg-zinc-900/40">
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setActiveTab('open')}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-bold transition-all',
              activeTab === 'open'
                ? 'bg-zinc-800 text-white shadow-sm border border-zinc-700'
                : 'text-zinc-400 hover:text-zinc-200'
            )}
          >
            <Layers className="w-3.5 h-3.5 text-emerald-400" />
            Active Covered Calls
            <span className={cn(
              'px-1.5 py-0.2 rounded-full text-[10px] font-mono',
              rows.length > 0 ? 'bg-emerald-500/20 text-emerald-300' : 'bg-zinc-800 text-zinc-500'
            )}>
              {rows.length}
            </span>
          </button>

          <button
            onClick={() => setActiveTab('history')}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-bold transition-all',
              activeTab === 'history'
                ? 'bg-zinc-800 text-white shadow-sm border border-zinc-700'
                : 'text-zinc-400 hover:text-zinc-200'
            )}
          >
            <History className="w-3.5 h-3.5 text-zinc-400" />
            Trade History &amp; Fills
            <span className="px-1.5 py-0.2 rounded-full text-[10px] font-mono bg-zinc-800 text-zinc-400">
              {history.length}
            </span>
          </button>
        </div>

        {activeTab === 'open' && rows.length > 0 && (
          <span className="text-[11px] text-zinc-500 hidden sm:inline">
            Rule of thumb: buy back or roll when decay reaches ~75%–80%
          </span>
        )}
      </div>

      {/* Tab: Open Calls */}
      {activeTab === 'open' && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-zinc-800">
                <th className={cn(TH, 'text-left')}><HeaderTip label="Contract" tip="NIFTY Call option strike and expiry date." /></th>
                <th className={cn(TH, 'text-right')}><HeaderTip label="DTE" tip="Calendar days remaining until contract expiry." align="right" /></th>
                <th className={cn(TH, 'text-right')}><HeaderTip label="Lots / Units" tip="Number of lots and total option units short in this contract." align="right" /></th>
                <th className={cn(TH, 'text-right')}><HeaderTip label="Sold @" tip="Average execution price at which you wrote/sold the call." align="right" /></th>
                <th className={cn(TH, 'text-right')}><HeaderTip label="Premium Sold" tip="Total premium collected in rupees: Sold @ price × units short." align="right" /></th>
                <th className={cn(TH, 'text-right')}><HeaderTip label="Current LTP" tip="Last traded price of the call in the market right now." align="right" /></th>
                <th className={cn(TH, 'text-center')}><HeaderTip label="Decay Progress" tip="Percentage of initial premium collected that has decayed into profit. Best practice is to Buy Back or Roll when decay reaches 70%–80%." align="center" /></th>
                <th className={cn(TH, 'text-right')}><HeaderTip label="MTM P&amp;L" tip="Unrealized profit/loss on this specific call leg: (Sold Price − Current LTP) × Units." align="right" /></th>
                <th className={cn(TH, 'text-right')}><HeaderTip label="Net Δ / Θ" tip="Delta (exposure to 1-pt Nifty move) and Daily Theta (time decay earned per day in ₹)." align="right" /></th>
                <th className={cn(TH, 'text-right')}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-4 py-8 text-center text-zinc-500">
                    <div className="flex flex-col items-center justify-center gap-2 max-w-sm mx-auto">
                      <div className="w-8 h-8 rounded-full bg-zinc-900 flex items-center justify-center text-zinc-600">
                        <Layers className="w-4 h-4" />
                      </div>
                      <div className="text-zinc-300 font-bold">No Active Covered Calls</div>
                      <div className="text-[11px] text-zinc-500">
                        Select a recommended strike on the right and click <b>Sell Call</b> to earn upfront premium against your NIFTYBEES.
                      </div>
                    </div>
                  </td>
                </tr>
              )}
              {rows.map((r, i) => {
                const decay = r.ltp != null && r.entryPrice > 0 ? (1 - r.ltp / r.entryPrice) * 100 : null;
                const drift = r.units < r.ledgerUnits;
                const lotsCount = lotSize > 0 ? (r.units / lotSize) : 0;
                const isHighDecay = decay != null && decay >= 75;

                return (
                  <tr key={r.id} className={cn('border-t border-zinc-800/60 transition-colors hover:bg-zinc-900/30', i % 2 === 1 && 'bg-zinc-900/15')}>
                    <td className="px-3 py-2.5 text-zinc-100 font-mono whitespace-nowrap">
                      <div className="font-bold text-sm text-emerald-400">{r.strike} CE</div>
                      <div className="text-[10px] text-zinc-500">{r.expiry}</div>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-zinc-300 font-mono">
                      {r.dte.toFixed(1)} <span className="text-[10px] text-zinc-500">days</span>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-zinc-200 whitespace-nowrap font-mono">
                      <span className="font-bold text-zinc-100">{lotsCount.toFixed(r.units % lotSize ? 2 : 0)} L</span>
                      <span className="text-zinc-500 text-[10px] ml-1">({r.units}u)</span>
                      {drift && (
                        <span className="ml-1 text-amber-300" title={`Ledger holds ${r.ledgerUnits}; broker shows only ${r.units} short`}>
                          ⚠ {r.ledgerUnits}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-zinc-300 font-mono">₹{r.entryPrice.toFixed(2)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-emerald-400 font-mono font-bold">₹{fmt0(r.entryPrice * r.units)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums font-bold text-zinc-100 font-mono">{r.ltp != null ? `₹${r.ltp.toFixed(2)}` : '—'}</td>
                    <td className="px-3 py-2.5 text-center">
                      {decay == null ? (
                        <span className="text-zinc-600">—</span>
                      ) : (
                        <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-mono font-bold"
                          style={{
                            backgroundColor: decay >= 75 ? 'rgba(16, 185, 129, 0.15)' : decay >= 40 ? 'rgba(16, 185, 129, 0.08)' : 'rgba(244, 63, 94, 0.1)',
                            color: decay >= 75 ? '#34d399' : decay >= 40 ? '#10b981' : '#f87171',
                          }}
                        >
                          {isHighDecay && <CheckCircle2 className="w-3 h-3 text-emerald-400" />}
                          {decay >= 0 ? `${decay.toFixed(0)}% Decayed` : `${Math.abs(decay).toFixed(0)}% Expanded`}
                        </div>
                      )}
                    </td>
                    <td className={cn('px-3 py-2.5 text-right tabular-nums font-mono font-bold text-sm', pnlClass(r.mtm))}>
                      {r.mtm != null ? `${r.mtm >= 0 ? '+' : '−'}₹${fmt0(Math.abs(r.mtm))}` : '—'}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-zinc-400 font-mono text-[11px]">
                      <div>Δ {r.delta == null ? '—' : r.delta.toFixed(2)}{r.deltaEstimated && <span className="text-amber-300">*</span>}</div>
                      <div className="text-emerald-400">+{fmt0(r.theta)}/d</div>
                    </td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap">
                      <div className="inline-flex gap-1.5">
                        {drift && (
                          <Button size="xs" variant="outline" disabled={busy} onClick={() => onSyncLedger(r)}
                            className="bg-amber-500/20 border-amber-500/40 text-amber-300 font-bold hover:bg-amber-500/30">
                            SYNC
                          </Button>
                        )}
                        {rollTarget && r.units > 0 && (rollTarget.strike !== r.strike || rollTarget.expiry !== r.expiry) && (
                          <Button size="xs" variant="outline" disabled={busy} onClick={() => onRoll(r)}
                            title={`Buy this call back, then sell ${rollTarget.strike} CE ${rollTarget.expiry} — ${rollTarget.basis}. Change it in Write Covered Call.`}
                            className="bg-sky-500/20 border-sky-500/40 text-sky-300 font-bold hover:bg-sky-500/30">
                            <ArrowRightLeft className="w-3 h-3 mr-1" /> ROLL → {rollTarget.strike}
                          </Button>
                        )}
                        {r.units > 0 && (
                          <Button size="xs" variant="outline" disabled={busy} onClick={() => onBuyBack(r)}
                            className="bg-emerald-500/20 border-emerald-500/40 text-emerald-300 font-bold hover:bg-emerald-500/30 hover:text-emerald-100">
                            BUY BACK
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            {rows.length > 1 && (
              <tfoot>
                <tr className="border-t border-zinc-700 bg-zinc-900/40 font-mono font-bold">
                  <td className="px-3 py-2 text-zinc-300" colSpan={4}>Total</td>
                  <td className="px-3 py-2 text-right tabular-nums text-emerald-400">₹{fmt0(rows.reduce((a, r) => a + r.entryPrice * r.units, 0))}</td>
                  <td colSpan={5} />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}

      {/* Tab: History */}
      {activeTab === 'history' && (
        <div className="overflow-x-auto max-h-80 overflow-y-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-zinc-800 sticky top-0">
                <th className={cn(TH, 'text-left')}>Timestamp</th>
                <th className={cn(TH, 'text-left')}>Contract</th>
                <th className={cn(TH, 'text-left')}>Action</th>
                <th className={cn(TH, 'text-right')}>Units</th>
                <th className={cn(TH, 'text-right')}>Price</th>
                <th className={cn(TH, 'text-right')}>Realized P&amp;L</th>
                <th className={cn(TH, 'text-left')}>Notes</th>
              </tr>
            </thead>
            <tbody>
              {history.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-zinc-500">
                    No closed call trades logged yet
                  </td>
                </tr>
              )}
              {[...history].reverse().map((t, i) => (
                <tr key={t.id} className={cn('border-t border-zinc-800/60 font-mono', i % 2 === 1 && 'bg-zinc-900/20')}>
                  <td className="px-3 py-2 text-zinc-400 whitespace-nowrap">
                    {new Date(t.ts).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })}
                  </td>
                  <td className="px-3 py-2 text-zinc-200 whitespace-nowrap font-bold">
                    {t.strike} CE <span className="text-zinc-500 text-[10px] font-normal">{t.expiry}</span>
                  </td>
                  <td className="px-3 py-2 font-bold">
                    <span className={cn(
                      'px-1.5 py-0.5 rounded text-[10px]',
                      t.action === 'BUY_CLOSE' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-rose-500/15 text-rose-400'
                    )}>
                      {t.action === 'SELL_OPEN' ? 'SELL' : t.action === 'BUY_CLOSE' ? 'BUY BACK' : 'ADOPT'}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-300">{t.units}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-300">₹{t.price.toFixed(2)}</td>
                  <td className={cn('px-3 py-2 text-right tabular-nums font-bold', pnlClass(t.realizedPnl))}>
                    {t.realizedPnl != null ? `${t.realizedPnl >= 0 ? '+' : '−'}₹${fmt0(Math.abs(t.realizedPnl))}` : '—'}
                  </td>
                  <td className="px-3 py-2 text-zinc-500 truncate max-w-[200px]" title={t.note}>{t.note ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

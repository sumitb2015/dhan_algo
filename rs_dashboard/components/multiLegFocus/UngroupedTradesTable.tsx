'use client';

import React from 'react';
import { AlertTriangle } from 'lucide-react';
import {
  legPnl, legAvgPrice, legQtyUnits, formatExpiryLabel, crudeQtyMultiplier,
  type MultiLegBasket, type MultiLegLeg, type LegQtyWarning,
} from '@/lib/multiLegFocus';
import { BROKER_LABELS, type Broker } from '@/hooks/useBrokerSelector';
import { FOCUS_RING } from '@/components/Scalper';
import { TagCell } from './MultiLegLegRow';

/** One ungrouped trade: a one-leg basket with no name (see isLooseTrade). */
export interface UngroupedTrade { basket: MultiLegBasket; leg: MultiLegLeg }

interface Props {
  trades: UngroupedTrade[];
  ltpFor: (basket: MultiLegBasket, leg: MultiLegLeg) => number;
  selectedLegIds: Set<string>;
  onSelectLegs: (legIds: string[], on: boolean) => void;
  onTag: (trade: UngroupedTrade, tag: string | undefined) => void;
  onExit: (trade: UngroupedTrade) => void;
  exitingLegs: Set<string>;
  /** Keyed `${basketId}:${legId}`. */
  legQtyWarnings: Record<string, LegQtyWarning>;
}

function fmtMoney(n: number): string {
  return `${n < 0 ? '-' : ''}₹${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

const TH = 'px-2 py-2 text-xs font-bold text-white';
const TD = 'px-2 py-1.5 text-xs';
const NUM = `${TD} text-right font-mono tabular-nums`;

/** Trades that are in no group, one line each. Tick them and use the group bar to combine them. */
export default function UngroupedTradesTable({
  trades, ltpFor, selectedLegIds, onSelectLegs, onTag, onExit, exitingLegs, legQtyWarnings,
}: Props) {
  if (trades.length === 0) return null;
  const ids = trades.map(t => t.leg.id);
  const allTicked = ids.every(id => selectedLegIds.has(id));

  return (
    <section aria-label="Ungrouped trades" className="flex flex-col gap-2 pt-2">
      <div className="flex items-center gap-2">
        <span className="text-xs font-bold uppercase tracking-wider text-zinc-300">Ungrouped trades · {trades.length}</span>
        <span className="text-[11px] text-zinc-500">Tick trades, then Group them in the bar below</span>
        <div className="flex-1 h-px bg-zinc-700" />
      </div>
      <div className="overflow-x-auto rounded-xl border border-zinc-800">
        <table className="w-full text-xs">
          <thead className="bg-zinc-800">
            <tr>
              <th className={`${TH} w-8 text-left`}>
                <input type="checkbox" aria-label="Select every ungrouped trade" checked={allTicked}
                  onChange={e => onSelectLegs(ids, e.target.checked)} className="h-3.5 w-3.5 accent-emerald-500 cursor-pointer align-middle" />
              </th>
              <th className={`${TH} text-left`}>Underlying</th>
              <th className={`${TH} text-left`}>Trade</th>
              <th className={`${TH} text-left`}>Expiry</th>
              <th className={`${TH} text-right`}>Lots</th>
              <th className={`${TH} text-right`}>Qty</th>
              <th className={`${TH} text-right`}>Avg</th>
              <th className={`${TH} text-right`}>LTP</th>
              <th className={`${TH} text-right`}>P&L</th>
              <th className={`${TH} text-left`}>Status</th>
              <th className={`${TH} text-left`}>Tag</th>
              <th className={`${TH} text-right`}>Action</th>
            </tr>
          </thead>
          <tbody>
            {trades.map(t => {
              const { basket, leg } = t;
              const ltp = ltpFor(basket, leg);
              const pnl = leg.fill ? legPnl(leg, ltp, crudeQtyMultiplier(basket.underlying, basket.broker)) : 0;
              const avg = legAvgPrice(leg);
              const qty = legQtyUnits(leg);
              const closed = leg.status === 'CLOSED';
              const warn = legQtyWarnings[`${basket.id}:${leg.id}`];
              const ticked = selectedLegIds.has(leg.id);
              return (
                <tr key={leg.id} className={`border-t border-zinc-800 ${ticked ? 'bg-emerald-500/5' : ''} ${closed ? 'text-zinc-500' : 'text-zinc-200'}`}>
                  <td className={TD}>
                    <input type="checkbox" checked={ticked} onChange={e => onSelectLegs([leg.id], e.target.checked)}
                      aria-label={`Select ${leg.strike} ${leg.option} to group`} className="h-3.5 w-3.5 accent-emerald-500 cursor-pointer" />
                  </td>
                  <td className={TD}>
                    <span className="font-semibold">{basket.underlying}</span>
                    <span className="ml-1.5 text-[10px] text-zinc-500">{BROKER_LABELS[basket.broker as Broker] ?? basket.broker}</span>
                  </td>
                  <td className={`${TD} font-semibold whitespace-nowrap`}>
                    <span className={leg.side === 'S' ? 'text-rose-400' : 'text-emerald-400'}>{leg.side === 'S' ? 'SELL' : 'BUY'}</span>
                    {' '}{leg.strike} {leg.option}
                    {warn && (
                      <span className="ml-1.5 inline-flex items-center gap-0.5 text-[10px] font-bold text-amber-400"
                        title={`Tracked ${warn.trackedQty}, broker ${warn.brokerQty}. Group this trade to use Claim / Reduce on it.`}>
                        <AlertTriangle className="w-3 h-3" aria-hidden /> {warn.kind === 'over' ? `Over ${warn.gap}` : `Untracked ${warn.gap}`}
                      </span>
                    )}
                  </td>
                  <td className={`${TD} whitespace-nowrap`}>{formatExpiryLabel(leg.expiry || basket.expiry)}</td>
                  <td className={NUM}>{leg.lots}</td>
                  <td className={NUM}>{qty != null ? qty.toLocaleString('en-IN') : '—'}</td>
                  <td className={NUM}>{avg != null ? avg.toFixed(2) : '—'}</td>
                  <td className={NUM}>{!closed && ltp > 0 ? ltp.toFixed(2) : '—'}</td>
                  <td className={`${NUM} font-bold ${pnl > 0 ? 'text-emerald-400' : pnl < 0 ? 'text-rose-400' : 'text-zinc-400'}`}>{leg.fill ? fmtMoney(pnl) : '—'}</td>
                  <td className={TD}>{leg.status}</td>
                  <td className={`${TD} max-w-[8rem]`}><TagCell value={leg.tag} onCommit={v => onTag(t, v || undefined)} /></td>
                  <td className={`${TD} text-right`}>
                    {leg.status === 'OPEN' && (
                      <button type="button" onClick={() => onExit(t)} disabled={exitingLegs.has(leg.id)}
                        className={`h-6 px-2 rounded border border-rose-500/40 text-[11px] font-bold text-rose-400 hover:bg-rose-500/10 disabled:opacity-50 ${FOCUS_RING}`}>
                        {exitingLegs.has(leg.id) ? 'Exiting…' : 'Exit'}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

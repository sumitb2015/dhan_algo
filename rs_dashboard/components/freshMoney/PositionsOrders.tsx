'use client';

/**
 * Fresh Money — this page's positions and orders (all brokers, all underlyings), from /api/fresh-money/trade.
 * Positions: what THIS page's own orders filled (never the broker's pooled net), with open / booked / total P&L, the LTP
 * source (WebSocket or REST) and × to square off (same rules and lock as the board's ×). Orders: today's latest orders
 * with their real state — UNKNOWN is shown as such, never as failed.
 */

import React, { useState } from 'react';
import { Loader2, X } from 'lucide-react';
import type { FreshMoneyTradeState } from '@/app/api/fresh-money/trade/route';
import type { FmPosition } from '@/lib/freshMoneyTrades';
import { brokerLabel, fmtRs, lockKey } from './trading';

const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/70';
const TH = 'px-2 py-1.5 text-left text-xs font-bold text-white';
const TD = 'px-2 py-1.5 tabular-nums';
const pnlClass = (n: number | null) => (n === null ? 'text-zinc-400' : n > 0 ? 'text-emerald-400' : n < 0 ? 'text-red-400' : 'text-zinc-300');

const istTime = (ms: number) => new Date(ms + 19_800_000).toISOString().slice(11, 19);
const px = (v: number | null | undefined) => (v == null ? '–' : v.toFixed(2));
const contract = (p: { underlying: string; strike: number; opt: string; expiry: string }) => `${p.underlying} ${p.strike} ${p.opt}`;

const STATE: Record<string, { label: string; cls: string }> = {
  filled: { label: 'FILLED', cls: 'bg-emerald-600/15 text-emerald-400' },
  partial: { label: 'PARTIAL', cls: 'bg-amber-600/15 text-amber-300' },
  pending: { label: 'PENDING', cls: 'bg-zinc-800 text-zinc-300' },
  sending: { label: 'SENDING', cls: 'bg-zinc-800 text-zinc-300' },
  rejected: { label: 'REJECTED', cls: 'bg-red-600/15 text-red-400' },
  cancelled: { label: 'CANCELLED', cls: 'bg-zinc-800 text-zinc-400' },
  unknown: { label: 'UNKNOWN', cls: 'bg-amber-600/20 text-amber-300' },
};

type Order = FreshMoneyTradeState['orders'][number];

export default function PositionsOrders({ state, armed, inflight, canClose, onClose }: {
  state: FreshMoneyTradeState | null;
  armed: boolean;
  inflight: ReadonlySet<string>;
  canClose: (p: FmPosition) => boolean;
  onClose: (p: FmPosition) => void;
}) {
  const [tab, setTab] = useState<'positions' | 'orders'>('positions');
  const positions = [...(state?.positions ?? [])]
    .filter(p => p.netQty !== 0 || p.realised !== 0)
    .sort((a, b) => Number(b.netQty !== 0) - Number(a.netQty !== 0) || a.underlying.localeCompare(b.underlying) || a.strike - b.strike);
  const orders: Order[] = state?.orders ?? [];
  const open = positions.filter(p => p.netQty !== 0).length;

  let tOpen: number | null = 0, tBooked: number | null = 0;
  for (const p of positions) {
    tOpen = tOpen === null || p.unrealised === null ? null : tOpen + p.unrealised;
    tBooked = tBooked === null || p.realised === null ? null : tBooked + p.realised;
  }
  const tTotal = tOpen === null || tBooked === null ? null : tOpen + tBooked;

  const tabBtn = (id: 'positions' | 'orders', label: string, n: number) => (
    <button type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
      className={`${FOCUS} rounded px-2.5 py-1 text-[12px] font-bold transition-colors ${tab === id ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}>
      {label} <span className="ml-0.5 rounded bg-zinc-800 px-1 text-[10px] text-zinc-300">{n}</span>
    </button>
  );

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900">
      <div className="flex flex-wrap items-center gap-3 border-b border-zinc-800 px-4 py-2">
        <div role="tablist" aria-label="Positions and orders" className="flex rounded-md border border-zinc-800 bg-zinc-950/40 p-0.5">
          {tabBtn('positions', 'Positions', open)}
          {tabBtn('orders', 'Orders', orders.length)}
        </div>
        <span className="text-[11px] text-zinc-500">
          {tab === 'positions'
            ? "This page's own positions, every broker and underlying (not the broker's pooled net)"
            : "Today's latest orders from this page"}
        </span>
        {tab === 'positions' && (
          <span className="ml-auto text-[12px] tabular-nums text-zinc-400">
            Open <span className={`font-bold ${pnlClass(tOpen)}`}>{fmtRs(tOpen)}</span>
            {' · '}Booked <span className={`font-bold ${pnlClass(tBooked)}`}>{fmtRs(tBooked)}</span>
            {' · '}P&amp;L <span className={`text-[13px] font-bold ${pnlClass(tTotal)}`}>{fmtRs(tTotal)}</span>
          </span>
        )}
      </div>

      <div className="max-h-[320px] overflow-auto">
        {tab === 'positions' ? (
          positions.length === 0 ? (
            <p className="px-4 py-6 text-center text-[12px] text-zinc-500">No positions from this page today.</p>
          ) : (
            <table className="w-full min-w-[860px] text-[12px]">
              <thead className="sticky top-0 z-10 bg-zinc-800">
                <tr>
                  <th className={TH}>Broker</th><th className={TH}>Contract</th><th className={TH}>Expiry</th>
                  <th className={TH}>Position</th><th className={`${TH} text-right`}>Avg</th><th className={`${TH} text-right`}>LTP</th>
                  <th className={`${TH} text-right`}>Open P&amp;L</th><th className={`${TH} text-right`}>Booked</th>
                  <th className={`${TH} text-right`}>Total</th><th className={TH}><span className="sr-only">Close</span></th>
                </tr>
              </thead>
              <tbody>
                {positions.map(p => {
                  const lots = p.lot > 0 ? Math.abs(p.netQty) / p.lot : 0;
                  const busy = inflight.has(lockKey(p.broker, p.underlying, p.strike, p.opt));
                  const src = state?.ltpSource?.[p.priceId];
                  return (
                    <tr key={p.key} className="border-t border-zinc-800 hover:bg-zinc-800/40">
                      <td className={TD}><span className="rounded bg-zinc-800 px-1 text-[10px] font-bold uppercase text-zinc-300">{brokerLabel(p.broker)}</span></td>
                      <td className={`${TD} font-bold text-zinc-200`}>{contract(p)}</td>
                      <td className={`${TD} text-zinc-400`}>{p.expiry}</td>
                      <td className={TD}>
                        {p.netQty === 0 ? <span className="text-zinc-500">Flat</span>
                          : <span className={`font-bold ${p.netQty > 0 ? 'text-emerald-400' : 'text-red-400'}`}>{p.netQty > 0 ? 'Long' : 'Short'} {lots} lot{lots === 1 ? '' : 's'}</span>}
                        {p.busy === 'unknown' && <span className="ml-1 text-[10px] font-bold text-amber-300">order UNKNOWN</span>}
                      </td>
                      <td className={`${TD} text-right text-zinc-300`}>{p.netQty === 0 ? '–' : px(p.avgPrice)}</td>
                      <td className={`${TD} text-right text-zinc-300`} title={src === 'ws' ? 'Live (WebSocket)' : src === 'rest' ? 'REST quote (no live price yet)' : undefined}>
                        {p.netQty === 0 ? '–' : px(p.ltp)}
                        {p.netQty !== 0 && src && <span className="ml-1 text-[9px] font-bold uppercase text-zinc-500">{src === 'ws' ? 'live' : 'rest'}</span>}
                      </td>
                      <td className={`${TD} text-right font-bold ${pnlClass(p.unrealised)}`}>{p.netQty === 0 ? '–' : fmtRs(p.unrealised)}</td>
                      <td className={`${TD} text-right ${pnlClass(p.realised)}`}>{fmtRs(p.realised)}</td>
                      <td className={`${TD} text-right font-bold ${pnlClass(p.pnl)}`}>{fmtRs(p.pnl)}</td>
                      <td className={`${TD} w-8`}>
                        {p.netQty !== 0 && armed && (busy ? <Loader2 className="h-4 w-4 animate-spin text-zinc-400" aria-label="Order in flight" /> : (
                          <button type="button" onClick={() => onClose(p)} disabled={!!p.busy || !canClose(p)}
                            aria-label={`Close ${contract(p)} position on ${brokerLabel(p.broker)}`} title="Square off this page's position (MARKET)"
                            className={`${FOCUS} flex h-5 w-5 items-center justify-center rounded text-zinc-400 hover:bg-zinc-700 hover:text-white disabled:opacity-40`}>
                            <X className="h-3.5 w-3.5" />
                          </button>
                        ))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )
        ) : orders.length === 0 ? (
          <p className="px-4 py-6 text-center text-[12px] text-zinc-500">No orders from this page today.</p>
        ) : (
          <table className="w-full min-w-[900px] text-[12px]">
            <thead className="sticky top-0 z-10 bg-zinc-800">
              <tr>
                <th className={TH}>Time</th><th className={TH}>Broker</th><th className={TH}>Contract</th><th className={TH}>Side</th>
                <th className={`${TH} text-right`}>Lots</th><th className={TH}>Status</th><th className={`${TH} text-right`}>Filled</th>
                <th className={`${TH} text-right`}>Avg price</th><th className={TH}>Note</th>
              </tr>
            </thead>
            <tbody>
              {orders.map(o => {
                const st = o.external ? { label: 'CLOSED OUTSIDE', cls: 'bg-zinc-800 text-zinc-400' } : STATE[o.effState] ?? STATE.pending;
                const lots = o.lot > 0 ? o.qty / o.lot : o.qty;
                const filledLots = o.lot > 0 ? o.filledQty / o.lot : o.filledQty;
                return (
                  <tr key={o.id} className="border-t border-zinc-800 hover:bg-zinc-800/40">
                    <td className={`${TD} text-zinc-400`}>{istTime(o.ts)}</td>
                    <td className={TD}><span className="rounded bg-zinc-800 px-1 text-[10px] font-bold uppercase text-zinc-300">{brokerLabel(o.broker ?? 'dhan')}</span></td>
                    <td className={`${TD} font-bold text-zinc-200`}>{contract(o)}</td>
                    <td className={TD}>
                      <span className={`font-bold ${o.side === 'BUY' ? 'text-emerald-400' : 'text-red-400'}`}>{o.side}</span>
                      {o.close && !o.external && <span className="ml-1 text-[10px] text-zinc-500">close</span>}
                    </td>
                    <td className={`${TD} text-right text-zinc-300`}>{lots}</td>
                    <td className={TD}><span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${st.cls}`}>{st.label}</span></td>
                    <td className={`${TD} text-right text-zinc-300`}>{filledLots}/{lots}</td>
                    <td className={`${TD} text-right text-zinc-300`}>{px(o.avgPrice)}</td>
                    <td className={`${TD} max-w-[320px] truncate text-zinc-400`} title={[o.reason, o.orderId ? `Order ${o.orderId}` : null].filter(Boolean).join(' · ')}>
                      {o.effState === 'unknown' ? 'May be live — check Positions/Orders at the broker' : o.reason || (o.orderId ? `#${o.orderId}` : '')}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

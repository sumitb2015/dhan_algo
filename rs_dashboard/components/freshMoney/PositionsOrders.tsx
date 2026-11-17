'use client';

/**
 * Fresh Money — this page's positions and orders (all brokers, all underlyings), from /api/fresh-money/trade.
 * Positions: what THIS page's own orders filled (never the broker's pooled net), with open / booked / total P&L, the LTP
 * source (WebSocket or REST) and × to square off (same rules and lock as the board's ×). Orders: today's latest orders
 * with their real state — UNKNOWN is shown as such, never as failed.
 */

import React, { useState } from 'react';
import CollapseToggle from './CollapseToggle';
import { Loader2, Pencil, X } from 'lucide-react';
import type { FreshMoneyTradeState } from '@/app/api/fresh-money/trade/route';
import { shownTotals, type FmBroker, type FmPosition } from '@/lib/freshMoneyTrades';
import type { FmExit } from '@/lib/freshMoneyExits';
import { ShownRs, brokerLabel, fmtRs, lockKey } from './trading';
import { istClock } from '@/lib/istTime';
import { EXIT_STATE_LABEL, ExitEditor, exitLevelsText, exitNeedsLook, type SetExitFn } from './ExitInputs';
import { entryActive, entryLabel, type FmEntry } from '@/lib/freshMoneyEntries';

const ENTRY_STATE: Record<FmEntry['state'], { label: string; cls: string }> = {
  armed: { label: 'ARMED', cls: 'bg-amber-600/20 text-amber-300' },
  firing: { label: 'FIRING', cls: 'bg-amber-600/20 text-amber-300' },
  sent: { label: 'SENT', cls: 'bg-emerald-600/15 text-emerald-400' },
  unknown: { label: 'UNKNOWN', cls: 'bg-amber-600/20 text-amber-300' },
  rejected: { label: 'REJECTED', cls: 'bg-red-600/15 text-red-400' },
  cancelled: { label: 'CANCELLED', cls: 'bg-zinc-800 text-zinc-400' },
  expired: { label: 'EXPIRED', cls: 'bg-zinc-800 text-zinc-400' },
};

const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/70';
const TH = 'px-2 py-1.5 text-left text-xs font-bold text-white';
const TD = 'px-2 py-1.5 tabular-nums';
const pnlClass = (n: number | null) => (n === null ? 'text-zinc-400' : n > 0 ? 'text-emerald-400' : n < 0 ? 'text-red-400' : 'text-zinc-300');

const istTime = istClock;
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

function ExitCell({ x }: { x: FmExit | undefined }) {
  if (!x) return <span className="text-zinc-500">–</span>;
  const p = (n: number | null) => (n === null ? 'off' : n.toFixed(2));
  const look = exitNeedsLook(x);
  return (
    <span className="flex flex-wrap items-center gap-1" title={[exitLevelsText(x), x.note].filter(Boolean).join(' — ')}>
      {x.state !== 'waiting-fill' && <span className="text-zinc-200">{p(x.targetPx)} / {p(x.slPx)}</span>}
      {x.trail && (
        // T = trailing armed; T3 = the stop has moved 3 steps (hover for the rule and where it started).
        <span className="rounded bg-sky-600/15 px-1 text-[10px] font-bold text-sky-300" aria-label={`Trailing stop-loss${(x.trailSteps ?? 0) > 0 ? `, moved ${x.trailSteps} times` : ''}`}>
          T{(x.trailSteps ?? 0) > 0 ? x.trailSteps : ''}
        </span>
      )}
      <span className={`rounded px-1 text-[10px] font-bold ${look ? 'bg-amber-600/20 text-amber-300' : x.state === 'watching' ? 'bg-emerald-600/15 text-emerald-400' : 'bg-zinc-800 text-zinc-300'}`}>
        {EXIT_STATE_LABEL[x.state]}
      </span>
    </span>
  );
}

export default function PositionsOrders({ state, broker, armed, inflight, canClose, onClose, onSetExit, onCancelEntry, collapsed = false, onToggle }: {
  /** Cancel an armed level entry (needs no ARM: it only removes a pending order). */
  onCancelEntry: (e: FmEntry) => void;
  state: FreshMoneyTradeState | null;
  /** The page's selected broker: only its positions and orders are listed (others are counted in the header). */
  broker: FmBroker;
  armed: boolean;
  inflight: ReadonlySet<string>;
  canClose: (p: FmPosition) => boolean;
  onClose: (p: FmPosition) => void;
  /** Change or clear one position's target / stop-loss (armed page only). */
  onSetExit: SetExitFn;
  /** Collapsed: only the header row (tabs with counts, P&L totals) stays. */
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const [tab, setTab] = useState<'positions' | 'orders'>('positions');
  const [editing, setEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const exits = state?.exits ?? {};
  const positions = [...(state?.positions ?? [])]
    .filter(p => p.broker === broker && (p.netQty !== 0 || p.realised !== 0))
    .sort((a, b) => Number(b.netQty !== 0) - Number(a.netQty !== 0) || a.underlying.localeCompare(b.underlying) || a.strike - b.strike);
  const orders: Order[] = (state?.orders ?? []).filter(o => (o.broker ?? 'dhan') === broker);
  // Level entries on this broker: active first, then today's ended ones (newest first).
  const entries = (state?.entries ?? []).filter(e => e.broker === broker)
    .sort((a, b) => Number(entryActive(b.state)) - Number(entryActive(a.state)) || b.ts - a.ts);
  const activeEntries = entries.filter(e => entryActive(e.state)).length;
  const otherOpen = (state?.positions ?? []).filter(p => p.broker !== broker && p.netQty !== 0).length;
  const open = positions.filter(p => p.netQty !== 0).length;

  // Display totals: the known part, "?" when a price is missing (shownTotals); never used for a decision.
  const tot = shownTotals(positions);

  const tabBtn = (id: 'positions' | 'orders', label: string, n: number) => (
    <button type="button" role="tab" aria-selected={tab === id} onClick={() => { setTab(id); if (collapsed) onToggle?.(); }}
      className={`${FOCUS} rounded px-2.5 py-1 text-[12px] font-bold transition-colors ${tab === id ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}>
      {label} <span className="ml-0.5 rounded bg-zinc-800 px-1 text-[10px] text-zinc-300">{n}</span>
    </button>
  );

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900">
      <div className={`flex flex-wrap items-center gap-3 px-4 py-2 ${collapsed ? '' : 'border-b border-zinc-800'}`}>
        {onToggle && <CollapseToggle collapsed={collapsed} onToggle={onToggle} label="positions and orders" controls="fm-pos-body" />}
        <div role="tablist" aria-label="Positions and orders" className="flex rounded-md border border-zinc-800 bg-zinc-950/40 p-0.5">
          {tabBtn('positions', 'Positions', open)}
          {tabBtn('orders', activeEntries ? `Orders · ${activeEntries} armed` : 'Orders', orders.length + activeEntries)}
        </div>
        <span className="text-[11px] text-zinc-500">
          {tab === 'positions'
            ? `This page's own fills (not the broker's pooled net)${otherOpen ? ` · ${otherOpen} open on other brokers, listed under the trade bar` : ''}`
            : "Today's latest orders from this page"}
        </span>
        {(tab === 'positions' || collapsed) && (
          <span className="ml-auto text-[12px] tabular-nums text-zinc-400">
            {/* Scope differs from the trade bar (one underlying) and the Total block (everything): say which. */}
            <span className="mr-2 text-[10px] font-bold uppercase tracking-wider text-zinc-500">{brokerLabel(broker)} · all underlyings</span>
            Open <ShownRs s={tot.open} />
            {' · '}Booked <ShownRs s={tot.booked} />
            {' · '}P&amp;L <ShownRs s={tot.pnl} big />
          </span>
        )}
      </div>

      {!collapsed && (
      <div id="fm-pos-body" className="max-h-[320px] overflow-auto">
        {tab === 'positions' ? (
          positions.length === 0 ? (
            <p className="px-4 py-6 text-center text-[12px] text-zinc-500">No positions from this page today.</p>
          ) : (
            <table className="w-full min-w-[980px] text-[12px]">
              <thead className="sticky top-0 z-10 bg-zinc-800">
                <tr>
                  <th className={TH}>Broker</th><th className={TH}>Contract</th><th className={TH}>Expiry</th>
                  <th className={TH}>Position</th><th className={`${TH} text-right`}>Avg</th><th className={`${TH} text-right`}>LTP</th>
                  <th className={`${TH} text-right`}>Open P&amp;L</th><th className={`${TH} text-right`}>Booked</th>
                  <th className={`${TH} text-right`}>Total</th><th className={TH}>Target / SL</th><th className={TH}><span className="sr-only">Close</span></th>
                </tr>
              </thead>
              <tbody>
                {positions.map(p => {
                  const lots = p.lot > 0 ? Math.abs(p.netQty) / p.lot : 0;
                  const busy = inflight.has(lockKey(p.broker, p.underlying, p.strike, p.opt, p.product));
                  const src = state?.ltpSource?.[p.priceId];
                  const x = exits[p.key];
                  return (
                    <React.Fragment key={p.key}>
                    <tr className="border-t border-zinc-800 hover:bg-zinc-800/40">
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
                      <td className={`${TD} text-right`}><ShownRs s={shownTotals([p]).booked} plain /></td>
                      <td className={`${TD} text-right`}><ShownRs s={shownTotals([p]).pnl} /></td>
                      <td className={TD}>
                        <span className="flex items-center gap-1">
                          <ExitCell x={x} />
                          {p.netQty !== 0 && armed && (
                            <button type="button" onClick={() => setEditing(editing === p.key ? null : p.key)} disabled={x?.state === 'firing'}
                              aria-label={`Edit target and stop-loss of ${contract(p)} on ${brokerLabel(p.broker)}`} aria-expanded={editing === p.key}
                              title="Change or clear this position's target / stop-loss"
                              className={`${FOCUS} flex h-5 w-5 items-center justify-center rounded text-zinc-400 hover:bg-zinc-700 hover:text-white disabled:opacity-40`}>
                              <Pencil className="h-3 w-3" />
                            </button>
                          )}
                        </span>
                      </td>
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
                    {editing === p.key && armed && p.netQty !== 0 && (
                      <tr className="border-t border-zinc-800 bg-zinc-950/40">
                        <td colSpan={11}>
                          <ExitEditor exit={x} avgPrice={p.avgPrice} ltp={p.ltp} dir={p.netQty > 0 ? 'long' : 'short'} saving={saving}
                            onCancel={() => setEditing(null)}
                            onSave={async (t, s, tr) => { setSaving(true); const ok = await onSetExit(p.key, t, s, tr); setSaving(false); if (ok) setEditing(null); }} />
                        </td>
                      </tr>
                    )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          )
        ) : (<>
        {entries.length > 0 && (
          <table className="w-full min-w-[900px] text-[12px]" data-testid="fm-levels">
            <thead className="bg-zinc-800">
              <tr>
                <th className={TH}>Armed</th><th className={TH}>Contract</th><th className={TH}>Level (sent at market on the cross)</th>
                <th className={`${TH} text-right`}>Lots</th><th className={TH}>Kind</th><th className={TH}>Status</th><th className={TH}>Note</th>
                <th className={TH}><span className="sr-only">Cancel</span></th>
              </tr>
            </thead>
            <tbody>
              {entries.map(e => {
                const st = ENTRY_STATE[e.state];
                return (
                  <tr key={e.id} className="border-t border-zinc-800 hover:bg-zinc-800/40">
                    <td className={`${TD} text-zinc-400`}>{istTime(e.ts)}</td>
                    <td className={`${TD} font-bold text-zinc-200`}>{contract(e)} <span className="text-[10px] font-normal text-zinc-500">{e.product}</span></td>
                    <td className={TD}><span className={`font-bold ${e.side === 'BUY' ? 'text-emerald-400' : 'text-red-400'}`}>{entryLabel(e)}</span>
                      <span className="ml-1 text-[11px] text-zinc-500">{e.underlying} was {px(e.spotAtArm)}</span></td>
                    <td className={`${TD} text-right text-zinc-300`}>{e.lots}</td>
                    <td className={`${TD} text-zinc-300`}>{e.kind === 'limit' ? 'Limit' : 'Stop'}</td>
                    <td className={TD}><span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${st.cls}`}>{st.label}</span></td>
                    <td className={`${TD} max-w-[320px] truncate text-zinc-400`} title={[e.reason, e.orderId ? `Order ${e.orderId}` : null].filter(Boolean).join(' · ')}>
                      {e.state === 'sent' ? `Fired at ${px(e.spotAtFire)}${e.orderId ? ` · #${e.orderId}` : ''}` : e.state === 'unknown' ? 'May be live — check Orders at the broker' : (e.reason ?? '')}
                    </td>
                    <td className={`${TD} w-8`}>
                      {e.state === 'armed' && (
                        <button type="button" onClick={() => onCancelEntry(e)} aria-label={`Cancel level ${entryLabel(e)} on ${contract(e)}`} title="Cancel this level"
                          className={`${FOCUS} flex h-5 w-5 items-center justify-center rounded text-zinc-400 hover:bg-zinc-700 hover:text-white`}>
                          <X className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {orders.length === 0 ? (
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
                    <td className={`${TD} text-zinc-400`}
                      title={o.seenAt !== undefined ? `Fill seen here +${((o.seenAt - o.ts) / 1000).toFixed(1)} s after sending` : undefined}>{istTime(o.ts)}</td>
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
                    <td className={`${TD} max-w-[320px] truncate text-zinc-400`} title={[o.trigger, o.reason, o.orderId ? `Order ${o.orderId}` : null].filter(Boolean).join(' · ')}>
                      {o.effState === 'unknown' ? 'May be live — check Positions/Orders at the broker' : [o.trigger, o.reason].filter(Boolean).join(' · ') || (o.orderId ? `#${o.orderId}` : '')}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        </>)}
      </div>
      )}
    </div>
  );
}

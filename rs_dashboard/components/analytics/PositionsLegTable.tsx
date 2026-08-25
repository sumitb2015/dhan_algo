'use client';

/**
 * Row-selection checkboxes are still out of scope (see below) but per-row
 * exit/adjust chips are not — closing or trimming a single leg is a normal
 * risk action and there is no reason to make the user leave this page and
 * find the leg again in the Scalper terminal to do it.
 *
 * No row-selection checkboxes here by design: the screenshot this page is
 * modeled on uses them to scope the SL & Trailing SL Manager's "apply to
 * selected legs" bar, which is Phase 2. A selection control with nothing
 * downstream consuming it is worse than none — it implies clicking it does
 * something. Reintroduce alongside that manager, not before.
 */

import React, { useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PositionLeg, UnparseableLeg } from '@/lib/positionLegs';
import { fmtExpiryShort } from '@/components/crudeoil/format';
import { partialCloseChips, type ClosePct } from '@/lib/partialQty';

const TH = 'bg-zinc-800 px-1.5 py-2 text-xs font-bold text-white whitespace-nowrap';
const TD = 'px-1.5 py-2 font-mono text-xs tabular-nums text-zinc-200 whitespace-nowrap';

function fmtInr(n: number, dec = 0): string {
  const abs = Math.abs(n);
  return `${n < 0 ? '-' : ''}₹${abs.toLocaleString('en-IN', { maximumFractionDigits: dec, minimumFractionDigits: dec })}`;
}

function pnlColor(n: number): string {
  return n > 0 ? 'text-emerald-400' : n < 0 ? 'text-red-400' : 'text-zinc-400';
}

export interface LegPnl {
  booked: number;
  unbooked: number | null;   // null when the LTP is unknown
  total: number | null;
}

/**
 * Per-leg P&L from the broker's own numbers.
 *
 * Unbooked is left null (rendered as a dash) rather than 0 when the LTP is
 * unknown — Kotak reports no last-traded price at all, and a 0 there would show
 * a short leg as fully profitable.
 */
export function legPnl(leg: PositionLeg): LegPnl {
  const booked = leg.display.realizedProfit;
  if (leg.display.ltp === null) return { booked, unbooked: null, total: null };
  const unbooked = leg.display.netQty * (leg.display.ltp - leg.display.entryAvg);
  return { booked, unbooked, total: booked + unbooked };
}

interface Props {
  legs: PositionLeg[];
  unparseable: UnparseableLeg[];
  lotSize: number;
  /** Omitted -> the Actions column and its chips are not rendered at all (e.g. no broker session). */
  onClose?: (leg: PositionLeg, pct: ClosePct) => void;
  /** Keys (legKey(leg)) currently mid-close, so the row can show a spinner and block re-clicks. */
  closingKeys?: Set<string>;
}

// Unique per row: tradingSymbol alone collides when the same contract is held
// under two product types (e.g. an MTF-converted leg alongside a fresh MARGIN
// one), which would merge two distinct rows onto one selection/warning key.
export const legKey = (l: PositionLeg) => `${l.display.tradingSymbol}|${l.display.productType}`;

/**
 * One row's quick-exit chips: 25/50/75/100%, click-to-arm / click-to-confirm
 * (same two-step pattern as Scalper's "Exit All", never a native `confirm()`
 * dialog, which blocks the extension/automation and is easy to blur-dismiss
 * by accident on a dense row).
 */
function ExitChips({
  leg, lotSize, closing, onClose,
}: {
  leg: PositionLeg; lotSize: number; closing: boolean; onClose: (pct: ClosePct) => void;
}) {
  const [armedPct, setArmedPct] = useState<ClosePct | null>(null);
  const chips = partialCloseChips(leg.display.netQty, lotSize);

  if (closing) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] text-zinc-400">
        <Loader2 className="h-3 w-3 animate-spin" /> Closing…
      </span>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-end gap-1">
      {chips.map((c) => (
        <button
          key={c.pct}
          type="button"
          disabled={!c.enabled}
          title={c.title}
          onClick={() => {
            if (armedPct !== c.pct) {
              setArmedPct(c.pct);
              setTimeout(() => setArmedPct((p) => (p === c.pct ? null : p)), 3000);
              return;
            }
            setArmedPct(null);
            onClose(c.pct);
          }}
          className={cn(
            'rounded border px-1.5 py-0.5 font-mono text-[10px] font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-30',
            armedPct === c.pct
              ? 'border-rose-500 bg-rose-500/20 text-rose-200'
              : c.pct === 100
                ? 'border-zinc-600 bg-zinc-800 text-zinc-200 hover:border-rose-600 hover:text-rose-300'
                : 'border-zinc-700 bg-zinc-900 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200',
          )}
        >
          {armedPct === c.pct ? 'Confirm?' : c.pct === 100 ? 'Exit' : `${c.pct}%`}
        </button>
      ))}
    </div>
  );
}

export default function PositionsLegTable({ legs, unparseable, lotSize, onClose, closingKeys }: Props) {
  if (!legs.length && !unparseable.length) {
    return <p className="px-3 py-6 text-center text-xs text-zinc-500">No open option positions.</p>;
  }

  return (
    <div className="space-y-2">
      {unparseable.length > 0 && (
        <div className="rounded border border-amber-800 bg-amber-950 px-3 py-2 text-[11px] text-amber-300">
          <div className="flex items-center gap-1.5 font-bold">
            <AlertTriangle className="h-3.5 w-3.5" />
            {unparseable.length} position{unparseable.length > 1 ? 's' : ''} excluded from the payoff
          </div>
          <ul className="mt-1 space-y-0.5 pl-5">
            {unparseable.map((u) => (
              // tradingSymbol alone can collide (e.g. carried-forward + fresh
              // MARGIN legs on the same contract), hence + productType.
              <li key={`${u.tradingSymbol}|${u.productType}`} className="font-mono">
                {u.tradingSymbol} [{u.productType}] ({u.netQty}) — {u.reason}
              </li>
            ))}
          </ul>
          <p className="mt-1 pl-5 text-amber-400">
            Every figure on this page ignores these legs, so the real risk is larger than shown.
          </p>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className={cn(TH, 'text-left')}>Instrument</th>
              <th className={TH}>Expiry</th>
              <th className={TH}>Qty</th>
              <th className={TH}>Lots</th>
              <th className={TH}>Avg</th>
              <th className={TH}>LTP</th>
              <th className={TH}>Booked</th>
              <th className={TH}>Unbook</th>
              <th className={TH}>P&amp;L</th>
              {onClose && <th className={cn(TH, 'text-right')}>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {legs.map((l) => {
              const key = legKey(l);
              const p = legPnl(l);
              const lots = lotSize > 0 ? l.qtyLots / lotSize : null;
              return (
                <tr key={key} className="border-b border-zinc-800 hover:bg-zinc-900"
                    title={`${l.display.tradingSymbol} · ${l.display.productType}`}>
                  <td className={cn(TD, 'text-left')}>
                    <span className={cn(
                      'mr-1.5 inline-block rounded px-1 py-px text-[9px] font-bold',
                      l.side === 'SELL' ? 'bg-rose-500/15 text-rose-300' : 'bg-sky-500/15 text-sky-300',
                    )}>
                      {l.side === 'SELL' ? 'S' : 'B'}
                    </span>
                    <span className="text-zinc-100">{l.strike.toLocaleString('en-IN')} {l.type}</span>
                  </td>
                  <td className={TD}>{l.expiry ? fmtExpiryShort(l.expiry) : '—'}</td>
                  <td className={TD}>{l.display.netQty.toLocaleString('en-IN')}</td>
                  <td className={TD}>
                    {lots === null ? '—' : Number.isInteger(lots) ? lots : lots.toFixed(2)}
                  </td>
                  <td className={TD}>{l.display.entryAvg.toFixed(2)}</td>
                  <td className={TD}>{l.display.ltp === null ? '—' : l.display.ltp.toFixed(2)}</td>
                  <td className={cn(TD, pnlColor(p.booked))}>{fmtInr(p.booked)}</td>
                  <td className={cn(TD, p.unbooked === null ? 'text-zinc-500' : pnlColor(p.unbooked))}>
                    {p.unbooked === null ? '—' : fmtInr(p.unbooked)}
                  </td>
                  <td className={cn(TD, 'font-bold', p.total === null ? 'text-zinc-500' : pnlColor(p.total))}>
                    {p.total === null ? '—' : fmtInr(p.total)}
                  </td>
                  {onClose && (
                    <td className={cn(TD, 'text-right')}>
                      <ExitChips
                        leg={l} lotSize={lotSize}
                        closing={closingKeys?.has(key) ?? false}
                        onClose={(pct) => onClose(l, pct)}
                      />
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

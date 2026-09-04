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

import React, { useState, useMemo } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PositionLeg, UnparseableLeg } from '@/lib/positionLegs';
import { fmtExpiryShort } from '@/components/crudeoil/format';
import { partialCloseChips, type ClosePct } from '@/lib/partialQty';

const TH = 'bg-zinc-800/90 px-2 py-1.5 text-[10px] font-bold uppercase tracking-wide text-white whitespace-nowrap';
const TD = 'px-2 py-1.5 font-mono text-[11px] tabular-nums text-zinc-200 whitespace-nowrap';

export type PositionSortKey =
  | 'instrument'
  | 'expiry'
  | 'qty'
  | 'lots'
  | 'avg'
  | 'ltp'
  | 'booked'
  | 'unbooked'
  | 'pnl'
  | 'pnlPct';

export type SortDir = 'asc' | 'desc';

function SortHeader({
  colKey,
  label,
  align = 'center',
  currentKey,
  dir,
  onSort,
}: {
  colKey: PositionSortKey;
  label: string;
  align?: 'left' | 'center' | 'right';
  currentKey: PositionSortKey | null;
  dir: SortDir;
  onSort: (k: PositionSortKey) => void;
}) {
  const active = currentKey === colKey;
  return (
    <th
      className={cn(
        TH,
        align === 'left' ? 'text-left' : align === 'right' ? 'text-right' : 'text-center',
        'cursor-pointer select-none transition-colors hover:bg-zinc-700',
      )}
      onClick={() => onSort(colKey)}
    >
      <div className={cn('inline-flex items-center gap-1', align === 'right' ? 'justify-end' : align === 'left' ? 'justify-start' : 'justify-center')}>
        <span>{label}</span>
        <span className={cn('text-[10px]', active ? 'text-sky-400 font-bold' : 'text-zinc-500')}>
          {active ? (dir === 'asc' ? '▲' : '▼') : '↕'}
        </span>
      </div>
    </th>
  );
}

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
  /** total P&L as a % of the entry premium value (|entryAvg * netQty|); null when total is null or there's no premium to divide by. */
  totalPct: number | null;
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
  if (leg.display.ltp === null) return { booked, unbooked: null, total: null, totalPct: null };
  const unbooked = leg.display.netQty * (leg.display.ltp - leg.display.entryAvg);
  const total = booked + unbooked;
  const premium = Math.abs(leg.display.entryAvg * leg.display.netQty);
  const totalPct = premium > 0 ? (total / premium) * 100 : null;
  return { booked, unbooked, total, totalPct };
}

interface Props {
  legs: PositionLeg[];
  unparseable: UnparseableLeg[];
  lotSize: number;
  /** Omitted -> the Actions column and its chips are not rendered at all (e.g. no broker session). */
  onClose?: (leg: PositionLeg, pct: ClosePct) => void;
  /** Keys (legKey(leg)) currently mid-close, so the row can show a spinner and block re-clicks. */
  closingKeys?: Set<string>;
  /** Omitted -> no per-row Buy/Sell add control is rendered. */
  onAdd?: (leg: PositionLeg, side: 'BUY' | 'SELL', lots: number) => void;
  /** Keys (legKey(leg)) currently mid-add, so the row can show a spinner and block re-clicks. */
  addingKeys?: Set<string>;
  /** Omitted -> no selection checkboxes are rendered at all (backward-compatible with existing callers). */
  selectedKeys?: Set<string>;
  onToggleSelect?: (key: string) => void;
  /** Called with every currently-rendered leg key when the header checkbox is used to select/deselect all at once. */
  onToggleSelectAll?: (keys: string[]) => void;
}

// Unique per row: tradingSymbol alone collides when the same contract is held
// under two product types (e.g. an MTF-converted leg alongside a fresh MARGIN
// one), or across different weekly expiries where Dhan's tradingSymbol only
// includes the month name (e.g. NIFTY-Sep2026-23900-PE on 01-Sep and 08-Sep).
export const legKey = (l: PositionLeg) => `${l.display.tradingSymbol}|${l.expiry ?? ''}|${l.display.productType}`;

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
              ? 'border-rose-500 bg-rose-500/20 text-rose-200 hover:bg-rose-500/30'
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

/**
 * One row's quick-add lots stepper + Buy/Sell, same click-to-arm /
 * click-to-confirm interaction as ExitChips — this places a real order too.
 */
function AddChips({
  adding, onAdd,
}: {
  adding: boolean; onAdd: (side: 'BUY' | 'SELL', lots: number) => void;
}) {
  const [lots, setLots] = useState(1);
  const [armed, setArmed] = useState<'BUY' | 'SELL' | null>(null);

  if (adding) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] text-zinc-400">
        <Loader2 className="h-3 w-3 animate-spin" /> Adding…
      </span>
    );
  }

  const fire = (side: 'BUY' | 'SELL') => {
    if (armed !== side) {
      setArmed(side);
      setTimeout(() => setArmed((a) => (a === side ? null : a)), 3000);
      return;
    }
    setArmed(null);
    onAdd(side, lots);
  };

  return (
    <div className="flex items-center gap-1">
      <button type="button" onClick={() => setLots((l) => Math.max(1, l - 1))}
        className="h-5 w-5 rounded border border-zinc-700 bg-zinc-900 text-[10px] text-zinc-400 hover:text-zinc-200">−</button>
      <span className="w-4 text-center font-mono text-[10px] text-zinc-300">{lots}</span>
      <button type="button" onClick={() => setLots((l) => l + 1)}
        className="h-5 w-5 rounded border border-zinc-700 bg-zinc-900 text-[10px] text-zinc-400 hover:text-zinc-200">+</button>
      <button type="button" onClick={() => fire('BUY')}
        className={cn('rounded border px-1.5 py-0.5 font-mono text-[10px] font-bold transition-colors',
          armed === 'BUY' ? 'border-sky-400 bg-sky-500/25 text-sky-100 hover:bg-sky-500/35' : 'border-sky-800 bg-sky-950 text-sky-300 hover:bg-sky-900')}>
        {armed === 'BUY' ? 'Confirm?' : 'B'}
      </button>
      <button type="button" onClick={() => fire('SELL')}
        className={cn('rounded border px-1.5 py-0.5 font-mono text-[10px] font-bold transition-colors',
          armed === 'SELL' ? 'border-rose-500 bg-rose-500/20 text-rose-200 hover:bg-rose-500/30' : 'border-rose-800 bg-rose-950 text-rose-300 hover:bg-rose-900')}>
        {armed === 'SELL' ? 'Confirm?' : 'S'}
      </button>
    </div>
  );
}

export default function PositionsLegTable({
  legs, unparseable, lotSize, onClose, closingKeys, onAdd, addingKeys,
  selectedKeys, onToggleSelect, onToggleSelectAll,
}: Props) {
  const [sortKey, setSortKey] = useState<PositionSortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const handleSort = (key: PositionSortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'instrument' || key === 'expiry' ? 'asc' : 'desc');
    }
  };

  const sortedLegs = useMemo(() => {
    if (!sortKey) return legs;
    return [...legs].sort((a, b) => {
      let diff = 0;
      if (sortKey === 'instrument') {
        if (a.strike !== b.strike) diff = a.strike - b.strike;
        else if (a.type !== b.type) diff = a.type.localeCompare(b.type);
        else diff = a.side.localeCompare(b.side);
      } else if (sortKey === 'expiry') {
        diff = (a.expiry ?? '').localeCompare(b.expiry ?? '');
      } else if (sortKey === 'qty') {
        diff = a.display.netQty - b.display.netQty;
      } else if (sortKey === 'lots') {
        diff = a.qtyLots - b.qtyLots;
      } else if (sortKey === 'avg') {
        diff = a.display.entryAvg - b.display.entryAvg;
      } else if (sortKey === 'ltp') {
        const la = a.display.ltp ?? -Infinity;
        const lb = b.display.ltp ?? -Infinity;
        diff = la - lb;
      } else if (sortKey === 'booked') {
        diff = a.display.realizedProfit - b.display.realizedProfit;
      } else if (sortKey === 'unbooked') {
        const pa = legPnl(a).unbooked ?? -Infinity;
        const pb = legPnl(b).unbooked ?? -Infinity;
        diff = pa - pb;
      } else if (sortKey === 'pnl') {
        const pa = legPnl(a).total ?? -Infinity;
        const pb = legPnl(b).total ?? -Infinity;
        diff = pa - pb;
      } else if (sortKey === 'pnlPct') {
        const pa = legPnl(a).totalPct ?? -Infinity;
        const pb = legPnl(b).totalPct ?? -Infinity;
        diff = pa - pb;
      }
      return sortDir === 'asc' ? diff : -diff;
    });
  }, [legs, sortKey, sortDir]);

  if (!legs.length && !unparseable.length) {
    return <p className="px-3 py-6 text-center text-xs text-zinc-500">No open option positions.</p>;
  }

  const selectable = !!selectedKeys && !!onToggleSelect;
  const allKeys = sortedLegs.map(legKey);
  const allSelected = selectable && allKeys.length > 0 && allKeys.every((k) => selectedKeys!.has(k));

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

      <div className="overflow-x-auto rounded-xl border border-zinc-800">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              {selectable && (
                <th className={cn(TH, 'text-left')}>
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={() => onToggleSelectAll?.(allKeys)}
                    className="h-3.5 w-3.5 cursor-pointer rounded-sm accent-sky-500 hover:ring-2 hover:ring-sky-500/50"
                    aria-label={allSelected ? 'Deselect all legs' : 'Select all legs'}
                  />
                </th>
              )}
              <SortHeader colKey="instrument" label="Instrument" align="left" currentKey={sortKey} dir={sortDir} onSort={handleSort} />
              <SortHeader colKey="expiry" label="Expiry" align="center" currentKey={sortKey} dir={sortDir} onSort={handleSort} />
              <SortHeader colKey="qty" label="Qty" align="center" currentKey={sortKey} dir={sortDir} onSort={handleSort} />
              <SortHeader colKey="lots" label="Lots" align="center" currentKey={sortKey} dir={sortDir} onSort={handleSort} />
              <SortHeader colKey="avg" label="Avg" align="center" currentKey={sortKey} dir={sortDir} onSort={handleSort} />
              <SortHeader colKey="ltp" label="LTP" align="center" currentKey={sortKey} dir={sortDir} onSort={handleSort} />
              <SortHeader colKey="booked" label="Booked" align="center" currentKey={sortKey} dir={sortDir} onSort={handleSort} />
              <SortHeader colKey="unbooked" label="Unbook" align="center" currentKey={sortKey} dir={sortDir} onSort={handleSort} />
              <SortHeader colKey="pnl" label="P&L" align="center" currentKey={sortKey} dir={sortDir} onSort={handleSort} />
              <SortHeader colKey="pnlPct" label="P&L %" align="center" currentKey={sortKey} dir={sortDir} onSort={handleSort} />
              {onClose && <th className={cn(TH, 'text-right')}>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {sortedLegs.map((l) => {
              const key = legKey(l);
              const p = legPnl(l);
              const lots = lotSize > 0 ? l.qtyLots / lotSize : null;
              return (
                <tr key={key} className="border-b border-zinc-800/70 transition-colors even:bg-zinc-900/40 hover:bg-zinc-800/60"
                    title={`${l.display.tradingSymbol} · ${l.display.productType}`}>
                  {selectable && (
                    <td className={cn(TD, 'text-left')}>
                      <input
                        type="checkbox"
                        checked={selectedKeys!.has(key)}
                        onChange={() => onToggleSelect!(key)}
                        className="h-3.5 w-3.5 cursor-pointer rounded-sm accent-sky-500 hover:ring-2 hover:ring-sky-500/50"
                        aria-label={`Select ${l.strike} ${l.type} for bulk exit`}
                      />
                    </td>
                  )}
                  <td className={cn(TD, 'text-left')}>
                    <span className={cn(
                      'mr-1.5 inline-block rounded px-1 py-px text-[8px] font-bold',
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
                  <td className={cn(TD, p.totalPct === null ? 'text-zinc-500' : pnlColor(p.totalPct))}>
                    {p.totalPct === null ? '—' : `${p.totalPct >= 0 ? '+' : ''}${p.totalPct.toFixed(1)}%`}
                  </td>
                  {onClose && (
                    <td className={cn(TD, 'text-right')}>
                      <div className="flex items-center justify-end gap-2">
                        {onAdd && (
                          <AddChips
                            adding={addingKeys?.has(key) ?? false}
                            onAdd={(side, lots) => onAdd(l, side, lots)}
                          />
                        )}
                        <ExitChips
                          leg={l} lotSize={lotSize}
                          closing={closingKeys?.has(key) ?? false}
                          onClose={(pct) => onClose(l, pct)}
                        />
                      </div>
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

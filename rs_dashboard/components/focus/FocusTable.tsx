'use client';

/**
 * The Focus Tool row table.
 *
 * One row is one straddle/strangle rule, laid out in four column bands:
 *
 *   CONFIGURATION      entry/exit time, DTE filter, strike, live premium, lots, side
 *   STATUS / ACTIONS   the row's state and its Arm / Disarm control
 *   POSITIONS & EXITS  CE and PE leg values, scale in/out, per-leg exit
 *   LEVEL EXITS        H↑, L↓, VWAP, SL ₹ / SL ×
 *
 * The row's *configuration* comes from the local config the user is editing;
 * its *state and prices* come from the worker's status file. Keeping those two
 * sources separate is what lets you edit a row without a status poll clobbering
 * the field you are typing in.
 */

import React from 'react';
import { cn } from '@/lib/utils';
import type { FocusGroup, FocusRow, LevelExits } from '@/lib/focusTool';
import type { WorkerStatusRow } from '@/lib/focusStore';
import { PillToggle, NumField, TimeField, ChipGroup, MiniButton, StateBadge, FieldLabel } from './FocusControls';

const DTE_OPTIONS = [
  { value: 'any' as const, label: 'Any' },
  { value: '0' as const,   label: '0' },
  { value: '1' as const,   label: '1' },
  { value: '0+1' as const, label: '0+1' },
];

function fmtPx(n: number | undefined | null): string {
  return n === undefined || n === null || !Number.isFinite(n) || n <= 0 ? '—' : n.toFixed(2);
}

function fmtSigned(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}`;
}

/** Header band. `text-xs font-bold text-white` on solid `bg-zinc-800` per CLAUDE.md —
 *  at 10px a header anti-aliases into grey and stops reading as a header. */
function BandTH({ children, span, className }: { children: React.ReactNode; span?: number; className?: string }) {
  return (
    <th colSpan={span} className={cn(
      'py-1 px-2 text-xs font-bold text-white bg-zinc-800 uppercase tracking-wide text-left', className,
    )}>
      {children}
    </th>
  );
}

function ColTH({ children, className }: { children?: React.ReactNode; className?: string }) {
  return (
    <th className={cn(
      'py-1 px-2 text-xs font-bold text-white bg-zinc-800 uppercase tracking-wide text-left whitespace-nowrap',
      className,
    )}>
      {children}
    </th>
  );
}

export interface FocusTableProps {
  group: FocusGroup;
  /** Live per-row state from the worker, keyed by row id. */
  status: Record<string, WorkerStatusRow>;
  disabled: boolean;
  onRowChange: (rowId: string, patch: Partial<FocusRow>) => void;
  onExitsChange: (rowId: string, patch: Partial<LevelExits>) => void;
  onArm: (rowId: string) => void;
  onDisarm: (rowId: string) => void;
  onClear: (rowId: string) => void;
  onRemove: (rowId: string) => void;
  onScale: (rowId: string, leg: 'CE' | 'PE', delta: 1 | -1) => void;
  onExitLeg: (rowId: string, leg: 'CE' | 'PE') => void;
  busyRows: Set<string>;
}

export default function FocusTable(props: FocusTableProps) {
  const { group, status } = props;

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse min-w-[1280px]">
        <thead>
          <tr>
            <BandTH span={6}>Configuration</BandTH>
            <BandTH span={1} className="border-l border-zinc-700">Status / Actions</BandTH>
            <BandTH span={2} className="border-l border-zinc-700">Positions &amp; Exits</BandTH>
            <BandTH span={1} className="border-l border-zinc-700">Level Exits</BandTH>
          </tr>
          <tr>
            <ColTH>Timing</ColTH>
            <ColTH>DTE</ColTH>
            <ColTH className="text-right">Strike</ColTH>
            <ColTH className="text-right">LTP</ColTH>
            <ColTH className="text-right">Lots</ColTH>
            <ColTH>Side</ColTH>
            <ColTH className="border-l border-zinc-700">State</ColTH>
            <ColTH className="border-l border-zinc-700 text-right">CE</ColTH>
            <ColTH className="text-right">PE</ColTH>
            <ColTH className="border-l border-zinc-700">Exits</ColTH>
          </tr>
        </thead>
        <tbody>
          {group.rows.length === 0 && (
            <tr>
              <td colSpan={10} className="py-6 text-center text-[11px] text-zinc-500">
                No rows yet — add one to define a straddle or strangle rule.
              </td>
            </tr>
          )}
          {group.rows.map(row => (
            <Row key={row.id} row={row} live={status[row.id]} {...props} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Row({
  row, live, disabled, onRowChange, onExitsChange, onArm, onDisarm, onClear, onRemove,
  onScale, onExitLeg, busyRows,
}: FocusTableProps & { row: FocusRow; live?: WorkerStatusRow }) {
  // The worker's state is the truth once it has spoken; the config's state is
  // the fallback before the first status poll lands.
  const state = live?.state ?? row.state;
  const entered = state === 'ENTERED';
  const busy = busyRows.has(row.id);
  // Configuration is frozen once a row is armed or filled: changing the strike
  // offset of a position that already exists would silently re-point the exit
  // rules at strikes nobody holds.
  const locked = disabled || state === 'ARMED' || entered;

  const ceLtp = live?.ceLtp ?? 0;
  const peLtp = live?.peLtp ?? 0;
  const combined = live?.combined ?? ceLtp + peLtp;
  const pnl = live?.pnl ?? 0;

  const fill = row.fill;
  const ceChange = fill ? ceLtp - fill.ceEntry : null;
  const peChange = fill ? peLtp - fill.peEntry : null;
  const combChange = fill ? combined - (fill.ceEntry + fill.peEntry) : null;

  return (
    <tr className={cn(
      'border-b border-zinc-800 last:border-0 align-top',
      entered ? 'bg-emerald-500/5' : 'hover:bg-zinc-800/30',
      state === 'EXITED' && 'opacity-60',
    )}>
      {/* ── Timing ── */}
      <td className="py-2 px-2">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1.5">
            <FieldLabel title="Time of day this row opens, if armed">Entry</FieldLabel>
            <TimeField value={row.entryTime} disabled={locked}
              onCommit={v => onRowChange(row.id, { entryTime: v })} />
          </div>
          <div className="flex items-center gap-1.5">
            <FieldLabel title="Time of day this row closes">Exit</FieldLabel>
            <TimeField value={row.exitTime} disabled={disabled}
              onCommit={v => onRowChange(row.id, { exitTime: v })} />
          </div>
        </div>
      </td>

      {/* ── DTE ── */}
      <td className="py-2 px-2">
        <ChipGroup
          options={DTE_OPTIONS}
          value={row.dte}
          disabled={locked}
          title="Only enter when the nearest expiry is this many days out"
          onChange={v => onRowChange(row.id, { dte: v })}
        />
      </td>

      {/* ── Strike ── */}
      <td className="py-2 px-2 text-right">
        {entered && fill ? (
          <div className="font-mono text-[11px] tabular-nums leading-tight">
            <div className="text-zinc-200">{fill.ceStrike} CE</div>
            <div className="text-zinc-200">{fill.peStrike} PE</div>
          </div>
        ) : (
          <div className="flex flex-col items-end gap-1">
            <div className="font-mono text-[11px] tabular-nums text-zinc-400 leading-tight">
              {live?.ceStrike ? (
                live.ceStrike === live.peStrike
                  ? <span>{live.ceStrike}</span>
                  : <span>{live.peStrike} / {live.ceStrike}</span>
              ) : <span className="text-zinc-600">—</span>}
            </div>
            <div className="flex items-center gap-1">
              <FieldLabel title="Steps away from ATM. 0 is a straddle; n is a strangle n steps wide each side.">±</FieldLabel>
              <NumField value={row.offset} min={0} width="w-12" disabled={locked}
                onCommit={v => onRowChange(row.id, { offset: v ?? 0 })} />
            </div>
          </div>
        )}
      </td>

      {/* ── LTP: combined premium, with the CE/PE breakdown beneath ── */}
      <td className="py-2 px-2 text-right">
        <div className="font-mono tabular-nums leading-tight">
          <div className="flex items-baseline justify-end gap-1.5">
            <span className="text-[13px] font-semibold text-zinc-100">{fmtPx(combined)}</span>
            {combChange !== null && (
              <span className={cn('text-[10px] font-bold',
                combChange >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                ({fmtSigned(combChange)})
              </span>
            )}
          </div>
          <div className="text-[10px] text-zinc-500 mt-0.5">
            {fmtPx(ceLtp)}
            {ceChange !== null && (
              <span className={ceChange >= 0 ? 'text-emerald-400' : 'text-red-400'}> ({fmtSigned(ceChange)})</span>
            )}
            <span className="text-zinc-600"> / </span>
            {fmtPx(peLtp)}
            {peChange !== null && (
              <span className={peChange >= 0 ? 'text-emerald-400' : 'text-red-400'}> ({fmtSigned(peChange)})</span>
            )}
          </div>
        </div>
      </td>

      {/* ── Lots ── */}
      <td className="py-2 px-2 text-right">
        <NumField value={row.lots} min={1} width="w-14" disabled={locked}
          title="Lots per leg" onCommit={v => onRowChange(row.id, { lots: Math.max(1, Math.trunc(v ?? 1)) })} />
      </td>

      {/* ── Side ── */}
      <td className="py-2 px-2">
        <ChipGroup
          options={[{ value: 'SELL' as const, label: 'Sell' }, { value: 'BUY' as const, label: 'Buy' }]}
          value={row.side}
          disabled={locked}
          onChange={v => onRowChange(row.id, { side: v })}
        />
      </td>

      {/* ── State / actions ── */}
      <td className="py-2 px-2 border-l border-zinc-800">
        <div className="flex flex-col items-start gap-1">
          <StateBadge state={state} title={live?.reason || row.error || undefined} />
          {state === 'DRAFT' && (
            <MiniButton tone="cyan" disabled={disabled} onClick={() => onArm(row.id)}
              title="Hand this row to the worker. It will enter at its entry time if the DTE matches.">
              Arm
            </MiniButton>
          )}
          {state === 'ARMED' && (
            <MiniButton disabled={disabled} onClick={() => onDisarm(row.id)}
              title="Return the row to draft — it will not enter">
              Disarm
            </MiniButton>
          )}
          {(state === 'EXITED' || state === 'ERROR') && (
            <MiniButton disabled={disabled} onClick={() => onClear(row.id)}
              title="Clear the fill and return this row to draft so it can be re-armed">
              Reset
            </MiniButton>
          )}
          {entered && (
            <span className={cn('text-[11px] font-mono font-bold tabular-nums',
              pnl > 0 ? 'text-emerald-400' : pnl < 0 ? 'text-red-400' : 'text-zinc-400')}>
              ₹{pnl.toFixed(0)}
            </span>
          )}
          {live?.reason && !entered && (
            <span className="text-[9px] text-zinc-500 max-w-[130px] leading-tight">{live.reason}</span>
          )}
          {(row.error || live?.error) && (
            <span className="text-[9px] text-red-400 max-w-[130px] leading-tight">{row.error || live?.error}</span>
          )}
        </div>
      </td>

      {/* ── CE / PE leg values ── */}
      <LegCell leg="CE" row={row} value={ceLtp} entered={entered} busy={busy} disabled={disabled}
        onScale={onScale} onExitLeg={onExitLeg} className="border-l border-zinc-800" />
      <LegCell leg="PE" row={row} value={peLtp} entered={entered} busy={busy} disabled={disabled}
        onScale={onScale} onExitLeg={onExitLeg} />

      {/* ── Level exits ── */}
      <td className="py-2 px-2 border-l border-zinc-800">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1.5">
            <FieldLabel title="Exit when the underlying trades at or above this">H↑</FieldLabel>
            <NumField value={row.exits.spotHigh} width="w-20" disabled={disabled}
              onCommit={v => onExitsChange(row.id, { spotHigh: v })} />
            <FieldLabel title="Exit when the underlying trades at or below this">L↓</FieldLabel>
            <NumField value={row.exits.spotLow} width="w-20" disabled={disabled}
              onCommit={v => onExitsChange(row.id, { spotLow: v })} />
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <PillToggle
              on={row.exits.vwap}
              disabled={disabled}
              label="VW"
              onChange={v => onExitsChange(row.id, { vwap: v })}
              title="Exit when the combined premium crosses its session VWAP against you — above VWAP for a short, below for a long"
            />
            <FieldLabel title="Exit at this rupee loss on the pair">SL ₹</FieldLabel>
            <NumField value={row.exits.slRupees} width="w-20" min={0} disabled={disabled}
              onCommit={v => onExitsChange(row.id, { slRupees: v })} />
            <FieldLabel title="Exit when the premium has moved this multiple against you. Must be greater than 1.">×</FieldLabel>
            <NumField value={row.exits.slMult} width="w-14" min={0} disabled={disabled}
              onCommit={v => onExitsChange(row.id, { slMult: v })} />
          </div>
          {live?.vwap != null && live.vwap > 0 && (
            <span className="text-[9px] text-zinc-500 font-mono">VWAP {live.vwap.toFixed(2)}</span>
          )}
          <div className="flex items-center gap-1.5 pt-0.5">
            <MiniButton disabled={disabled}
              onClick={() => onExitsChange(row.id, {
                spotHigh: null, spotLow: null, vwap: false, slRupees: null, slMult: null,
              })}
              title="Clear every level exit on this row">
              ✕ Clear
            </MiniButton>
            <MiniButton tone="ghostRed" disabled={disabled || entered} onClick={() => onRemove(row.id)}
              title={entered ? 'Close the position before removing the row' : 'Remove this row'}>
              Delete
            </MiniButton>
          </div>
        </div>
      </td>
    </tr>
  );
}

/** One option leg: its live value, scale in/out chevrons and a per-leg exit. */
function LegCell({ leg, row, value, entered, busy, disabled, onScale, onExitLeg, className }: {
  leg: 'CE' | 'PE';
  row: FocusRow;
  value: number;
  entered: boolean;
  busy: boolean;
  disabled: boolean;
  onScale: (rowId: string, leg: 'CE' | 'PE', delta: 1 | -1) => void;
  onExitLeg: (rowId: string, leg: 'CE' | 'PE') => void;
  className?: string;
}) {
  const qty = row.fill?.qty ?? 0;
  // Leg value at market, not P&L: what this leg is worth right now.
  const legValue = entered && qty > 0 ? value * qty : null;

  return (
    <td className={cn('py-2 px-2 text-right', className)}>
      <div className="flex flex-col items-end gap-1">
        <span className="font-mono text-[12px] tabular-nums text-zinc-200">
          {legValue !== null ? `₹${Math.round(legValue).toLocaleString('en-IN')}` : fmtPx(value)}
        </span>
        {entered && (
          <div className="flex items-center gap-1">
            <MiniButton disabled={disabled || busy} onClick={() => onScale(row.id, leg, 1)}
              title={`Add one lot to the ${leg} leg`}>+</MiniButton>
            <MiniButton disabled={disabled || busy} onClick={() => onScale(row.id, leg, -1)}
              title={`Reduce the ${leg} leg by one lot`}>−</MiniButton>
            <MiniButton tone="ghostRed" disabled={disabled || busy} onClick={() => onExitLeg(row.id, leg)}
              title={`Close the ${leg} leg at market`}>Exit</MiniButton>
          </div>
        )}
      </div>
    </td>
  );
}

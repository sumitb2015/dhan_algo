'use client';

/**
 * The four auxiliary views behind the title-bar buttons: Exit Rules, Risk / MTM,
 * Order Book and Cards.
 *
 * Each is a read-only lens over state that already exists elsewhere on the page.
 * Exit Rules in particular earns its place: the level exits are spread across
 * three groups and a dozen rows, and "what will actually fire, and in what
 * order" is not answerable by scanning the table.
 */

import React, { useMemo } from 'react';
import { cn } from '@/lib/utils';
import { Stat } from '../IntradayTerminalPanels';
import { TabTable, type SortState } from '../Scalper';
import type { FocusConfig, FocusRow, FocusGroup } from '@/lib/focusTool';
import type { WorkerStatus, WorkerStatusRow } from '@/lib/focusStore';
import { StateBadge, MiniButton } from './FocusControls';

export type FocusView = 'table' | 'exit-rules' | 'risk' | 'orders' | 'cards';

function inr(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return `${n < 0 ? '-' : ''}₹${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

function tone(n: number): 'up' | 'down' | 'neutral' {
  return n > 0 ? 'up' : n < 0 ? 'down' : 'neutral';
}

// ─── Exit Rules ───────────────────────────────────────────────────

/**
 * Every rule that could close a row, listed in the precedence the worker
 * actually applies. This mirrors evaluate_exit — if you reorder the ladder
 * there, reorder it here.
 */
function rulesFor(row: FocusRow, group: FocusGroup): { label: string; detail: string }[] {
  const out: { label: string; detail: string }[] = [];
  out.push({ label: '1 · Bell', detail: 'Intraday auto-exit at 15:17' });
  if (group.bookExit.enabled && (group.bookExit.spotHigh || group.bookExit.spotLow)) {
    const parts = [
      group.bookExit.spotHigh ? `≥ ${group.bookExit.spotHigh}` : null,
      group.bookExit.spotLow ? `≤ ${group.bookExit.spotLow}` : null,
    ].filter(Boolean).join(' or ');
    out.push({ label: '2 · Book exit', detail: `${group.underlying} spot ${parts}` });
  }
  if (row.exitTime) out.push({ label: '3 · Exit time', detail: row.exitTime });
  if (row.exits.spotHigh) out.push({ label: '4 · H↑', detail: `spot ≥ ${row.exits.spotHigh}` });
  if (row.exits.spotLow) out.push({ label: '4 · L↓', detail: `spot ≤ ${row.exits.spotLow}` });
  if (row.exits.vwap) {
    out.push({
      label: '5 · VWAP',
      detail: row.side === 'SELL' ? 'premium ≥ session VWAP' : 'premium ≤ session VWAP',
    });
  }
  if (row.exits.slRupees) out.push({ label: '6 · SL ₹', detail: `loss ≥ ₹${row.exits.slRupees}` });
  if (row.exits.slMult) {
    out.push({
      label: '6 · SL ×',
      detail: row.side === 'SELL'
        ? `premium ≥ ${row.exits.slMult}× entry`
        : `premium ≤ entry ÷ ${row.exits.slMult}`,
    });
  }
  return out;
}

export function ExitRulesView({ config }: { config: FocusConfig }) {
  const active = config.groups.flatMap(g =>
    g.rows.filter(r => r.state === 'ARMED' || r.state === 'ENTERED').map(r => ({ group: g, row: r })));

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2">
        <p className="text-[11px] text-zinc-400 leading-relaxed">
          Rules are evaluated top-down and the <strong className="text-zinc-200">first match wins</strong>.
          The global Target / Stop / Trail budget outranks everything listed here.
          Any spot-based rule is skipped entirely on a tick where the underlying quote failed —
          a missing price is treated as unknown, never as a breach.
        </p>
      </div>

      {active.length === 0 ? (
        <div className="py-8 text-center text-[11px] text-zinc-500">
          No armed or open rows — nothing is being watched.
        </div>
      ) : active.map(({ group, row }) => (
        <div key={`${group.underlying}-${row.id}`} className="rounded-lg border border-zinc-800 bg-zinc-900">
          <div className="flex items-center gap-2 px-3 py-1.5 border-b border-zinc-800">
            <span className="text-xs font-bold text-white">{group.underlying}</span>
            <span className="text-[11px] text-zinc-400 font-mono">
              {row.side} {row.lots} lot{row.lots > 1 ? 's' : ''}
              {row.offset === 0 ? ' straddle' : ` strangle ±${row.offset}`}
            </span>
            <StateBadge state={row.state} />
            {row.entryTime && <span className="text-[10px] text-zinc-500">enters {row.entryTime}</span>}
          </div>
          <ul className="divide-y divide-zinc-800">
            {rulesFor(row, group).map((r, i) => (
              <li key={i} className="flex items-center justify-between gap-3 px-3 py-1">
                <span className="text-[11px] font-bold text-zinc-300 whitespace-nowrap">{r.label}</span>
                <span className="text-[11px] text-zinc-400 font-mono text-right">{r.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

// ─── Risk / MTM ───────────────────────────────────────────────────

export function RiskView({ config, status }: { config: FocusConfig; status: WorkerStatus | null }) {
  const pnl = status?.pnl;
  const total = pnl?.total ?? 0;
  const peak = pnl?.peak ?? 0;
  const lock = pnl?.lock ?? null;
  const trailState = pnl?.trailState ?? 'INACTIVE';

  // How much room is left before each configured brake fires.
  const target = config.risk.enabled ? config.risk.targetRs : null;
  const stop = config.risk.enabled ? config.risk.stopRs : null;

  const groupPnl = (status?.groups ?? []).map(g => ({
    underlying: g.underlying,
    pnl: (g.rows ?? []).reduce((a, r) => a + (r.pnl ?? 0), 0),
    open: (g.rows ?? []).filter(r => r.state === 'ENTERED').length,
  }));

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Tile label="Realised" value={inr(pnl?.realised)} t={tone(pnl?.realised ?? 0)} />
        <Tile label="Unrealised" value={inr(pnl?.unrealised)} t={tone(pnl?.unrealised ?? 0)} />
        <Tile label="Total" value={inr(total)} t={tone(total)} />
        <Tile label="Session peak" value={inr(peak)} t="neutral" />
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2.5">
        <h3 className="text-xs font-bold text-white uppercase tracking-wide mb-2">Account budget</h3>
        <div className="flex items-center gap-6 flex-wrap">
          <Stat label="Target" value={target ? inr(target) : 'off'}
            hint="Closes every open row once total P&L reaches this" />
          <Stat label="Stop" value={stop ? `-${inr(stop)}` : 'off'}
            hint="Closes every open row once total P&L falls to this loss" />
          <Stat label="Trail" value={config.trail.enabled ? trailState : 'off'}
            tone={trailState === 'ARMED' ? 'up' : trailState === 'DORMANT' ? 'warn' : 'neutral'}
            hint="Dormant until P&L clears TRIGGER, then a floor that ratchets up with each new peak and never falls" />
          <Stat label="Locked floor" value={lock === null ? '—' : inr(lock)}
            hint="Total P&L falling to this closes everything" />
          <Stat label="Room to stop"
            value={stop ? inr(total + stop) : '—'}
            tone={stop && total + stop < 0 ? 'down' : 'neutral'}
            hint="How much further P&L can fall before the stop fires" />
        </div>
        {status?.message && (
          <p className="mt-2 text-[11px] text-amber-400">{status.message}</p>
        )}
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2.5">
        <h3 className="text-xs font-bold text-white uppercase tracking-wide mb-2">By underlying</h3>
        {groupPnl.length === 0 ? (
          <p className="text-[11px] text-zinc-500">No worker data yet.</p>
        ) : (
          <div className="flex items-center gap-6 flex-wrap">
            {groupPnl.map(g => (
              <Stat key={g.underlying} label={g.underlying} value={inr(g.pnl)} tone={tone(g.pnl)}
                hint={`${g.open} open row${g.open === 1 ? '' : 's'}`} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Tile({ label, value, t }: { label: string; value: string; t: 'up' | 'down' | 'neutral' }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2">
      <p className="text-[9px] font-bold text-zinc-500 uppercase tracking-[0.14em]">{label}</p>
      <p className={cn('text-lg font-bold tabular-nums',
        t === 'up' ? 'text-emerald-400' : t === 'down' ? 'text-red-400' : 'text-zinc-100')}>
        {value}
      </p>
    </div>
  );
}

// ─── Order Book ───────────────────────────────────────────────────

export function OrderBookView({ orders, sort, onSort, onRefresh, loading, error }: {
  orders: Record<string, unknown>[];
  sort: SortState;
  onSort: (key: string) => void;
  onRefresh: () => void;
  loading: boolean;
  error: string | null;
}) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-3 py-1.5 border-b border-zinc-800">
        <h3 className="text-xs font-bold text-white uppercase tracking-wide">
          Broker order book
          <span className="ml-2 font-normal text-[10px] text-zinc-500 normal-case">
            every order on the account, not only this tool&apos;s
          </span>
        </h3>
        <MiniButton onClick={onRefresh} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</MiniButton>
      </div>
      {error && <p className="px-3 py-2 text-[11px] text-red-400">{error}</p>}
      <TabTable tab="orders" data={orders} sort={sort} onSort={onSort} />
    </div>
  );
}

// ─── Cards ────────────────────────────────────────────────────────

/** The same rows as the table, one card each — easier to read at a glance when
 *  a handful of positions are open and the config is settled. */
export function CardsView({ config, status }: { config: FocusConfig; status: WorkerStatus | null }) {
  const byId = useMemo(() => {
    const m: Record<string, WorkerStatusRow> = {};
    for (const g of status?.groups ?? []) for (const r of g.rows ?? []) m[r.id] = r;
    return m;
  }, [status]);

  const cards = config.groups.flatMap(g => g.rows.map(row => ({ group: g, row })));

  if (cards.length === 0) {
    return <div className="py-8 text-center text-[11px] text-zinc-500">No rows configured.</div>;
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
      {cards.map(({ group, row }) => {
        const live = byId[row.id];
        const state = live?.state ?? row.state;
        const pnl = live?.pnl ?? 0;
        return (
          <div key={`${group.underlying}-${row.id}`}
            className={cn('rounded-lg border bg-zinc-900 p-3 flex flex-col gap-2',
              state === 'ENTERED' ? 'border-emerald-500/30' : 'border-zinc-800')}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-bold text-white">{group.underlying}</span>
              <StateBadge state={state} title={live?.reason} />
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[11px] text-zinc-400 font-mono">
                {row.side} {row.lots}L · {row.offset === 0 ? 'straddle' : `strangle ±${row.offset}`}
              </span>
              <span className={cn('text-sm font-bold tabular-nums',
                pnl > 0 ? 'text-emerald-400' : pnl < 0 ? 'text-red-400' : 'text-zinc-400')}>
                {inr(pnl)}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2 text-[11px] font-mono text-zinc-400">
              <span>
                {row.fill ? `${row.fill.peStrike} / ${row.fill.ceStrike}` :
                  live?.ceStrike ? `${live.peStrike} / ${live.ceStrike}` : '—'}
              </span>
              <span className="text-zinc-200">{live?.combined ? live.combined.toFixed(2) : '—'}</span>
            </div>
            <div className="flex items-center gap-3 text-[10px] text-zinc-500">
              {row.entryTime && <span>in {row.entryTime}</span>}
              {row.exitTime && <span>out {row.exitTime}</span>}
              <span>DTE {row.dte}</span>
            </div>
            {live?.reason && <p className="text-[10px] text-zinc-500 leading-tight">{live.reason}</p>}
          </div>
        );
      })}
    </div>
  );
}

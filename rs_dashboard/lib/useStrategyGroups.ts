'use client';

import { useState, useCallback, useMemo } from 'react';

/**
 * Shared plumbing for the two strategy control pages (/strategies and /strategies-plus).
 *
 * Both poll the same three endpoints and present the same two concepts — a portfolio
 * summary, and strategy entries grouped by underlying behind collapsible headers — but
 * they render different item shapes: /strategies groups registry entries (one card per
 * strategy), /strategies-plus groups instance rows (one row per running duplicate). So
 * the grouping helper is generic over the item type and takes accessors, rather than
 * assuming either shape.
 */

export interface PortfolioData {
  success: boolean;
  available_funds: number;
  total_realized_pnl: number;
  total_unrealized_pnl: number;
  total_pnl: number;
  positions: any[];
  error?: string;
}

/** Running instances of one /api/strategies registry entry (primary + "+ Add run" duplicates). */
export function runningInstancesOf(item: any): any[] {
  return Object.values(item?.instances || {}).filter((st: any) => st?.status !== 'STOPPED');
}

/**
 * The session P&L of one instance, for summing across instances.
 *
 * NOT `total_pnl`: for multi-cycle strategies that is the OPEN cycle's P&L, so a run that
 * banked a winner and re-entered flat reports 0 (see save_state() in
 * nifty_advanced_imbalance.py — `daily_pnl` is banked + open cycle). Strategies that never
 * cycle only publish `total_pnl`, hence the fallback. Individual cards deliberately keep
 * showing `total_pnl` as their headline; only aggregates need the day's number.
 */
export function sessionPnlOf(state: any): number {
  return state?.daily_pnl ?? state?.total_pnl ?? 0;
}

export const inr = (n: number, digits = 0) =>
  `₹${n.toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;

export const signedInr = (n: number, digits = 0) =>
  `${n >= 0 ? '+' : '-'}${inr(Math.abs(n), digits)}`;

/* ── Collapsible group headers ───────────────────────────────────────────── */

export interface GroupCollapse {
  /** Explicit choices only. Absent key = caller's default applies. */
  isOpen: (underlying: string, defaultOpen: boolean) => boolean;
  toggle: (underlying: string, currentlyOpen: boolean) => void;
  setAll: (underlyings: string[], open: boolean) => void;
  /** Pin the named groups open, without disturbing groups already decided. */
  ensureOpen: (underlyings: string[]) => void;
}

/**
 * Tracks which index groups are expanded. Stores only decided groups, so an undecided one
 * falls back to the caller's default (open when something in it is running).
 *
 * The "running" default alone is not enough, which is why `ensureOpen` exists: the pages
 * poll every 2s, so the instant a group's last strategy goes STOPPED the default would flip
 * and the group would fold up while the user is still looking at the card that just exited.
 * Callers pin auto-opened groups on sight; from then on only a click closes them.
 */
export function useGroupCollapse(): GroupCollapse {
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const isOpen = useCallback(
    (underlying: string, defaultOpen: boolean) => open[underlying] ?? defaultOpen,
    [open],
  );

  const toggle = useCallback((underlying: string, currentlyOpen: boolean) => {
    setOpen(prev => ({ ...prev, [underlying]: !currentlyOpen }));
  }, []);

  // Merges rather than replaces: with a search filter active, the groups on screen are a
  // subset, and replacing would silently discard choices for the ones filtered out.
  const setAll = useCallback((underlyings: string[], value: boolean) => {
    setOpen(prev => ({ ...prev, ...Object.fromEntries(underlyings.map(u => [u, value])) }));
  }, []);

  const ensureOpen = useCallback((underlyings: string[]) => {
    setOpen(prev => {
      const missing = underlyings.filter(u => prev[u] === undefined);
      // Returning `prev` unchanged is what keeps this safe to call from a render-driven
      // effect on every 2s poll — no new object, no re-render, no loop.
      if (missing.length === 0) return prev;
      return { ...prev, ...Object.fromEntries(missing.map(u => [u, true])) };
    });
  }, []);

  return { isOpen, toggle, setAll, ensureOpen };
}

/* ── Grouping by underlying ──────────────────────────────────────────────── */

export interface UnderlyingGroup<T> {
  underlying: string;
  items: T[];
  /** Live instances the caller's `liveStatesOf` reported for this group. */
  runningCount: number;
  /** Summed session P&L of those live instances — see sessionPnlOf. */
  pnl: number;
}

/**
 * Groups items by underlying, preserving first-seen order. Callers pass items in the
 * registry's key order, so group order follows STRATEGIES_METADATA — there is no second
 * ordering list to keep in sync. Items missing an underlying land in 'OTHER' rather than
 * being dropped.
 *
 * @param liveStatesOf returns the running instance states an item contributes, which is
 *   what runningCount and pnl are computed from.
 */
export function groupByUnderlying<T>(
  items: T[],
  underlyingOf: (item: T) => string | undefined,
  liveStatesOf: (item: T) => any[],
): UnderlyingGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const underlying = underlyingOf(item) || 'OTHER';
    const bucket = groups.get(underlying);
    if (bucket) bucket.push(item);
    else groups.set(underlying, [item]);
  }
  return [...groups.entries()].map(([underlying, groupItems]) => {
    const live = groupItems.flatMap(liveStatesOf);
    return {
      underlying,
      items: groupItems,
      runningCount: live.length,
      pnl: live.reduce((n, st: any) => n + sessionPnlOf(st), 0),
    };
  });
}

/** Memoized `groupByUnderlying`. Accessors must be stable (module-scope or useCallback). */
export function useUnderlyingGroups<T>(
  items: T[],
  underlyingOf: (item: T) => string | undefined,
  liveStatesOf: (item: T) => any[],
): UnderlyingGroup<T>[] {
  return useMemo(
    () => groupByUnderlying(items, underlyingOf, liveStatesOf),
    [items, underlyingOf, liveStatesOf],
  );
}

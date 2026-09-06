'use client';

/**
 * Landing view for the positions-analytics pages: open option positions grouped
 * by underlying, one card per underlying linking into the full analysis. This is
 * what the analysis page's "Back to Positions" returns to.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, RefreshCw, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useBrokerSelector, scalperRoute, BROKER_LABELS, type Broker } from '@/hooks/useBrokerSelector';
import { ANALYTICS_UNDERLYINGS, underlyingOfSymbol, type AnalyticsUnderlying } from '@/lib/analyticsUnderlyings';
import { todayIso } from '@/components/crudeoil/format';
import type { ScalperPosition } from '@/lib/zerodhaShape';
import NavBar from './NavBar';

const BROKERS: Broker[] = ['dhan', 'kotak'];
const POLL_MS = 5_000;

function fmtInr(n: number): string {
  const abs = Math.abs(n);
  return `${n < 0 ? '-' : ''}₹${abs.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

function pnlColor(n: number): string {
  return n > 0 ? 'text-emerald-400' : n < 0 ? 'text-red-400' : 'text-zinc-400';
}

interface Group {
  underlying: AnalyticsUnderlying;
  legs: number;
  shorts: number;
  longs: number;
  pnl: number;
  /** Legs reporting no live price. `pnl` still uses the broker's own realized/unrealized split for these. */
  unpriced: number;
}

export default function PositionsAnalyticsHome() {
  const { broker, setBroker, authenticatedBrokers, authChecked } = useBrokerSelector();
  const [positions, setPositions] = useState<ScalperPosition[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);

  const brokerRef = useRef(broker);
  useEffect(() => { brokerRef.current = broker; }, [broker]);

  const availableBrokers = useMemo(
    () => BROKERS.filter((b) => authenticatedBrokers.includes(b)),
    [authenticatedBrokers],
  );
  useEffect(() => {
    if (authChecked && !BROKERS.includes(broker)) setBroker('dhan');
  }, [authChecked, broker, setBroker]);

  const load = useCallback(async () => {
    const forBroker = brokerRef.current;
    try {
      const res = await fetch(scalperRoute(forBroker, 'positions'));
      const json = await res.json();
      if (brokerRef.current !== forBroker) return;
      if (!json?.success) { setError(json?.error ?? 'Failed to fetch positions'); return; }
      setPositions((json.data ?? []) as ScalperPosition[]);
      setError(null);
      setRefreshedAt(new Date());
    } catch (err) {
      setError(String((err as Error).message ?? err));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load, broker]);

  const groups = useMemo<Group[]>(() => {
    const byUnderlying = new Map<AnalyticsUnderlying, Group>();
    for (const u of ANALYTICS_UNDERLYINGS) {
      byUnderlying.set(u, { underlying: u, legs: 0, shorts: 0, longs: 0, pnl: 0, unpriced: 0 });
    }
    for (const p of positions) {
      if (!p || !p.netQty) continue;
      const u = underlyingOfSymbol(p.tradingSymbol ?? '');
      if (!u) continue;
      const g = byUnderlying.get(u)!;
      g.legs += 1;
      if (p.netQty < 0) g.shorts += 1; else g.longs += 1;
      // Trust the broker's own realized/unrealized split rather than
      // re-deriving unrealized from lastTradedPrice: Dhan's v2 /positions API
      // omits lastTradedPrice entirely (see the comment at Scalper.tsx:293),
      // so deriving from it made every Dhan leg "unpriced" and every card's
      // P&L realized-only. Dhan's own unrealizedProfit is populated even
      // without a reported LTP; Kotak's shim already derives the same fields
      // itself (0 when its LTP is unknown).
      g.pnl += (p.realizedProfit ?? 0) + (p.unrealizedProfit ?? 0);
      if (!(p.lastTradedPrice > 0)) g.unpriced += 1;
    }
    return [...byUnderlying.values()];
  }, [positions]);

  return (
    <div className="min-h-screen text-zinc-300">
      <div className="sticky top-0 z-30 border-b border-zinc-800 bg-zinc-950/80 px-4 py-3 backdrop-blur-md">
        <div className="mx-auto flex flex-wrap items-center gap-3">
          <h1 className="text-sm font-bold text-white">NSE / BSE Options Analytics</h1>
          <span className="rounded bg-zinc-800 px-2 py-0.5 font-mono text-xs text-zinc-400">
            DATA: {todayIso()}
          </span>
          {availableBrokers.length > 1 && (
            <select
              value={broker}
              onChange={(e) => setBroker(e.target.value as Broker)}
              className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200"
            >
              {availableBrokers.map((b) => <option key={b} value={b}>{BROKER_LABELS[b]}</option>)}
            </select>
          )}
          <button type="button" onClick={load}
            className="flex items-center gap-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-300 hover:text-white">
            <RefreshCw className="h-3 w-3" /> Refresh
          </button>
          {refreshedAt && (
            <span className="font-mono text-[10px] text-zinc-500">
              {refreshedAt.toLocaleTimeString('en-IN', { hour12: false })}
            </span>
          )}
          <span className="w-px h-5 bg-zinc-800 shrink-0 ml-auto" />
          <NavBar />
        </div>
      </div>

      <div className="mx-auto max-w-4xl space-y-4 px-4 py-6">
        <p className="text-xs text-zinc-500">
          Pick an underlying to analyse combined payoff, Greeks and P&amp;L for its open positions.
          Positions are read from {BROKER_LABELS[broker]}; chain, greeks, IV and OI always come from Dhan.
        </p>

        {error && (
          <div className="flex items-center gap-2 rounded border border-rose-800 bg-rose-950 px-3 py-2 text-xs text-rose-300">
            <AlertTriangle className="h-4 w-4" /> {error}
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {groups.map((g) => (
            <Link
              key={g.underlying}
              href={`/options-analytics/${g.underlying}`}
              className={cn(
                'group rounded-xl border bg-zinc-950 p-4 transition-colors',
                g.legs > 0
                  ? 'border-zinc-700 hover:border-sky-600 hover:bg-zinc-900'
                  : 'border-zinc-800 hover:border-zinc-700',
              )}
            >
              <div className="flex items-center gap-2">
                <span className="text-base font-bold text-white">{g.underlying}</span>
                <ArrowRight className="h-3.5 w-3.5 text-zinc-500 transition-transform group-hover:translate-x-0.5 group-hover:text-sky-400" />
              </div>

              {!loaded ? (
                <p className="mt-2 text-xs text-zinc-500">Loading…</p>
              ) : g.legs === 0 ? (
                <p className="mt-2 text-xs text-zinc-500">No open option positions</p>
              ) : (
                <>
                  <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 font-mono text-xs tabular-nums">
                    <span className="text-zinc-400">{g.legs} leg{g.legs > 1 ? 's' : ''}</span>
                    <span className="text-rose-300">{g.shorts} short</span>
                    <span className="text-sky-300">{g.longs} long</span>
                  </div>
                  <div className={cn('mt-1 font-mono text-lg font-bold tabular-nums', pnlColor(g.pnl))}>
                    {fmtInr(g.pnl)}
                  </div>
                  {g.unpriced > 0 && (
                    <p className="mt-0.5 text-[10px] text-amber-400">
                      {g.unpriced} leg(s) report no live price — P&amp;L above uses the broker&apos;s own figure,
                      which may be stale for these
                    </p>
                  )}
                </>
              )}
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

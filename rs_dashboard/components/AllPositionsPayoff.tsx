'use client';

/**
 * Live combined payoff diagram for every underlying with an open option book,
 * all on one page. One positions poll is shared across underlyings (the
 * scalper positions endpoint already returns the whole book); each underlying
 * then gets its own chain poll and payoff chart via useUnderlyingPayoff.
 *
 * Deliberately excludes margin/Kelly sizing (see useUnderlyingPayoff's header
 * comment) — this page is a live glance across the whole book, not the
 * detailed single-underlying workbench at /options-analytics/[underlying].
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, RefreshCw, AlertTriangle, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useBrokerSelector, scalperRoute, BROKER_LABELS, type Broker } from '@/hooks/useBrokerSelector';
import { ANALYTICS_UNDERLYINGS, underlyingOfSymbol, type AnalyticsUnderlying } from '@/lib/analyticsUnderlyings';
import { buildInstrumentIndex, type InstrumentRow } from '@/lib/positionLegs';
import { useUnderlyingPayoff } from '@/lib/useUnderlyingPayoff';
import { todayIso, fmtExpiryShort } from '@/components/crudeoil/format';
import type { ScalperPosition } from '@/lib/zerodhaShape';

import PositionsPayoffChart, { pnlAt } from '@/components/analytics/PositionsPayoffChart';
import { StatChip } from '@/components/analytics/PayoffMetricStrip';

const BROKERS: Broker[] = ['dhan', 'kotak'];
const POSITIONS_POLL_MS = 15_000;
const FUNDS_POLL_MS = 15_000;

function fmtInr(n: number): string {
  const abs = Math.abs(n);
  return `${n < 0 ? '-' : ''}₹${abs.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

function pnlColor(n: number): string {
  return n > 0 ? 'text-emerald-400' : n < 0 ? 'text-red-400' : 'text-zinc-400';
}

function UnderlyingCard({
  underlying, positions, rawPositions, broker, instruments,
}: {
  underlying: AnalyticsUnderlying;
  positions: ScalperPosition[];
  rawPositions: Record<string, unknown>[];
  broker: Broker;
  instruments: Map<string, InstrumentRow> | undefined;
}) {
  const [showOi, setShowOi] = useState(true);

  const data = useUnderlyingPayoff(underlying, positions, rawPositions, broker, instruments);
  const { legs, spot, spotChangePct, chainLoading, chainError, expiryCurve, targetCurve, stats, oiBars, finalExpiry, rollup } = data;

  const projected = expiryCurve.length ? pnlAt(expiryCurve, spot) : null;

  return (
    <section className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-950 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-bold text-white">{underlying}</h2>
        {chainLoading && <Loader2 className="h-3 w-3 animate-spin text-zinc-500" />}
        {spot > 0 && (
          <span className={cn(
            'rounded border px-2 py-0.5 font-mono text-[11px] font-bold tabular-nums',
            spotChangePct >= 0
              ? 'border-emerald-500 bg-emerald-500/10 text-emerald-400'
              : 'border-red-500 bg-red-500/10 text-red-400',
          )}>
            {spot.toLocaleString('en-IN', { maximumFractionDigits: 2 })} ({spotChangePct >= 0 ? '+' : ''}{spotChangePct.toFixed(2)}%)
          </span>
        )}
        <span className="font-mono text-[11px] text-zinc-500">{legs.length} leg(s)</span>
        <Link
          href={`/options-analytics/${underlying}`}
          className="ml-auto flex items-center gap-1 text-[11px] text-zinc-400 hover:text-white"
        >
          Full analysis <ArrowRight className="h-3 w-3" />
        </Link>
      </div>

      {chainError && (
        <div className="flex items-center gap-2 rounded border border-amber-800 bg-amber-950 px-2.5 py-1.5 text-[11px] text-amber-300">
          <AlertTriangle className="h-3.5 w-3.5" /> {chainError}
        </div>
      )}

      {stats && (
        <div className="flex flex-wrap items-center gap-y-2 rounded-lg border border-zinc-800 bg-zinc-900 px-2 py-2">
          <StatChip
            label="Max Profit"
            value={stats.maxProfit === 'Unlimited' ? 'Unlimited' : fmtInr(stats.maxProfit)}
            color="text-emerald-400"
          />
          <StatChip
            label="Max Loss"
            value={stats.maxLoss === 'Unlimited' ? 'Unlimited' : fmtInr(stats.maxLoss as number)}
            color={stats.maxLoss === 'Unlimited' ? 'text-rose-400' : 'text-red-400'}
          />
          <StatChip
            label="Breakeven"
            value={stats.breakevensExpiry.length
              ? stats.breakevensExpiry.map((b) => Math.round(b).toLocaleString('en-IN')).join(', ')
              : '—'}
            color="text-amber-400"
          />
          <StatChip label="Live P&L" value={fmtInr(rollup.total)} color={pnlColor(rollup.total)} />
          <StatChip
            label="At Expiry (spot)"
            value={projected === null ? '—' : fmtInr(projected)}
            color={projected !== null ? pnlColor(projected) : undefined}
          />
        </div>
      )}

      <PositionsPayoffChart
        expiryCurve={expiryCurve}
        targetCurve={targetCurve}
        breakevens={stats?.breakevensExpiry ?? []}
        spot={spot}
        targetSpot={spot}
        expiryLabel={finalExpiry ? fmtExpiryShort(finalExpiry) : '—'}
        targetLabel="Today"
        oiBars={oiBars}
        showOi={showOi}
        onToggleOi={() => setShowOi((v) => !v)}
        onZoomIn={() => {}}
        onZoomOut={() => {}}
        canZoomIn={false}
        canZoomOut={false}
        emptyReason={
          !legs.length ? `No open ${underlying} option positions on ${BROKER_LABELS[broker]}`
          : !spot ? 'Waiting for spot price from the option chain…'
          : undefined
        }
      />
    </section>
  );
}

export default function AllPositionsPayoff() {
  const { broker, setBroker, authenticatedBrokers, authChecked } = useBrokerSelector();
  const [positions, setPositions] = useState<ScalperPosition[]>([]);
  const [rawPositions, setRawPositions] = useState<Record<string, unknown>[]>([]);
  const [instruments, setInstruments] = useState<Map<string, InstrumentRow> | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);
  const [funds, setFunds] = useState<number | null>(null);

  const brokerRef = useRef(broker);
  useEffect(() => { brokerRef.current = broker; }, [broker]);

  const positionsSigRef = useRef<string>('');

  const availableBrokers = useMemo(
    () => BROKERS.filter((b) => authenticatedBrokers.includes(b)),
    [authenticatedBrokers],
  );
  useEffect(() => {
    if (authChecked && !BROKERS.includes(broker)) setBroker('dhan');
  }, [authChecked, broker, setBroker]);

  // Dhan needs no instrument cache. Non-Dhan brokers cache one file per
  // underlying, so every underlying present in the book is fetched and merged
  // into a single lookup keyed by trading symbol (no cross-underlying collisions).
  useEffect(() => {
    let cancelled = false;
    const fetchAll = broker === 'dhan'
      ? Promise.resolve([])
      : Promise.all(ANALYTICS_UNDERLYINGS.map((u) =>
          fetch(`/api/options/instruments?broker=${broker}&underlying=${u.toLowerCase()}`)
            .then((r) => r.json())
            .catch(() => null),
        ));
    fetchAll.then((results) => {
      if (cancelled) return;
      const rows: InstrumentRow[] = [];
      for (const j of results) if (j?.available) rows.push(...(j.data as InstrumentRow[]));
      setInstruments(rows.length ? buildInstrumentIndex(rows) : undefined);
    });
    return () => { cancelled = true; };
  }, [broker]);

  const load = useCallback(async () => {
    const forBroker = brokerRef.current;
    try {
      const res = await fetch(scalperRoute(forBroker, 'positions'));
      const json = await res.json();
      if (brokerRef.current !== forBroker) return;
      if (!json?.success) { setError(json?.error ?? 'Failed to fetch positions'); return; }
      const rows = (json.data ?? []) as Record<string, unknown>[];
      const sig = JSON.stringify(rows);
      if (sig !== positionsSigRef.current) {
        positionsSigRef.current = sig;
        setRawPositions(rows);
        setPositions(rows as unknown as ScalperPosition[]);
      }
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
    const id = setInterval(load, POSITIONS_POLL_MS);
    return () => clearInterval(id);
  }, [load, broker]);

  useEffect(() => {
    let cancelled = false;
    const loadFunds = async () => {
      try {
        const res = await fetch(scalperRoute(brokerRef.current, 'funds'));
        const json = await res.json();
        if (cancelled || !json?.success) return;
        const bal = json.data?.availabelBalance ?? json.data?.availableBalance;
        setFunds(typeof bal === 'number' ? bal : null);
      } catch { /* funds are advisory */ }
    };
    loadFunds();
    const id = setInterval(loadFunds, FUNDS_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [broker]);

  const activeUnderlyings = useMemo(() => {
    const present = new Set<AnalyticsUnderlying>();
    for (const p of positions) {
      if (!p || !p.netQty) continue;
      const u = underlyingOfSymbol(p.tradingSymbol ?? '');
      if (u) present.add(u);
    }
    return ANALYTICS_UNDERLYINGS.filter((u) => present.has(u));
  }, [positions]);

  const totalPnl = useMemo(
    () => positions.reduce((sum, p) => (p && p.netQty ? sum + (p.realizedProfit ?? 0) + (p.unrealizedProfit ?? 0) : sum), 0),
    [positions],
  );

  return (
    <div className="min-h-screen text-zinc-300">
      <div className="sticky top-0 z-30 border-b border-zinc-800 bg-zinc-950/80 px-4 py-3 backdrop-blur-md">
        <div className="mx-auto flex flex-wrap items-center gap-3">
          <h1 className="text-sm font-bold text-white">Live Payoff — All Open Positions</h1>
          <span className="rounded bg-zinc-800 px-2 py-0.5 font-mono text-xs text-zinc-400">
            DATA: {todayIso()}
          </span>
          {loaded && (
            <span className={cn('font-mono text-xs font-bold tabular-nums', pnlColor(totalPnl))}>
              Total P&amp;L {fmtInr(totalPnl)}
            </span>
          )}
          {funds !== null && (
            <span className="font-mono text-[11px] text-zinc-500">Funds {fmtInr(funds)}</span>
          )}

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

          <Link href="/options-analytics"
            className="ml-auto text-xs text-zinc-400 hover:text-white">
            Positions Analytics →
          </Link>
        </div>
      </div>

      <div className="mx-auto space-y-4 px-4 py-5">
        <p className="text-xs text-zinc-500">
          Live combined payoff for every underlying with an open option book. Positions come from{' '}
          {BROKER_LABELS[broker]}; chain, greeks, IV and OI always come from Dhan. Each underlying is
          priced independently — spot, strikes and expiries do not mix across underlyings.
        </p>

        {error && (
          <div className="flex items-center gap-2 rounded border border-rose-800 bg-rose-950 px-3 py-2 text-xs text-rose-300">
            <AlertTriangle className="h-4 w-4" /> {error}
          </div>
        )}

        {!loaded ? (
          <p className="px-3 py-10 text-center text-xs text-zinc-500">Loading positions…</p>
        ) : activeUnderlyings.length === 0 ? (
          <div className="rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-10 text-center">
            <p className="text-sm text-zinc-400">No open option positions on {BROKER_LABELS[broker]}.</p>
            <Link href="/options-analytics" className="mt-2 inline-flex items-center gap-1 text-xs text-sky-400 hover:text-sky-300">
              Browse positions analytics <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
        ) : (
          <div className={cn('grid grid-cols-1 gap-4', activeUnderlyings.length > 1 && 'xl:grid-cols-2')}>
            {activeUnderlyings.map((u) => (
              <UnderlyingCard
                key={u}
                underlying={u}
                positions={positions}
                rawPositions={rawPositions}
                broker={broker}
                instruments={instruments}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

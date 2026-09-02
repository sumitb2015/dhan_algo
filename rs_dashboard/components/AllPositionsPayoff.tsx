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
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center justify-center w-6 h-6 rounded-md bg-emerald-500/10 border border-emerald-500/25 shrink-0">
          <span className="text-[10px] font-bold text-emerald-400">{underlying[0]}</span>
        </span>
        <h2 className="text-sm font-bold text-white tracking-tight">{underlying}</h2>
        {chainLoading && <Loader2 className="h-3 w-3 animate-spin text-zinc-500" />}
        {spot > 0 && (
          <span className={cn(
            'rounded-md border px-2 py-0.5 font-mono text-[11px] font-bold tabular-nums',
            spotChangePct >= 0
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
              : 'border-red-500/40 bg-red-500/10 text-red-400',
          )}>
            {spot.toLocaleString('en-IN', { maximumFractionDigits: 2 })} ({spotChangePct >= 0 ? '+' : ''}{spotChangePct.toFixed(2)}%)
          </span>
        )}
        <span className="font-mono text-[11px] text-zinc-500">{legs.length} leg(s)</span>
        <Link
          href={`/options-analytics/${underlying}`}
          className="ml-auto flex items-center gap-1 text-[11px] font-semibold text-zinc-400 hover:text-white"
        >
          Full analysis <ArrowRight className="h-3 w-3" />
        </Link>
      </div>

      {chainError && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-800/50 bg-amber-950/40 px-2.5 py-1.5 text-[11px] text-amber-300">
          <AlertTriangle className="h-3.5 w-3.5" /> {chainError}
        </div>
      )}

      {stats && (
        <div className="flex flex-wrap items-center gap-y-2 rounded-xl border border-zinc-800 bg-zinc-950/60 px-2 py-2">
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
              ? stats.breakevensExpiry.map((b) => {
                  const pct = spot > 0 ? ((b - spot) / spot) * 100 : null;
                  const pctStr = pct !== null ? ` (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)` : '';
                  return `${Math.round(b).toLocaleString('en-IN')}${pctStr}`;
                }).join(', ')
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
    <div className="flex flex-col min-h-screen bg-zinc-950 text-white">
      {/* Header */}
      <div className="sticky top-0 z-30 flex items-center justify-between gap-3 flex-wrap
                      px-6 py-3 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/25 shrink-0">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" className="text-emerald-400">
              <path d="M3 15c3-6 5-9 7-9s3 9 5 9 3-4 6-4" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M3 21h18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.4" />
            </svg>
          </div>
          <div>
            <p className="text-[9px] font-bold text-emerald-500 uppercase tracking-[0.18em] mb-0.5">
              Options · Live Book
            </p>
            <h1 className="text-sm font-bold text-white tracking-tight leading-none">Live Payoff — All Open Positions</h1>
            <p className="text-[10px] text-zinc-500 font-medium mt-1">
              Combined payoff per underlying, priced independently off the live chain
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <span className="rounded-md bg-zinc-900 border border-zinc-800 px-2 py-1 font-mono text-[10px] font-bold text-zinc-400 tabular-nums">
            DATA: {todayIso()}
          </span>
          {loaded && (
            <span className={cn(
              'rounded-md border px-2 py-1 font-mono text-[11px] font-bold tabular-nums',
              totalPnl > 0 ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                : totalPnl < 0 ? 'border-red-500/40 bg-red-500/10 text-red-400'
                : 'border-zinc-700 bg-zinc-900 text-zinc-400',
            )}>
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
              className="bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-mono font-semibold
                         rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-emerald-500"
            >
              {availableBrokers.map((b) => <option key={b} value={b}>{BROKER_LABELS[b]}</option>)}
            </select>
          )}

          <button type="button" onClick={load}
            className="flex items-center gap-1 rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs font-semibold text-zinc-300 hover:text-white hover:border-zinc-600">
            <RefreshCw className="h-3 w-3" /> Refresh
          </button>
          {refreshedAt && (
            <span className="font-mono text-[10px] text-zinc-500">
              {refreshedAt.toLocaleTimeString('en-IN', { hour12: false })}
            </span>
          )}

          <Link href="/options-analytics"
            className="flex items-center gap-1 text-xs font-semibold text-zinc-400 hover:text-white">
            Positions Analytics <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
      </div>

      {error && (
        <div className="mx-6 mt-3 px-3 py-2 bg-red-900/20 border border-red-700/40 rounded-lg text-xs text-red-400 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0" /> {error}
        </div>
      )}

      <div className="flex-1 flex flex-col gap-4 px-6 py-5 max-w-[1800px] w-full mx-auto">
        <p className="text-[11px] text-zinc-500">
          Positions come from {BROKER_LABELS[broker]}; chain, greeks, IV and OI always come from Dhan.
          Each underlying is priced independently — spot, strikes and expiries do not mix across underlyings.
        </p>

        {!loaded ? (
          <p className="px-3 py-24 text-center text-xs text-zinc-500">Loading positions…</p>
        ) : activeUnderlyings.length === 0 ? (
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 px-4 py-16 text-center">
            <p className="text-sm text-zinc-400">No open option positions on {BROKER_LABELS[broker]}.</p>
            <Link href="/options-analytics" className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-sky-400 hover:text-sky-300">
              Browse positions analytics <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
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

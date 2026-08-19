'use client';

/**
 * Per-underlying payoff data for the "all open positions" live dashboard.
 *
 * A slimmed-down sibling of the state built inline in components/PositionsAnalysis.tsx:
 * same leg-building / chain-joining / curve-building pipeline, but margin and Kelly
 * sizing are deliberately left out — computing standalone margin is a ~3s Python
 * spawn per underlying, which is fine for one underlying's dedicated page but would
 * serialize into a multi-second stall once N underlyings render side by side here.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  buildPositionLegs, legExpiries,
  type PositionLeg, type UnparseableLeg, type InstrumentRow,
} from '@/lib/positionLegs';
import {
  buildMultiExpiryCurve, computePayoffStats, daysBetweenDates,
  impliedVolFromPrice, lookupChainLegData, type ChainOc, type PayoffStats,
} from '@/lib/optionsStrategy';
import { STRIKE_STEP, lotSizeOverride, type AnalyticsUnderlying } from '@/lib/analyticsUnderlyings';
import { todayIso } from '@/components/crudeoil/format';
import type { ScalperPosition } from '@/lib/zerodhaShape';
import type { OiBar } from '@/components/analytics/PositionsPayoffChart';
import { legPnl } from '@/components/analytics/PositionsLegTable';

/** Dhan's option-chain API is rate limited (~1 call / 3.5 s per underlying). */
const CHAIN_SPACING_MS = 3_800;
const MAX_CHAIN_EXPIRIES = 2;
// The route itself serializes spawns per underlying to >=3.5s apart and caches
// each (underlying, expiry) response for 10s server-side, so re-polling faster
// than that cache TTL would just be wasted client requests. 15s keeps every
// underlying's cadence well clear of the rate limit even with several expiries.
const CHAIN_POLL_MS = 15_000;
const SPAN_PCT = 0.04;

export interface UnderlyingPayoffData {
  legs: PositionLeg[];
  unparseable: UnparseableLeg[];
  spot: number;
  spotChangePct: number;
  chainLoading: boolean;
  chainError: string | null;
  lotSize: number | null;
  expiryCurve: { spot: number; pnl: number }[];
  targetCurve: { spot: number; pnl: number }[] | null;
  stats: PayoffStats | null;
  oiBars: OiBar[];
  finalExpiry: string | null;
  bookExpiries: string[];
  rollup: { booked: number; unbooked: number; total: number; unknown: number };
}

export function useUnderlyingPayoff(
  underlying: AnalyticsUnderlying,
  positions: ScalperPosition[],
  rawPositions: Record<string, unknown>[],
  broker: string,
  instruments: Map<string, InstrumentRow> | undefined,
): UnderlyingPayoffData {
  const strikeStep = STRIKE_STEP[underlying];

  const [chains, setChains] = useState<Record<string, ChainOc>>({});
  const [spot, setSpot] = useState(0);
  const [spotChangePct, setSpotChangePct] = useState(0);
  const [chainError, setChainError] = useState<string | null>(null);
  const [chainLoading, setChainLoading] = useState(false);
  const [fetchedLotSize, setFetchedLotSize] = useState<number | null>(null);
  // Derived synchronously, not via setState-in-effect, so a CRUDEOIL mount never
  // renders once with the wrong (fetched) lot size before the override lands.
  const lotOverride = useMemo(() => lotSizeOverride(underlying), [underlying]);
  const lotSize = lotOverride ?? fetchedLotSize;

  useEffect(() => {
    if (lotOverride !== null) return; // no fetch needed — see lotSizeOverride
    let cancelled = false;
    fetch(`/api/lotsize?symbol=${underlying}`)
      .then((r) => r.json())
      .then((j) => { if (!cancelled) setFetchedLotSize(typeof j?.lot_size === 'number' && j.lot_size > 0 ? j.lot_size : null); })
      .catch(() => { if (!cancelled) setFetchedLotSize(null); });
    return () => { cancelled = true; };
  }, [underlying, lotOverride]);

  const { legs: allLegs, unparseable } = useMemo(() => {
    if (!positions.length) return { legs: [] as PositionLeg[], unparseable: [] as UnparseableLeg[] };
    return buildPositionLegs(positions, {
      raw: broker === 'dhan' ? rawPositions : undefined,
      instruments,
      underlying,
    });
  }, [positions, rawPositions, instruments, underlying, broker]);

  const legs = useMemo<PositionLeg[]>(() => {
    if (!allLegs.length) return allLegs;
    return allLegs.map((leg) => {
      const oc = leg.expiry ? chains[leg.expiry] : undefined;
      if (!oc) return leg;
      const cl = lookupChainLegData(oc, leg.strike, leg.type);
      if (!cl) return leg;
      return {
        ...leg,
        delta: cl.greeks?.delta ?? leg.delta,
        gamma: cl.greeks?.gamma ?? leg.gamma,
        theta: cl.greeks?.theta ?? leg.theta,
        vega: cl.greeks?.vega ?? leg.vega,
        iv: typeof cl.implied_volatility === 'number' && cl.implied_volatility > 0
          ? cl.implied_volatility / 100
          : leg.iv,
        display: {
          ...leg.display,
          ltp: leg.display.ltp ?? (cl.last_price > 0 ? cl.last_price : null),
        },
      };
    });
  }, [allLegs, chains]);

  const bookExpiries = useMemo(() => legExpiries(legs), [legs]);
  const bookExpiriesKey = bookExpiries.join(',');

  useEffect(() => {
    if (!bookExpiries.length) return;
    let cancelled = false;

    const fetchChains = async () => {
      setChainLoading(true);
      const wanted = bookExpiries.slice(0, MAX_CHAIN_EXPIRIES);
      for (let i = 0; i < wanted.length; i++) {
        if (cancelled) return;
        if (i > 0) await new Promise((r) => setTimeout(r, CHAIN_SPACING_MS));
        try {
          const res = await fetch(`/api/options/chain?underlying=${underlying}&expiry=${wanted[i]}`);
          const json = await res.json();
          if (cancelled) return;
          if (!json?.success) { setChainError(json?.error ?? 'chain unavailable'); continue; }
          const oc = (json.data?.chain?.oc ?? {}) as ChainOc;
          setChains((prev) => ({ ...prev, [wanted[i]]: oc }));
          if (i === 0) {
            setSpot(json.data?.spot ?? 0);
            setSpotChangePct(json.data?.change_pct ?? 0);
          }
          setChainError(null);
        } catch (err) {
          if (!cancelled) setChainError(String((err as Error).message ?? err));
        }
      }
      if (!cancelled) setChainLoading(false);
    };

    fetchChains();
    // Re-poll so spot/greeks/IV/OI keep tracking the live market rather than
    // freezing at the values captured when the book's expiry set last changed.
    const id = setInterval(fetchChains, CHAIN_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookExpiriesKey, underlying]);

  const finalExpiry = useMemo(() => (bookExpiries.length ? bookExpiries[bookExpiries.length - 1] : null), [bookExpiries]);

  // Fill in IV the chain omitted by inverting the leg's own live mark — see the
  // long comment on the identical block in PositionsAnalysis.tsx for why this
  // must use the live LTP and never the entry price.
  const pricedLegs = useMemo<PositionLeg[]>(() => {
    if (!spot || !finalExpiry) return legs;
    return legs.map((leg) => {
      if (leg.iv && leg.iv > 0) return leg;
      const mark = leg.display.ltp;
      if (mark === null || !(mark > 0)) return leg;
      const t = leg.expiry ? daysBetweenDates(todayIso(), leg.expiry) / 365 : 0;
      const solved = impliedVolFromPrice(leg.type, spot, leg.strike, t, mark);
      return solved ? { ...leg, iv: solved } : leg;
    });
  }, [legs, spot, finalExpiry]);

  const expiryCurve = useMemo(
    () => (pricedLegs.length && spot && finalExpiry
      ? buildMultiExpiryCurve(pricedLegs, spot, 1, finalExpiry, strikeStep, SPAN_PCT)
      : []),
    [pricedLegs, spot, finalExpiry, strikeStep],
  );

  const todayStr = todayIso();
  const targetCurve = useMemo(() => {
    if (!pricedLegs.length || !spot || !finalExpiry) return null;
    if (todayStr >= finalExpiry) return null; // identical to the expiry curve
    return buildMultiExpiryCurve(pricedLegs, spot, 1, todayStr, strikeStep, SPAN_PCT);
  }, [pricedLegs, spot, finalExpiry, strikeStep, todayStr]);

  const stats = useMemo<PayoffStats | null>(
    () => (pricedLegs.length && spot && finalExpiry
      ? computePayoffStats(pricedLegs, spot, 1, finalExpiry, strikeStep, SPAN_PCT)
      : null),
    [pricedLegs, spot, finalExpiry, strikeStep],
  );

  const oiBars = useMemo<OiBar[]>(() => {
    const oc = finalExpiry ? chains[finalExpiry] ?? chains[bookExpiries[0]] : undefined;
    if (!oc) return [];
    return Object.entries(oc)
      .map(([k, v]) => ({ strike: Number(k), callOi: v.ce?.oi ?? 0, putOi: v.pe?.oi ?? 0 }))
      .filter((b) => Number.isFinite(b.strike) && (b.callOi > 0 || b.putOi > 0))
      .sort((a, b) => a.strike - b.strike);
  }, [chains, finalExpiry, bookExpiries]);

  const rollup = useMemo(() => {
    let booked = 0, unbooked = 0, unknown = 0;
    for (const l of legs) {
      const p = legPnl(l);
      booked += p.booked;
      if (p.unbooked === null) unknown++; else unbooked += p.unbooked;
    }
    return { booked, unbooked, total: booked + unbooked, unknown };
  }, [legs]);

  return {
    legs, unparseable, spot, spotChangePct, chainLoading, chainError, lotSize,
    expiryCurve, targetCurve, stats, oiBars, finalExpiry, bookExpiries, rollup,
  };
}

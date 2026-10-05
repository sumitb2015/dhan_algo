// Shared data-gathering pipeline behind both scripts/analyze-positions.ts (CLI,
// mints its own session cookie) and app/api/options/analyze/route.ts (server
// route, forwards the caller's already-valid cookie) — one place that builds
// the exact same positions/greeks/payoff snapshot
// components/PositionsAnalysis.tsx renders client-side, so the two entry
// points can never drift out of sync with each other or with the page.

import {
  buildPositionLegs, buildInstrumentIndex, computeExposure, legExpiries,
  type InstrumentRow, type PositionLeg, type UnparseableLeg,
} from './positionLegs.ts';
import { lookupChainLegData, type ChainOc, type PayoffStats } from './optionsStrategy.ts';
import { positionNetGreeks, positionPayoff, withSolvedIv, type FutureRef } from './positionPayoff.ts';
import { STRIKE_STEP, type AnalyticsUnderlying } from './analyticsUnderlyings.ts';
import type { ScalperPosition } from './zerodhaShape.ts';

// Mirrors components/PositionsAnalysis.tsx's DEFAULT_SPAN_INDEX (SPAN_STEPS[2]).
const DEFAULT_SPAN_PCT = 0.04;
const MAX_CHAIN_EXPIRIES = 4;

async function getJson(baseUrl: string, cookie: string, urlPath: string): Promise<any> {
  const res = await fetch(`${baseUrl}${urlPath}`, { headers: { Cookie: cookie } });
  const json = await res.json();
  if (!res.ok || json?.success === false) {
    throw new Error(`${urlPath} -> ${res.status}: ${json?.error ?? 'request failed'}`);
  }
  return json;
}

/** Net Greeks (units / ₹ per day / ₹ per 1% IV) from the central pricing library; `missing` = legs priced on an assumed IV. */
export interface NetGreeks {
  delta: number; gamma: number; theta: number; vega: number;
  missing: PositionLeg[];
}

export interface PositionSnapshot {
  underlying: AnalyticsUnderlying;
  broker: 'dhan' | 'kotak';
  spot: number;
  finalExpiry: string | null;
  generatedAt: string;
  legs: PositionLeg[];
  unparseable: UnparseableLeg[];
  netGreeks: NetGreeks;
  payoffStats: PayoffStats | null;
  exposure: ReturnType<typeof computeExposure>;
}

/**
 * Fetches live positions + option chain(s) through the dashboard's own
 * (already auth-gated) API routes and reduces them to the same
 * legs/greeks/payoff-stats/exposure the page computes client-side.
 *
 * `cookie` must be a value valid for the `Cookie` request header (e.g.
 * `dhan_session=<uuid>.<sig>`) — callers own how they obtained it: a route
 * handler forwards the incoming request's own cookie, the CLI script mints
 * one from debug/session.json.
 */
export async function buildPositionSnapshot(opts: {
  underlying: AnalyticsUnderlying;
  broker: 'dhan' | 'kotak';
  baseUrl: string;
  cookie: string;
}): Promise<PositionSnapshot> {
  const { underlying, broker, baseUrl, cookie } = opts;
  const strikeStep = STRIKE_STEP[underlying];

  // ── positions (same two data sources PositionsAnalysis.tsx reads) ──────────
  const posEndpoint = broker === 'dhan' ? '/api/scalper/positions' : '/api/scalper/kotak/positions';
  const posJson = await getJson(baseUrl, cookie, posEndpoint);
  const positions = (posJson.data ?? []) as Record<string, unknown>[];

  let instruments: Map<string, InstrumentRow> | undefined;
  if (broker !== 'dhan') {
    const instJson = await getJson(baseUrl, cookie, `/api/options/instruments?broker=${broker}&underlying=${underlying.toLowerCase()}`);
    instruments = instJson.available ? buildInstrumentIndex(instJson.data as InstrumentRow[]) : undefined;
  }

  const { legs: bareLegs, unparseable } = buildPositionLegs(positions as unknown as ScalperPosition[], {
    raw: broker === 'dhan' ? positions : undefined,
    instruments,
    underlying,
  });

  // ── chains, one per expiry present in the book (same cap as the page) ──────
  const bookExpiries = legExpiries(bareLegs).slice(0, MAX_CHAIN_EXPIRIES);
  const chains: Record<string, ChainOc> = {};
  let spot = 0;
  let future: FutureRef | null = null;
  for (let i = 0; i < bookExpiries.length; i++) {
    const chainJson = await getJson(baseUrl, cookie, `/api/options/chain?underlying=${underlying}&expiry=${bookExpiries[i]}`);
    chains[bookExpiries[i]] = (chainJson.data?.chain?.oc ?? {}) as ChainOc;
    if (i === 0) {
      spot = chainJson.data?.spot ?? 0;
      const fp = chainJson.data?.future_price, fe = chainJson.data?.future_expiry;
      if (typeof fp === 'number' && fp > 0 && typeof fe === 'string' && fe) future = { price: fp, expiry: fe };
    }
  }

  // Join greeks/IV per leg from its own expiry's chain — same as PositionsAnalysis.tsx's `legs` memo.
  const joinedLegs = bareLegs.map((leg) => {
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
      iv: typeof cl.implied_volatility === 'number' && cl.implied_volatility > 0 ? cl.implied_volatility / 100 : leg.iv,
      display: { ...leg.display, ltp: leg.display.ltp ?? (cl.last_price > 0 ? cl.last_price : null) },
    };
  });

  const finalExpiry = (() => {
    const es = legExpiries(joinedLegs);
    return es.length ? es[es.length - 1] : null;
  })();
  // IV from each leg's live mark through the central pricing library (same as PositionsAnalysis.tsx's `pricedLegs`).
  const pricedLegs = (!spot || !finalExpiry) ? joinedLegs : withSolvedIv(joinedLegs, spot, { defaultExpiry: finalExpiry, future });

  // ── funds (for exposure %-of-capital) ───────────────────────────────────────
  let funds: number | null = null;
  try {
    const fundsJson = await getJson(baseUrl, cookie, broker === 'dhan' ? '/api/scalper/funds' : `/api/scalper/${broker}/funds`);
    const bal = fundsJson.data?.availabelBalance ?? fundsJson.data?.availableBalance;
    funds = typeof bal === 'number' ? bal : null;
  } catch { /* funds are advisory */ }

  // Greeks and payoff stats from the central libraries, exactly as the page computes them.
  const greeks = positionNetGreeks(pricedLegs, spot, { future, defaultExpiry: finalExpiry });
  const netGreeks: NetGreeks = { delta: greeks.delta, gamma: greeks.gamma, theta: greeks.theta, vega: greeks.vega, missing: greeks.assumed };
  const payoffStats = (pricedLegs.length && spot && finalExpiry)
    ? positionPayoff(pricedLegs, spot, { strikeStep, spanPct: DEFAULT_SPAN_PCT, defaultExpiry: finalExpiry, future })?.stats ?? null
    : null;
  const exposure = computeExposure(pricedLegs, { capital: funds, nav: funds });

  return {
    underlying, broker, spot, finalExpiry, generatedAt: new Date().toISOString(),
    legs: pricedLegs, unparseable, netGreeks, payoffStats, exposure,
  };
}

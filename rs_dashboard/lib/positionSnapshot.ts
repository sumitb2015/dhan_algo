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
import {
  computePayoffStats, daysBetweenDates, impliedVolFromPrice, lookupChainLegData,
  type ChainOc, type PayoffStats,
} from './optionsStrategy.ts';
import { computeNetGreeks, type NetGreeks } from './positionGreeks.ts';
import { STRIKE_STEP, type AnalyticsUnderlying } from './analyticsUnderlyings.ts';
import type { ScalperPosition } from './zerodhaShape.ts';

// Mirrors components/PositionsAnalysis.tsx's DEFAULT_SPAN_INDEX (SPAN_STEPS[2]).
const DEFAULT_SPAN_PCT = 0.04;
const MAX_CHAIN_EXPIRIES = 4;

function todayIso(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function getJson(baseUrl: string, cookie: string, urlPath: string): Promise<any> {
  const res = await fetch(`${baseUrl}${urlPath}`, { headers: { Cookie: cookie } });
  const json = await res.json();
  if (!res.ok || json?.success === false) {
    throw new Error(`${urlPath} -> ${res.status}: ${json?.error ?? 'request failed'}`);
  }
  return json;
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
  for (let i = 0; i < bookExpiries.length; i++) {
    const chainJson = await getJson(baseUrl, cookie, `/api/options/chain?underlying=${underlying}&expiry=${bookExpiries[i]}`);
    chains[bookExpiries[i]] = (chainJson.data?.chain?.oc ?? {}) as ChainOc;
    if (i === 0) spot = chainJson.data?.spot ?? 0;
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

  // Solve IV from the live mark where the chain omitted it — same fallback as
  // PositionsAnalysis.tsx's `pricedLegs` memo.
  const finalExpiry = (() => {
    const es = legExpiries(joinedLegs);
    return es.length ? es[es.length - 1] : null;
  })();
  const pricedLegs = (!spot || !finalExpiry) ? joinedLegs : joinedLegs.map((leg) => {
    if (leg.iv && leg.iv > 0) return leg;
    const mark = leg.display.ltp;
    if (mark === null || !(mark > 0)) return leg;
    const t = leg.expiry ? daysBetweenDates(todayIso(), leg.expiry) / 365 : 0;
    const solved = impliedVolFromPrice(leg.type, spot, leg.strike, t, mark);
    return solved ? { ...leg, iv: solved } : leg;
  });

  // ── funds (for exposure %-of-capital) ───────────────────────────────────────
  let funds: number | null = null;
  try {
    const fundsJson = await getJson(baseUrl, cookie, broker === 'dhan' ? '/api/scalper/funds' : `/api/scalper/${broker}/funds`);
    const bal = fundsJson.data?.availabelBalance ?? fundsJson.data?.availableBalance;
    funds = typeof bal === 'number' ? bal : null;
  } catch { /* funds are advisory */ }

  const netGreeks = computeNetGreeks(pricedLegs);
  const payoffStats = (pricedLegs.length && spot && finalExpiry)
    ? computePayoffStats(pricedLegs, spot, 1, finalExpiry, strikeStep, DEFAULT_SPAN_PCT)
    : null;
  const exposure = computeExposure(pricedLegs, { capital: funds, nav: funds });

  return {
    underlying, broker, spot, finalExpiry, generatedAt: new Date().toISOString(),
    legs: pricedLegs, unparseable, netGreeks, payoffStats, exposure,
  };
}

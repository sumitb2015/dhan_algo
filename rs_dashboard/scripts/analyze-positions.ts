// Read-only snapshot of one underlying's open-position risk/payoff, for a
// Claude session asked to review a book and propose adjustments (see
// app/api/options/suggestions/route.ts and components/PositionsAnalysis.tsx's
// "Suggested Actions" panel for the other half of that flow).
//
// Deliberately NOT a Next.js API route: this only ever needs to run on-demand
// from a terminal, reuses the exact same pure functions
// components/PositionsAnalysis.tsx already runs client-side, and never
// touches the running app's state. Run with plain `node` — Node's built-in
// TypeScript type-stripping handles this file the same way it already runs
// this repo's `lib/*.test.ts` files (see package.json's `test` script).
//
// Usage:
//   node scripts/analyze-positions.ts --underlying NIFTY [--broker dhan] [--base-url http://localhost:3000]
//
// Prints one JSON object to stdout: { underlying, spot, legs, netGreeks,
// payoffStats, exposure } — the same numbers /options-analytics/<underlying>
// renders in the browser for the same book.

import { createHmac } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  buildPositionLegs, buildInstrumentIndex, computeExposure, legExpiries,
  type InstrumentRow,
} from '../lib/positionLegs.ts';
import {
  computePayoffStats, daysBetweenDates, impliedVolFromPrice, lookupChainLegData,
  type ChainOc,
} from '../lib/optionsStrategy.ts';
import { computeNetGreeks } from '../lib/positionGreeks.ts';
import { ANALYTICS_UNDERLYINGS, STRIKE_STEP, type AnalyticsUnderlying } from '../lib/analyticsUnderlyings.ts';
import { COOKIE_SECRET, SESSION_COOKIE } from '../lib/auth.ts';
import type { ScalperPosition } from '../lib/zerodhaShape.ts';

// Mirrors components/PositionsAnalysis.tsx's DEFAULT_SPAN_INDEX (SPAN_STEPS[2]).
const DEFAULT_SPAN_PCT = 0.04;
const MAX_CHAIN_EXPIRIES = 4;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..', '..');
const SESSION_FILE = path.join(PROJECT_ROOT, 'debug', 'session.json');

function todayIso(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function parseArgs(argv: string[]): { underlying: string; broker: 'dhan' | 'kotak'; baseUrl: string } {
  const get = (flag: string, fallback: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  return {
    underlying: get('--underlying', '').toUpperCase(),
    broker: (get('--broker', 'dhan').toLowerCase() as 'dhan' | 'kotak'),
    baseUrl: get('--base-url', 'http://localhost:3000'),
  };
}

/** Same session-cookie scheme as lib/session.ts's createDashboardSession() — mints one from an existing logged-in session rather than logging in again. */
function mintSessionCookie(): string {
  let raw: { sessions?: Record<string, unknown> };
  try {
    raw = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  } catch {
    throw new Error(`Could not read ${SESSION_FILE} — log into the dashboard at :3000 first, then re-run this script.`);
  }
  const uuid = Object.keys(raw.sessions ?? {})[0];
  if (!uuid) throw new Error(`No session found in ${SESSION_FILE} — log into the dashboard first.`);
  const sig = createHmac('sha256', COOKIE_SECRET).update(uuid).digest('hex');
  return `${SESSION_COOKIE}=${uuid}.${sig}`;
}

async function getJson(baseUrl: string, cookie: string, urlPath: string): Promise<any> {
  const res = await fetch(`${baseUrl}${urlPath}`, { headers: { Cookie: cookie } });
  const json = await res.json();
  if (!res.ok || json?.success === false) {
    throw new Error(`${urlPath} -> ${res.status}: ${json?.error ?? 'request failed'}`);
  }
  return json;
}

async function main() {
  const { underlying: underlyingRaw, broker, baseUrl } = parseArgs(process.argv.slice(2));
  if (!ANALYTICS_UNDERLYINGS.includes(underlyingRaw as AnalyticsUnderlying)) {
    console.error(`--underlying must be one of ${ANALYTICS_UNDERLYINGS.join(', ')}, got "${underlyingRaw}"`);
    process.exit(1);
  }
  const underlying = underlyingRaw as AnalyticsUnderlying;
  const strikeStep = STRIKE_STEP[underlying];
  const cookie = mintSessionCookie();

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

  console.log(JSON.stringify({
    underlying, broker, spot, finalExpiry, generatedAt: new Date().toISOString(),
    legs: pricedLegs.map((l) => ({
      strike: l.strike, type: l.type, side: l.side, expiry: l.expiry,
      qtyLots: l.qtyLots, price: l.price, iv: l.iv,
      delta: l.delta, gamma: l.gamma, theta: l.theta, vega: l.vega,
      display: l.display,
    })),
    unparseable,
    netGreeks,
    payoffStats,
    exposure,
  }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

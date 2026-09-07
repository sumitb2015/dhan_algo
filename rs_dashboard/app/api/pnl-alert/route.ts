import { NextRequest, NextResponse } from 'next/server';
import { readPnlAlertState, writePnlAlertState, istToday } from '@/lib/pnlAlertState';

// Alerts whenever combined day P&L (all brokers) moves ALERT_STEP_INR away
// from wherever it was at the last alert — a moving baseline, not a single
// fixed daily threshold, so it fires repeatedly in both directions.
const ALERT_STEP_INR = 1000;

interface NiftyQuote { ltp: number; changePct: number | null }

export interface PnlAlertResponse {
  success: boolean;
  updatedAt: string;
  totalPnl: number;
  openPositions: number;
  nifty: NiftyQuote | null;
  alert: boolean;
  delta?: number;
  baseline: number;
}

// Last known-good portfolio read, so a transient upstream failure falls back
// to it instead of fabricating totalPnl: 0 (dhan-polling-guards: never treat
// a failed/empty fetch as new state).
let lastGoodTotals: { totalPnl: number; openPositions: number } | null = null;

export async function GET(request: NextRequest) {
  // proxy.ts gates every /api/* route on the signed dhan_session cookie, and a
  // server-side fetch() does not inherit the original request's cookies — must
  // forward it explicitly or these internal calls 401.
  const cookie = request.headers.get('cookie') ?? '';

  const [portfolioRes, indicesRes] = await Promise.allSettled([
    fetch(new URL('/api/dashboard/portfolio', request.url), { headers: { cookie } }),
    fetch(new URL('/api/scalper/top-indices', request.url), { headers: { cookie } }),
  ]);

  let totalPnl: number | null = null;
  let openPositions = 0;
  if (portfolioRes.status === 'fulfilled' && portfolioRes.value.ok) {
    const json = await portfolioRes.value.json();
    if (json?.success) {
      const totals = { totalPnl: json.totals.totalPnl as number, openPositions: json.totals.openPositions as number };
      totalPnl = totals.totalPnl;
      openPositions = totals.openPositions;
      lastGoodTotals = totals;
    }
  }
  const usingFallback = totalPnl === null;
  if (usingFallback) {
    totalPnl = lastGoodTotals?.totalPnl ?? 0;
    openPositions = lastGoodTotals?.openPositions ?? 0;
  }

  let nifty: NiftyQuote | null = null;
  if (indicesRes.status === 'fulfilled' && indicesRes.value.ok) {
    const json = await indicesRes.value.json();
    const q = json?.quotes?.NIFTY;
    if (q) nifty = { ltp: q.ltp, changePct: q.change_pct };
  }

  const today = istToday();
  let state = readPnlAlertState();
  if (!state || state.date !== today) {
    // New trading day (or first-ever run): baseline starts at CURRENT
    // totalPnl, never 0 — otherwise a fresh session immediately "moves"
    // ₹1000+ from a bogus zero baseline.
    state = { date: today, baseline: totalPnl!, updatedAt: new Date().toISOString() };
    writePnlAlertState(state);
  }

  // Never fire off a fallback/stale read.
  let alert = false;
  let delta: number | undefined;
  if (!usingFallback) {
    const diff = totalPnl! - state.baseline;
    if (Math.abs(diff) >= ALERT_STEP_INR) {
      alert = true;
      delta = diff;
      // Flip the baseline to the CURRENT value in the same response that
      // reports alert:true, so the next poll's diff starts fresh — this is
      // what prevents re-showing the same alert on every subsequent poll.
      state = { date: today, baseline: totalPnl!, updatedAt: new Date().toISOString() };
      writePnlAlertState(state);
    }
  }

  const body: PnlAlertResponse = {
    success: true,
    updatedAt: new Date().toISOString(),
    totalPnl: totalPnl!,
    openPositions,
    nifty,
    alert,
    delta,
    baseline: state.baseline,
  };
  return NextResponse.json(body);
}

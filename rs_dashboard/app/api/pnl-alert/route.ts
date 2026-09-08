import { NextRequest, NextResponse } from 'next/server';
import { readPnlAlertState, writePnlAlertState, istToday } from '@/lib/pnlAlertState';
import { sendTelegramAlert } from '@/lib/telegramAlert';

// Alerts whenever combined day P&L (all brokers) moves ALERT_STEP_INR away
// from wherever it was at the last alert — a moving baseline, not a single
// fixed daily threshold, so it fires repeatedly in both directions.
const ALERT_STEP_INR = 1000;

export interface PnlAlertResponse {
  success: boolean;
  updatedAt: string;
  totalPnl: number;
  openPositions: number;
  alert: boolean;
  delta?: number;
  baseline: number;
}

// Last known-good portfolio read, so a transient upstream failure falls back
// to it instead of fabricating totalPnl: 0 (dhan-polling-guards: never treat
// a failed/empty fetch as new state).
let lastGoodTotals: { totalPnl: number; openPositions: number } | null = null;

// Serializes the read-check-write of the alert baseline across concurrent
// pollers (two open tabs, or a tab plus another window) — without this, two
// requests landing before either write completes both see the same
// pre-write baseline, both compute the same over-threshold diff, and both
// fire a Telegram alert for the same P&L move (dhan-polling-guards guard #2).
let writeQueue: Promise<unknown> = Promise.resolve();
function withWriteLock<T>(fn: () => T): Promise<T> {
  const result = writeQueue.then(fn, fn); // run even if the previous cycle threw
  writeQueue = result.then(() => undefined, () => undefined);
  return result;
}

export async function GET(request: NextRequest) {
  // proxy.ts gates every /api/* route on the signed dhan_session cookie, and a
  // server-side fetch() does not inherit the original request's cookies — must
  // forward it explicitly or these internal calls 401.
  const cookie = request.headers.get('cookie') ?? '';

  const portfolioRes = await fetch(new URL('/api/dashboard/portfolio', request.url), { headers: { cookie } })
    .catch(() => null);

  let totalPnl: number | null = null;
  let openPositions = 0;
  if (portfolioRes?.ok) {
    const json = await portfolioRes.json();
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

  const today = istToday();
  const finalTotalPnl = totalPnl!;

  const { alert, delta, baseline } = await withWriteLock(() => {
    let state = readPnlAlertState();
    if (!state || state.date !== today) {
      // New trading day (or first-ever run): baseline starts at CURRENT
      // totalPnl, never 0 — otherwise a fresh session immediately "moves"
      // ₹1000+ from a bogus zero baseline.
      state = { date: today, baseline: finalTotalPnl, updatedAt: new Date().toISOString() };
      writePnlAlertState(state);
    }

    // Never fire off a fallback/stale read.
    let alertFlag = false;
    let diffOut: number | undefined;
    if (!usingFallback) {
      const diff = finalTotalPnl - state.baseline;
      if (Math.abs(diff) >= ALERT_STEP_INR) {
        alertFlag = true;
        diffOut = diff;
        // Flip the baseline to the CURRENT value in the same response that
        // reports alert:true, so the next poll's diff starts fresh — this is
        // what prevents re-showing the same alert on every subsequent poll.
        state = { date: today, baseline: finalTotalPnl, updatedAt: new Date().toISOString() };
        writePnlAlertState(state);
        const arrow = diff >= 0 ? '📈' : '📉';
        void sendTelegramAlert(
          `${arrow} Day P&L moved ${diff >= 0 ? '+' : ''}₹${diff.toFixed(0)} to ₹${finalTotalPnl.toFixed(0)} (${openPositions} open positions)`
        );
      }
    }

    return { alert: alertFlag, delta: diffOut, baseline: state.baseline };
  });

  const body: PnlAlertResponse = {
    success: true,
    updatedAt: new Date().toISOString(),
    totalPnl: finalTotalPnl,
    openPositions,
    alert,
    delta,
    baseline,
  };
  return NextResponse.json(body);
}

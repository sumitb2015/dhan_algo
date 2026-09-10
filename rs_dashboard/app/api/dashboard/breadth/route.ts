import { NextResponse } from 'next/server';
import path from 'path';
import { PROJECT_ROOT, runPythonJson, dedupe } from '@/lib/pyExec';
import { NIFTY50_SYMBOLS } from '@/lib/nifty50';
import { BANKNIFTY_SYMBOLS } from '@/lib/banknifty';
import { readNifty500List } from '@/lib/dataLoader';

// Live advance/decline breadth for the three baskets the terminal's Breadth
// panel shows: Nifty 50, Bank Nifty and Nifty 500.
//
// Deliberately ONE Python sweep over the union of the three symbol lists rather
// than three routes: Nifty 500 is a superset of almost every Nifty 50 and Bank
// Nifty constituent, so three separate sweeps would triple the load on Dhan's
// account-wide quote bucket to fetch mostly the same quotes. The union is
// fetched once and bucketed here.
//
// Distinct from /api/breadth (EOD, daily-cached, moving-average based) and from
// /api/breadth-intraday (which additionally persists a per-minute history file
// for its chart — this route is a point-in-time snapshot with no history).

const SCRIPT_PATH = path.join(PROJECT_ROOT, 'scripts', 'tools', 'breadth_intraday_snapshot.py');

// A ~500-symbol sweep is 3 paced quote calls plus DhanHelper's master-list load.
const TIMEOUT_MS = 90_000;

// Breadth moves slowly relative to price, and the sweep is the most expensive
// thing on this page — a minute is plenty fresh and keeps the quote bucket free
// for the LTP pollers.
const CACHE_TTL_MS = 60_000;

interface Counts {
  advancing: number;
  declining: number;
  unchanged: number;
  total: number;
  advDecRatio: number | null;
  breadthPct: number | null;
}

interface SnapshotEntry { ltp: number; prevClose: number; direction: 'up' | 'down' | 'flat' }
type SnapshotResult = Record<string, SnapshotEntry> & { error?: string };

export interface DashboardBreadthResponse {
  success: boolean;
  updatedAt: string;
  baskets: Record<string, Counts>;
  error?: string;
}

let cache: { ts: number; body: DashboardBreadthResponse } | null = null;

function countBasket(symbols: string[], snapshot: SnapshotResult): Counts {
  let advancing = 0;
  let declining = 0;
  let unchanged = 0;
  for (const symbol of symbols) {
    const entry = snapshot[symbol];
    if (!entry) continue;
    if (entry.direction === 'up') advancing++;
    else if (entry.direction === 'down') declining++;
    else unchanged++;
  }
  const total = advancing + declining + unchanged;
  return {
    advancing,
    declining,
    unchanged,
    total,
    // null rather than a made-up Infinity/0 when the denominator is missing —
    // the panel renders those as "—" instead of a confident wrong number.
    advDecRatio: declining > 0 ? advancing / declining : null,
    breadthPct: total > 0 ? (advancing / total) * 100 : null,
  };
}

export async function GET() {
  if (cache && Date.now() - cache.ts < CACHE_TTL_MS) {
    return NextResponse.json(cache.body);
  }

  const nifty500 = readNifty500List();
  const union = Array.from(new Set([...NIFTY50_SYMBOLS, ...BANKNIFTY_SYMBOLS, ...nifty500]));

  try {
    // dedupe: several open tabs (or a React StrictMode double-mount) hitting a
    // cold cache would otherwise each spawn their own ~15s sweep.
    const snapshot = await dedupe('dashboard-breadth', () =>
      runPythonJson<SnapshotResult>(SCRIPT_PATH, union, TIMEOUT_MS),
    );

    if (snapshot?.error) {
      // Not cached — a failed sweep served stale for the full TTL would leave
      // the panel blank for a minute after the underlying problem is fixed.
      return NextResponse.json(
        { success: false, updatedAt: new Date().toISOString(), baskets: {}, error: snapshot.error },
        { status: 200 },
      );
    }

    const body: DashboardBreadthResponse = {
      success: true,
      updatedAt: new Date().toISOString(),
      baskets: {
        nifty50: countBasket(NIFTY50_SYMBOLS, snapshot),
        banknifty: countBasket(BANKNIFTY_SYMBOLS, snapshot),
        nifty500: countBasket(nifty500, snapshot),
      },
    };
    cache = { ts: Date.now(), body };
    return NextResponse.json(body);
  } catch (err) {
    console.error('[/api/dashboard/breadth] error:', err);
    return NextResponse.json(
      {
        success: false,
        updatedAt: new Date().toISOString(),
        baskets: {},
        error: String((err as Error).message).slice(0, 200),
      },
      { status: 200 },
    );
  }
}

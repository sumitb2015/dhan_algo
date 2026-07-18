import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { readNifty50Index } from '@/lib/dataLoader';

const DEBUG_DIR = path.join(process.cwd(), '..', 'debug');
const TRACKED_FILE = path.join(DEBUG_DIR, 'portfolio_value_history.json');
const RECONSTRUCTED_FILE = path.join(DEBUG_DIR, 'portfolio_value_history_reconstructed.json');

interface PortfolioValueEntry {
  date: string;
  totalCurrentValue: number;
}

interface CombinedPoint {
  date: string;
  totalCurrentValue: number;
  synthetic: boolean;
}

function readJsonSafe(file: string): any | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

// GET-only: the historical reconstruction (Apr 1 → today, using real trade history) is generated
// on-demand from the Reports page — it makes ~150+ paginated Dhan API calls and takes a minute or
// two, too slow to run on every page load. This route just merges that cached reconstruction with
// the daily-snapshot tracker (which accumulates one real data point per day going forward).
export async function GET() {
  const reconstructed = readJsonSafe(RECONSTRUCTED_FILE);
  const tracked = readJsonSafe(TRACKED_FILE);
  const trackedHistory: PortfolioValueEntry[] = Array.isArray(tracked?.history) ? tracked.history : [];
  const trackedDates = new Set(trackedHistory.map((t) => t.date));

  const reconstructedPoints: CombinedPoint[] = Array.isArray(reconstructed?.points)
    ? reconstructed.points
        .filter((p: any) => !trackedDates.has(p.date))
        .map((p: any) => ({ date: p.date, totalCurrentValue: p.totalCurrentValue, synthetic: true }))
    : [];

  const combined: CombinedPoint[] = [
    ...reconstructedPoints,
    ...trackedHistory.map((t) => ({ date: t.date, totalCurrentValue: t.totalCurrentValue, synthetic: false })),
  ].sort((a, b) => a.date.localeCompare(b.date));

  if (combined.length === 0) {
    return NextResponse.json({ success: true, points: [], startDate: null, backfilled: false });
  }

  const nifty = readNifty50Index();
  const niftyByDate = new Map(nifty.map((row) => [row.date, row.close]));

  const startDate = combined[0].date;
  const startPortfolioValue = combined[0].totalCurrentValue;
  const startNiftyClose = niftyByDate.get(startDate);

  const points = combined.map((entry) => {
    const niftyClose = niftyByDate.get(entry.date);
    return {
      date: entry.date,
      totalCurrentValue: entry.totalCurrentValue,
      synthetic: entry.synthetic,
      portfolioPct:
        startPortfolioValue > 0 ? ((entry.totalCurrentValue - startPortfolioValue) / startPortfolioValue) * 100 : 0,
      niftyPct:
        niftyClose != null && startNiftyClose != null && startNiftyClose > 0
          ? ((niftyClose - startNiftyClose) / startNiftyClose) * 100
          : null,
    };
  });

  return NextResponse.json({
    success: true,
    points,
    startDate,
    backfilled: reconstructedPoints.length > 0,
    reconstructedGeneratedAt: reconstructed?.generatedAt ?? null,
  });
}

import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

const DEBUG_DIR = path.join(process.cwd(), '..', 'debug');
const TRACKED_FILE = path.join(DEBUG_DIR, 'portfolio_value_history.json');
const RECONSTRUCTED_FILE = path.join(DEBUG_DIR, 'portfolio_value_history_reconstructed.json');

interface PortfolioValueEntry {
  date: string;
  totalCurrentValue: number;
  equityValue?: number;
  etfValue?: number;
}

interface CombinedPoint {
  date: string;
  totalCurrentValue: number;
  equityValue: number;
  etfValue: number;
  synthetic: boolean;
}

interface RawPoint {
  date: string;
  totalCurrentValue: number;
  equityValue: number | null;
  etfValue: number | null;
  synthetic: boolean;
}

// Older snapshots (before the equity/ETF split was tracked) have no equityValue/etfValue — filling
// those with 0 would draw a false dip to zero on the chart. Instead, borrow the equity/ETF ratio from
// the nearest point that does have a real split (preferring the next one chronologically, since the
// split composition drifts slowly) and scale it to this point's actual totalCurrentValue.
function fillMissingSplits(points: RawPoint[]): CombinedPoint[] {
  const knownRatioIndices = points
    .map((p, i) => (p.equityValue != null && p.etfValue != null && p.totalCurrentValue > 0 ? i : -1))
    .filter((i) => i >= 0);

  return points.map((p, i) => {
    if (p.equityValue != null && p.etfValue != null) {
      return { date: p.date, totalCurrentValue: p.totalCurrentValue, equityValue: p.equityValue, etfValue: p.etfValue, synthetic: p.synthetic };
    }
    if (knownRatioIndices.length === 0) {
      return { date: p.date, totalCurrentValue: p.totalCurrentValue, equityValue: 0, etfValue: 0, synthetic: p.synthetic };
    }
    const nearest = knownRatioIndices.reduce((best, idx) =>
      Math.abs(idx - i) < Math.abs(best - i) ? idx : best
    );
    const ref = points[nearest];
    const equityRatio = ref.equityValue! / ref.totalCurrentValue;
    const etfRatio = ref.etfValue! / ref.totalCurrentValue;
    return {
      date: p.date,
      totalCurrentValue: p.totalCurrentValue,
      equityValue: Math.round(p.totalCurrentValue * equityRatio * 100) / 100,
      etfValue: Math.round(p.totalCurrentValue * etfRatio * 100) / 100,
      synthetic: p.synthetic,
    };
  });
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

  const reconstructedPoints: RawPoint[] = Array.isArray(reconstructed?.points)
    ? reconstructed.points
        .filter((p: any) => !trackedDates.has(p.date))
        .map((p: any) => ({
          date: p.date,
          totalCurrentValue: p.totalCurrentValue,
          equityValue: p.equityValue ?? null,
          etfValue: p.etfValue ?? null,
          synthetic: true,
        }))
    : [];

  const rawCombined: RawPoint[] = [
    ...reconstructedPoints,
    ...trackedHistory.map((t) => ({
      date: t.date,
      totalCurrentValue: t.totalCurrentValue,
      equityValue: t.equityValue ?? null,
      etfValue: t.etfValue ?? null,
      synthetic: false,
    })),
  ].sort((a, b) => a.date.localeCompare(b.date));

  if (rawCombined.length === 0) {
    return NextResponse.json({ success: true, points: [], startDate: null, backfilled: false });
  }

  const combined = fillMissingSplits(rawCombined);
  const startDate = combined[0].date;

  return NextResponse.json({
    success: true,
    points: combined,
    startDate,
    backfilled: reconstructedPoints.length > 0,
    reconstructedGeneratedAt: reconstructed?.generatedAt ?? null,
  });
}

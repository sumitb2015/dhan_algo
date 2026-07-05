import { NextRequest, NextResponse } from 'next/server';
import { readNifty50Index } from '@/lib/dataLoader';

export interface WeeklyBucket {
  startDate: string;  // window open date (Fri pre-2025-09-01, Wed from 2025-09-01)
  endDate: string;    // expiry date     (Thu pre-2025-09-01, Tue from 2025-09-01)
  startOpen: number;
  endClose: number;
  returnPct: number;
}

// SEBI mandated expiry day change: Thursday → Tuesday effective 2025-09-01
const REGIME_CHANGE_DATE = '2025-09-01';

// 5-minute in-memory cache keyed by startDate+endDate
const cache = new Map<string, { data: unknown; ts: number }>();
const CACHE_TTL = 5 * 60 * 1000;

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const startDate = searchParams.get('startDate') ?? '';
  const endDate = searchParams.get('endDate') ?? '';
  const cacheKey = `${startDate}|${endDate}`;

  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.ts < CACHE_TTL) {
    return NextResponse.json(hit.data);
  }

  try {
    const rows = readNifty50Index();

    // Filter to requested date range
    const filtered = rows.filter((r) => {
      if (startDate && r.date < startDate) return false;
      if (endDate && r.date > endDate) return false;
      return true;
    });

    // Two regimes (getUTCDay: 0=Sun 1=Mon 2=Tue 3=Wed 4=Thu 5=Fri 6=Sat):
    //   Old (< 2025-09-01): Fri open (5) → Thu close (4)  [expiry Thursday]
    //   New (≥ 2025-09-01): Wed open (3) → Tue close (2)  [expiry Tuesday]
    const weeks: WeeklyBucket[] = [];
    let openBucket: { startDate: string; startOpen: number; regime: 'old' | 'new' } | null = null;
    let lastRow: (typeof filtered)[0] | null = null;

    for (const row of filtered) {
      const regime: 'old' | 'new' = row.date < REGIME_CHANGE_DATE ? 'old' : 'new';
      const openDay  = regime === 'old' ? 5 : 3; // Fri or Wed
      const closeDay = regime === 'old' ? 4 : 2; // Thu or Tue
      const dayOfWeek = new Date(row.date + 'T00:00:00Z').getUTCDay();

      if (dayOfWeek === openDay) {
        // If a prior bucket is still open, the expected close day was a holiday (no CSV row).
        // Backfill the close using lastRow — the last trading day before this new-week open.
        if (openBucket && lastRow && openBucket.startOpen > 0) {
          const raw = ((lastRow.close - openBucket.startOpen) / openBucket.startOpen) * 100;
          weeks.push({
            startDate: openBucket.startDate,
            endDate: lastRow.date,
            startOpen: openBucket.startOpen,
            endClose: lastRow.close,
            returnPct: Math.round(raw * 100) / 100,
          });
        }
        openBucket = { startDate: row.date, startOpen: row.open, regime };
      } else if (dayOfWeek === closeDay && openBucket && openBucket.regime === regime) {
        // Normal (non-holiday) close — expiry day row exists in CSV
        if (openBucket.startOpen > 0) {
          const raw = ((row.close - openBucket.startOpen) / openBucket.startOpen) * 100;
          weeks.push({
            startDate: openBucket.startDate,
            endDate: row.date,
            startOpen: openBucket.startOpen,
            endClose: row.close,
            returnPct: Math.round(raw * 100) / 100,
          });
        }
        openBucket = null;
      }

      lastRow = row;
    }

    const dataStart = rows.length > 0 ? rows[0].date : '';
    const dataEnd = rows.length > 0 ? rows[rows.length - 1].date : '';

    const payload = { weeks, dataStart, dataEnd };
    cache.set(cacheKey, { data: payload, ts: Date.now() });
    return NextResponse.json(payload);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

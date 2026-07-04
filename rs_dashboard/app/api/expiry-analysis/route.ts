import { NextRequest, NextResponse } from 'next/server';
import { readNifty50Index } from '@/lib/dataLoader';

export interface WeeklyBucket {
  wedDate: string;
  tueDate: string;
  wedOpen: number;
  tueClose: number;
  returnPct: number;
}

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

    // Bucket Wed (open) → Tue (close) weeks
    // getDay(): 0=Sun 1=Mon 2=Tue 3=Wed 4=Thu 5=Fri 6=Sat
    const weeks: WeeklyBucket[] = [];
    let openBucket: { wedDate: string; wedOpen: number } | null = null;

    for (const row of filtered) {
      // Use UTC to avoid TZ-shifting the date string
      const dayOfWeek = new Date(row.date + 'T00:00:00Z').getUTCDay();

      if (dayOfWeek === 3) {
        // Wednesday → open a new bucket (replace any previously unclosed one)
        openBucket = { wedDate: row.date, wedOpen: row.open };
      } else if (dayOfWeek === 2 && openBucket) {
        // Tuesday → close the bucket
        const raw = ((row.close - openBucket.wedOpen) / openBucket.wedOpen) * 100;
        weeks.push({
          wedDate: openBucket.wedDate,
          tueDate: row.date,
          wedOpen: openBucket.wedOpen,
          tueClose: row.close,
          returnPct: Math.round(raw * 100) / 100,
        });
        openBucket = null;
      }
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

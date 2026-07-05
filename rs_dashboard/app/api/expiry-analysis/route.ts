import { NextRequest, NextResponse } from 'next/server';
import { readNifty50Index, readStockCSV, readIndexCSV, KNOWN_INDICES } from '@/lib/dataLoader';

export interface WeeklyBucket {
  startDate: string;  // window open date (Fri pre-2025-09-01, Wed from 2025-09-01)
  endDate: string;    // expiry date     (Thu pre-2025-09-01, Tue from 2025-09-01)
  startOpen: number;
  endClose: number;
  returnPct: number;
}

export interface DailyStats {
  latestClose: number;
  periodHigh: number;
  periodLow: number;
  totalTradingDays: number;
  avgDailyReturn: number;
  dailyReturnStd: number;
  avgVolume: number;
}

export interface DailyRow {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  dailyReturnPct: number | null;
}

// SEBI mandated expiry day change: Thursday → Tuesday effective 2025-09-01
const REGIME_CHANGE_DATE = '2025-09-01';

// 5-minute in-memory cache keyed by symbol+startDate+endDate
const cache = new Map<string, { data: unknown; ts: number }>();
const CACHE_TTL = 5 * 60 * 1000;

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const symbol    = (searchParams.get('symbol') ?? 'NIFTY50').trim().toUpperCase();
  const startDate = searchParams.get('startDate') ?? '';
  const endDate   = searchParams.get('endDate')   ?? '';
  const cacheKey  = `${symbol}|${startDate}|${endDate}`;

  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.ts < CACHE_TTL) {
    return NextResponse.json(hit.data);
  }

  try {
    // ── Resolve rows based on symbol ─────────────────────────────────────────
    let rows;
    if (symbol === 'NIFTY50') {
      rows = readNifty50Index();
    } else {
      const knownIdx = KNOWN_INDICES.find((m) => m.key === symbol);
      if (knownIdx) {
        rows = readIndexCSV(knownIdx);
      } else {
        rows = readStockCSV(symbol);
      }
    }

    // Filter to requested date range
    const filtered = rows.filter((r) => {
      if (startDate && r.date < startDate) return false;
      if (endDate   && r.date > endDate)   return false;
      return true;
    });

    // ── Weekly buckets ───────────────────────────────────────────────────────
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

    // ── Daily stats + rows ───────────────────────────────────────────────────
    let periodHigh = -Infinity;
    let periodLow  =  Infinity;
    let totalVolume = 0;
    const dailyReturns: number[] = [];
    const dailyRows: DailyRow[] = [];

    for (let i = 0; i < filtered.length; i++) {
      const row = filtered[i];
      if (row.high > periodHigh) periodHigh = row.high;
      if (row.low > 0 && row.low < periodLow) periodLow = row.low;
      totalVolume += row.volume;
      let dailyReturnPct: number | null = null;
      if (i > 0 && filtered[i - 1].close > 0) {
        dailyReturnPct = Math.round(((row.close - filtered[i - 1].close) / filtered[i - 1].close) * 10000) / 100;
        dailyReturns.push(dailyReturnPct);
      }
      dailyRows.push({
        date: row.date,
        open:   Math.round(row.open  * 100) / 100,
        high:   Math.round(row.high  * 100) / 100,
        low:    Math.round(row.low   * 100) / 100,
        close:  Math.round(row.close * 100) / 100,
        volume: Math.round(row.volume),
        dailyReturnPct,
      });
    }

    const latestClose      = filtered.length > 0 ? filtered[filtered.length - 1].close : 0;
    const totalTradingDays = filtered.length;
    const avgVolume        = totalTradingDays > 0 ? totalVolume / totalTradingDays : 0;
    const avgDailyReturn   = dailyReturns.length > 0
      ? dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length : 0;
    const variance = dailyReturns.length > 1
      ? dailyReturns.reduce((s, r) => s + (r - avgDailyReturn) ** 2, 0) / (dailyReturns.length - 1)
      : 0;

    const dailyStats: DailyStats = {
      latestClose:     Math.round(latestClose     * 100) / 100,
      periodHigh:      filtered.length > 0 ? Math.round(periodHigh * 100) / 100 : 0,
      periodLow:       filtered.length > 0 ? Math.round(periodLow  * 100) / 100 : 0,
      totalTradingDays,
      avgDailyReturn:  Math.round(avgDailyReturn  * 10000) / 10000,
      dailyReturnStd:  Math.round(Math.sqrt(variance) * 10000) / 10000,
      avgVolume:       Math.round(avgVolume),
    };

    const dataStart = rows.length > 0 ? rows[0].date : '';
    const dataEnd   = rows.length > 0 ? rows[rows.length - 1].date : '';

    const payload = { weeks, dailyStats, dailyRows, dataStart, dataEnd };
    cache.set(cacheKey, { data: payload, ts: Date.now() });
    return NextResponse.json(payload);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

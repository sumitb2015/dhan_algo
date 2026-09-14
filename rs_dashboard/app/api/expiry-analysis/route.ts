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
  const weeksToExpiryRaw = Number(searchParams.get('weeksToExpiry') ?? '1');
  const weeksToExpiry = ([1, 2, 3] as const).includes(weeksToExpiryRaw as 1 | 2 | 3)
    ? (weeksToExpiryRaw as 1 | 2 | 3) : 1;
  const cacheKey  = `${symbol}|${startDate}|${endDate}|${weeksToExpiry}`;

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
    // NSE's weekly Nifty expiry day: Thursday through 2025-08-28, Tuesday from
    // 2025-09-02 (SEBI circular, effective 2025-09-01). A Monday-expiry plan
    // was announced 2025-03-04 for 2025-04-05 but deferred before ever going
    // live, so there is no third regime to model — just the Thu/Tue split.
    //
    // When an expiry's nominal weekday falls on a trading holiday, NSE rolls
    // it back to the PREVIOUS trading day (not forward). So buckets are built
    // from nominal calendar dates plus a "closest trading day on/before"
    // lookup, rather than scanning for an exact weekday match in the data —
    // the old approach silently merged two calendar weeks into one whenever
    // the expiry day itself was a holiday (e.g. NIFTY50's back-to-back
    // 2022-04-14/04-15 holidays used to produce a single 13-day "week"
    // spanning 2022-04-08 → 2022-04-21 instead of two normal weeks).
    const weeks: WeeklyBucket[] = [];
    let currentWeek: WeeklyBucket | null = null;

    function addDays(iso: string, n: number): string {
      const d = new Date(iso + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + n);
      return d.toISOString().slice(0, 10);
    }
    // Index (into `filtered`) of the last trading row with date <= target.
    function onOrBefore(target: string): number {
      let lo = 0, hi = filtered.length - 1, ans = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (filtered[mid].date <= target) { ans = mid; lo = mid + 1; } else hi = mid - 1;
      }
      return ans;
    }

    if (filtered.length > 0) {
      const dataStartD = filtered[0].date;
      const dataEndD = filtered[filtered.length - 1].date;

      // Nominal expiry (close) dates across the whole filtered span — every
      // Thursday before the regime change, every Tuesday from it onward.
      const nominalCloses: string[] = [];
      const firstOldClose = addDays(dataStartD, (4 - new Date(dataStartD + 'T00:00:00Z').getUTCDay() + 7) % 7);
      for (let d = firstOldClose; d < REGIME_CHANGE_DATE && d <= dataEndD; d = addDays(d, 7)) {
        nominalCloses.push(d);
      }
      const newRegimeAnchor = dataStartD > REGIME_CHANGE_DATE ? dataStartD : REGIME_CHANGE_DATE;
      const firstNewClose = addDays(newRegimeAnchor, (2 - new Date(newRegimeAnchor + 'T00:00:00Z').getUTCDay() + 7) % 7);
      for (let d = firstNewClose; d <= dataEndD; d = addDays(d, 7)) {
        nominalCloses.push(d);
      }

      // Walk cycles chronologically: each cycle opens on the trading day right
      // after the previous cycle's actual close, and closes on the latest
      // trading day on/before its nominal expiry date (the NSE holiday-shift
      // rule). A nominal close that can't roll back past the previous cycle's
      // close (only possible with an implausible run of consecutive holidays
      // covering a whole week) is skipped — that span folds into the next
      // successful cycle rather than fabricating a return from stale data.
      let prevCloseIdx = -1;
      for (const nominalClose of nominalCloses) {
        const closeIdx = onOrBefore(nominalClose);
        if (closeIdx < 0 || closeIdx <= prevCloseIdx) continue;
        const openIdx = prevCloseIdx + 1;
        const openRow = filtered[openIdx];
        const closeRow = filtered[closeIdx];
        if (openRow.open > 0) {
          const raw = ((closeRow.close - openRow.open) / openRow.open) * 100;
          weeks.push({
            startDate: openRow.date,
            endDate: closeRow.date,
            startOpen: openRow.open,
            endClose: closeRow.close,
            returnPct: Math.round(raw * 100) / 100,
          });
        }
        prevCloseIdx = closeIdx;
      }

      // In-progress cycle: only when the filtered slice reaches today's latest
      // available trading day, and at least one trading day exists after the
      // last completed cycle's close.
      const isLatestData = rows.length > 0 && dataEndD === rows[rows.length - 1].date;
      if (isLatestData) {
        const openIdx = prevCloseIdx + 1;
        if (openIdx < filtered.length) {
          const openRow = filtered[openIdx];
          const lastRow = filtered[filtered.length - 1];
          if (openRow.open > 0) {
            const raw = ((lastRow.close - openRow.open) / openRow.open) * 100;
            currentWeek = {
              startDate: openRow.date,
              endDate: lastRow.date,
              startOpen: openRow.open,
              endClose: lastRow.close,
              returnPct: Math.round(raw * 100) / 100,
            };
          }
        }
      }
    }

    // ── Roll up to N-week-to-expiry buckets (sliding window over 1-week buckets) ──
    const N = weeksToExpiry;

    function rollUp(oneWeek: WeeklyBucket[]): WeeklyBucket[] {
      if (N === 1) return oneWeek;
      const out: WeeklyBucket[] = [];
      for (let i = N - 1; i < oneWeek.length; i++) {
        const start = oneWeek[i - N + 1];
        const end = oneWeek[i];
        if (start.startOpen <= 0) continue;
        const raw = ((end.endClose - start.startOpen) / start.startOpen) * 100;
        out.push({
          startDate: start.startDate,
          endDate: end.endDate,
          startOpen: start.startOpen,
          endClose: end.endClose,
          returnPct: Math.round(raw * 100) / 100,
        });
      }
      return out;
    }

    let nWeekCurrent: WeeklyBucket | null = null;
    if (N === 1) {
      nWeekCurrent = currentWeek;
    } else if (currentWeek && weeks.length >= N - 1) {
      const startBucket = weeks[weeks.length - N + 1];
      if (startBucket.startOpen > 0) {
        const raw = ((currentWeek.endClose - startBucket.startOpen) / startBucket.startOpen) * 100;
        nWeekCurrent = {
          startDate: startBucket.startDate,
          endDate: currentWeek.endDate,
          startOpen: startBucket.startOpen,
          endClose: currentWeek.endClose,
          returnPct: Math.round(raw * 100) / 100,
        };
      }
    }

    const outputWeeks = rollUp(weeks);
    const outputCurrentWeek = nWeekCurrent;

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

    const payload = { weeks: outputWeeks, currentWeek: outputCurrentWeek, weeksToExpiry, dailyStats, dailyRows, dataStart, dataEnd };
    cache.set(cacheKey, { data: payload, ts: Date.now() });
    return NextResponse.json(payload);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

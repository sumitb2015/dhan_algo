import { NextRequest, NextResponse } from 'next/server';
import { readStockCSV, KNOWN_INDICES, readIndexCSV, IndexMeta } from '@/lib/dataLoader';
import { OHLCVRow } from '@/lib/rs';

export interface SeasonalityCell {
  value: number | null;
  startDate: string | null; // previous month's last trading day
  endDate: string | null;   // this month's last trading day
  startClose: number | null;
  endClose: number | null;
}

export interface MonthStat {
  month: string;
  monthIdx: number;
  avgReturn: number | null;
  medianReturn: number | null;
  winRate: number; // % positive (0-100)
  positiveCount: number;
  negativeCount: number;
  totalCount: number;
  bestYear: { year: number; returnPct: number } | null;
  worstYear: { year: number; returnPct: number } | null;
}

export interface YearReturn {
  year: number;
  returnPct: number | null;
  positiveMonths: number;
  negativeMonths: number;
  totalMonths: number;
}

export interface QuarterlyStat {
  quarter: string;
  label: string;
  avgReturn: number;
  winRate: number;
  positiveYears: number;
  totalYears: number;
}

export interface CumulativePoint {
  month: string;
  monthIdx: number;
  avgReturn: number;
  cumulativePct: number;
  indexBase: number;
}

export interface SeasonalityResponse {
  symbol: string;
  years: number[];
  months: string[]; // Jan..Dec
  matrix: SeasonalityCell[][]; // matrix[yearIdx][monthIdx]
  monthAverages: (number | null)[];
  monthMedians: (number | null)[];
  monthWinRates: number[];
  monthStats: MonthStat[];
  yearReturns: YearReturn[];
  quarterlyStats: QuarterlyStat[];
  cumulativeCurve: CumulativePoint[];
  dataDate: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

interface MonthEnd {
  close: number;
  date: string; // actual last trading day in this calendar month
}

/** Last close (and its actual trading date) of each calendar month, keyed by "YYYY-MM". */
function monthEndCloses(rows: OHLCVRow[]): Map<string, MonthEnd> {
  const map = new Map<string, MonthEnd>();
  for (const row of rows) {
    const key = row.date.slice(0, 7); // YYYY-MM
    map.set(key, { close: row.close, date: row.date }); // rows are date-sorted ascending, so last write wins
  }
  return map;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return +((sorted[mid - 1] + sorted[mid]) / 2).toFixed(2);
  }
  return +sorted[mid].toFixed(2);
}

function resolveIndexMeta(sym: string): IndexMeta | undefined {
  const s = sym.trim();
  // Direct key match
  const directKey = KNOWN_INDICES.find((m) => m.key.toLowerCase() === s.toLowerCase());
  if (directKey) return directKey;

  // Direct label match
  const directLabel = KNOWN_INDICES.find((m) => m.label.toLowerCase() === s.toLowerCase());
  if (directLabel) return directLabel;

  // Normalized alphanumeric match (removes spaces, underscores, hyphens)
  const norm = s.toUpperCase().replace(/[\s_-]+/g, '');

  if (norm === 'NIFTY' || norm === 'NIFTY50' || norm === 'NIFTYINDEX') {
    return KNOWN_INDICES.find((m) => m.key === 'NIFTY50');
  }
  if (norm === 'BANKNIFTY' || norm === 'NIFTYBANK') {
    return KNOWN_INDICES.find((m) => m.key === 'BANKNIFTY');
  }
  if (norm === 'FINNIFTY' || norm === 'NIFTYFIN' || norm === 'NIFTYFINANCIAL') {
    return KNOWN_INDICES.find((m) => m.key === 'FINNIFTY');
  }
  if (norm === 'NIFTYIT' || norm === 'IT') {
    return KNOWN_INDICES.find((m) => m.key === 'NIFTYIT');
  }
  if (norm === 'NIFTY500') {
    return KNOWN_INDICES.find((m) => m.key === 'NIFTY_500');
  }

  return KNOWN_INDICES.find((m) => {
    const kNorm = m.key.toUpperCase().replace(/[\s_-]+/g, '');
    const lNorm = m.label.toUpperCase().replace(/[\s_-]+/g, '');
    return kNorm === norm || lNorm === norm;
  });
}

export async function GET(req: NextRequest) {
  try {
    const symbol = req.nextUrl.searchParams.get('symbol');
    if (!symbol) {
      return NextResponse.json({ success: false, error: 'symbol is required' }, { status: 400 });
    }

    const indexMeta = resolveIndexMeta(symbol);
    const rows = indexMeta ? readIndexCSV(indexMeta) : readStockCSV(symbol.trim().toUpperCase());
    if (rows.length === 0) {
      return NextResponse.json({ success: false, error: `No data found for ${symbol}` }, { status: 404 });
    }

    const monthEnds = monthEndCloses(rows);
    const monthKeys = Array.from(monthEnds.keys()).sort();

    const years = Array.from(new Set(monthKeys.map((k) => parseInt(k.slice(0, 4), 10)))).sort((a, b) => b - a);

    const matrix: SeasonalityCell[][] = years.map((year) =>
      MONTHS.map((_, monthIdx) => {
        const key = `${year}-${String(monthIdx + 1).padStart(2, '0')}`;
        const prevMonthIdx = monthIdx === 0 ? 11 : monthIdx - 1;
        const prevYear = monthIdx === 0 ? year - 1 : year;
        const prevKey = `${prevYear}-${String(prevMonthIdx + 1).padStart(2, '0')}`;

        const curr = monthEnds.get(key);
        const prev = monthEnds.get(prevKey);
        if (curr === undefined || prev === undefined || prev.close === 0) {
          return { value: null, startDate: null, endDate: null, startClose: null, endClose: null };
        }
        return {
          value: +(((curr.close - prev.close) / prev.close) * 100).toFixed(2),
          startDate: prev.date,
          endDate: curr.date,
          startClose: prev.close,
          endClose: curr.close,
        };
      })
    );

    // Month Stats & Averages
    const monthStats: MonthStat[] = MONTHS.map((month, monthIdx) => {
      const yearValues: { year: number; val: number }[] = [];
      years.forEach((year, yIdx) => {
        const cell = matrix[yIdx][monthIdx];
        if (cell.value !== null) {
          yearValues.push({ year, val: cell.value });
        }
      });

      if (yearValues.length === 0) {
        return {
          month,
          monthIdx,
          avgReturn: null,
          medianReturn: null,
          winRate: 0,
          positiveCount: 0,
          negativeCount: 0,
          totalCount: 0,
          bestYear: null,
          worstYear: null,
        };
      }

      const vals = yearValues.map(v => v.val);
      const avg = +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2);
      const med = median(vals);
      const positiveCount = vals.filter(v => v > 0).length;
      const negativeCount = vals.filter(v => v < 0).length;
      const winRate = +( (positiveCount / vals.length) * 100 ).toFixed(1);

      const sortedByVal = [...yearValues].sort((a, b) => b.val - a.val);
      const bestYear = { year: sortedByVal[0].year, returnPct: sortedByVal[0].val };
      const worstYear = { year: sortedByVal[sortedByVal.length - 1].year, returnPct: sortedByVal[sortedByVal.length - 1].val };

      return {
        month,
        monthIdx,
        avgReturn: avg,
        medianReturn: med,
        winRate,
        positiveCount,
        negativeCount,
        totalCount: vals.length,
        bestYear,
        worstYear,
      };
    });

    const monthAverages = monthStats.map(m => m.avgReturn);
    const monthMedians = monthStats.map(m => m.medianReturn);
    const monthWinRates = monthStats.map(m => m.winRate);

    // Year-by-Year full returns
    const yearReturns: YearReturn[] = years.map((year, yIdx) => {
      const row = matrix[yIdx];
      const validCells = row.filter(c => c.value !== null);
      const pos = validCells.filter(c => c.value! > 0).length;
      const neg = validCells.filter(c => c.value! < 0).length;

      // Calculate annual compounded return across the year
      // Find start of year (prev year's Dec close or first available startClose)
      const prevDecKey = `${year - 1}-12`;
      const prevDec = monthEnds.get(prevDecKey);

      // Find latest close of this year
      let latestCloseInYear: number | null = null;
      for (let m = 12; m >= 1; m--) {
        const mKey = `${year}-${String(m).padStart(2, '0')}`;
        const end = monthEnds.get(mKey);
        if (end !== undefined) {
          latestCloseInYear = end.close;
          break;
        }
      }

      let returnPct: number | null = null;
      if (prevDec && prevDec.close > 0 && latestCloseInYear !== null) {
        returnPct = +(((latestCloseInYear - prevDec.close) / prevDec.close) * 100).toFixed(2);
      } else if (validCells.length > 0) {
        // Fallback: compound valid monthly returns
        let comp = 1.0;
        for (const c of validCells) {
          comp *= (1 + (c.value! / 100));
        }
        returnPct = +((comp - 1) * 100).toFixed(2);
      }

      return {
        year,
        returnPct,
        positiveMonths: pos,
        negativeMonths: neg,
        totalMonths: validCells.length,
      };
    });

    // Quarterly Stats
    const quarters = [
      { quarter: 'Q1', label: 'Q1 (Jan - Mar)', months: [0, 1, 2] },
      { quarter: 'Q2', label: 'Q2 (Apr - Jun)', months: [3, 4, 5] },
      { quarter: 'Q3', label: 'Q3 (Jul - Sep)', months: [6, 7, 8] },
      { quarter: 'Q4', label: 'Q4 (Oct - Dec)', months: [9, 10, 11] },
    ];

    const quarterlyStats: QuarterlyStat[] = quarters.map(q => {
      const qReturns: number[] = [];
      years.forEach((year, yIdx) => {
        const qCells = q.months.map(mIdx => matrix[yIdx][mIdx].value).filter((v): v is number => v !== null);
        if (qCells.length === q.months.length) {
          // Compound the 3 months
          let comp = 1.0;
          qCells.forEach(r => { comp *= (1 + (r / 100)); });
          qReturns.push(+((comp - 1) * 100).toFixed(2));
        }
      });

      if (qReturns.length === 0) {
        return {
          quarter: q.quarter,
          label: q.label,
          avgReturn: 0,
          winRate: 0,
          positiveYears: 0,
          totalYears: 0,
        };
      }

      const avg = +(qReturns.reduce((a, b) => a + b, 0) / qReturns.length).toFixed(2);
      const pos = qReturns.filter(r => r > 0).length;
      const winRate = +((pos / qReturns.length) * 100).toFixed(1);

      return {
        quarter: q.quarter,
        label: q.label,
        avgReturn: avg,
        winRate,
        positiveYears: pos,
        totalYears: qReturns.length,
      };
    });

    // Cumulative Annual Seasonality Curve (starts at 100)
    let runningComp = 1.0;
    const cumulativeCurve: CumulativePoint[] = MONTHS.map((month, mIdx) => {
      const avg = monthStats[mIdx].avgReturn ?? 0;
      runningComp *= (1 + (avg / 100));
      return {
        month,
        monthIdx: mIdx,
        avgReturn: avg,
        cumulativePct: +((runningComp - 1) * 100).toFixed(2),
        indexBase: +(100 * runningComp).toFixed(2),
      };
    });

    const data: SeasonalityResponse = {
      symbol,
      years,
      months: MONTHS,
      matrix,
      monthAverages,
      monthMedians,
      monthWinRates,
      monthStats,
      yearReturns,
      quarterlyStats,
      cumulativeCurve,
      dataDate: rows[rows.length - 1].date,
    };

    return NextResponse.json({ success: true, data });
  } catch (err) {
    console.error('[/api/seasonality] Error:', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}

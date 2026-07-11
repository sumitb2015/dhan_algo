import { NextRequest, NextResponse } from 'next/server';
import { readStockCSV } from '@/lib/dataLoader';
import { OHLCVRow } from '@/lib/rs';

export interface SeasonalityCell {
  value: number | null;
  startDate: string | null; // previous month's last trading day
  endDate: string | null;   // this month's last trading day
}

export interface SeasonalityResponse {
  symbol: string;
  years: number[];
  months: string[]; // Jan..Dec
  matrix: SeasonalityCell[][]; // matrix[yearIdx][monthIdx]
  monthAverages: (number | null)[];
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

export async function GET(req: NextRequest) {
  try {
    const symbol = req.nextUrl.searchParams.get('symbol');
    if (!symbol) {
      return NextResponse.json({ success: false, error: 'symbol is required' }, { status: 400 });
    }

    const rows = readStockCSV(symbol);
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
          return { value: null, startDate: null, endDate: null };
        }
        return {
          value: +(((curr.close - prev.close) / prev.close) * 100).toFixed(2),
          startDate: prev.date,
          endDate: curr.date,
        };
      })
    );

    const monthAverages: (number | null)[] = MONTHS.map((_, monthIdx) => {
      const values = matrix.map((row) => row[monthIdx].value).filter((v): v is number => v !== null);
      if (values.length === 0) return null;
      return +(values.reduce((a, b) => a + b, 0) / values.length).toFixed(2);
    });

    const data: SeasonalityResponse = {
      symbol,
      years,
      months: MONTHS,
      matrix,
      monthAverages,
      dataDate: rows[rows.length - 1].date,
    };

    return NextResponse.json({ success: true, data });
  } catch (err) {
    console.error('[/api/seasonality] Error:', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}

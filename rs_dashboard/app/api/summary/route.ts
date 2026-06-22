import { NextRequest, NextResponse } from 'next/server';
import { readNifty50Index, readNifty500Index, readNifty500List } from '@/lib/dataLoader';

export async function GET(request: NextRequest) {
  try {
    const nifty50Rows = readNifty50Index();
    const nifty500List = readNifty500List();
    const nifty500Rows = await readNifty500Index(nifty500List);

    const getStats = (rows: any[]) => {
      if (rows.length < 2) return { close: 0, change: 0, changePercent: 0 };
      const latest = rows[rows.length - 1];
      const prev = rows[rows.length - 2];
      const change = latest.close - prev.close;
      const changePercent = (change / prev.close) * 100;
      return {
        close: +latest.close.toFixed(2),
        change: +change.toFixed(2),
        changePercent: +changePercent.toFixed(2),
        date: latest.date,
      };
    };

    const nifty50Stats = getStats(nifty50Rows);
    const nifty500Stats = getStats(nifty500Rows);

    return NextResponse.json({
      success: true,
      nifty50: nifty50Stats,
      nifty500: nifty500Stats,
    });
  } catch (err) {
    console.error('[/api/summary] Error:', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}

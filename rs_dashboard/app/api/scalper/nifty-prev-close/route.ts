import { NextResponse } from 'next/server';
import { readNifty50Index } from '@/lib/dataLoader';

export async function GET() {
  try {
    const rows = readNifty50Index();
    if (rows.length < 2) {
      return NextResponse.json({ success: false, error: 'Insufficient historical data' }, { status: 500 });
    }
    // Last row is the most recent completed trading day (previous close during market hours)
    const last = rows[rows.length - 1];
    return NextResponse.json({ success: true, prevClose: last.close, date: last.date });
  } catch (err) {
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}

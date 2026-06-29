import { NextResponse } from 'next/server';
import { readNifty50Index } from '@/lib/dataLoader';

export async function GET() {
  try {
    const rows = readNifty50Index();
    if (rows.length < 2) {
      return NextResponse.json({ success: false, error: 'Insufficient historical data' }, { status: 500 });
    }

    // readNifty50Index() patches today's row with the live _NIFTY50_INDEX quote,
    // so rows[last] may equal the current spot price → 0% change.
    // Use the last row strictly before today (IST) as the previous trading day close.
    const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const prevRows = rows.filter(r => r.date < todayIST);
    const prev = prevRows.length > 0 ? prevRows[prevRows.length - 1] : rows[rows.length - 2];

    return NextResponse.json({ success: true, prevClose: prev.close, date: prev.date });
  } catch (err) {
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}

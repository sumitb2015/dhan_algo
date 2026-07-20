import { NextResponse } from 'next/server';
import { readNifty50Index } from '@/lib/dataLoader';
import { getDhanCredentials } from '@/lib/dhanToken';
import { kiteGet } from '@/lib/zerodhaToken';

// NIFTY's previous close is broker-independent, but it must come from a LIVE
// source: the historical CSV is only as fresh as the last dashboard-data
// refresh, and a stale CSV made the scalper header show yesterday's move in
// the wrong direction (spot vs a 2-day-old close). Order of preference:
// Dhan OHLC -> Kite OHLC -> CSV (last resort).

const DHAN_OHLC_URL = 'https://api.dhan.co/v2/marketfeed/ohlc';
const NIFTY_IDX_SECURITY_ID = 13; // Nifty 50 index (spot) on Dhan IDX_I

// Prev close changes once per trading day — cache per IST date.
let cache: { date: string; prevClose: number; source: string } | null = null;

function istToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

async function fromDhan(): Promise<number | null> {
  try {
    const { clientId, token } = getDhanCredentials();
    if (!token) return null;
    const res = await fetch(DHAN_OHLC_URL, {
      method: 'POST',
      headers: {
        'access-token': token,
        'client-id': clientId,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ IDX_I: [NIFTY_IDX_SECURITY_ID] }),
      signal: AbortSignal.timeout(5000),
    });
    const json = await res.json() as {
      status?: string;
      data?: Record<string, Record<string, { ohlc?: { close?: number } }>>;
    };
    if (json.status !== 'success') return null;
    const close = json.data?.IDX_I?.[String(NIFTY_IDX_SECURITY_ID)]?.ohlc?.close ?? 0;
    return close > 0 ? close : null;
  } catch {
    return null;
  }
}

async function fromKite(): Promise<number | null> {
  try {
    const data = await kiteGet(`/quote/ohlc?i=${encodeURIComponent('NSE:NIFTY 50')}`) as
      Record<string, { ohlc?: { close?: number } }>;
    const close = data?.['NSE:NIFTY 50']?.ohlc?.close ?? 0;
    return close > 0 ? close : null;
  } catch {
    return null;
  }
}

function fromCsv(): { prevClose: number; date: string } | null {
  try {
    const rows = readNifty50Index();
    if (rows.length < 2) return null;
    // readNifty50Index() patches today's row with the live quote, so take the
    // last row strictly before today (IST).
    const todayIST = istToday();
    const prevRows = rows.filter(r => r.date < todayIST);
    const prev = prevRows.length > 0 ? prevRows[prevRows.length - 1] : rows[rows.length - 2];
    return prev.close > 0 ? { prevClose: prev.close, date: prev.date } : null;
  } catch {
    return null;
  }
}

export async function GET() {
  const today = istToday();
  if (cache && cache.date === today) {
    return NextResponse.json({ success: true, prevClose: cache.prevClose, source: cache.source });
  }

  const dhan = await fromDhan();
  if (dhan !== null) {
    cache = { date: today, prevClose: dhan, source: 'dhan' };
    return NextResponse.json({ success: true, prevClose: dhan, source: 'dhan' });
  }

  const kite = await fromKite();
  if (kite !== null) {
    cache = { date: today, prevClose: kite, source: 'zerodha' };
    return NextResponse.json({ success: true, prevClose: kite, source: 'zerodha' });
  }

  const csv = fromCsv();
  if (csv) {
    // Deliberately NOT cached: the CSV may be stale, and a later poll should
    // get another shot at the live sources (e.g. after login.py is run).
    return NextResponse.json({ success: true, prevClose: csv.prevClose, source: 'csv', date: csv.date });
  }

  return NextResponse.json({ success: false, error: 'Could not determine previous close' }, { status: 500 });
}

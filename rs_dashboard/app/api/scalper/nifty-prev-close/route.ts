import { NextRequest, NextResponse } from 'next/server';
import { readNifty50Index } from '@/lib/dataLoader';
import { getDhanCredentials } from '@/lib/dhanToken';
import { kiteGet } from '@/lib/zerodhaToken';

// Previous close for the scalper header spot ticker — must come from a LIVE
// source: the historical CSV is only as fresh as the last dashboard-data
// refresh, and a stale CSV made the scalper header show yesterday's move in
// the wrong direction (spot vs a 2-day-old close). Order of preference:
// Dhan OHLC -> Kite OHLC -> CSV (NIFTY only — no CSV/Kite source for SENSEX yet).

const DHAN_OHLC_URL = 'https://api.dhan.co/v2/marketfeed/ohlc';

type UnderlyingConfig = { sid: number; dhanSeg: 'IDX_I' | 'BSE_IDX'; kiteSymbol?: string };
const UNDERLYINGS: Record<string, UnderlyingConfig> = {
  NIFTY:     { sid: 13, dhanSeg: 'IDX_I', kiteSymbol: 'NSE:NIFTY 50' },
  BANKNIFTY: { sid: 25, dhanSeg: 'IDX_I', kiteSymbol: 'NSE:NIFTY BANK' },
  SENSEX:    { sid: 51, dhanSeg: 'BSE_IDX' },
};

// Prev close changes once per trading day — cache per IST date, per underlying.
const cache = new Map<string, { prevClose: number; source: string }>();

function istToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

async function fromDhan(cfg: UnderlyingConfig): Promise<number | null> {
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
      body: JSON.stringify({ [cfg.dhanSeg]: [cfg.sid] }),
      signal: AbortSignal.timeout(5000),
    });
    const json = await res.json() as {
      status?: string;
      data?: Record<string, Record<string, { ohlc?: { close?: number } }>>;
    };
    if (json.status !== 'success') return null;
    const close = json.data?.[cfg.dhanSeg]?.[String(cfg.sid)]?.ohlc?.close ?? 0;
    return close > 0 ? close : null;
  } catch {
    return null;
  }
}

async function fromKite(kiteSymbol: string): Promise<number | null> {
  try {
    const data = await kiteGet(`/quote/ohlc?i=${encodeURIComponent(kiteSymbol)}`) as
      Record<string, { ohlc?: { close?: number } }>;
    const close = data?.[kiteSymbol]?.ohlc?.close ?? 0;
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

export async function GET(request: NextRequest) {
  const underlying = (request.nextUrl.searchParams.get('underlying') ?? 'NIFTY').toUpperCase();
  const cfg = UNDERLYINGS[underlying] ?? UNDERLYINGS.NIFTY;
  const today = istToday();
  const cacheKey = `${underlying}:${today}`;

  const cached = cache.get(cacheKey);
  if (cached) {
    return NextResponse.json({ success: true, prevClose: cached.prevClose, source: cached.source });
  }

  const dhan = await fromDhan(cfg);
  if (dhan !== null) {
    cache.set(cacheKey, { prevClose: dhan, source: 'dhan' });
    return NextResponse.json({ success: true, prevClose: dhan, source: 'dhan' });
  }

  if (cfg.kiteSymbol) {
    const kite = await fromKite(cfg.kiteSymbol);
    if (kite !== null) {
      cache.set(cacheKey, { prevClose: kite, source: 'zerodha' });
      return NextResponse.json({ success: true, prevClose: kite, source: 'zerodha' });
    }
  }

  if (underlying === 'NIFTY') {
    // Deliberately NOT cached: the CSV may be stale, and a later poll should
    // get another shot at the live sources (e.g. after login.py is run).
    const csv = fromCsv();
    if (csv) {
      return NextResponse.json({ success: true, prevClose: csv.prevClose, source: 'csv', date: csv.date });
    }
  }

  return NextResponse.json({ success: false, error: 'Could not determine previous close' }, { status: 500 });
}

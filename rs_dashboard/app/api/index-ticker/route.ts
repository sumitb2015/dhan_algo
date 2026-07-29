import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getDhanCredentials } from '@/lib/dhanToken';
import { readNifty50Index } from '@/lib/dataLoader';

// Lightweight live ticker for header widgets (NIFTY spot + India VIX, both
// with prev-close %). One batched Dhan OHLC call covers both security ids —
// no websocket bridge needed for a simple header display.

const PROJECT_ROOT  = path.resolve(process.cwd(), '..');
const VIX_CSV        = path.join(PROJECT_ROOT, 'Historical Data', 'Indices', 'INDIA_VIX.csv');
const DHAN_OHLC_URL  = 'https://api.dhan.co/v2/marketfeed/ohlc';

const NIFTY_SECURITY_ID = 13;
const VIX_SECURITY_ID   = 21;

interface Quote { ltp: number; prevClose: number }

function csvVixFallback(): Quote | null {
  try {
    if (!fs.existsSync(VIX_CSV)) return null;
    const lines = fs.readFileSync(VIX_CSV, 'utf-8').split(/\r?\n/).filter(Boolean).slice(1);
    if (lines.length < 2) return null;
    const parse = (line: string) => parseFloat((line.split(',')[4] ?? '').trim());
    const last = parse(lines[lines.length - 1]);
    const prev = parse(lines[lines.length - 2]);
    return (!isNaN(last) && !isNaN(prev)) ? { ltp: last, prevClose: prev } : null;
  } catch {
    return null;
  }
}

function csvNiftyFallback(): Quote | null {
  try {
    const rows = readNifty50Index();
    if (rows.length < 2) return null;
    const last = rows[rows.length - 1];
    const prev = rows[rows.length - 2];
    return (last.close > 0 && prev.close > 0) ? { ltp: last.close, prevClose: prev.close } : null;
  } catch {
    return null;
  }
}

export async function GET() {
  let nifty: Quote | null = null;
  let vix: Quote | null = null;

  try {
    const { clientId, token } = getDhanCredentials();
    if (token) {
      const res = await fetch(DHAN_OHLC_URL, {
        method: 'POST',
        headers: {
          'access-token': token,
          'client-id': clientId,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({ IDX_I: [NIFTY_SECURITY_ID, VIX_SECURITY_ID] }),
        signal: AbortSignal.timeout(5000),
      });

      const json = await res.json() as {
        status?: string;
        data?: Record<string, Record<string, {
          last_price?: number;
          ohlc?: { close?: number };
        }>>;
      };

      if (json.status === 'success') {
        const niftyEntry = json.data?.IDX_I?.[String(NIFTY_SECURITY_ID)];
        const vixEntry   = json.data?.IDX_I?.[String(VIX_SECURITY_ID)];

        if ((niftyEntry?.last_price ?? 0) > 0 && (niftyEntry?.ohlc?.close ?? 0) > 0) {
          nifty = { ltp: niftyEntry!.last_price!, prevClose: niftyEntry!.ohlc!.close! };
        }
        if ((vixEntry?.last_price ?? 0) > 0 && (vixEntry?.ohlc?.close ?? 0) > 0) {
          vix = { ltp: vixEntry!.last_price!, prevClose: vixEntry!.ohlc!.close! };
        }
      }
    }
  } catch {
    // fall through to CSV fallbacks below
  }

  if (!nifty) nifty = csvNiftyFallback();
  if (!vix) vix = csvVixFallback();

  if (!nifty && !vix) {
    return NextResponse.json({ success: false, error: 'Could not fetch index ticker data' }, { status: 500 });
  }

  return NextResponse.json({ success: true, nifty, vix });
}

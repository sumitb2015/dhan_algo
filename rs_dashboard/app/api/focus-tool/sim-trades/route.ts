import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { PROJECT_ROOT } from '@/lib/pyExec';

/**
 * Paper-fill journal for Focus Tool rows in SIM mode.
 *
 * A sim row's fill ledger is cleared when it exits or is re-armed, exactly
 * like a real row's — but a real row's history still lives at the broker,
 * and a sim row's has nowhere else to go. Every paper fill is appended here
 * (one JSON object per line) so a forward test can be judged after the fact.
 * Append-only: no read-modify-write, so concurrent fills cannot lose a line.
 */
const JOURNAL = path.join(PROJECT_ROOT, 'debug', 'focus_tool_sim_trades.jsonl');

export interface SimTrade {
  ts: string;
  rowId: string;
  underlying: string;
  expiry: string;
  leg: 'CE' | 'PE';
  strike: number;
  side: 'BUY' | 'SELL';
  qty: number;
  price: number;
  /** Realised P&L this fill booked (closing fills only; 0 on an open). */
  booked: number;
  reason?: string;
}

function istDate(iso: string): string {
  return new Date(new Date(iso).getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const t = await req.json() as Partial<SimTrade>;
    if (!t.rowId || (t.leg !== 'CE' && t.leg !== 'PE') || (t.side !== 'BUY' && t.side !== 'SELL')
      || !(Number(t.qty) > 0) || !(Number(t.price) > 0)) {
      return NextResponse.json({ success: false, error: 'invalid sim trade' }, { status: 400 });
    }
    const rec: SimTrade = {
      ts: new Date().toISOString(),
      rowId: String(t.rowId),
      underlying: String(t.underlying ?? ''),
      expiry: String(t.expiry ?? ''),
      leg: t.leg,
      strike: Number(t.strike) || 0,
      side: t.side,
      qty: Number(t.qty),
      price: Number(t.price),
      booked: Number(t.booked) || 0,
      ...(t.reason ? { reason: String(t.reason) } : {}),
    };
    await fs.promises.mkdir(path.dirname(JOURNAL), { recursive: true });
    await fs.promises.appendFile(JOURNAL, JSON.stringify(rec) + '\n', 'utf-8');
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[/api/focus-tool/sim-trades POST]', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}

/** ?date=YYYY-MM-DD (IST, default today) → that day's paper fills + booked total. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const date = req.nextUrl.searchParams.get('date') || istDate(new Date().toISOString());
    let trades: SimTrade[] = [];
    try {
      const raw = await fs.promises.readFile(JOURNAL, 'utf-8');
      trades = raw.split('\n').filter(Boolean).flatMap(line => {
        try { return [JSON.parse(line) as SimTrade]; } catch { return []; }
      }).filter(t => istDate(t.ts) === date);
    } catch { /* no journal yet */ }
    const booked = trades.reduce((s, t) => s + (Number(t.booked) || 0), 0);
    return NextResponse.json({ success: true, date, trades, booked });
  } catch (err) {
    console.error('[/api/focus-tool/sim-trades GET]', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}

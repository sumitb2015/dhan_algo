import { NextRequest, NextResponse } from 'next/server';
import type { WantedPair } from '@/lib/pnfWanted';
import { askBridge, ensureBridge, readBack, readBridgeBook, SEGMENTS } from '@/lib/pnfLiveBridge';

// Live price for the Point & Figure page, from the WebSocket bridge scripts/tools/pnf_ws.py (lib/pnfLiveBridge.ts). This route only
// asks the bridge for the page's instrument and reads its quotes file: read-only, no orders.

/** `ids=SEG:ID[,SEG:ID]` (a straddle's two legs) or the single `segment=&id=` form. */
function parseInstruments(p: URLSearchParams): [string, string][] | null {
  const raw = p.get('ids');
  const pairs = raw ? raw.split(',').map(x => x.split(':')) : [[p.get('segment') ?? '', p.get('id') ?? '']];
  if (pairs.length < 1 || pairs.length > 2) return null;
  for (const pair of pairs) if (pair.length !== 2 || !SEGMENTS.has(pair[0]) || !/^\d{1,9}$/.test(pair[1])) return null;
  return pairs as [string, string][];
}

export async function GET(request: NextRequest) {
  const instruments = parseInstruments(new URL(request.url).searchParams);
  if (!instruments) {
    return NextResponse.json({ success: false, error: 'Use ids=SEG:ID[,SEG:ID] or segment=IDX_I|NSE_EQ|NSE_FNO|MCX_COMM&id=<security id>' }, { status: 400 });
  }
  const key = instruments.map(([s, i]) => `${s}:${i}`).join(',');
  const now = Date.now();
  try {
    askBridge(key, instruments as WantedPair[], now);
  } catch (err) {
    return NextResponse.json({ success: false, error: `could not ask the bridge: ${(err as Error).message}` }, { status: 500 });
  }
  const running = ensureBridge(now);
  const { hub: fresh, book } = readBridgeBook(now);
  const legs = instruments.map(([s, i]) => readBack(book?.[`${s}:${i}`]));
  return NextResponse.json({ success: true, bridge: running, hub: fresh, ...legs[0], legs });
}

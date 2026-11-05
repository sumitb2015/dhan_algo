import { NextRequest, NextResponse } from 'next/server';
import { SEGMENTS } from '@/lib/pnfLiveBridge';
import { forgetOtherDays, istDate, readTickFile, rowsBetween, SETTLE_MS, tickFile } from '@/lib/pnfTicksServer';

// Renko Tick mode: today's recorded prices for one instrument or a straddle's two legs, from the price bridge's tick log
// (lib/pnfTicksServer.ts). `since` = the `upTo` of the previous read (0 for the whole day). Read-only, no orders; the page's live
// route keeps asking the bridge for the instruments, so this route never starts or subscribes anything.

export async function GET(request: NextRequest) {
  const p = new URL(request.url).searchParams;
  const pairs = (p.get('ids') ?? '').split(',').map(x => x.split(':'));
  if (pairs.length < 1 || pairs.length > 2 || pairs.some(x => x.length !== 2 || !SEGMENTS.has(x[0]) || !/^\d{1,9}$/.test(x[1]))) {
    return NextResponse.json({ success: false, error: 'Use ids=SEG:ID[,SEG:ID]' }, { status: 400 });
  }
  const sinceRaw = Number(p.get('since') ?? 0);
  const since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? sinceRaw : 0;
  const now = Date.now();
  const upTo = now - SETTLE_MS;
  const day = istDate(now);
  forgetOtherDays(day);
  try {
    const legs = pairs.map(([seg, sid]) => rowsBetween(readTickFile(tickFile(day, seg, sid)), since, upTo));
    return NextResponse.json({ success: true, day, upTo, legs });
  } catch (err) {
    return NextResponse.json({ success: false, error: `could not read the tick log: ${(err as Error).message}` }, { status: 500 });
  }
}

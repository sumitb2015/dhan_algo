import { NextRequest, NextResponse } from 'next/server';
import { parseIndexMap } from '@/lib/pnfIndexMap';
import { resolveIndexTrade } from '@/lib/pnfIndexTradeServer';
import { isComplete, parseTarget } from '@/lib/pnfTarget';

// The Renko index chart's mapped option (lib/pnfIndexMap.ts): which CE / PE the next bullish or bearish trade would be, resolved from the
// index's live spot. Read-only - no order is placed here; the page then sends the ordinary order route the returned OPTION target.
//   GET ?broker=dhan|kotak|zerodha&target=<index target JSON>&map=<IndexMap JSON>&dir=bull|bear[&premium=1]

const bad = (error: string, status = 400) => NextResponse.json({ success: false, error }, { status });
const json = (raw: string | null): unknown => { try { return JSON.parse(raw ?? 'null'); } catch { return null; } };

export async function GET(req: NextRequest): Promise<NextResponse> {
  const p = req.nextUrl.searchParams;
  const broker = p.get('broker');
  if (broker !== 'dhan' && broker !== 'kotak' && broker !== 'zerodha') return bad('broker must be dhan, kotak or zerodha');
  const target = parseTarget(json(p.get('target')));
  if (!target || !isComplete(target) || target.kind !== 'index') return bad('An index chart target is required');
  const map = parseIndexMap(json(p.get('map')));
  if (!map) return bad('A valid index -> option map is required');
  const dir = p.get('dir');
  if (dir !== 'bull' && dir !== 'bear') return bad('dir must be bull or bear');
  try {
    const r = await resolveIndexTrade(broker, target, map, dir, p.get('premium') === '1');
    if (typeof r === 'string') return NextResponse.json({ success: false, error: r }, { status: 422 });
    return NextResponse.json({ success: true, ...r });
  } catch (e) {
    return bad(`Could not resolve the option: ${(e as Error).message}`, 500);
  }
}

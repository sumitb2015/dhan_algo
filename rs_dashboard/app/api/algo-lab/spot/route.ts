import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { PROJECT_ROOT, dedupe, spaced, runPythonJson } from '@/lib/pyExec';

// Today's 1-minute closes of an index for the Algo Lab live engine (scripts/tools/algo_lab_spot_bars.py, read-only).
// Cached per minute; spawns share the dhan-spawn:<underlying> lane with the option-bars route (account-wide limit).
// After an error the last good answer is served for up to 5 minutes, marked stale.

const SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'algo_lab_spot_bars.py');
const UNDERLYINGS = new Set(['NIFTY', 'BANKNIFTY', 'SENSEX']);
type Reply = { ok: boolean; date?: string; bars?: [string, number][]; error?: string };

const cache = new Map<string, { minute: string; at: number; data: Reply }>();
const minuteNow = () => new Date().toISOString().slice(0, 16);

export async function GET(request: NextRequest) {
  const u = (new URL(request.url).searchParams.get('underlying') ?? 'NIFTY').toUpperCase();
  if (!UNDERLYINGS.has(u)) return NextResponse.json({ success: false, error: 'unsupported underlying' }, { status: 400 });
  const hit = cache.get(u);
  if (hit && hit.minute === minuteNow()) return NextResponse.json({ success: true, ...hit.data });
  try {
    const data = await dedupe(`algo-lab-spot:${u}`, () => spaced(`dhan-spawn:${u}`, () => runPythonJson<Reply>(SCRIPT, ['--underlying', u], 25_000)));
    if (data.ok) {
      cache.set(u, { minute: minuteNow(), at: Date.now(), data });
      return NextResponse.json({ success: true, ...data });
    }
    if (hit && Date.now() - hit.at < 5 * 60_000) return NextResponse.json({ success: true, stale: true, ...hit.data });
    return NextResponse.json({ success: false, error: data.error ?? 'no data' }, { status: 502 });
  } catch (err) {
    if (hit && Date.now() - hit.at < 5 * 60_000) return NextResponse.json({ success: true, stale: true, ...hit.data });
    return NextResponse.json({ success: false, error: String((err as Error).message ?? err) }, { status: 502 });
  }
}

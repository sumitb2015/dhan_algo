import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { PROJECT_ROOT, dedupe, spaced, runPythonJson } from '@/lib/pyExec';

// High / low of a time range for one Focus Tool leg's Range Breakout — wraps
// scripts/tools/focus_tool_range.py (1-minute Dhan bars, range = [start, end)).
//
// A COMPLETE range never changes, so it is cached for the day; an incomplete
// one is never cached (the client retries). Shares the dhan-spawn pacing
// bucket with the VWAP route — same account-wide historical-data limit.

const SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'focus_tool_range.py');

interface RangeResult { high: number | null; low: number | null; bars?: number; complete?: boolean; error?: string }

const cache = new Map<string, RangeResult>();
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;

export async function GET(request: NextRequest) {
  const q = new URL(request.url).searchParams;
  const underlying = (q.get('underlying') ?? '').toUpperCase();
  const on = q.get('on') === 'underlying' ? 'underlying' : 'instrument';
  const expiry = q.get('expiry') ?? '';
  const strike = q.get('strike') ?? '';
  const leg = (q.get('leg') ?? '').toUpperCase();
  const start = q.get('start') ?? '';
  const end = q.get('end') ?? '';

  if (!['NIFTY', 'BANKNIFTY', 'SENSEX'].includes(underlying) || !HM.test(start) || !HM.test(end)) {
    return NextResponse.json({ success: false, error: 'underlying, start and end (HH:MM) required' }, { status: 400 });
  }
  if (on === 'instrument' && (!/^\d{4,6}$/.test(strike) || !['CE', 'PE'].includes(leg) || !/^\d{4}-\d{2}-\d{2}$/.test(expiry))) {
    return NextResponse.json({ success: false, error: 'expiry, strike and leg required for an instrument range' }, { status: 400 });
  }

  const today = new Date().toISOString().slice(0, 10);
  const key = `${today}:${underlying}:${on}:${on === 'instrument' ? `${expiry}:${strike}:${leg}` : ''}:${start}:${end}`;
  const hit = cache.get(key);
  if (hit) return NextResponse.json({ success: true, ...hit });

  const args = ['--underlying', underlying, '--start', start, '--end', end];
  if (on === 'underlying') args.push('--index');
  else args.push('--expiry', expiry, '--strike', strike, '--leg', leg);

  try {
    const result = await dedupe(`focus-tool-range:${key}`, () =>
      spaced(`dhan-spawn:${underlying}`, () => runPythonJson<RangeResult>(SCRIPT, args, 45_000)),
    );
    if (result.complete) cache.set(key, result);
    return NextResponse.json({ success: !result.error, ...result });
  } catch (err) {
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}

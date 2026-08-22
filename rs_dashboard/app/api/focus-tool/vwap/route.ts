import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { PROJECT_ROOT, dedupe, spaced, runPythonJson } from '@/lib/pyExec';

// Session-open VWAP for one Focus Tool row's CE+PE strike pair — wraps
// scripts/tools/focus_tool_vwap.py, which pulls today's actual intraday
// candles from Dhan (session-open anchored, not a live-tick guess) at the
// requested --interval (default 1-minute, the finest Dhan supports), using
// only closed bars so the number matches TradingView/broker-platform VWAP.
//
// Dhan's historical intraday endpoint shares the same account-wide ~1 req/3s
// limit as the option chain route, so this reuses that exact pacing bucket
// (dhan-spawn:<underlying>) rather than a separate one — two routes racing
// independent limiters for the same underlying would still 429 each other.

const SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'focus_tool_vwap.py');

interface VwapResult { vwap: number | null; error?: string }
interface CacheEntry { minuteKey: string; result: VwapResult }

const cache = new Map<string, CacheEntry>();

function minuteKey(): string {
  return new Date().toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM
}

const VALID_INTERVALS = new Set(['1', '5', '15', '25', '60']);
const VALID_SIDES = new Set(['CE', 'PE', 'BOTH']);

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const underlying = (searchParams.get('underlying') ?? '').toUpperCase();
  const expiry = searchParams.get('expiry') ?? '';
  const ceStrike = searchParams.get('ceStrike') ?? '';
  const peStrike = searchParams.get('peStrike') ?? '';
  const interval = searchParams.get('interval') ?? '1';
  const side = (searchParams.get('side') ?? 'BOTH').toUpperCase();

  if (!['NIFTY', 'BANKNIFTY', 'SENSEX'].includes(underlying) || !expiry || !ceStrike || !peStrike) {
    return NextResponse.json(
      { success: false, error: 'underlying, expiry, ceStrike, peStrike all required' },
      { status: 400 },
    );
  }
  if (!VALID_INTERVALS.has(interval)) {
    return NextResponse.json({ success: false, error: 'interval must be one of 1/5/15/25/60' }, { status: 400 });
  }
  if (!VALID_SIDES.has(side)) {
    return NextResponse.json({ success: false, error: 'side must be CE, PE or BOTH' }, { status: 400 });
  }

  const cacheKey = `${underlying}:${expiry}:${ceStrike}:${peStrike}:${interval}:${side}`;
  const nowMinute = minuteKey();
  const cached = cache.get(cacheKey);
  if (cached && cached.minuteKey === nowMinute) {
    return NextResponse.json({ success: true, ...cached.result });
  }

  try {
    const result = await dedupe(`focus-tool-vwap:${cacheKey}:${nowMinute}`, () =>
      spaced(`dhan-spawn:${underlying}`, () =>
        runPythonJson<VwapResult>(SCRIPT, [
          '--underlying', underlying,
          '--expiry', expiry,
          '--ce-strike', ceStrike,
          '--pe-strike', peStrike,
          '--interval', interval,
          '--side', side,
        ], 45_000),
      ),
    );
    cache.set(cacheKey, { minuteKey: nowMinute, result });
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}

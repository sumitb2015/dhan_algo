import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { PROJECT_ROOT, runPythonJson, dedupe } from '@/lib/pyExec';

const SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'analysis', 'strike_history.py');

const STRIKE_RELATIVE_RE = /^ATM([+-](?:[1-9]|10))?$/i;

export interface StrikeHistoryPoint {
  datetime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  strike: number;
  spot: number;
  oi: number;
  volume: number;
  iv: number;
}

export interface StrikeHistoryMeta {
  initialSpot: number;
  latestSpot: number;
  spotChange: number;
  spotChangePct: number;
  initialStrike: number;
  latestStrike: number;
  minStrike: number;
  maxStrike: number;
  distinctStrikes: number[];
  initialClose: number;
  latestClose: number;
  minClose: number;
  maxClose: number;
  decay: number;
  decayPct: number;
  tradingDays: string[];
  totalDays: number;
}

interface StrikeHistoryPayload {
  expiry: string;
  strikeRelative: string;
  optionType: 'CE' | 'PE';
  meta?: StrikeHistoryMeta;
  points: StrikeHistoryPoint[];
  error?: string;
}

interface ExpiriesPayload {
  expiries: string[];
  error?: string;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get('mode');

  if (mode === 'expiries') {
    try {
      const parsed = await dedupe('strike-history:expiries', () =>
        runPythonJson<ExpiriesPayload>(SCRIPT, ['--list-expiries'], 30_000)
      );
      if (parsed.error) {
        return NextResponse.json({ success: false, error: parsed.error }, { status: 500 });
      }
      const response = NextResponse.json({ success: true, expiries: parsed.expiries });
      response.headers.set('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
      return response;
    } catch (err) {
      console.error('[/api/options/strike-history?mode=expiries] error:', err);
      return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
    }
  }

  const expiry = (searchParams.get('expiry') ?? '').trim();
  const rawRelative = (searchParams.get('strikeRelative') ?? '').trim();
  const strikeRelative = rawRelative.toUpperCase().replace(/\s+/g, '+');
  const optionType = (searchParams.get('optionType') ?? '').trim().toUpperCase();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) {
    return NextResponse.json({ success: false, error: 'invalid expiry format (expected YYYY-MM-DD)' }, { status: 400 });
  }
  if (!STRIKE_RELATIVE_RE.test(strikeRelative)) {
    return NextResponse.json({ success: false, error: `invalid strikeRelative "${rawRelative}". Expected ATM or ATM±[1-10]` }, { status: 400 });
  }
  if (optionType !== 'CE' && optionType !== 'PE') {
    return NextResponse.json({ success: false, error: 'invalid optionType (expected CE or PE)' }, { status: 400 });
  }

  try {
    const key = `strike-history:${expiry}:${strikeRelative}:${optionType}`;
    const parsed = await dedupe(key, () =>
      runPythonJson<StrikeHistoryPayload>(
        SCRIPT,
        ['--expiry', expiry, '--strike-relative', strikeRelative, '--option-type', optionType],
        45_000
      )
    );

    if (parsed.error) {
      return NextResponse.json({ success: false, error: parsed.error }, { status: 500 });
    }

    const response = NextResponse.json({ success: true, ...parsed });
    response.headers.set('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
    return response;
  } catch (err) {
    console.error('[/api/options/strike-history] error:', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}

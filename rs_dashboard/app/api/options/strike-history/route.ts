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

interface StrikeHistoryPayload {
  expiry: string;
  strikeRelative: string;
  optionType: 'CE' | 'PE';
  points: StrikeHistoryPoint[];
  error?: string;
}

interface ExpiriesPayload {
  expiries: string[];
  error?: string;
}

interface StrikesPayload {
  expiry: string;
  strikes: number[];
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

  if (mode === 'strikes') {
    const expiry = (searchParams.get('expiry') ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) {
      return NextResponse.json({ success: false, error: 'invalid expiry format (expected YYYY-MM-DD)' }, { status: 400 });
    }
    try {
      const parsed = await dedupe(`strike-history:strikes:${expiry}`, () =>
        runPythonJson<StrikesPayload>(SCRIPT, ['--list-strikes', '--expiry', expiry], 30_000)
      );
      if (parsed.error) {
        return NextResponse.json({ success: false, error: parsed.error }, { status: 500 });
      }
      const response = NextResponse.json({ success: true, expiry, strikes: parsed.strikes });
      response.headers.set('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
      return response;
    } catch (err) {
      console.error('[/api/options/strike-history?mode=strikes] error:', err);
      return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
    }
  }

  const expiry = (searchParams.get('expiry') ?? '').trim();
  const strikeParam = searchParams.get('strike');
  const rawRelative = (searchParams.get('strikeRelative') ?? '').trim();
  const optionType = (searchParams.get('optionType') ?? '').trim().toUpperCase();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) {
    return NextResponse.json({ success: false, error: 'invalid expiry format (expected YYYY-MM-DD)' }, { status: 400 });
  }
  if (optionType !== 'CE' && optionType !== 'PE') {
    return NextResponse.json({ success: false, error: 'invalid optionType (expected CE or PE)' }, { status: 400 });
  }

  const strikeNum = strikeParam ? parseFloat(strikeParam) : null;
  const isFixed = strikeNum !== null && !isNaN(strikeNum) && strikeNum > 0;
  const strikeRelative = rawRelative ? rawRelative.toUpperCase().replace(/\s+/g, '+') : '';

  if (!isFixed && !STRIKE_RELATIVE_RE.test(strikeRelative)) {
    return NextResponse.json(
      {
        success: false,
        error: `invalid strike or strikeRelative. Provide strike (e.g. 24000) or strikeRelative (e.g. ATM+2)`,
      },
      { status: 400 }
    );
  }

  try {
    const key = isFixed
      ? `strike-history:${expiry}:fixed:${strikeNum}:${optionType}`
      : `strike-history:${expiry}:rel:${strikeRelative}:${optionType}`;

    const args = isFixed
      ? ['--expiry', expiry, '--strike', String(strikeNum), '--option-type', optionType]
      : ['--expiry', expiry, '--strike-relative', strikeRelative, '--option-type', optionType];

    const parsed = await dedupe(key, () =>
      runPythonJson<StrikeHistoryPayload>(SCRIPT, args, 45_000)
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

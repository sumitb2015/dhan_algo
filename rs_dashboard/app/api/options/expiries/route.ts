import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';

import { PROJECT_ROOT, PYTHON_EXE } from '@/lib/pyExec';

const execFileAsync = promisify(execFile);

const FETCH_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'options_data_fetch.py');

const cache = new Map<string, { data: string[]; ts: number }>();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

// Brokers whose expiries come from a locally cached instrument master rather
// than a live API call. Both caches are written in the same row shape, so one
// code path serves them; only the file name and the builder script differ.
const CACHE_BROKERS: Record<string, { supported: Set<string>; script: string }> = {
  zerodha: {
    supported: new Set(['NIFTY', 'BANKNIFTY', 'SENSEX']),
    script: 'zerodha_instruments_cache.py',
  },
  kotak: {
    supported: new Set(['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'SENSEX', 'CRUDEOIL', 'CRUDEOILM']),
    script: 'kotak_instruments_cache.py',
  },
};

// Today's date in IST, as YYYY-MM-DD — used to both scope the cache key
// (so a stale entry can never survive a day rollover) and to filter out
// any already-lapsed expiry dates the broker/cache might still hand back.
function todayIST(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const underlying = (searchParams.get('underlying') ?? 'NIFTY').toUpperCase();
  const broker = (searchParams.get('broker') ?? 'dhan').toLowerCase();
  const today = todayIST();

  const cacheBroker = CACHE_BROKERS[broker];

  if (cacheBroker && !cacheBroker.supported.has(underlying)) {
    // Fail loudly instead of silently returning another underlying's
    // expiries mislabeled as the requested one.
    return NextResponse.json(
      { success: false, error: `${broker} does not support ${underlying} yet` },
      { status: 400 },
    );
  }

  if (cacheBroker) {
    try {
      const cacheFile = path.join(PROJECT_ROOT, 'debug', `${broker}_${underlying.toLowerCase()}_instruments.json`);
      if (!fs.existsSync(cacheFile)) {
        const cacheScript = path.join(PROJECT_ROOT, 'scripts', 'tools', cacheBroker.script);
        await execFileAsync(PYTHON_EXE, [cacheScript, '--underlying', underlying], { encoding: 'utf8', timeout: 120_000, windowsHide: true });
      }
      if (fs.existsSync(cacheFile)) {
        const raw = fs.readFileSync(cacheFile, 'utf8');
        const instruments = JSON.parse(raw) as { expiry: string }[];
        const uniqueExpiries = Array.from(new Set(instruments.map(x => x.expiry)))
          .filter(d => d >= today)
          .sort();
        return NextResponse.json({ success: true, data: uniqueExpiries });
      }
    } catch (err) {
      console.error(`[/api/options/expiries] Failed to read/generate ${broker} cache:`, err);
      return NextResponse.json({ success: false, error: `Failed to retrieve ${broker} expiries` }, { status: 500 });
    }
  }

  const cacheKey = `${underlying}:${today}`;

  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.ts < CACHE_TTL) {
    return NextResponse.json({ success: true, data: hit.data });
  }

  try {
    const { stdout, stderr } = await execFileAsync(
      PYTHON_EXE,
      [FETCH_SCRIPT, 'expiries', '--underlying', underlying],
      { encoding: 'utf8', timeout: 30_000, windowsHide: true },
    );

    // Script prints one JSON line to stdout; Python/DhanHelper logs go to stderr.
    const jsonLine = stdout.trim().split('\n').pop() ?? '{}';
    const parsed = JSON.parse(jsonLine) as { expiries?: string[]; error?: string };

    if (parsed.error) {
      console.error('[/api/options/expiries] script error:', parsed.error, (stderr ?? '').slice(0, 500));
      return NextResponse.json({ success: false, error: parsed.error }, { status: 500 });
    }

    const expiries = (parsed.expiries ?? []).filter((d) => d >= today);
    if (expiries.length) cache.set(cacheKey, { data: expiries, ts: Date.now() });
    return NextResponse.json({ success: true, data: expiries });
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    if (e.stdout) {
      try {
        const jsonLine = String(e.stdout).trim().split('\n').pop() ?? '{}';
        const parsed = JSON.parse(jsonLine) as { expiries?: string[]; error?: string };
        if (!parsed.error) {
          const expiries = (parsed.expiries ?? []).filter((d) => d >= today);
          if (expiries.length) cache.set(cacheKey, { data: expiries, ts: Date.now() });
          return NextResponse.json({ success: true, data: expiries });
        }
      } catch {}
    }
    console.error('[/api/options/expiries] error:', e.message, e.stderr ?? '');
    return NextResponse.json({ success: false, error: `Script error: ${String(e.message)}` }, { status: 500 });
  }
}

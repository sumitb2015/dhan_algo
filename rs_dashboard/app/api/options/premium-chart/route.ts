import { NextResponse } from 'next/server';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

import { PROJECT_ROOT, PYTHON_EXE } from '@/lib/pyExec';

const execFileAsync = promisify(execFile);

const PREMIUM_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'tradebook_premium.py');

// Polled every 30s by OptionsPositionsTab with zero prior caching — a fresh spawn on
// every poll blocks the whole single-threaded dev server for the script's full runtime.
const CACHE_TTL = 5_000;
let cacheEntry: { data: ScriptResponse; ts: number } | null = null;

interface PremiumPoint { time: string; premium: number }

interface SymbolMeta { securityId: string; tradingSymbol: string; displayName: string }

interface ScriptResponse {
  success: boolean;
  data: PremiumPoint[];
  by_symbol: Record<string, PremiumPoint[]>;
  symbols: SymbolMeta[];
  current_premium: number;
  session_date: string;
  trades_count: number;
  error?: string;
}

export async function GET() {
  if (cacheEntry && Date.now() - cacheEntry.ts < CACHE_TTL) {
    return NextResponse.json(cacheEntry.data);
  }

  try {
    const { stdout } = await execFileAsync(PYTHON_EXE, [PREMIUM_SCRIPT], {
      encoding: 'utf8', timeout: 30_000, windowsHide: true,
    });

    const jsonLine = (stdout ?? '').trim().split('\n').pop() ?? '{}';
    const parsed   = JSON.parse(jsonLine) as ScriptResponse;

    if (!parsed.success) {
      console.error('[/api/options/premium-chart]', parsed.error);
      return NextResponse.json({ success: false, error: parsed.error ?? 'Script error' }, { status: 500 });
    }

    cacheEntry = { data: parsed, ts: Date.now() };
    return NextResponse.json(parsed);
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    if (e.stdout) {
      try {
        const jsonLine = String(e.stdout).trim().split('\n').pop() ?? '{}';
        const parsed = JSON.parse(jsonLine) as ScriptResponse;
        if (parsed.success) {
          cacheEntry = { data: parsed, ts: Date.now() };
          return NextResponse.json(parsed);
        }
      } catch {}
    }
    console.error('[/api/options/premium-chart] error:', e.message, e.stderr ?? '');
    return NextResponse.json({ success: false, error: `Script error: ${String(e.message)}` }, { status: 500 });
  }
}

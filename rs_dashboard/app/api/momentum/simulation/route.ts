import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { promisify } from 'util';
import { execFile } from 'child_process';
import { DEBUG_DIR, PROJECT_ROOT } from '@/lib/strategyRegistry';
import { PYTHON_EXE } from '@/lib/pyExec';
import { readJsonFile } from '@/lib/lockedJsonFile';

const execFileAsync = promisify(execFile);
const REPLAYS_DIR = path.join(DEBUG_DIR, 'replays');

function sanitizeDate(d: string | null | undefined, fallback: string): string {
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return fallback;
  return d;
}

function sanitizeStrategy(s: string | null | undefined): string {
  const allowed = ['turtle_rs', 'minervini', '52w_high', 'clenow'];
  const val = (s || '').toLowerCase().trim();
  return allowed.includes(val) ? val : 'turtle_rs';
}

/** Stop distance each model used before it became a setting. Mirrors default_stop_pct() in simulate_momentum_replay.py. */
function defaultStop(strategy: string): number {
  return strategy === 'clenow' ? 15 : 12;
}

/** Max positions per sector. Mirrors DEFAULT_SECTOR_CAP in simulate_momentum_replay.py. */
const DEFAULT_SECTOR_CAP = 2;

function sanitizeStop(v: unknown, strategy: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return defaultStop(strategy);
  return Math.round(Math.max(2, Math.min(30, n)) * 10) / 10;
}

interface ReplayParams {
  start: string;
  end: string;
  capital: number;
  slots: number;
  regimeEnabled: boolean;
  breakoutDays: number;
  strategy: string;
  stopPct: number;
  sectorCap: number;
  benchmark: 'nifty50' | 'nifty500';
  regimeInterval: 'weekly' | 'daily';
}

function parseParams(get: (k: string) => unknown): ReplayParams | { error: string } {
  const start = sanitizeDate(get('start') as string, '2026-10-15');
  const end = sanitizeDate(get('end') as string, '2026-11-20');
  if (start > end) return { error: 'Start date cannot be after end date' };
  const strategy = sanitizeStrategy(get('strategy') as string);
  const benchmark = String(get('benchmark') || 'nifty50').toLowerCase() === 'nifty500' ? 'nifty500' : 'nifty50';
  const regimeInterval = String(get('regime_interval') || get('regimeInterval') || 'weekly').toLowerCase() === 'daily' ? 'daily' : 'weekly';
  return {
    start,
    end,
    capital: Math.max(10_000, Number(get('capital')) || 500_000),
    slots: Math.max(1, Math.min(30, Number(get('slots')) || 10)),
    regimeEnabled: get('regime') !== 'false' && get('regime') !== false,
    breakoutDays: Math.max(5, Math.min(100, Number(get('breakout_days')) || 55)),
    strategy,
    stopPct: sanitizeStop(get('stop_pct'), strategy),
    sectorCap: Math.max(1, Math.min(10, Math.round(Number(get('sector_cap'))) || DEFAULT_SECTOR_CAP)),
    benchmark,
    regimeInterval,
  };
}

/** Cache filename. Every suffix must mirror run_replay_simulation() in simulate_momentum_replay.py exactly. */
function cacheFileFor(p: ReplayParams): string {
  const regimeSuffix = p.regimeEnabled ? '' : '_no_regime';
  const benchSuffix = p.benchmark === 'nifty500' ? '_nifty500' : '';
  const intervalSuffix = p.regimeInterval === 'daily' ? '_daily' : '';
  let boSuffix: string;
  if (p.strategy === 'clenow') boSuffix = '';
  else if (p.strategy === 'minervini') boSuffix = p.breakoutDays === 20 || p.breakoutDays === 55 ? '' : `_bo${p.breakoutDays}`;
  else if (p.strategy === '52w_high') boSuffix = p.breakoutDays === 5 || p.breakoutDays === 55 ? '' : `_bo${p.breakoutDays}`;
  else boSuffix = p.breakoutDays === 55 ? '' : `_bo${p.breakoutDays}`;
  const slSuffix = p.stopPct === defaultStop(p.strategy) ? '' : `_sl${p.stopPct}`;
  const scSuffix = p.sectorCap === DEFAULT_SECTOR_CAP ? '' : `_sc${p.sectorCap}`;
  const stratPrefix = p.strategy !== 'turtle_rs' ? `${p.strategy}_` : '';
  return path.join(
    REPLAYS_DIR,
    `replay_${stratPrefix}${p.start}_${p.end}_${Math.round(p.capital)}_${p.slots}${regimeSuffix}${benchSuffix}${intervalSuffix}${boSuffix}${slSuffix}${scSuffix}.json`,
  );
}

async function runReplay(p: ReplayParams, force: boolean) {
  const scriptPath = path.join(PROJECT_ROOT, 'scripts', 'analysis', 'simulate_momentum_replay.py');
  const args = [
    scriptPath,
    '--start', p.start,
    '--end', p.end,
    '--capital', String(p.capital),
    '--slots', String(p.slots),
    '--strategy', p.strategy,
    '--benchmark', p.benchmark,
    '--regime-interval', p.regimeInterval,
    '--regime', String(p.regimeEnabled),
    '--breakout-days', String(p.breakoutDays),
    '--stop-pct', String(p.stopPct),
    '--sector-cap', String(p.sectorCap),
  ];
  if (force) args.push('--force');
  return execFileAsync(PYTHON_EXE, args, { cwd: PROJECT_ROOT, timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });
}

async function respond(p: ReplayParams, force: boolean) {
  fs.mkdirSync(REPLAYS_DIR, { recursive: true });
  const cacheFile = cacheFileFor(p);
  if (!force && fs.existsSync(cacheFile)) {
    const cached = readJsonFile(cacheFile);
    if (cached) return NextResponse.json(cached);
  }
  const run = await runReplay(p, force);
  const data = fs.existsSync(cacheFile) ? readJsonFile(cacheFile) : null;
  if (data) return NextResponse.json(data);
  return NextResponse.json(
    {
      success: false,
      error: `Replay output was not generated (expected ${path.basename(cacheFile)}). ${String(run.stderr || run.stdout || '').slice(-300)}`,
    },
    { status: 500 },
  );
}

export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const p = parseParams((k) => sp.get(k));
    if ('error' in p) return NextResponse.json({ success: false, error: p.error }, { status: 400 });
    return await respond(p, false);
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    if (body?.action === 'clear_cache') {
      let count = 0;
      if (fs.existsSync(REPLAYS_DIR)) {
        for (const f of fs.readdirSync(REPLAYS_DIR)) {
          if (f.startsWith('replay_') && f.endsWith('.json')) {
            try {
              fs.unlinkSync(path.join(REPLAYS_DIR, f));
              count++;
            } catch {}
          }
        }
      }
      return NextResponse.json({ success: true, message: `Cleared ${count} cached replay files.`, cleared: count });
    }

    const p = parseParams((k) => body?.[k]);
    if ('error' in p) return NextResponse.json({ success: false, error: p.error }, { status: 400 });
    const force = body?.force !== false;
    return await respond(p, force);
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

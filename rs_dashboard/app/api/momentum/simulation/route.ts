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


export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const start = sanitizeDate(sp.get('start'), '2026-10-15');
    const end = sanitizeDate(sp.get('end'), '2026-11-20');
    if (start > end) {
      return NextResponse.json({ success: false, error: 'Start date cannot be after end date' }, { status: 400 });
    }
    const capital = Math.max(10_000, Number(sp.get('capital')) || 175_000);
    const slots = Math.max(1, Math.min(30, Number(sp.get('slots')) || 10));
    const regimeEnabled = sp.get('regime') !== 'false';
    const breakoutDays = Math.max(5, Math.min(100, Number(sp.get('breakout_days')) || 55));
    const strategy = sanitizeStrategy(sp.get('strategy'));

    fs.mkdirSync(REPLAYS_DIR, { recursive: true });
    const regimeSuffix = regimeEnabled ? '' : '_no_regime';
    let boSuffix = '';
    if (strategy === 'clenow') {
      boSuffix = '';
    } else if (strategy === 'minervini') {
      boSuffix = breakoutDays === 20 || breakoutDays === 55 ? '' : `_bo${breakoutDays}`;
    } else if (strategy === '52w_high') {
      boSuffix = breakoutDays === 5 || breakoutDays === 55 ? '' : `_bo${breakoutDays}`;
    } else {
      boSuffix = breakoutDays === 55 ? '' : `_bo${breakoutDays}`;
    }

    const stratPrefix = strategy !== 'turtle_rs' ? `${strategy}_` : '';
    const cacheFile = path.join(REPLAYS_DIR, `replay_${stratPrefix}${start}_${end}_${Math.round(capital)}_${slots}${regimeSuffix}${boSuffix}.json`);
    const fallbackFile = path.join(REPLAYS_DIR, `replay_${stratPrefix}${start}_${end}_${Math.round(capital)}_${slots}${regimeSuffix}.json`);
    const legacyFile = path.join(REPLAYS_DIR, `replay_${start}_${end}_${Math.round(capital)}_${slots}${regimeSuffix}${boSuffix}.json`);

    const targetFile = fs.existsSync(cacheFile)
      ? cacheFile
      : (fs.existsSync(fallbackFile)
        ? fallbackFile
        : (strategy === 'turtle_rs' && fs.existsSync(legacyFile) ? legacyFile : null));

    if (targetFile) {
      const data = readJsonFile(targetFile);
      if (data) {
        return NextResponse.json(data);
      }
    }

    // Generate on demand
    const scriptPath = path.join(PROJECT_ROOT, 'scripts', 'analysis', 'simulate_momentum_replay.py');
    const args = [
      scriptPath,
      '--start', start,
      '--end', end,
      '--capital', String(capital),
      '--slots', String(slots),
      '--strategy', strategy,
      '--regime', String(regimeEnabled),
      '--breakout-days', String(breakoutDays),
    ];

    const run = await execFileAsync(PYTHON_EXE, args, {
      cwd: PROJECT_ROOT,
      timeout: 120_000,
      maxBuffer: 32 * 1024 * 1024,
    });

    if (fs.existsSync(cacheFile)) {
      const data = readJsonFile(cacheFile);
      if (data) return NextResponse.json(data);
    }
    if (strategy === 'turtle_rs' && fs.existsSync(legacyFile)) {
      const data = readJsonFile(legacyFile);
      if (data) return NextResponse.json(data);
    }

    return NextResponse.json(
      {
        success: false,
        error: `Replay output was not generated (expected ${path.basename(cacheFile)}). ${String(run.stderr || run.stdout || '').slice(-300)}`,
      },
      { status: 500 }
    );
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const start = sanitizeDate(body.start, '2026-10-15');
    const end = sanitizeDate(body.end, '2026-11-20');
    if (start > end) {
      return NextResponse.json({ success: false, error: 'Start date cannot be after end date' }, { status: 400 });
    }
    const capital = Math.max(10_000, Number(body.capital) || 175_000);
    const slots = Math.max(1, Math.min(30, Number(body.slots) || 10));
    const regimeEnabled = body.regime !== false;
    const breakoutDays = Math.max(5, Math.min(100, Number(body.breakout_days) || 55));
    const strategy = sanitizeStrategy(body.strategy);

    fs.mkdirSync(REPLAYS_DIR, { recursive: true });
    const scriptPath = path.join(PROJECT_ROOT, 'scripts', 'analysis', 'simulate_momentum_replay.py');
    const args = [
      scriptPath,
      '--start', start,
      '--end', end,
      '--capital', String(capital),
      '--slots', String(slots),
      '--strategy', strategy,
      '--regime', String(regimeEnabled),
      '--breakout-days', String(breakoutDays),
      '--force',
    ];

    await execFileAsync(PYTHON_EXE, args, {
      cwd: PROJECT_ROOT,
      timeout: 120_000,
      maxBuffer: 32 * 1024 * 1024,
    });

    const regimeSuffix = regimeEnabled ? '' : '_no_regime';
    let boSuffix = '';
    if (strategy === 'clenow') {
      boSuffix = '';
    } else if (strategy === 'minervini') {
      boSuffix = breakoutDays === 20 || breakoutDays === 55 ? '' : `_bo${breakoutDays}`;
    } else if (strategy === '52w_high') {
      boSuffix = breakoutDays === 5 || breakoutDays === 55 ? '' : `_bo${breakoutDays}`;
    } else {
      boSuffix = breakoutDays === 55 ? '' : `_bo${breakoutDays}`;
    }

    const stratPrefix = strategy !== 'turtle_rs' ? `${strategy}_` : '';
    const cacheFile = path.join(REPLAYS_DIR, `replay_${stratPrefix}${start}_${end}_${Math.round(capital)}_${slots}${regimeSuffix}${boSuffix}.json`);
    const fallbackFile = path.join(REPLAYS_DIR, `replay_${stratPrefix}${start}_${end}_${Math.round(capital)}_${slots}${regimeSuffix}.json`);

    if (fs.existsSync(cacheFile)) {
      const data = readJsonFile(cacheFile);
      if (data) return NextResponse.json(data);
    }
    if (fs.existsSync(fallbackFile)) {
      const data = readJsonFile(fallbackFile);
      if (data) return NextResponse.json(data);
    }

    return NextResponse.json(
      { success: false, error: 'Simulation completed but replay cache not found.' },
      { status: 500 }
    );
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

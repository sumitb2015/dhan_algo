import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const PROJECT_ROOT   = path.resolve(process.cwd(), '..');
const PYTHON_EXE     = path.join(PROJECT_ROOT, 'venv', 'Scripts', 'pythonw.exe');
const SCALPER_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'scalper_api.py');

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = await req.json();
  const { underlying = 'NIFTY', expiry, strike, option, side, lots = 1, type = 'MARKET', price } = body;

  if (!expiry || !strike || !option || !side) {
    return NextResponse.json({ success: false, error: 'Missing required fields: expiry, strike, option, side' }, { status: 400 });
  }

  const lotsNum = Number(lots);
  if (!Number.isInteger(lotsNum) || lotsNum <= 0) {
    return NextResponse.json({ success: false, error: `Invalid lots: ${lots} (must be a positive integer)` }, { status: 400 });
  }

  const sideUpper = String(side).toUpperCase();
  if (sideUpper !== 'BUY' && sideUpper !== 'SELL') {
    return NextResponse.json({ success: false, error: `Invalid side: ${side} (must be BUY or SELL)` }, { status: 400 });
  }

  if (String(type).toUpperCase() === 'LIMIT' && !(Number(price) > 0)) {
    return NextResponse.json({ success: false, error: `Invalid price for LIMIT order: ${price}` }, { status: 400 });
  }

  const args = [
    SCALPER_SCRIPT, 'order',
    '--underlying', String(underlying),
    '--expiry', String(expiry),
    '--strike', String(strike),
    '--option', String(option),
    '--side', String(side),
    '--lots', String(lots),
    '--type', String(type),
    ...(String(type).toUpperCase() === 'LIMIT' && price != null ? ['--price', String(price)] : []),
  ];

  try {
    const { stdout } = await execFileAsync(PYTHON_EXE, args, {
      encoding: 'utf8',
      cwd: PROJECT_ROOT,
      timeout: 30_000,
      windowsHide: true,
    });

    const lines = (stdout ?? '').trim().split('\n').filter(Boolean);
    const jsonLine = lines[lines.length - 1] ?? '{}';
    const parsed = JSON.parse(jsonLine);
    if (parsed.error && !parsed.success) {
      console.error('[/api/scalper/order] script error:', parsed.error);
    }
    return NextResponse.json(parsed);
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    if (e.stdout) {
      try {
        const lines = String(e.stdout).trim().split('\n').filter(Boolean);
        const jsonLine = lines[lines.length - 1] ?? '{}';
        return NextResponse.json(JSON.parse(jsonLine));
      } catch {}
    }
    console.error('[/api/scalper/order] error:', e.message, e.stderr ?? '');
    return NextResponse.json({ success: false, error: `Script error: ${String(e.message)}` }, { status: 500 });
  }
}

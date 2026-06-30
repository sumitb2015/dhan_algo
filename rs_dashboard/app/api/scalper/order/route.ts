import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { spawnSync } from 'child_process';

const PROJECT_ROOT   = path.resolve(process.cwd(), '..');
const PYTHON_EXE     = path.join(PROJECT_ROOT, 'venv', 'Scripts', 'pythonw.exe');
const SCALPER_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'scalper_api.py');

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = await req.json();
  const { underlying = 'NIFTY', expiry, strike, option, side, lots = 1, type = 'MARKET', price } = body;

  if (!expiry || !strike || !option || !side) {
    return NextResponse.json({ success: false, error: 'Missing required fields: expiry, strike, option, side' }, { status: 400 });
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

  const result = spawnSync(PYTHON_EXE, args, {
    encoding: 'utf8',
    cwd: PROJECT_ROOT,
    timeout: 30_000,
    windowsHide: true,
  });

  if (result.error) {
    console.error('[/api/scalper/order] spawn error:', result.error);
    return NextResponse.json({ success: false, error: String(result.error) }, { status: 500 });
  }

  try {
    const stdout = result.stdout ?? '';
    const lines = stdout.trim().split('\n').filter(Boolean);
    const jsonLine = lines[lines.length - 1] ?? '{}';
    const parsed = JSON.parse(jsonLine);
    if (parsed.error && !parsed.success) {
      const stderr = (result.stderr ?? '').slice(0, 500);
      console.error('[/api/scalper/order] script error:', parsed.error, stderr);
    }
    return NextResponse.json(parsed);
  } catch (err) {
    const stderr = (result.stderr ?? '').slice(0, 500);
    console.error('[/api/scalper/order] parse error:', err, '\nstdout:', result.stdout, '\nstderr:', stderr);
    return NextResponse.json({ success: false, error: `Parse error: ${String(err)}` }, { status: 500 });
  }
}

import { NextResponse } from 'next/server';
import path from 'path';
import { spawnSync } from 'child_process';

const PROJECT_ROOT   = path.resolve(process.cwd(), '..');
const PYTHON_EXE     = path.join(PROJECT_ROOT, 'venv', 'Scripts', 'pythonw.exe');
const PREMIUM_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'tradebook_premium.py');

interface PremiumPoint { time: string; premium: number }

interface ScriptResponse {
  success: boolean;
  data: PremiumPoint[];
  current_premium: number;
  session_date: string;
  trades_count: number;
  error?: string;
}

export async function GET() {
  const result = spawnSync(
    PYTHON_EXE,
    [PREMIUM_SCRIPT],
    { encoding: 'utf8', timeout: 30_000, windowsHide: true },
  );

  if (result.error) {
    console.error('[/api/options/premium-chart] spawn error:', result.error);
    return NextResponse.json({ success: false, error: String(result.error) }, { status: 500 });
  }

  try {
    const stdout   = result.stdout ?? '';
    const jsonLine = stdout.trim().split('\n').pop() ?? '{}';
    const parsed   = JSON.parse(jsonLine) as ScriptResponse;

    if (!parsed.success) {
      console.error('[/api/options/premium-chart]', parsed.error, (result.stderr ?? '').slice(0, 400));
      return NextResponse.json({ success: false, error: parsed.error ?? 'Script error' }, { status: 500 });
    }

    return NextResponse.json(parsed);
  } catch (err) {
    console.error('[/api/options/premium-chart] parse error:', err, '\nstdout:', result.stdout);
    return NextResponse.json({ success: false, error: `Parse error: ${String(err)}` }, { status: 500 });
  }
}

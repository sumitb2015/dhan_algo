import { NextResponse } from 'next/server';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const PROJECT_ROOT   = path.resolve(process.cwd(), '..');
const PYTHON_EXE     = path.join(PROJECT_ROOT, 'venv', 'Scripts', 'python.exe');
const SCALPER_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'scalper_api.py');

export async function GET(): Promise<NextResponse> {
  try {
    const { stdout } = await execFileAsync(PYTHON_EXE, [SCALPER_SCRIPT, 'positions'], {
      cwd: PROJECT_ROOT,
      timeout: 20_000,
    });
    const lines = stdout.trim().split('\n').filter(Boolean);
    const data = JSON.parse(lines[lines.length - 1]);
    return NextResponse.json(data);
  } catch (err: unknown) {
    const e = err as { stdout?: string; message?: string; stderr?: string };
    if (e.stdout) {
      try {
        const lines = String(e.stdout).trim().split('\n').filter(Boolean);
        return NextResponse.json(JSON.parse(lines[lines.length - 1]));
      } catch {}
    }
    console.error('[/api/scalper/positions] error:', e.message, e.stderr ?? '');
    return NextResponse.json({ success: false, error: 'Failed to fetch positions', detail: String(e.message) }, { status: 500 });
  }
}

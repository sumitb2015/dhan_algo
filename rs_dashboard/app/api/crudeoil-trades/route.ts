import { NextResponse } from 'next/server';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { PYTHON_EXE } from '@/lib/pyExec';

const execFileAsync = promisify(execFile);

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'get_crudeoil_trades_data.py');

export async function GET() {
  try {
    const { stdout } = await execFileAsync(PYTHON_EXE, [SCRIPT], {
      cwd: PROJECT_ROOT,
      timeout: 25000,
      windowsHide: true,
    });

    const lines = stdout.trim().split('\n').filter(Boolean);
    const jsonLine = lines[lines.length - 1];
    const data = JSON.parse(jsonLine);

    return NextResponse.json(data);
  } catch (err: any) {
    if (err.stdout) {
      try {
        const lines = String(err.stdout).trim().split('\n').filter(Boolean);
        const data = JSON.parse(lines[lines.length - 1]);
        return NextResponse.json(data);
      } catch {}
    }
    console.error('Crude oil trades API error:', err.message, err.stderr ?? '');
    return NextResponse.json(
      { success: false, error: 'Failed to fetch crude oil trades data', detail: String(err.message) },
      { status: 500 }
    );
  }
}

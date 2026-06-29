import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const PYTHON_EXE = path.join(PROJECT_ROOT, 'venv', 'Scripts', 'python.exe');
const SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'pnl_exit.py');

function parseScriptOutput(stdout: string) {
  const lines = stdout.trim().split('\n').filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

export async function GET() {
  try {
    const { stdout } = await execFileAsync(PYTHON_EXE, [SCRIPT, '--action', 'get'], {
      cwd: PROJECT_ROOT,
      timeout: 15000,
    });
    return NextResponse.json(parseScriptOutput(stdout));
  } catch (err: any) {
    if (err.stdout) {
      try { return NextResponse.json(parseScriptOutput(String(err.stdout))); } catch {}
    }
    return NextResponse.json({ success: false, error: String(err.message) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const { profitValue, lossValue, productTypes, enableKillSwitch } = await req.json();
    const args = [
      SCRIPT,
      '--action', 'set',
      '--profit', String(profitValue ?? 0),
      '--loss', String(lossValue ?? 0),
      '--product-types', ...(productTypes ?? ['INTRADAY']),
      '--kill-switch', enableKillSwitch ? 'true' : 'false',
    ];
    const { stdout } = await execFileAsync(PYTHON_EXE, args, {
      cwd: PROJECT_ROOT,
      timeout: 15000,
    });
    return NextResponse.json(parseScriptOutput(stdout));
  } catch (err: any) {
    if (err.stdout) {
      try { return NextResponse.json(parseScriptOutput(String(err.stdout))); } catch {}
    }
    return NextResponse.json({ success: false, error: String(err.message) }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const { stdout } = await execFileAsync(PYTHON_EXE, [SCRIPT, '--action', 'delete'], {
      cwd: PROJECT_ROOT,
      timeout: 15000,
    });
    return NextResponse.json(parseScriptOutput(stdout));
  } catch (err: any) {
    if (err.stdout) {
      try { return NextResponse.json(parseScriptOutput(String(err.stdout))); } catch {}
    }
    return NextResponse.json({ success: false, error: String(err.message) }, { status: 500 });
  }
}

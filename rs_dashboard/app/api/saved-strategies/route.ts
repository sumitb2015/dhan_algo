import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { spawnSync } from 'child_process';

const PROJECT_ROOT  = path.resolve(process.cwd(), '..');
const PYTHON_EXE    = path.join(PROJECT_ROOT, 'venv', 'Scripts', 'pythonw.exe');
const STORE_SCRIPT  = path.join(PROJECT_ROOT, 'scripts', 'tools', 'strategy_store.py');

function runStore(args: string[]) {
  return spawnSync(PYTHON_EXE, [STORE_SCRIPT, ...args], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
}

function parseLastJsonLine(stdout: string | null): any {
  const jsonLine = (stdout ?? '').trim().split('\n').pop() ?? '{}';
  return JSON.parse(jsonLine);
}

export async function GET() {
  const result = runStore(['list']);
  if (result.error) {
    return NextResponse.json({ success: false, error: String(result.error) }, { status: 500 });
  }
  try {
    const parsed = parseLastJsonLine(result.stdout);
    if (parsed.error) return NextResponse.json({ success: false, error: parsed.error }, { status: 500 });
    return NextResponse.json({ success: true, data: parsed.strategies ?? [] });
  } catch (err) {
    return NextResponse.json({ success: false, error: `Parse error: ${String(err)}` }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ success: false, error: 'invalid JSON body' }, { status: 400 });
  }
  const result = runStore(['save', '--json', JSON.stringify(body)]);
  if (result.error) {
    return NextResponse.json({ success: false, error: String(result.error) }, { status: 500 });
  }
  try {
    const parsed = parseLastJsonLine(result.stdout);
    if (parsed.error) return NextResponse.json({ success: false, error: parsed.error }, { status: 500 });
    return NextResponse.json({ success: true, data: parsed });
  } catch (err) {
    const stderr = (result.stderr ?? '').slice(0, 500);
    console.error('[/api/saved-strategies POST] parse error:', err, stderr);
    return NextResponse.json({ success: false, error: `Parse error: ${String(err)}` }, { status: 500 });
  }
}

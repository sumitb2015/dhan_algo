import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { spawnSync } from 'child_process';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const PYTHON_EXE   = path.join(PROJECT_ROOT, 'venv', 'Scripts', 'pythonw.exe');
const STORE_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'strategy_store.py');

function runStore(args: string[]) {
  return spawnSync(PYTHON_EXE, [STORE_SCRIPT, ...args], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
}

function parseLastJsonLine(stdout: string | null): any {
  const jsonLine = (stdout ?? '').trim().split('\n').pop() ?? '{}';
  return JSON.parse(jsonLine);
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = runStore(['get', id]);
  if (result.error) {
    return NextResponse.json({ success: false, error: String(result.error) }, { status: 500 });
  }
  try {
    const parsed = parseLastJsonLine(result.stdout);
    if (parsed.error === 'not_found') return NextResponse.json({ success: false, error: 'not_found' }, { status: 404 });
    if (parsed.error) return NextResponse.json({ success: false, error: parsed.error }, { status: 500 });
    return NextResponse.json({ success: true, data: parsed });
  } catch (err) {
    return NextResponse.json({ success: false, error: `Parse error: ${String(err)}` }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => null) as { status?: string } | null;
  if (!body?.status) {
    return NextResponse.json({ success: false, error: 'status is required' }, { status: 400 });
  }
  const result = runStore(['update', id, '--status', body.status]);
  if (result.error) {
    return NextResponse.json({ success: false, error: String(result.error) }, { status: 500 });
  }
  try {
    const parsed = parseLastJsonLine(result.stdout);
    if (parsed.error === 'not_found') return NextResponse.json({ success: false, error: 'not_found' }, { status: 404 });
    if (parsed.error) return NextResponse.json({ success: false, error: parsed.error }, { status: 500 });
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ success: false, error: `Parse error: ${String(err)}` }, { status: 500 });
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = runStore(['delete', id]);
  if (result.error) {
    return NextResponse.json({ success: false, error: String(result.error) }, { status: 500 });
  }
  try {
    const parsed = parseLastJsonLine(result.stdout);
    if (parsed.error === 'not_found') return NextResponse.json({ success: false, error: 'not_found' }, { status: 404 });
    if (parsed.error) return NextResponse.json({ success: false, error: parsed.error }, { status: 500 });
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ success: false, error: `Parse error: ${String(err)}` }, { status: 500 });
  }
}

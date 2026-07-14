import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { PROJECT_ROOT, runPythonJson } from '@/lib/pyExec';

const STORE_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'strategy_store.py');

function runStore(args: string[]): Promise<any> {
  return runPythonJson<any>(STORE_SCRIPT, args, 20_000);
}

function errorResponse(parsed: any): NextResponse | null {
  if (parsed.error === 'not_found') return NextResponse.json({ success: false, error: 'not_found' }, { status: 404 });
  if (parsed.error) return NextResponse.json({ success: false, error: parsed.error }, { status: 500 });
  return null;
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const parsed = await runStore(['get', id]);
    return errorResponse(parsed) ?? NextResponse.json({ success: true, data: parsed });
  } catch (err) {
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => null) as { status?: string } | null;
  if (!body?.status) {
    return NextResponse.json({ success: false, error: 'status is required' }, { status: 400 });
  }
  try {
    const parsed = await runStore(['update', id, '--status', body.status]);
    return errorResponse(parsed) ?? NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const parsed = await runStore(['delete', id]);
    return errorResponse(parsed) ?? NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { PROJECT_ROOT, runPythonJson, dedupe } from '@/lib/pyExec';

const STORE_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'strategy_store.py');

function runStore(args: string[]): Promise<any> {
  return runPythonJson<any>(STORE_SCRIPT, args, 20_000);
}

export async function GET() {
  try {
    const parsed = await dedupe('saved-strategies:list', () => runStore(['list']));
    if (parsed.error) return NextResponse.json({ success: false, error: parsed.error }, { status: 500 });
    return NextResponse.json({ success: true, data: parsed.strategies ?? [] });
  } catch (err) {
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ success: false, error: 'invalid JSON body' }, { status: 400 });
  }
  try {
    const parsed = await runStore(['save', '--json', JSON.stringify(body)]);
    if (parsed.error) return NextResponse.json({ success: false, error: parsed.error }, { status: 500 });
    return NextResponse.json({ success: true, data: parsed });
  } catch (err) {
    console.error('[/api/saved-strategies POST] error:', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}

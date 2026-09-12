import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { runPythonJson, dedupe, PROJECT_ROOT } from '@/lib/pyExec';

const SCRIPT_PATH = path.join(PROJECT_ROOT, 'scripts', 'tools', 'unusual_options_scanner.py');

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const underlying = (searchParams.get('underlying') ?? 'NIFTY').toUpperCase();
  const expiry = searchParams.get('expiry') ?? '';
  const minRatio = searchParams.get('min_ratio') ?? '1.0';

  const args = ['--underlying', underlying, '--min-ratio', minRatio];
  if (expiry) {
    args.push('--expiry', expiry);
  }

  const dedupeKey = `unusual-options-${underlying}-${expiry}-${minRatio}`;

  try {
    const data = await dedupe(dedupeKey, () =>
      runPythonJson<Record<string, unknown>>(SCRIPT_PATH, args, 30_000)
    );
    return NextResponse.json(data);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

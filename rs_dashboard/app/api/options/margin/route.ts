import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { spawnSync } from 'child_process';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const PYTHON_EXE    = path.join(PROJECT_ROOT, 'venv', 'Scripts', 'pythonw.exe');
const MARGIN_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'options_margin.py');

interface MarginLegInput { strike: number; type: 'CE' | 'PE'; side: 'BUY' | 'SELL'; qtyLots: number; price: number }

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as
    { underlying?: string; expiry?: string; legs?: MarginLegInput[] } | null;

  if (!body?.expiry || !body?.legs?.length) {
    return NextResponse.json({ success: false, error: 'expiry and legs are required' }, { status: 400 });
  }
  const underlying = (body.underlying ?? 'NIFTY').toUpperCase();

  const result = spawnSync(
    PYTHON_EXE,
    [MARGIN_SCRIPT, '--underlying', underlying, '--expiry', body.expiry, '--legs-json', JSON.stringify(body.legs)],
    { encoding: 'utf8', timeout: 45_000, windowsHide: true },
  );

  if (result.error) {
    console.error('[/api/options/margin] spawn error:', result.error);
    return NextResponse.json({ success: false, error: String(result.error) }, { status: 500 });
  }

  try {
    const stdout = result.stdout ?? '';
    const jsonLine = stdout.trim().split('\n').pop() ?? '{}';
    const parsed = JSON.parse(jsonLine) as {
      total_margin?: number; span_margin?: number; exposure_margin?: number;
      hedge_benefit?: number; available_funds?: number; error?: string;
    };

    if (parsed.error) {
      const stderr = (result.stderr ?? '').slice(0, 500);
      console.error('[/api/options/margin] script error:', parsed.error, stderr);
      return NextResponse.json({ success: false, error: parsed.error }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      data: {
        total_margin: parsed.total_margin ?? 0,
        span_margin: parsed.span_margin ?? 0,
        exposure_margin: parsed.exposure_margin ?? 0,
        hedge_benefit: parsed.hedge_benefit ?? 0,
        available_funds: parsed.available_funds ?? 0,
      },
    });
  } catch (err) {
    const stderr = (result.stderr ?? '').slice(0, 500);
    console.error('[/api/options/margin] parse error:', err, '\nstdout:', result.stdout, '\nstderr:', stderr);
    return NextResponse.json({ success: false, error: `Parse error: ${String(err)}` }, { status: 500 });
  }
}

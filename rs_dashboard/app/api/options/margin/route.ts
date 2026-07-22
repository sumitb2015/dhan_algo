import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const PYTHON_EXE    = path.join(PROJECT_ROOT, 'venv', 'Scripts', 'python.exe');
const MARGIN_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'options_margin.py');

interface MarginLegInput { strike: number; type: 'CE' | 'PE'; side: 'BUY' | 'SELL'; qtyLots: number; price: number }

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as
    { underlying?: string; expiry?: string; legs?: MarginLegInput[] } | null;

  if (!body?.expiry || !body?.legs?.length) {
    return NextResponse.json({ success: false, error: 'expiry and legs are required' }, { status: 400 });
  }
  const underlying = (body.underlying ?? 'NIFTY').toUpperCase();

  try {
    const { stdout } = await execFileAsync(
      PYTHON_EXE,
      [MARGIN_SCRIPT, '--underlying', underlying, '--expiry', body.expiry, '--legs-json', JSON.stringify(body.legs)],
      { encoding: 'utf8', timeout: 45_000, windowsHide: true },
    );

    const jsonLine = (stdout ?? '').trim().split('\n').pop() ?? '{}';
    const parsed = JSON.parse(jsonLine) as {
      total_margin?: number; span_margin?: number; exposure_margin?: number;
      hedge_benefit?: number; overall_margin?: number; available_funds?: number; error?: string;
    };

    if (parsed.error) {
      console.error('[/api/options/margin] script error:', parsed.error);
      return NextResponse.json({ success: false, error: parsed.error }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      data: {
        total_margin: parsed.total_margin ?? 0,
        span_margin: parsed.span_margin ?? 0,
        exposure_margin: parsed.exposure_margin ?? 0,
        hedge_benefit: parsed.hedge_benefit ?? 0,
        overall_margin: parsed.overall_margin ?? 0,
        available_funds: parsed.available_funds ?? 0,
      },
    });
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    if (e.stdout) {
      try {
        const jsonLine = String(e.stdout).trim().split('\n').pop() ?? '{}';
        const parsed = JSON.parse(jsonLine) as {
          total_margin?: number; span_margin?: number; exposure_margin?: number;
          hedge_benefit?: number; overall_margin?: number; available_funds?: number; error?: string;
        };
        if (!parsed.error) {
          return NextResponse.json({
            success: true,
            data: {
              total_margin: parsed.total_margin ?? 0,
              span_margin: parsed.span_margin ?? 0,
              exposure_margin: parsed.exposure_margin ?? 0,
              hedge_benefit: parsed.hedge_benefit ?? 0,
              overall_margin: parsed.overall_margin ?? 0,
              available_funds: parsed.available_funds ?? 0,
            },
          });
        }
      } catch {}
    }
    console.error('[/api/options/margin] error:', e.message, e.stderr ?? '');
    return NextResponse.json({ success: false, error: `Script error: ${String(e.message)}` }, { status: 500 });
  }
}

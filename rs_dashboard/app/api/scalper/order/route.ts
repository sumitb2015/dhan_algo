import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { PYTHON_EXE } from '@/lib/pyExec';
import { invalidateBrokerCache } from '@/lib/brokerPositionsCache';

const execFileAsync = promisify(execFile);

const PROJECT_ROOT   = path.resolve(process.cwd(), '..');
const SCALPER_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'scalper_api.py');

// Opt-in idempotency (same contract as scalper/fast-order): a repeat of an `idempotencyKey` within
// the TTL gets the first request's answer instead of booking a second order. A timeout with no
// parseable output is kept too — the script may have placed the order.
const IDEMPOTENCY_TTL_MS = 60_000;
const idempotent = new Map<string, { at: number; result: Promise<NextResponse> }>();

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = await req.json();
  const key = typeof body?.idempotencyKey === 'string' && body.idempotencyKey.length >= 8 && body.idempotencyKey.length <= 64
    ? body.idempotencyKey : null;
  if (!key) return placeOnce(body);
  const now = Date.now();
  for (const [k, v] of idempotent) if (now - v.at > IDEMPOTENCY_TTL_MS) idempotent.delete(k);
  const prior = idempotent.get(key);
  if (prior) return (await prior.result).clone() as NextResponse;
  const result = placeOnce(body);
  idempotent.set(key, { at: now, result });
  const res = await result;
  const ok = res.status < 400 && ((await res.clone().json()) as { success?: boolean }).success === true;
  if (!ok && res.status !== 504) idempotent.delete(key);
  return res.clone() as NextResponse;
}

async function placeOnce(body: Record<string, unknown>): Promise<NextResponse> {
  const { underlying = 'NIFTY', expiry, strike, option, side, lots = 1, type = 'MARKET', price } = body;

  if (!expiry || !strike || !option || !side) {
    return NextResponse.json({ success: false, error: 'Missing required fields: expiry, strike, option, side' }, { status: 400 });
  }

  const lotsNum = Number(lots);
  if (!Number.isInteger(lotsNum) || lotsNum <= 0) {
    return NextResponse.json({ success: false, error: `Invalid lots: ${lots} (must be a positive integer)` }, { status: 400 });
  }

  const sideUpper = String(side).toUpperCase();
  if (sideUpper !== 'BUY' && sideUpper !== 'SELL') {
    return NextResponse.json({ success: false, error: `Invalid side: ${side} (must be BUY or SELL)` }, { status: 400 });
  }

  if (String(type).toUpperCase() === 'LIMIT' && !(Number(price) > 0)) {
    return NextResponse.json({ success: false, error: `Invalid price for LIMIT order: ${price}` }, { status: 400 });
  }

  const args = [
    SCALPER_SCRIPT, 'order',
    '--underlying', String(underlying),
    '--expiry', String(expiry),
    '--strike', String(strike),
    '--option', String(option),
    '--side', String(side),
    '--lots', String(lots),
    '--type', String(type),
    ...(String(type).toUpperCase() === 'LIMIT' && price != null ? ['--price', String(price)] : []),
  ];

  try {
    const { stdout } = await execFileAsync(PYTHON_EXE, args, {
      encoding: 'utf8',
      cwd: PROJECT_ROOT,
      timeout: 30_000,
      windowsHide: true,
    });

    const lines = (stdout ?? '').trim().split('\n').filter(Boolean);
    const jsonLine = lines[lines.length - 1] ?? '{}';
    const parsed = JSON.parse(jsonLine);
    if (parsed.error && !parsed.success) {
      console.error('[/api/scalper/order] script error:', parsed.error);
    } else if (parsed.success) {
      invalidateBrokerCache('dhan');
    }
    return NextResponse.json(parsed);
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    if (e.stdout) {
      try {
        const lines = String(e.stdout).trim().split('\n').filter(Boolean);
        const jsonLine = lines[lines.length - 1] ?? '{}';
        const recovered = JSON.parse(jsonLine);
        // execFile rejects on the 30s timeout, but the script may already have
        // placed the order and printed its success line before being killed —
        // that is a real fill, so it has to evict like the happy path does.
        if (recovered.success) invalidateBrokerCache('dhan');
        return NextResponse.json(recovered);
      } catch {}
    }
    console.error('[/api/scalper/order] error:', e.message, e.stderr ?? '');
    // No parseable output: the script may have been killed AFTER placing the order (30s timeout),
    // so this is "unknown", not a clean failure. 504 keeps the idempotency entry.
    return NextResponse.json(
      { success: false, error: `Order status unknown — the order script did not confirm (${String(e.message).slice(0, 120)}). Check Positions/Orders before retrying.` },
      { status: 504 },
    );
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { isKotakTokenValid } from '@/lib/kotakToken';
import { readGuardState, updateGuardState, startKotakGuardLoop, istDay } from '@/lib/kotakGuardServer';
import { SOFT_BRACKET_MARKET_TTL_MS, SOFT_BRACKET_TTL_MS, guardProductOf, validateSoftPnlGuard } from '@/lib/softGuards';
import type { ServerBracket } from '@/lib/kotakGuardEngine';

// Registers and reads the SERVER-resident Kotak P&L Guard and brackets (lib/kotakGuardServer.ts). Registering a guard here is
// what arms it: the tab never fires one. Real-money endpoint (the watcher it feeds sends market exits), so every field is
// validated and nothing is defaulted.

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v));
const bad = (error: string) => NextResponse.json({ success: false, error }, { status: 400 });

export async function GET(): Promise<NextResponse> {
  startKotakGuardLoop();
  const s = readGuardState();
  return NextResponse.json({ success: true, sessionValid: isKotakTokenValid(), state: s });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  startKotakGuardLoop();
  let body: Record<string, unknown>;
  try { body = await req.json() as Record<string, unknown>; } catch { return bad('Invalid JSON'); }
  const action = String(body.action ?? '');

  if (action === 'setPnl') {
    const profit = Math.abs(num(body.profit)) || 0;
    const loss = Math.abs(num(body.loss)) || 0;
    const products = Array.isArray(body.products) ? [...new Set(body.products.map(p => guardProductOf(p)).filter(Boolean))] : [];
    const err = validateSoftPnlGuard(profit, loss, products);
    if (err) return bad(err);
    if (!isKotakTokenValid()) return bad('Kotak session is not valid - log in first; a guard cannot watch or exit without it');
    const s = await updateGuardState(st => ({ ...st, pnl: { profit, loss, products, date: istDay() } }));
    return NextResponse.json({ success: true, state: s });
  }

  if (action === 'clearPnl') {
    const s = await updateGuardState(st => ({ ...st, pnl: null }));
    return NextResponse.json({ success: true, state: s });
  }

  if (action === 'addBracket') {
    const symbol = String(body.symbol ?? '').trim();
    const product = guardProductOf(body.product);
    const dir = num(body.dir);
    const target = num(body.target);
    const sl = num(body.sl);
    const qtyBefore = num(body.qtyBefore);
    const mode = body.mode === 'LIMIT' ? 'LIMIT' : 'MARKET';
    if (!symbol) return bad('symbol is required');
    if (product !== 'INTRADAY' && product !== 'MARGIN') return bad('product must be INTRADAY or MARGIN');
    if (dir !== 1 && dir !== -1) return bad('dir must be 1 (long) or -1 (short)');
    if (!(target > 0) || !(sl > 0)) return bad('target and sl must be positive prices');
    // A target/stop on the wrong side of each other would exit on the first tick.
    if (dir === 1 ? !(target > sl) : !(target < sl)) return bad(`${dir === 1 ? 'long' : 'short'} bracket needs target ${dir === 1 ? 'above' : 'below'} its stop`);
    if (!Number.isFinite(qtyBefore)) return bad('qtyBefore is required');
    if (!isKotakTokenValid()) return bad('Kotak session is not valid - log in first; a bracket cannot be watched without it');
    const b: ServerBracket = {
      id: `kb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      symbol, product, dir: dir as 1 | -1, target, sl, trail: body.trail === true, at: Date.now(),
      ttlMs: mode === 'MARKET' ? SOFT_BRACKET_MARKET_TTL_MS : SOFT_BRACKET_TTL_MS, qtyBefore,
      state: 'pending', best: 0, entry: 0,
    };
    const s = await updateGuardState(st => ({
      ...st,
      // Same contract + side + product replaces its older pending/armed bracket (an add re-levels, it does not stack).
      brackets: [...st.brackets.filter(x => !(x.symbol === symbol && x.product === product && x.dir === b.dir)), b],
    }));
    return NextResponse.json({ success: true, id: b.id, state: s });
  }

  if (action === 'removeBracket') {
    const id = String(body.id ?? '');
    const s = await updateGuardState(st => ({ ...st, brackets: st.brackets.filter(x => x.id !== id) }));
    return NextResponse.json({ success: true, state: s });
  }

  if (action === 'clearBrackets') {
    const s = await updateGuardState(st => ({ ...st, brackets: [] }));
    return NextResponse.json({ success: true, state: s });
  }

  return bad(`Unknown action: ${action}`);
}

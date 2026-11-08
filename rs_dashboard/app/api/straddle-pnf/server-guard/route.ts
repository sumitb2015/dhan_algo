import { NextRequest, NextResponse } from 'next/server';
import { cleanGuard } from '@/lib/priceLadderGuard';
import { parseScope } from '@/lib/pnfScope';
import { readServerGuards, setServerGuard, startAutoServerLoop } from '@/lib/autoServerWatcher';
import type { GuardLevels, ServerGuardCfg } from '@/lib/autoServerGuard';

// Where the P&F / Renko page syncs its MTM guard so the dashboard SERVER can enforce it on open REAL AUTO positions with the tab closed
// (lib/autoServerWatcher.ts). GET: the synced guards of a page (`?scope=renko`); POST: set or remove one chart's. Places no orders.

const LEVEL_KEYS = ['target', 'stop', 'trailBy', 'lockAt', 'lockKeep', 'lockStepEvery', 'lockStepKeep', 'targetBoxes', 'stopBoxes'] as const;
const bad = (error: string, status = 400) => NextResponse.json({ success: false, error }, { status });

export async function GET(req: NextRequest): Promise<NextResponse> {
  const scope = parseScope(req.nextUrl.searchParams.get('scope'));
  const cfg = readServerGuards().cfg;
  const mine = Object.fromEntries(Object.entries(cfg).filter(([k]) => k.startsWith(`${scope}:`)));
  return NextResponse.json({ success: true, guards: mine });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let b: Record<string, unknown>;
  try { b = await req.json() as Record<string, unknown>; } catch { return bad('Invalid JSON'); }
  const scope = parseScope(req.nextUrl.searchParams.get('scope') ?? b.scope);
  const chart = b.chart === 2 ? 2 : b.chart === 1 ? 1 : null;
  if (!chart) return bad('chart must be 1 or 2');
  if (b.on !== true) { await setServerGuard(scope, chart, null); return NextResponse.json({ success: true }); }
  if (b.mode !== 'REAL' && b.mode !== 'PAPER') return bad('mode must be PAPER or REAL');
  if (typeof b.broker !== 'string' || !b.broker) return bad('broker is required');
  const levelsIn = (b.levels && typeof b.levels === 'object' ? b.levels : {}) as Record<string, unknown>;
  // The same validation as the page's own guard card: one source of truth for what a valid level set is.
  const cleaned = cleanGuard({ on: true, ...Object.fromEntries(LEVEL_KEYS.map(k => [k, levelsIn[k]])) });
  if (typeof cleaned === 'string') return bad(cleaned);
  const levels = Object.fromEntries(LEVEL_KEYS.filter(k => cleaned[k] !== undefined).map(k => [k, cleaned[k]])) as GuardLevels;
  const boxPts = Number(b.boxPts);
  // a Renko Log % chart's grid ratio (1 + P/100, P inside the settings' 0.05-5 %): its box levels are log steps from the entry
  const boxLogR = Number(b.boxLogR);
  const logOk = Number.isFinite(boxLogR) && boxLogR >= 1.0005 - 1e-12 && boxLogR <= 1.05 + 1e-12;
  const cfg: ServerGuardCfg = {
    on: true, broker: b.broker, mode: b.mode, levels, boxPts: Number.isFinite(boxPts) && boxPts > 0 ? boxPts : null,
    ...(logOk ? { boxLogR } : {}), updatedMs: Date.now(),
  };
  await setServerGuard(scope, chart, cfg);
  startAutoServerLoop();
  return NextResponse.json({ success: true, guard: cfg });
}

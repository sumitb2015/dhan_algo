import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { PROJECT_ROOT, runPythonJson } from '@/lib/pyExec';
import { createDashboardSession, hasValidSessionCookie, isDhanTokenValid } from '@/lib/session';
import { SESSION_COOKIE } from '@/lib/auth';

const DHAN_SCRIPT    = path.join(PROJECT_ROOT, 'scripts', 'tools', 'dhan_autologin.py');
const ZERODHA_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'zerodha_autologin.py');
const KOTAK_SCRIPT   = path.join(PROJECT_ROOT, 'scripts', 'tools', 'kotak_autologin.py');

const TARGETS = ['dhan', 'zerodha', 'kotak'] as const;
type Target = typeof TARGETS[number];
type BrokerResult = { success: boolean; error?: string };

type DhanAutologinResult = { success: boolean; clientId?: string; expiryTime?: string; error?: string };
type ZerodhaAutologinResult = { success: boolean; userId?: string; expiryTime?: string; error?: string };
type KotakAutologinResult = { success: boolean; ucc?: string; expiryTime?: string; reused?: boolean; error?: string };

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: { targets?: Target[]; remember?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const targets = body.targets ?? [];
  const remember = body.remember ?? false;

  if (targets.length === 0 || targets.some(t => !TARGETS.includes(t))) {
    return NextResponse.json({ error: `targets must be a non-empty array of ${TARGETS.map(t => `"${t}"`).join(', ')}` }, { status: 400 });
  }

  const [dhanResult, zerodhaResult, kotakResult] = await Promise.all([
    targets.includes('dhan')
      ? runPythonJson<DhanAutologinResult>(DHAN_SCRIPT, [], 20_000).catch(
          (): DhanAutologinResult => ({ success: false, error: 'Dhan autologin script failed to run' })
        )
      : Promise.resolve<DhanAutologinResult | undefined>(undefined),
    targets.includes('zerodha')
      ? runPythonJson<ZerodhaAutologinResult>(ZERODHA_SCRIPT, [], 30_000).catch(
          (): ZerodhaAutologinResult => ({ success: false, error: 'Zerodha autologin script failed to run' })
        )
      : Promise.resolve<ZerodhaAutologinResult | undefined>(undefined),
    // Longer budget than the others: a Kotak login can wait out a full TOTP
    // window (~31s) before retrying with a fresh code.
    targets.includes('kotak')
      ? runPythonJson<KotakAutologinResult>(KOTAK_SCRIPT, [], 90_000).catch(
          (): KotakAutologinResult => ({ success: false, error: 'Kotak autologin script failed to run' })
        )
      : Promise.resolve<KotakAutologinResult | undefined>(undefined),
  ]);

  let setCookieHeader: string | null = null;

  if (dhanResult?.success && dhanResult.clientId && dhanResult.expiryTime) {
    // dhan_autologin.py already wrote access_token.json — just issue the dashboard session.
    setCookieHeader = createDashboardSession(dhanResult.clientId, remember);
  }

  const hasExistingSession = hasValidSessionCookie(req.cookies.get(SESSION_COOKIE)?.value) && isDhanTokenValid();
  const enterDashboard = dhanResult ? !!dhanResult.success : hasExistingSession;

  const response: {
    enterDashboard: boolean;
    dhan?: BrokerResult;
    zerodha?: BrokerResult;
    kotak?: BrokerResult;
  } = { enterDashboard };
  if (dhanResult) response.dhan = { success: dhanResult.success, error: dhanResult.error };
  if (zerodhaResult) response.zerodha = { success: zerodhaResult.success, error: zerodhaResult.error };
  if (kotakResult) response.kotak = { success: kotakResult.success, error: kotakResult.error };

  const nextResponse = NextResponse.json(response);
  if (setCookieHeader) nextResponse.headers.set('Set-Cookie', setCookieHeader);
  return nextResponse;
}

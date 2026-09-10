import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createDashboardSession, writeDhanTokenFile } from '@/lib/session';
import { PYTHON_EXE } from '@/lib/pyExec';

const execFileAsync = promisify(execFile);

const PROJECT_ROOT    = path.resolve(process.cwd(), '..');
const VALIDATE_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'validate_token.py');

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: { client_id?: string; access_token?: string; remember?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid request body' }, { status: 400 });
  }

  const { client_id, access_token, remember = false } = body;

  if (!client_id?.trim() || !access_token?.trim()) {
    return NextResponse.json({ success: false, error: 'client_id and access_token are required' }, { status: 400 });
  }
  if (access_token.trim().length < 10) {
    return NextResponse.json({ success: false, error: 'Access token appears too short' }, { status: 400 });
  }

  // Validate credentials via Python script
  let validationResult: { success: boolean; error?: string };
  try {
    const { stdout } = await execFileAsync(
      PYTHON_EXE,
      [VALIDATE_SCRIPT, client_id.trim(), access_token.trim()],
      { cwd: PROJECT_ROOT, timeout: 20_000, windowsHide: true }
    );
    const lines = stdout.trim().split('\n').filter(Boolean);
    validationResult = JSON.parse(lines[lines.length - 1]);
  } catch (err: unknown) {
    const e = err as { stdout?: string; message?: string };
    if (e.stdout) {
      try {
        const lines = String(e.stdout).trim().split('\n').filter(Boolean);
        validationResult = JSON.parse(lines[lines.length - 1]);
      } catch {
        return NextResponse.json({ success: false, error: 'Validation script failed to run' }, { status: 500 });
      }
    } else {
      return NextResponse.json({ success: false, error: 'Could not reach validation service' }, { status: 500 });
    }
  }

  if (!validationResult.success) {
    return NextResponse.json(
      { success: false, error: validationResult.error ?? 'Invalid credentials' },
      { status: 401 }
    );
  }

  // Write access_token.json (adds clientId so Python scripts can reference it)
  const expiryTime = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  writeDhanTokenFile(access_token.trim(), client_id.trim(), expiryTime);

  // Create signed session cookie
  const setCookieHeader = createDashboardSession(client_id.trim(), remember);

  const response = NextResponse.json({ success: true });
  response.headers.set('Set-Cookie', setCookieHeader);
  return response;
}

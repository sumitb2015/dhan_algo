import { NextResponse } from 'next/server';
import path from 'path';
import { PROJECT_ROOT, runPythonJson } from '@/lib/pyExec';

const CONFIG_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'get_auth_config.py');

type FieldStatus = { set: boolean; masked?: string };
type AuthConfig = { dhan: Record<string, FieldStatus>; zerodha: Record<string, FieldStatus> };

export async function GET(): Promise<NextResponse> {
  try {
    const config = await runPythonJson<AuthConfig>(CONFIG_SCRIPT, [], 10_000);
    return NextResponse.json(config);
  } catch {
    return NextResponse.json({ error: 'Could not read auth configuration' }, { status: 500 });
  }
}

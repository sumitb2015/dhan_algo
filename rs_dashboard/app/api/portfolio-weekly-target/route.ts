import { NextResponse, NextRequest } from 'next/server';
import path from 'path';
import fs from 'fs';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const TARGET_FILE = path.join(PROJECT_ROOT, 'debug', 'portfolio_weekly_target.json');

export async function GET() {
  try {
    if (!fs.existsSync(TARGET_FILE)) {
      return NextResponse.json({ weeklyTarget: 0 });
    }
    const raw = fs.readFileSync(TARGET_FILE, 'utf-8');
    const data = JSON.parse(raw);
    const weeklyTarget = Number(data?.weeklyTarget);
    return NextResponse.json({ weeklyTarget: Number.isFinite(weeklyTarget) && weeklyTarget >= 0 ? weeklyTarget : 0 });
  } catch {
    return NextResponse.json({ weeklyTarget: 0 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const weeklyTarget = Number(body?.weeklyTarget);
    if (!Number.isFinite(weeklyTarget) || weeklyTarget < 0) {
      return NextResponse.json({ success: false, error: 'weeklyTarget must be a finite number >= 0' }, { status: 400 });
    }
    const debugDir = path.join(PROJECT_ROOT, 'debug');
    if (!fs.existsSync(debugDir)) {
      fs.mkdirSync(debugDir, { recursive: true });
    }
    fs.writeFileSync(TARGET_FILE, JSON.stringify({ weeklyTarget }, null, 2), 'utf-8');
    return NextResponse.json({ success: true, weeklyTarget });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

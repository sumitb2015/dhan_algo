import { NextResponse, NextRequest } from 'next/server';
import path from 'path';
import fs from 'fs';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const TARGET_FILE = path.join(PROJECT_ROOT, 'debug', 'portfolio_weekly_target.json');

const WEEK_START_RE = /^\d{4}-\d{2}-\d{2}$/;

interface TargetConfig {
  defaultTarget: number;
  overrides: Record<string, number>;
}

function readConfig(): TargetConfig {
  try {
    if (!fs.existsSync(TARGET_FILE)) return { defaultTarget: 0, overrides: {} };
    const raw = JSON.parse(fs.readFileSync(TARGET_FILE, 'utf-8'));
    // Back-compat with the earlier single-value shape ({ weeklyTarget }) written before
    // per-week overrides existed.
    const defaultTarget = Number(raw?.defaultTarget ?? raw?.weeklyTarget);
    const overridesRaw = raw?.overrides;
    const overrides: Record<string, number> = {};
    if (overridesRaw && typeof overridesRaw === 'object') {
      for (const [k, v] of Object.entries(overridesRaw)) {
        const n = Number(v);
        if (WEEK_START_RE.test(k) && Number.isFinite(n) && n >= 0) overrides[k] = n;
      }
    }
    return { defaultTarget: Number.isFinite(defaultTarget) && defaultTarget >= 0 ? defaultTarget : 0, overrides };
  } catch {
    return { defaultTarget: 0, overrides: {} };
  }
}

function writeConfig(config: TargetConfig) {
  const debugDir = path.join(PROJECT_ROOT, 'debug');
  if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
  fs.writeFileSync(TARGET_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

export async function GET() {
  return NextResponse.json({ success: true, ...readConfig() });
}

// POST accepts one of:
//   { defaultTarget: number }                 — set the recurring default target
//   { weekStart: 'YYYY-MM-DD', target: number } — set a one-off override for that week
//   { weekStart: 'YYYY-MM-DD', target: null }   — clear the override, reverting to default
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const config = readConfig();

    if (body?.weekStart !== undefined) {
      const { weekStart, target } = body;
      if (typeof weekStart !== 'string' || !WEEK_START_RE.test(weekStart)) {
        return NextResponse.json({ success: false, error: 'weekStart must be a YYYY-MM-DD string' }, { status: 400 });
      }
      if (target === null) {
        delete config.overrides[weekStart];
      } else {
        const n = Number(target);
        if (!Number.isFinite(n) || n < 0) {
          return NextResponse.json({ success: false, error: 'target must be a finite number >= 0, or null to clear' }, { status: 400 });
        }
        config.overrides[weekStart] = n;
      }
      writeConfig(config);
      return NextResponse.json({ success: true, ...config });
    }

    const defaultTarget = Number(body?.defaultTarget);
    if (!Number.isFinite(defaultTarget) || defaultTarget < 0) {
      return NextResponse.json({ success: false, error: 'defaultTarget must be a finite number >= 0' }, { status: 400 });
    }
    config.defaultTarget = defaultTarget;
    writeConfig(config);
    return NextResponse.json({ success: true, ...config });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

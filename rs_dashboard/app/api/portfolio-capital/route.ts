import { NextResponse, NextRequest } from 'next/server';
import path from 'path';
import fs from 'fs';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const CAPITAL_FILE = path.join(PROJECT_ROOT, 'debug', 'portfolio_capital.json');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// A shape-only regex accepts '2026-13-45', which Date silently rolls over to 2027-02-14 and
// shifts the entire FY month grid. Round-trip through UTC to reject impossible dates.
function isRealDate(s: unknown): s is string {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const DEFAULT_CAPITAL = 2500000; // 25 lakh
const DEFAULT_FY_START = '2026-04-01';

interface CapitalConfig {
  startingCapital: number;
  fyStart: string;
}

function readConfig(): CapitalConfig {
  try {
    if (!fs.existsSync(CAPITAL_FILE)) return { startingCapital: DEFAULT_CAPITAL, fyStart: DEFAULT_FY_START };
    const raw = JSON.parse(fs.readFileSync(CAPITAL_FILE, 'utf-8'));
    const startingCapital = Number(raw?.startingCapital);
    const fyStart = raw?.fyStart;
    return {
      startingCapital: Number.isFinite(startingCapital) && startingCapital >= 0 ? startingCapital : DEFAULT_CAPITAL,
      fyStart: isRealDate(fyStart) ? fyStart : DEFAULT_FY_START,
    };
  } catch {
    return { startingCapital: DEFAULT_CAPITAL, fyStart: DEFAULT_FY_START };
  }
}

function writeConfig(config: CapitalConfig) {
  const debugDir = path.join(PROJECT_ROOT, 'debug');
  if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
  fs.writeFileSync(CAPITAL_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

// Serializes read-modify-write cycles across concurrent POSTs (e.g. two open tabs saving
// around the same time) — without this, both requests can read the same pre-write snapshot
// and the later writeConfig() silently clobbers the other tab's change.
let writeQueue: Promise<unknown> = Promise.resolve();

function withWriteLock<T>(fn: () => T): Promise<T> {
  const result = writeQueue.then(fn, fn);
  writeQueue = result.then(() => undefined, () => undefined);
  return result;
}

export async function GET() {
  return NextResponse.json({ success: true, ...readConfig() });
}

// POST accepts either or both of:
//   { startingCapital: number }   — the capital base the FY return is measured against
//   { fyStart: 'YYYY-MM-DD' }     — first day of the financial year the month grid starts from
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const hasCapital = body?.startingCapital !== undefined;
    const hasFyStart = body?.fyStart !== undefined;
    if (!hasCapital && !hasFyStart) {
      return NextResponse.json({ success: false, error: 'provide startingCapital and/or fyStart' }, { status: 400 });
    }

    let startingCapital = 0;
    if (hasCapital) {
      startingCapital = Number(body.startingCapital);
      if (!Number.isFinite(startingCapital) || startingCapital < 0) {
        return NextResponse.json({ success: false, error: 'startingCapital must be a finite number >= 0' }, { status: 400 });
      }
    }
    if (hasFyStart && !isRealDate(body.fyStart)) {
      return NextResponse.json({ success: false, error: 'fyStart must be a YYYY-MM-DD string' }, { status: 400 });
    }

    const config = await withWriteLock(() => {
      const c = readConfig();
      if (hasCapital) c.startingCapital = startingCapital;
      if (hasFyStart) c.fyStart = body.fyStart;
      writeConfig(c);
      return c;
    });
    return NextResponse.json({ success: true, ...config });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

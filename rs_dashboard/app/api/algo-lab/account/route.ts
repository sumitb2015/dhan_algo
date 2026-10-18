import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { PROJECT_ROOT } from '@/lib/pyExec';
import { STRATEGIES } from '@/lib/algoLab/registry';
import type { AlgoStateFile } from '@/lib/algoLab/types';

// Account-level REAL loss cap across every Algo Lab strategy. GET = today's REAL P&L summed over all strategy ledgers
// (realized + the open P&L each leader tab last wrote) and the cap; POST {limit} = set the cap.
// Entries pause when total <= -limit; exits are never blocked by it.

const DIR = path.join(PROJECT_ROOT, 'debug', 'algo_lab');
const FILE = path.join(DIR, 'account.json');
const DEFAULT_LIMIT = 10_000;
const istDay = (ms: number) => new Date(ms + 5.5 * 3600_000).toISOString().slice(0, 10);

const readLimit = (): number => {
  try {
    const n = Number((JSON.parse(fs.readFileSync(FILE, 'utf8')) as { limit?: unknown }).limit);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_LIMIT;
  } catch {
    return DEFAULT_LIMIT;
  }
};

export async function GET() {
  const today = istDay(Date.now());
  let total = 0;
  const byStrategy: Record<string, number> = {};
  for (const s of STRATEGIES) {
    let f: AlgoStateFile | null = null;
    try {
      f = JSON.parse(fs.readFileSync(path.join(DIR, `${s.key}_state.json`), 'utf8')) as AlgoStateFile;
    } catch {
      continue;
    }
    let sum = 0;
    for (const p of f.positions ?? []) {
      if (p.mode !== 'REAL') continue;
      if (p.status === 'CLOSED' && p.closedAt != null && istDay(p.closedAt) === today) sum += Number(p.realized) || 0;
      if (p.status === 'OPEN' && istDay(p.openedAt) === today && typeof p.openPnl === 'number') sum += p.openPnl;
    }
    byStrategy[s.key] = Math.round(sum * 100) / 100;
    total += sum;
  }
  return NextResponse.json({ success: true, date: today, total: Math.round(total * 100) / 100, limit: readLimit(), byStrategy });
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as { limit?: unknown } | null;
  const n = Number(body?.limit);
  if (!Number.isFinite(n) || n < 500 || n > 500_000) {
    return NextResponse.json({ success: false, error: 'limit must be between 500 and 500000' }, { status: 400 });
  }
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(`${FILE}.tmp`, JSON.stringify({ limit: n }));
  fs.renameSync(`${FILE}.tmp`, FILE);
  return NextResponse.json({ success: true, limit: n });
}

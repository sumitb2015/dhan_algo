import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs/promises';
import { PROJECT_ROOT, runPythonJson, dedupe } from '@/lib/pyExec';

const SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'scalper_mtm_history.py');

// One intraday Data API call per distinct contract traded today, paced at 0.35s inside the
// script, on top of the master-list load. ~4s for a typical 7-leg day; a heavy book with
// 30+ legs approaches 20s.
const TIMEOUT_MS = 60_000;

const BROKERS = ['dhan', 'zerodha', 'kotak'];

// Rebuilding the curve costs a burst of rate-limited Dhan calls, and the answer only moves
// when a new fill lands. Several open scalper tabs polling the same book must not each
// trigger that burst, so cache per (broker, fill count) - a new fill changes the key and
// invalidates naturally, while the TTL covers a same-count refresh.
const CACHE_TTL_MS = 30_000;

interface MtmPoint { time: string; pnl: number; realized: number; unrealized: number }
interface MtmResult {
  success: boolean;
  points: MtmPoint[];
  unresolved: string[];
  truncated: number;
  error: string | null;
}

const cache = new Map<string, { at: number; value: MtmResult }>();

export async function POST(request: NextRequest) {
  let body: { broker?: string; trades?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'invalid JSON body' }, { status: 400 });
  }

  const broker = String(body.broker ?? 'dhan').toLowerCase();
  if (!BROKERS.includes(broker)) {
    return NextResponse.json({ success: false, error: `broker must be one of ${BROKERS.join(', ')}` }, { status: 400 });
  }
  const trades = Array.isArray(body.trades) ? body.trades : [];
  if (trades.length === 0) {
    return NextResponse.json({ success: true, points: [], unresolved: [], truncated: 0, error: null });
  }

  const key = `${broker}:${trades.length}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return NextResponse.json(hit.value);
  }

  try {
    const result = await dedupe(`mtm-history:${key}`, async () => {
      // runPythonJson has no stdin channel and a 93-fill book is far too large for argv,
      // so hand the request over as a file. Uniquely named: two brokers can be in flight
      // at once, and the loser of a rename race would otherwise be charted as the winner.
      const reqPath = path.join(PROJECT_ROOT, 'debug', `mtm_request_${broker}_${process.pid}_${Date.now()}.json`);
      await fs.writeFile(reqPath, JSON.stringify({ broker, trades }), 'utf8');
      try {
        return await runPythonJson<MtmResult>(SCRIPT, [reqPath], TIMEOUT_MS);
      } finally {
        await fs.unlink(reqPath).catch(() => {});
      }
    });
    if (result?.success) cache.set(key, { at: Date.now(), value: result });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { success: false, points: [], unresolved: [], truncated: 0, error: String(err) },
      { status: 500 },
    );
  }
}

import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { PROJECT_ROOT } from '@/lib/pyExec';

/**
 * Audit journal for Focus Tool decisions: every automatic exit / entry / re-entry,
 * every manual exit, strike shift and add-to-all-legs, with the rule that fired
 * and the prices it fired at. The on-screen toast is the only other place the
 * reason appears, and it is gone seconds later — this is what answers "why did
 * it exit?" after the fact.
 *
 * Append-only JSON lines (no read-modify-write, so concurrent events cannot lose
 * one), same pattern as sim-trades/route.ts.
 */
const JOURNAL = path.join(PROJECT_ROOT, 'debug', 'focus_tool_events.jsonl');
const MAX_FIELD = 600;

function istDate(iso: string): string {
  return new Date(new Date(iso).getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
}

/** Keep only short scalar fields so one bad payload cannot bloat the journal. */
function scalarsOnly(o: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(o).slice(0, 40)) {
    if (v == null || typeof v === 'number' || typeof v === 'boolean') out[k] = v as number | boolean | null;
    else if (typeof v === 'string') out[k] = v.slice(0, MAX_FIELD);
  }
  return out;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body = await req.json() as Record<string, unknown>;
    if (typeof body.kind !== 'string' || !body.kind || typeof body.rowId !== 'string') {
      return NextResponse.json({ success: false, error: 'kind and rowId required' }, { status: 400 });
    }
    const rec = { ts: new Date().toISOString(), ...scalarsOnly(body) };
    await fs.promises.mkdir(path.dirname(JOURNAL), { recursive: true });
    await fs.promises.appendFile(JOURNAL, JSON.stringify(rec) + '\n', 'utf-8');
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[/api/focus-tool/events POST]', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}

/** ?date=YYYY-MM-DD (IST, default today) → that day's events, oldest first. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const date = req.nextUrl.searchParams.get('date') || istDate(new Date().toISOString());
    let events: Record<string, unknown>[] = [];
    try {
      const raw = await fs.promises.readFile(JOURNAL, 'utf-8');
      events = raw.split('\n').filter(Boolean).flatMap(line => {
        try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
      }).filter(e => typeof e.ts === 'string' && istDate(e.ts) === date);
    } catch { /* no journal yet */ }
    return NextResponse.json({ success: true, date, events });
  } catch (err) {
    console.error('[/api/focus-tool/events GET]', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}

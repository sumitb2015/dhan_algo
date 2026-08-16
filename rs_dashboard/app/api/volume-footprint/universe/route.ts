import { NextResponse } from 'next/server';
import path from 'path';
import { runPythonJson, dedupe, PROJECT_ROOT } from '@/lib/pyExec';

const SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'fno_stocks_list.py');

export interface UniverseIndex {
  symbol: string;
  exchange: string;
  label: string;
}

export interface UniverseResponse {
  success: boolean;
  indices: UniverseIndex[];
  stocks: string[];
  built_on?: string;
  error?: string;
}

// The universe changes on F&O inclusion/exclusion cycles, not intraday. The Python side
// caches to disk by date; this holds it in memory so a page mount doesn't even spawn.
let memo: { at: number; payload: UniverseResponse } | null = null;
const MEMO_MS = 60 * 60 * 1000;

/** Symbols the footprint page can chart: NSE/BSE indices plus every F&O stock underlying. */
export async function GET() {
  if (memo && Date.now() - memo.at < MEMO_MS) {
    return NextResponse.json(memo.payload);
  }
  try {
    const payload = await dedupe('volume-footprint:universe', () =>
      runPythonJson<UniverseResponse>(SCRIPT, [], 60_000),
    );
    if (payload?.success) memo = { at: Date.now(), payload };
    return NextResponse.json(
      payload ?? { success: false, indices: [], stocks: [], error: 'empty response' },
    );
  } catch (e) {
    return NextResponse.json(
      {
        success: false,
        indices: [],
        stocks: [],
        error: e instanceof Error ? e.message : String(e),
      } satisfies UniverseResponse,
      { status: 500 },
    );
  }
}

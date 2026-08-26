import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { PROJECT_ROOT, runPythonJson, dedupe, spaced } from '@/lib/pyExec';

const SCRIPT_PATH = path.join(PROJECT_ROOT, 'scripts', 'tools', 'straddle_live_matrix.py');

export interface MatrixCell {
  time: string;
  sl_pct: number;
  pnl_pts: number;
  status: 'intact+' | 'intact-' | 'ce_out' | 'pe_out' | 'both_out';
  ce_out: boolean;
  pe_out: boolean;
  ce_entry: number;
  pe_entry: number;
  ce_exit: number;
  pe_exit: number;
  ce_exit_time: string | null;
  pe_exit_time: string | null;
  var_pts: number;
}

export interface ColumnData {
  time: string;
  strike: number;
  entry: number;
  ce_entry: number;
  pe_entry: number;
  ltp: number;
  ce_ltp: number;
  pe_ltp: number;
  best_sl: string;
  best_sl_pct: number;
  pnl_pts: number;
  var_pts: number;
  col_total: number;
}

export interface SlRow {
  sl_pct: number;
  sl_label: string;
  cells: MatrixCell[];
  row_total: number;
}

export interface StraddleMatrixSummary {
  total_best_pnl_pts: number;
  total_best_pnl_inr: number;
  total_col_sum_pts: number;
  total_var_pts: number;
  total_var_inr: number;
  grand_row_total: number;
  best_fixed_sl: string;
  best_fixed_sl_pnl: number;
  win_rate_pct: number;
  entries_count: number;
  profitable_entries: number;
}

export interface StraddleMatrixResponse {
  underlying: string;
  expiry: string;
  all_expiries: string[];
  dte: number;
  data_date: string;
  current_spot: number;
  lot_size: number;
  is_historical?: boolean;
  data_source?: string;
  timestamps: string[];
  columns: ColumnData[];
  sl_rows: SlRow[];
  summary: StraddleMatrixSummary;
  stale?: boolean;
  error?: string;
}

interface CacheEntry {
  data: StraddleMatrixResponse;
  ts: number;
  ttl: number;
}

const serverCache = new Map<string, CacheEntry>();
const LIVE_CACHE_TTL_MS = 10_000;
const HISTORICAL_CACHE_TTL_MS = 24 * 60 * 60_000;

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const underlying = searchParams.get('underlying') ?? 'NIFTY';
  const expiry = searchParams.get('expiry') ?? '';
  const date = searchParams.get('date') ?? '';
  const interval = searchParams.get('interval') ?? '30';

  const cacheKey = `straddle-matrix:${underlying}:${expiry}:${date}:${interval}`;

  const hit = serverCache.get(cacheKey);
  if (hit && Date.now() - hit.ts < hit.ttl) {
    return NextResponse.json({ success: true, data: hit.data }, {
      headers: { 'Cache-Control': 'no-store' }
    });
  }

  const args = ['--underlying', underlying, '--interval', interval];
  if (expiry) args.push('--expiry', expiry);
  if (date) args.push('--date', date);

  try {
    const data = await dedupe(cacheKey, () =>
      spaced(`dhan-straddle-matrix:${underlying}`, () =>
        runPythonJson<StraddleMatrixResponse>(SCRIPT_PATH, args, 60_000)
      )
    );

    if (data.error) {
      console.error('[/api/straddle-matrix] Script error:', data.error);
      return NextResponse.json({ success: false, error: data.error }, { status: 500 });
    }

    const ttl = date ? HISTORICAL_CACHE_TTL_MS : LIVE_CACHE_TTL_MS;
    serverCache.set(cacheKey, { data, ts: Date.now(), ttl });

    return NextResponse.json({ success: true, data }, {
      headers: { 'Cache-Control': 'no-store' }
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[/api/straddle-matrix] Error executing straddle matrix script:', message);

    if (hit) {
      return NextResponse.json({ success: true, data: { ...hit.data, stale: true } }, {
        headers: { 'Cache-Control': 'no-store' }
      });
    }

    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

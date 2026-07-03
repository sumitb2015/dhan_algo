import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const DEBUG_DIR    = path.join(PROJECT_ROOT, 'debug');
const LOT_SIZE     = 75;
const STRIKE_STEP  = 50;

function todayIST(): string {
  const now = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return now.toISOString().slice(0, 10);
}

function parseNumber(s: string): number {
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

// "YYYY-MM-DD HH:MM:SS" IST → epoch ms
function istStringToEpoch(ts: string): number {
  const [datePart, timePart] = ts.split(' ');
  return new Date(`${datePart}T${timePart}+05:30`).getTime();
}

const EMPTY_RESPONSE = (date: string) => ({
  success: true, hasData: false, date, atm: 0, expiry: '',
  current: null, gex_profile: [], gex_flip_strike: null, timeline: [],
});

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const date  = searchParams.get('date')  ?? todayIST();
  const wings = Math.min(Math.max(parseInt(searchParams.get('wings') ?? '10', 10), 1), 10);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json(EMPTY_RESPONSE(date));
  }

  const csvPath = path.join(DEBUG_DIR, `iv_snapshots_${date}.csv`);
  if (!fs.existsSync(csvPath)) {
    return NextResponse.json(EMPTY_RESPONSE(date));
  }

  const raw   = fs.readFileSync(csvPath, 'utf8');
  const lines = raw.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) {
    return NextResponse.json(EMPTY_RESPONSE(date));
  }

  const headers = lines[0].split(',').map(h => h.trim());
  const colMap  = new Map(headers.map((h, i) => [h, i]));
  const col     = (name: string) => colMap.get(name) ?? -1;

  const allRows = lines.slice(1).map(line => {
    const c = line.split(',');
    const g = (name: string) => c[col(name)] ?? '';
    return {
      timestamp: g('timestamp'),
      spot:      parseNumber(g('spot')),
      expiry:    g('expiry').trim(),
      strike:    parseInt(g('strike'), 10),
      CE_OI:     parseNumber(g('CE_OI')),
      CE_IV:     parseNumber(g('CE_IV')),
      CE_gamma:  parseNumber(g('CE_gamma')),
      PE_OI:     parseNumber(g('PE_OI')),
      PE_IV:     parseNumber(g('PE_IV')),
      PE_gamma:  parseNumber(g('PE_gamma')),
    };
  }).filter(r => !isNaN(r.strike) && r.timestamp.length > 0);

  if (allRows.length === 0) {
    return NextResponse.json(EMPTY_RESPONSE(date));
  }

  const firstRow  = allRows[0];
  const atm       = Math.round(firstRow.spot / STRIKE_STEP) * STRIKE_STEP;
  const expiry    = firstRow.expiry;
  const wingRange = wings * STRIKE_STEP;

  // Group rows by timestamp
  const byTs = new Map<string, { spot: number; rows: typeof allRows }>();
  for (const row of allRows) {
    if (!byTs.has(row.timestamp)) byTs.set(row.timestamp, { spot: row.spot, rows: [] });
    byTs.get(row.timestamp)!.rows.push(row);
  }

  const sortedEntries = [...byTs.entries()].sort(([a], [b]) => a.localeCompare(b));

  // Build timeline — one point per timestamp
  const timeline = sortedEntries.map(([timestamp, { spot, rows }]) => {
    const wing = rows.filter(r => Math.abs(r.strike - atm) <= wingRange);
    const sumCE = wing.reduce((s, r) => s + r.CE_OI, 0);
    const sumPE = wing.reduce((s, r) => s + r.PE_OI, 0);
    const pcr   = sumCE > 0 ? Math.round((sumPE / sumCE) * 100) / 100 : 0;

    const atmRow = wing.reduce<typeof allRows[0] | null>((best, r) =>
      !best || Math.abs(r.strike - atm) < Math.abs(best.strike - atm) ? r : best, null);
    const atm_iv = atmRow ? Math.round(atmRow.CE_IV * 10) / 10 : 0;

    const net_gex = Math.round(
      wing.reduce((s, r) =>
        s + (r.CE_OI * r.CE_gamma - r.PE_OI * r.PE_gamma) * LOT_SIZE * spot / 100, 0),
    );

    return { time: timestamp.slice(11, 16), ts: istStringToEpoch(timestamp), pcr, atm_iv, net_gex };
  });

  // GEX profile from most-recent snapshot
  const [latestTs, { spot: latestSpot, rows: latestRows }] = sortedEntries[sortedEntries.length - 1];
  const gex_profile = latestRows
    .filter(r => Math.abs(r.strike - atm) <= wingRange)
    .sort((a, b) => a.strike - b.strike)
    .map(r => ({
      strike:  r.strike,
      net_gex: Math.round((r.CE_OI * r.CE_gamma - r.PE_OI * r.PE_gamma) * LOT_SIZE * latestSpot / 100),
      ce_gex:  Math.round(r.CE_OI * r.CE_gamma * LOT_SIZE),
      pe_gex:  Math.round(r.PE_OI * r.PE_gamma * LOT_SIZE),
    }));

  // GEX flip strike — first sign change in cumulative GEX (ascending strikes)
  let cumGex = 0;
  let gex_flip_strike: number | null = null;
  for (const { strike, net_gex } of gex_profile) {
    const prevSign = cumGex === 0 ? 0 : Math.sign(cumGex);
    cumGex += net_gex;
    if (prevSign !== 0 && Math.sign(cumGex) !== prevSign) {
      gex_flip_strike = strike;
      break;
    }
  }

  // Current values
  const latestTl   = timeline[timeline.length - 1];
  const ivValues   = timeline.map(t => t.atm_iv).filter(v => v > 0);
  const iv_min     = ivValues.length > 0 ? Math.min(...ivValues) : 0;
  const iv_max     = ivValues.length > 0 ? Math.max(...ivValues) : 0;

  const nowTs      = istStringToEpoch(latestTs);
  const target30   = nowTs - 30 * 60 * 1000;
  const closest30  = timeline.reduce<typeof timeline[0] | null>((best, t) =>
    !best || Math.abs(t.ts - target30) < Math.abs(best.ts - target30) ? t : best, null);
  const pcr_30min_ago = closest30 && closest30.ts !== latestTl?.ts ? closest30.pcr : null;

  const current = latestTl ? {
    net_gex: latestTl.net_gex, pcr: latestTl.pcr, atm_iv: latestTl.atm_iv,
    iv_min, iv_max, pcr_30min_ago,
  } : null;

  const response = NextResponse.json({
    success: true, hasData: timeline.length >= 2,
    date, atm, expiry, current, gex_profile, gex_flip_strike, timeline,
  });
  response.headers.set('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60');
  return response;
}

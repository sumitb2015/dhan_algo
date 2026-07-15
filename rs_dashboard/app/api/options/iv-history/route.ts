import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const DEBUG_DIR    = path.join(PROJECT_ROOT, 'debug');

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
  const iso = `${datePart}T${timePart}+05:30`;
  return new Date(iso).getTime();
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const date       = searchParams.get('date') ?? todayIST();
  const mode       = searchParams.get('mode') ?? 'iv';                           // 'iv' | 'cumulative'
  const underlying = (searchParams.get('underlying') ?? 'NIFTY').toUpperCase();
  const isCrude    = underlying === 'CRUDEOIL';
  const strike     = searchParams.get('strike') ? parseInt(searchParams.get('strike')!, 10) : null;
  const defaultWings = isCrude ? 6 : 10;
  const wings      = searchParams.get('wings')  ? parseInt(searchParams.get('wings')!,  10) : defaultWings;

  const csvFile = isCrude ? `crudeoil_oi_snapshots_${date}.csv` : `iv_snapshots_${date}.csv`;
  const csvPath = path.join(DEBUG_DIR, csvFile);

  if (!fs.existsSync(csvPath)) {
    return NextResponse.json(
      { success: false, error: `No IV snapshot data for ${date}` },
      { status: 404 },
    );
  }

  const raw   = fs.readFileSync(csvPath, 'utf8');
  // Split on \r\n or \n (Windows CSV from Python csv module uses \r\n)
  const lines = raw.split(/\r?\n/).filter(l => l.trim());

  if (lines.length < 2) {
    return NextResponse.json({ success: false, error: 'CSV file is empty' }, { status: 404 });
  }

  // Trim each header to strip any stray \r that split might leave on the last token
  const headers  = lines[0].split(',').map(h => h.trim());
  const colMap   = new Map(headers.map((h, i) => [h, i]));
  const colIdx   = (name: string) => colMap.get(name) ?? -1;

  // Parse every data row
  const allRows = lines.slice(1).map(line => {
    const cols = line.split(',');
    const get  = (name: string) => cols[colIdx(name)] ?? '';
    return {
      timestamp:    get('timestamp'),
      spot:         parseNumber(get('spot')),
      expiry:       get('expiry'),
      strike:       parseInt(get('strike'), 10),
      time:         get('timestamp').slice(11, 19), // HH:MM:SS
      CE_LTP:       parseNumber(get('CE_LTP')),
      CE_IV:        parseNumber(get('CE_IV')),
      CE_OI:        parseNumber(get('CE_OI')),
      CE_change_OI: parseNumber(get('CE_change_OI')),
      CE_volume:    parseNumber(get('CE_volume')),
      CE_bid:       parseNumber(get('CE_bid')),
      CE_ask:       parseNumber(get('CE_ask')),
      CE_delta:     parseNumber(get('CE_delta')),
      CE_gamma:     parseNumber(get('CE_gamma')),
      CE_theta:     parseNumber(get('CE_theta')),
      CE_vega:      parseNumber(get('CE_vega')),
      PE_LTP:       parseNumber(get('PE_LTP')),
      PE_IV:        parseNumber(get('PE_IV')),
      PE_OI:        parseNumber(get('PE_OI')),
      PE_change_OI: parseNumber(get('PE_change_OI')),
      PE_volume:    parseNumber(get('PE_volume')),
      PE_bid:       parseNumber(get('PE_bid')),
      PE_ask:       parseNumber(get('PE_ask')),
      PE_delta:     parseNumber(get('PE_delta')),
      PE_gamma:     parseNumber(get('PE_gamma')),
      PE_theta:     parseNumber(get('PE_theta')),
      PE_vega:      parseNumber(get('PE_vega')),
    };
  }).filter(r => !isNaN(r.strike));

  if (allRows.length === 0) {
    return NextResponse.json({ success: false, error: 'No valid rows in CSV' }, { status: 404 });
  }

  const firstRow = allRows[0];
  const strikeStep = isCrude ? 100 : 50;
  // ATM is locked at 9:15 (first snapshot) — the collector records a constant strike set per day
  const atm    = Math.round(firstRow.spot / strikeStep) * strikeStep;
  const expiry = firstRow.expiry;

  // ── Cumulative OI mode ────────────────────────────────────────────
  if (mode === 'cumulative') {
    // Collector captures ATM±10 (500pt) for Nifty, ATM±6 (600pt) for Crude — clamp to avoid silent partial-data responses
    const maxWings = isCrude ? 6 : 10;
    const clampedWings = Math.min(Math.max(wings, 1), maxWings);
    const wingRange = clampedWings * strikeStep;

    // Group by timestamp, sum OI for strikes within atm±wings
    const byTs = new Map<string, { spot: number; ceOI: number; peOI: number }>();
    for (const row of allRows) {
      if (Math.abs(row.strike - atm) > wingRange) continue;
      const existing = byTs.get(row.timestamp);
      if (existing) {
        existing.ceOI += row.CE_OI;
        existing.peOI += row.PE_OI;
      } else {
        byTs.set(row.timestamp, { spot: row.spot, ceOI: row.CE_OI, peOI: row.PE_OI });
      }
    }

    const data = [...byTs.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([timestamp, { spot, ceOI, peOI }]) => ({
        time: timestamp.slice(11, 19),
        ts:   istStringToEpoch(timestamp),
        spot,
        ceOI,
        peOI,
        diff: peOI - ceOI,
      }));

    const response = NextResponse.json({
      success: true, date, atm, expiry, wings: clampedWings, data,
    });
    response.headers.set('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60');
    return response;
  }

  // ── IV mode (default) ─────────────────────────────────────────────
  const strikeSet = [...new Set(allRows.map(r => r.strike))].sort((a, b) => a - b);

  const targetStrike = strike ?? atm;
  const nearest = strikeSet.reduce((best, sk) =>
    Math.abs(sk - targetStrike) < Math.abs(best - targetStrike) ? sk : best,
    strikeSet[0],
  );

  const data = allRows
    .filter(r => r.strike === nearest)
    .map(({ timestamp: _ts, expiry: _exp, strike: _sk, ...rest }) => rest);

  const response = NextResponse.json({
    success: true, date, atm, expiry, strikes: strikeSet, selectedStrike: nearest, data,
  });
  response.headers.set('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60');
  return response;
}

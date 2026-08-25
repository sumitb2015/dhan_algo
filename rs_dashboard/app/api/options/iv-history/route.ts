import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { computeRegimeSeries, type RegimeInputPoint } from '@/lib/optionsRegime';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const DEBUG_DIR    = path.join(PROJECT_ROOT, 'debug');

function todayIST(): string {
  const now = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return now.toISOString().slice(0, 10);
}

/** Snapshot dates present on disk, newest first. */
function listDates(isCrude: boolean): string[] {
  const prefix = isCrude ? 'crudeoil_oi_snapshots_' : 'iv_snapshots_';
  if (!fs.existsSync(DEBUG_DIR)) return [];
  return fs.readdirSync(DEBUG_DIR)
    .filter(f => f.startsWith(prefix) && f.endsWith('.csv'))
    .map(f => f.slice(prefix.length, -4))
    .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort((a, b) => b.localeCompare(a));
}

/** Treat 0 / NaN as "not reported" so charts break the line instead of dropping to zero. */
function orNull(n: number): number | null {
  return Number.isFinite(n) && n !== 0 ? n : null;
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
  const mode       = searchParams.get('mode') ?? 'iv';           // 'iv' | 'cumulative' | 'all' | 'dates'
  const underlying = (searchParams.get('underlying') ?? 'NIFTY').toUpperCase();
  const isCrude    = underlying === 'CRUDEOIL';
  const strike     = searchParams.get('strike') ? parseInt(searchParams.get('strike')!, 10) : null;
  const defaultWings = isCrude ? 6 : 10;
  const wings      = searchParams.get('wings')  ? parseInt(searchParams.get('wings')!,  10) : defaultWings;

  const availableDates = listDates(isCrude);

  if (mode === 'dates') {
    return NextResponse.json({ success: true, dates: availableDates, today: todayIST() });
  }

  // Fall back to the most recent day on disk when the requested date (default: today)
  // has no file — the collector may not have run, and an empty page is worse than
  // the last session's data clearly labelled as such.
  // Opt-in (`fallback=1`) so the existing cumulative-OI tabs keep their strict
  // "no data today" behaviour and only the IV Charts page shows last-session data.
  const allowFallback = searchParams.get('fallback') === '1';
  const requested = searchParams.get('date') ?? todayIST();
  const date      = availableDates.includes(requested) || !allowFallback
    ? requested
    : availableDates[0];
  const isFallback = date !== requested;

  if (!date) {
    return NextResponse.json(
      { success: false, error: `No IV snapshot data for ${requested}`, availableDates },
      { status: 404 },
    );
  }

  const csvFile = isCrude ? `crudeoil_oi_snapshots_${date}.csv` : `iv_snapshots_${date}.csv`;
  const csvPath = path.join(DEBUG_DIR, csvFile);

  if (!fs.existsSync(csvPath)) {
    return NextResponse.json(
      { success: false, error: `No IV snapshot data for ${date}`, availableDates },
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

    // Group by timestamp, sum OI for strikes within atm±wings.
    // LTP is tracked as an OI-weighted sum (divided by total OI below) rather than
    // a plain sum across strikes, since summing premiums across different strikes
    // is not meaningful — the weighted average reflects where OI pressure sits.
    const byTs = new Map<string, {
      spot: number; ceOI: number; peOI: number;
      ceLtpWeighted: number; peLtpWeighted: number;
      ceChgOI: number; peChgOI: number;
    }>();
    for (const row of allRows) {
      if (Math.abs(row.strike - atm) > wingRange) continue;
      const existing = byTs.get(row.timestamp);
      if (existing) {
        existing.ceOI += row.CE_OI;
        existing.peOI += row.PE_OI;
        existing.ceLtpWeighted += row.CE_LTP * row.CE_OI;
        existing.peLtpWeighted += row.PE_LTP * row.PE_OI;
        existing.ceChgOI += row.CE_change_OI;
        existing.peChgOI += row.PE_change_OI;
      } else {
        byTs.set(row.timestamp, {
          spot: row.spot, ceOI: row.CE_OI, peOI: row.PE_OI,
          ceLtpWeighted: row.CE_LTP * row.CE_OI, peLtpWeighted: row.PE_LTP * row.PE_OI,
          ceChgOI: row.CE_change_OI, peChgOI: row.PE_change_OI,
        });
      }
    }

    const sorted = [...byTs.entries()].sort(([a], [b]) => a.localeCompare(b));

    // Despike single-snapshot bad reads: the collector occasionally falls back
    // to a stale price for exactly one poll (e.g. the market-open price on a
    // transient LTP hiccup — see iv_snapshot_collector.py), which reads as a
    // sharp one-tick spike that fully reverts on the very next poll. A real
    // move never reverts within one snapshot, so any point that jumps away
    // from both neighbours while its neighbours stay close to each other is
    // swapped for their average rather than plotted as-is.
    const spikeJump = 12;     // points — bigger than a normal 30s NIFTY move
    const neighborClose = 10; // points — how close the two flanking reads must be
    const spots = sorted.map(([, v]) => v.spot);
    for (let i = 1; i < spots.length - 1; i++) {
      const prev = spots[i - 1], cur = spots[i], next = spots[i + 1];
      if (Math.abs(cur - prev) > spikeJump && Math.abs(cur - next) > spikeJump
          && Math.abs(prev - next) < neighborClose) {
        sorted[i][1].spot = (prev + next) / 2;
      }
    }

    const regimeInput: RegimeInputPoint[] = sorted.map(([, v]) => ({
      spot: v.spot,
      ceOI: v.ceOI,
      peOI: v.peOI,
      ceLTP: v.ceOI > 0 ? v.ceLtpWeighted / v.ceOI : 0,
      peLTP: v.peOI > 0 ? v.peLtpWeighted / v.peOI : 0,
      ceChgOI: v.ceChgOI,
      peChgOI: v.peChgOI,
    }));
    const { points: regimePoints, latest: regime } = computeRegimeSeries(regimeInput);

    const data = sorted.map(([timestamp, { spot, ceOI, peOI }], i) => ({
      time: timestamp.slice(11, 19),
      ts:   istStringToEpoch(timestamp),
      spot,
      ceOI,
      peOI,
      diff: peOI - ceOI,
      slope: regimePoints[i].slope,
      accel: regimePoints[i].accel,
      wpi: regimePoints[i].wpi,
    }));

    const response = NextResponse.json({
      success: true, date, atm, expiry, wings: clampedWings, data, regime,
    });
    response.headers.set('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60');
    return response;
  }

  // ── IV mode (default) ─────────────────────────────────────────────
  const strikeSet = [...new Set(allRows.map(r => r.strike))].sort((a, b) => a - b);

  // ── Full-page mode: per-strike series + skew + surface in one round trip ──
  if (mode === 'all') {
    const targetStrike = strike ?? atm;
    const nearest = strikeSet.reduce((best, sk) =>
      Math.abs(sk - targetStrike) < Math.abs(best - targetStrike) ? sk : best,
      strikeSet[0],
    );

    const series = allRows
      .filter(r => r.strike === nearest)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
      .map(r => ({
        time:     r.time.slice(0, 5),
        ts:       istStringToEpoch(r.timestamp),
        spot:     r.spot,
        ceIV:     orNull(r.CE_IV),
        peIV:     orNull(r.PE_IV),
        ivAvg:    orNull((r.CE_IV + r.PE_IV) / 2),
        ivSpread: r.CE_IV && r.PE_IV ? r.CE_IV - r.PE_IV : null,
        ceLTP:    r.CE_LTP,
        peLTP:    r.PE_LTP,
        straddle: r.CE_LTP + r.PE_LTP,
        ceOI:     r.CE_OI,
        peOI:     r.PE_OI,
        ceDelta:  r.CE_delta,
        peDelta:  r.PE_delta,
        ceVega:   r.CE_vega,
        ceTheta:  r.CE_theta,
        peTheta:  r.PE_theta,
      }));

    // Timeline shared by the skew (open vs latest) and the surface grid
    const timestamps = [...new Set(allRows.map(r => r.timestamp))].sort();
    const firstTs = timestamps[0];
    const lastTs  = timestamps[timestamps.length - 1];

    const rowsAt = (ts: string) => new Map(
      allRows.filter(r => r.timestamp === ts).map(r => [r.strike, r]),
    );
    const openRows = rowsAt(firstTs);
    const lastRows = rowsAt(lastTs);

    const skew = strikeSet.map(sk => {
      const o = openRows.get(sk);
      const l = lastRows.get(sk);
      return {
        strike:    sk,
        ceIVOpen:  o ? orNull(o.CE_IV) : null,
        peIVOpen:  o ? orNull(o.PE_IV) : null,
        ceIV:      l ? orNull(l.CE_IV) : null,
        peIV:      l ? orNull(l.PE_IV) : null,
        ceOI:      l?.CE_OI ?? 0,
        peOI:      l?.PE_OI ?? 0,
        straddle:  l ? l.CE_LTP + l.PE_LTP : null,
      };
    });

    // Surface: strike × time grid of the OTM leg's IV — puts below ATM, calls above.
    // Deep-ITM legs quote off a wide spread and their implied vol is mostly noise;
    // including them washes out the colour scale. Columns are downsampled so a full
    // session (~750 snapshots) stays a readable — and small — payload.
    const MAX_COLS = 96;
    const step = Math.max(1, Math.ceil(timestamps.length / MAX_COLS));
    const cols = timestamps.filter((_, i) => i % step === 0 || i === timestamps.length - 1);
    const byTsStrike = new Map<string, number | null>();
    for (const r of allRows) {
      const otm = r.strike > atm ? r.CE_IV
                : r.strike < atm ? r.PE_IV
                : (r.CE_IV + r.PE_IV) / 2;
      byTsStrike.set(`${r.timestamp}|${r.strike}`, orNull(otm));
    }
    const surface = {
      times:   cols.map(t => t.slice(11, 16)),
      // highest strike first — the heatmap reads like a price ladder
      strikes: [...strikeSet].reverse(),
      // grid[strikeIdx][timeIdx], aligned to `strikes`
      grid: [...strikeSet].reverse().map(sk => cols.map(t => byTsStrike.get(`${t}|${sk}`) ?? null)),
    };

    const withIV = series.filter(p => p.ivAvg !== null);
    const first  = withIV[0];
    const last   = withIV[withIV.length - 1];
    const ivVals = withIV.map(p => p.ivAvg as number);
    const summary = {
      ivOpen:       first?.ivAvg ?? null,
      ivLast:       last?.ivAvg ?? null,
      ivMin:        ivVals.length ? Math.min(...ivVals) : null,
      ivMax:        ivVals.length ? Math.max(...ivVals) : null,
      ceIVLast:     last?.ceIV ?? null,
      peIVLast:     last?.peIV ?? null,
      spotOpen:     series[0]?.spot ?? null,
      spotLast:     series[series.length - 1]?.spot ?? null,
      straddleOpen: series[0]?.straddle ?? null,
      straddleLast: series[series.length - 1]?.straddle ?? null,
      lastTime:     lastTs.slice(11, 19),
      points:       series.length,
    };

    const response = NextResponse.json({
      success: true, date, requestedDate: requested, isFallback, availableDates, today: todayIST(),
      atm, expiry, strikes: strikeSet, selectedStrike: nearest,
      series, skew, surface, summary,
    });
    response.headers.set('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60');
    return response;
  }

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

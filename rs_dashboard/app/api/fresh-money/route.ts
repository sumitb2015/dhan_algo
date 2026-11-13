import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import { listDates, resolveCsvPath } from '@/lib/ivSnapshotFiles';
import { resolveLotSize } from '@/lib/lotSize';
import { MCX_LOT_MULTIPLIER } from '@/lib/positionPnl';
import { parsedDay } from '@/lib/freshMoneyFiles';
import { readJsonFile } from '@/lib/lockedJsonFile';
import { buildBoardRows, strikeStep, type Buildup, type PrevCloses } from '@/lib/freshMoney';

// Read-only: everything comes from snapshot CSVs in debug/ (no Dhan call except the cached lot-size lookup). The IV
// snapshot collector writes NIFTY / BANKNIFTY / SENSEX (starts with the dashboard); scripts/tools/crudeoil_oi_collector.py
// writes CRUDEOIL / CRUDEOILM (started from the page). Each underlying reads ONLY its own files (strict prefixes).
const UNDERLYINGS = new Set(['NIFTY', 'BANKNIFTY', 'SENSEX', 'CRUDEOIL', 'CRUDEOILM']);
/** Session window (IST minutes) of the market. MCX runs to 23:30 / 23:55 (US DST). */
const NSE_DAY = { from: 9 * 60 + 15, to: 15 * 60 + 30 };
const MCX_DAY = { from: 9 * 60, to: 23 * 60 + 55 };
const WINGS = 12;

export interface FreshMoneySide { oi: number | null; oiMoved: number | null; buildup: Buildup | null }
export interface FreshMoneyRow { strike: number; put: FreshMoneySide | null; call: FreshMoneySide | null }

export interface FreshMoneyResponse {
  underlying: string;
  date: string;
  isToday: boolean;
  lastTs: string;
  spot: number | null;
  expiry: string;
  step: number;
  lot: number | null;
  oiUnit: 'lots' | 'units';
  /** 'NSE' or 'MCX'. MCX OI/volume and order quantity are already in lots. */
  market: 'NSE' | 'MCX';
  /** Rupees per point per lot for MCX (barrels per lot); null on NSE, where `lot` is the units per lot. */
  mult: number | null;
  /** The market session, IST minutes. */
  day: { from: number; to: number };
  rows: FreshMoneyRow[];
  /** Option previous closes are on record for this day (the collector's side file): buildup tags can be shown. */
  hasBuildup: boolean;
  error?: string;
}

// The shown day is re-read when the collector appends (mtime changes); polls in between reuse the result.
const respCache = new Map<string, { key: string; body: FreshMoneyResponse }>();

function todayIST(): string {
  return new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
}

export async function GET(req: NextRequest) {
  const underlying = (new URL(req.url).searchParams.get('underlying') ?? 'NIFTY').toUpperCase();
  if (!UNDERLYINGS.has(underlying)) {
    return NextResponse.json({ error: `unsupported underlying ${underlying}` }, { status: 400 });
  }

  const allDates = listDates(underlying, false, true);
  // Show the newest day whose file the live collector wrote. A backfilled file (build_oi_snapshots.py from 1-minute
  // candles) carries per-candle volume, so |ΔOI| / volume from it is meaningless (shares far above 100%): skip it.
  let shown = -1;
  for (let i = 0; i < allDates.length; i++) {
    const f = resolveCsvPath(underlying, allDates[i], true);
    if (f && (await parsedDay(f, i === 0))?.cumulative) { shown = i; break; }
  }
  const dates = shown >= 0 ? allDates.slice(shown) : [];
  const date = dates[0];
  const file = date ? resolveCsvPath(underlying, date, true) : null;
  if (!date || !file) {
    const mcx = MCX_LOT_MULTIPLIER[underlying] !== undefined;
    const onlyBackfill = allDates.length > 0;
    return NextResponse.json({
      error: mcx
        ? `No live-collected ${underlying} snapshots yet${onlyBackfill ? ' (the files on disk are 1-minute backfills, which are not shown)' : ''}. Start the ${underlying} OI collector during MCX hours to build the board.`
        : 'No IV snapshot files on disk yet. The IV snapshot collector writes them while the dashboard runs in market hours.',
      needsCollector: mcx,
    }, { status: 404 });
  }

  const isMcx = MCX_LOT_MULTIPLIER[underlying] !== undefined;
  // MCX: OI, volume and order quantity are already lots (master LOT_SIZE is 1) — never divide by a lot size.
  let lot: number | null = isMcx ? 1 : null;
  if (!isMcx) { try { lot = await resolveLotSize(underlying); } catch { lot = null; } }
  const day = isMcx ? MCX_DAY : NSE_DAY;

  let st: fs.Stats;
  try { st = await fs.promises.stat(file); } catch {
    return NextResponse.json({ error: `Cannot read ${date} snapshot file` }, { status: 500 });
  }
  const cacheKey = `${file}:${st.mtimeMs}:${st.size}:${lot}:${todayIST()}`;
  const cached = respCache.get(underlying);
  if (cached && cached.key === cacheKey) return NextResponse.json(cached.body);

  const parsed = await parsedDay(file, true);
  const snaps = parsed?.snaps ?? [];
  const expiry = parsed?.expiry ?? '';
  const last = snaps[snaps.length - 1];
  if (!parsed || !last) {
    return NextResponse.json({ error: `The ${date} snapshot file has no rows yet` }, { status: 404 });
  }

  const toLots = (n: number | null) => (n === null ? null : lot ? n / lot : n);
  // Option previous closes for the buildup tags: the collector's side file next to the CSV, for this expiry only.
  const pcFile = readJsonFile<{ expiry?: string; ce?: Record<string, number>; pe?: Record<string, number> }>(file.replace(/\.csv$/, '_prev_close.json'));
  const prevCloses: PrevCloses | null = pcFile && pcFile.expiry === expiry ? { ce: pcFile.ce ?? {}, pe: pcFile.pe ?? {} } : null;
  const rows: FreshMoneyRow[] = buildBoardRows(last, WINGS, prevCloses).map(r => ({
    strike: r.strike,
    put: r.put ? { oi: toLots(r.put.oi), oiMoved: toLots(r.put.oiMoved), buildup: r.put.buildup } : null,
    call: r.call ? { oi: toLots(r.call.oi), oiMoved: toLots(r.call.oiMoved), buildup: r.call.buildup } : null,
  }));

  const body: FreshMoneyResponse = {
    underlying,
    date,
    isToday: date === todayIST(),
    lastTs: last.ts,
    spot: last.spot,
    expiry,
    step: strikeStep([...last.strikes.keys()]),
    lot,
    oiUnit: lot ? 'lots' : 'units',
    market: isMcx ? 'MCX' : 'NSE',
    mult: isMcx ? MCX_LOT_MULTIPLIER[underlying] : null,
    day,
    rows,
    hasBuildup: prevCloses !== null,
  };
  respCache.set(underlying, { key: cacheKey, body });
  return NextResponse.json(body);
}

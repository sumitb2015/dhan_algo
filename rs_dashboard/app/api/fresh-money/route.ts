import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import { listDates, resolveCsvPath } from '@/lib/ivSnapshotFiles';
import { resolveLotSize } from '@/lib/lotSize';
import {
  parseSnapshotCsv, latestExpiry, summarizeDay, hasCumulativeVolume, boardFresh, normalAt, bandFromHistory, buildBoardRows, strikeStep,
  type DaySummary, type SidePair, type Range, type SeriesPoint, type BandPoint,
} from '@/lib/freshMoney';

// Read-only: everything comes from the IV snapshot collector's CSVs in debug/ (no Dhan call except the cached
// lot-size lookup). The collector covers these three underlyings.
const UNDERLYINGS = new Set(['NIFTY', 'BANKNIFTY', 'SENSEX']);
const HISTORY_DAYS = 14;
const WINGS = 12;

export interface FreshMoneySide { oiMoved: number | null; fresh: number | null }
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
  rows: FreshMoneyRow[];
  board: SidePair;
  normal: { puts: Range | null; calls: Range | null };
  series: SeriesPoint[];
  band: BandPoint[];
  historyDays: number;
  error?: string;
}

// Past days never change: memoise each day's summary by path + mtime + size.
const dayCache = new Map<string, { key: string; summary: DaySummary | null }>();

async function summaryFor(file: string): Promise<DaySummary | null> {
  try {
    const st = await fs.promises.stat(file);
    const key = `${st.mtimeMs}:${st.size}`;
    const hit = dayCache.get(file);
    if (hit && hit.key === key) return hit.summary;
    const text = await fs.promises.readFile(file, 'utf8');
    const all = parseSnapshotCsv(text);
    const snaps = parseSnapshotCsv(text, latestExpiry(all));
    // A backfilled file with per-candle volume would skew the normal band; skip the day (cached as null).
    const summary = hasCumulativeVolume(snaps) ? summarizeDay(snaps) : null;
    dayCache.set(file, { key, summary });
    return summary;
  } catch {
    return null;
  }
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

  const dates = listDates(underlying, false);
  const date = dates[0];
  const file = date ? resolveCsvPath(underlying, date) : null;
  if (!date || !file) {
    return NextResponse.json({ error: 'No IV snapshot files on disk yet. The IV snapshot collector writes them while the dashboard runs in market hours.' }, { status: 404 });
  }

  let lot: number | null = null;
  try { lot = await resolveLotSize(underlying); } catch { lot = null; }

  let st: fs.Stats;
  try { st = await fs.promises.stat(file); } catch {
    return NextResponse.json({ error: `Cannot read ${date} snapshot file` }, { status: 500 });
  }
  const cacheKey = `${file}:${st.mtimeMs}:${st.size}:${lot}:${todayIST()}`;
  const cached = respCache.get(underlying);
  if (cached && cached.key === cacheKey) return NextResponse.json(cached.body);

  const text = await fs.promises.readFile(file, 'utf8');
  const all = parseSnapshotCsv(text);
  const expiry = latestExpiry(all);
  const snaps = parseSnapshotCsv(text, expiry);
  const last = snaps[snaps.length - 1];
  if (!last) {
    return NextResponse.json({ error: `The ${date} snapshot file has no rows yet` }, { status: 404 });
  }

  const today = summarizeDay(snaps);
  const history: DaySummary[] = [];
  for (const d of dates.slice(1, 1 + HISTORY_DAYS)) {
    const f = resolveCsvPath(underlying, d);
    const s = f ? await summaryFor(f) : null;
    if (s) history.push(s);
  }

  const toLots = (n: number | null) => (n === null ? null : lot ? n / lot : n);
  const rows: FreshMoneyRow[] = buildBoardRows(last, WINGS).map(r => ({
    strike: r.strike,
    put: r.put ? { oiMoved: toLots(r.put.oiMoved), fresh: r.put.fresh } : null,
    call: r.call ? { oiMoved: toLots(r.call.oiMoved), fresh: r.call.fresh } : null,
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
    rows,
    board: boardFresh(last),
    normal: normalAt(history, Math.floor(last.min)),
    series: today.series,
    band: bandFromHistory(history),
    historyDays: history.length,
  };
  respCache.set(underlying, { key: cacheKey, body });
  return NextResponse.json(body);
}

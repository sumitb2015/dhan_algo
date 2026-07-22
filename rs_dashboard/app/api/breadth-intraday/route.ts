import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT, runPythonJson, dedupe } from '@/lib/pyExec';
import { NIFTY50_SYMBOLS } from '@/lib/nifty50';
import { BANKNIFTY_SYMBOLS } from '@/lib/banknifty';

const SCRIPT_PATH = path.join(PROJECT_ROOT, 'scripts', 'tools', 'breadth_intraday_snapshot.py');
const BACKFILL_SCRIPT_PATH = path.join(PROJECT_ROOT, 'scripts', 'tools', 'breadth_intraday_backfill.py');
const DEBUG_DIR = path.join(PROJECT_ROOT, 'debug');

const ALL_SYMBOLS = Array.from(new Set([...NIFTY50_SYMBOLS, ...BANKNIFTY_SYMBOLS]));

const FETCH_COOLDOWN_MS = 50_000;
const MARKET_OPEN_MIN = 9 * 60 + 15;
const MARKET_CLOSE_MIN = 15 * 60 + 30;

// One-off historical reconstruction of missed minutes — 60+ sequential
// per-symbol candle fetches, much slower than the live snapshot's single
// bulk quote call.
const BACKFILL_TIMEOUT_MS = 180_000;

interface Counts { adv: number; decl: number; unch: number }
interface HistoryPoint { time: string; nifty50: Counts; banknifty: Counts }
// backfilledThrough: last minute (HH:MM) the backfill has attempted to cover.
// A watermark rather than a one-shot flag — lets the route catch up on gaps
// left by a poller that stopped early (e.g. tab closed mid-session), instead
// of locking in whatever partial coverage the first run happened to get.
interface HistoryFile { date: string; updated_at: string; history: HistoryPoint[]; backfilledThrough?: string }

interface SnapshotEntry { ltp: number; prevClose: number; direction: 'up' | 'down' | 'flat' }
type SnapshotResult = Record<string, SnapshotEntry> & { error?: string };

type BackfillResult = Record<string, Record<string, 'up' | 'down' | 'flat'>> & { error?: string };

let lastFetchTs = 0;
let lastBackfillTs = 0;
const BACKFILL_COOLDOWN_MS = 60_000;
const MARKET_CLOSE_STR = '15:30';

function istNow(): Date {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000);
}

function istHM(now: Date): [number, number] {
  return [now.getUTCHours(), now.getUTCMinutes()];
}

function istDateStr(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function istTimeStr(now: Date): string {
  const [h, m] = istHM(now);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function historyFilePath(dateStr: string): string {
  return path.join(DEBUG_DIR, `breadth_intraday_${dateStr}.json`);
}

function readHistory(dateStr: string): HistoryFile {
  try {
    const raw = fs.readFileSync(historyFilePath(dateStr), 'utf8');
    return JSON.parse(raw) as HistoryFile;
  } catch {
    return { date: dateStr, updated_at: '', history: [] };
  }
}

function writeHistory(file: HistoryFile) {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  fs.writeFileSync(historyFilePath(file.date), JSON.stringify(file));
}

function countDirections(symbols: string[], snapshot: SnapshotResult): Counts {
  const counts: Counts = { adv: 0, decl: 0, unch: 0 };
  for (const sym of symbols) {
    const entry = snapshot[sym];
    if (!entry) continue;
    if (entry.direction === 'up') counts.adv++;
    else if (entry.direction === 'down') counts.decl++;
    else counts.unch++;
  }
  return counts;
}

function countDirectionsAt(symbols: string[], backfill: BackfillResult, minute: string): Counts {
  const counts: Counts = { adv: 0, decl: 0, unch: 0 };
  for (const sym of symbols) {
    const dir = backfill[sym]?.[minute];
    if (!dir) continue;
    if (dir === 'up') counts.adv++;
    else if (dir === 'down') counts.decl++;
    else counts.unch++;
  }
  return counts;
}

/** Reconstructs minutes the live poller missed (before it started, or after
 *  it stopped mid-session) from historical candles. Re-runs whenever the
 *  history's coverage hasn't yet caught up to targetMinute — not just once
 *  per day — so a poller that stops early doesn't leave a permanent gap. */
async function backfillHistory(file: HistoryFile, targetMinute: string): Promise<HistoryFile> {
  try {
    // dedupe() shares one in-flight Python spawn across concurrent GETs
    // (e.g. multiple tabs opening at once) — each still does its own merge
    // below since another request may have written more live points meanwhile.
    const backfill = await dedupe('breadth-intraday-backfill', () =>
      runPythonJson<BackfillResult>(BACKFILL_SCRIPT_PATH, ALL_SYMBOLS, BACKFILL_TIMEOUT_MS),
    );
    if (backfill.error) {
      console.error('[/api/breadth-intraday] backfill error:', backfill.error);
      return file;
    }

    // Re-read from disk — the shared promise may have resolved after another
    // request's live poll already appended a newer point.
    file = readHistory(file.date);

    const minutes = new Set<string>();
    for (const sym of Object.keys(backfill)) {
      for (const t of Object.keys(backfill[sym])) minutes.add(t);
    }

    const byTime = new Map(file.history.map((p) => [p.time, p]));
    for (const t of minutes) {
      if (byTime.has(t)) continue; // live-observed value wins, never overwritten
      byTime.set(t, {
        time: t,
        nifty50: countDirectionsAt(NIFTY50_SYMBOLS, backfill, t),
        banknifty: countDirectionsAt(BANKNIFTY_SYMBOLS, backfill, t),
      });
    }

    file.history = Array.from(byTime.values()).sort((a, b) => a.time.localeCompare(b.time));
    file.backfilledThrough = targetMinute;
    writeHistory(file);
  } catch (err) {
    console.error('[/api/breadth-intraday] backfill error:', err);
  }
  return file;
}

export async function GET() {
  const now = istNow();
  const [h, m] = istHM(now);
  const minutesOfDay = h * 60 + m;
  const marketOpen = minutesOfDay >= MARKET_OPEN_MIN && minutesOfDay <= MARKET_CLOSE_MIN;
  const dateStr = istDateStr(now);

  let file = readHistory(dateStr);

  const targetMinute = minutesOfDay >= MARKET_CLOSE_MIN ? MARKET_CLOSE_STR : istTimeStr(now);
  const needsBackfill = minutesOfDay >= MARKET_OPEN_MIN
    && (!file.backfilledThrough || file.backfilledThrough < targetMinute);
  if (needsBackfill && Date.now() - lastBackfillTs >= BACKFILL_COOLDOWN_MS) {
    lastBackfillTs = Date.now();
    file = await backfillHistory(file, targetMinute);
  }

  if (marketOpen && Date.now() - lastFetchTs >= FETCH_COOLDOWN_MS) {
    lastFetchTs = Date.now();
    try {
      const snapshot = await dedupe('breadth-intraday', () =>
        runPythonJson<SnapshotResult>(SCRIPT_PATH, ALL_SYMBOLS, 30_000),
      );

      if (!snapshot.error) {
        const point: HistoryPoint = {
          time: istTimeStr(now),
          nifty50: countDirections(NIFTY50_SYMBOLS, snapshot),
          banknifty: countDirections(BANKNIFTY_SYMBOLS, snapshot),
        };

        const idx = file.history.findIndex((p) => p.time === point.time);
        if (idx >= 0) file.history[idx] = point;
        else file.history.push(point);
        file.history.sort((a, b) => a.time.localeCompare(b.time));
        file.updated_at = now.toISOString();

        writeHistory(file);
      } else {
        console.error('[/api/breadth-intraday] snapshot error:', snapshot.error);
      }
    } catch (err) {
      console.error('[/api/breadth-intraday] error:', err);
    }
  }

  const latest = file.history.length > 0 ? file.history[file.history.length - 1] : null;

  return NextResponse.json({
    success: true,
    date: dateStr,
    marketOpen,
    updatedAt: file.updated_at,
    history: file.history,
    latest,
  });
}

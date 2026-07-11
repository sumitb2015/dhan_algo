import fs from 'fs';
import path from 'path';
import { OHLCVRow } from './rs';

// ─── Paths ────────────────────────────────────────────────────────────────────
const DATA_DIR = path.join(process.cwd(), '..', 'Daily_Historical_Data_Fresh');
const HIST_DIR = path.join(process.cwd(), '..', 'Historical Data');
const DEBUG_DIR = path.join(process.cwd(), '..', 'debug');
const NIFTY50_5Y_CSV  = path.join(HIST_DIR, 'NIFTY_50_Daily_5Y.csv');
const NIFTY50_1Y_CSV  = path.join(HIST_DIR, 'NIFTY_50_Daily_1Y.csv');
const NIFTY500_INDEX_CSV = path.join(HIST_DIR, 'NIFTY_500_Daily.csv');
const TODAY_QUOTES_JSON = path.join(DEBUG_DIR, 'today_quotes.json');

// ─── Simple CSV Parser ────────────────────────────────────────────────────────
function parseCSV(content: string): Record<string, string>[] {
  const lines = content.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map((h) => h.trim());
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(',');
    if (vals.length < headers.length) continue;
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => (row[h] = vals[idx]?.trim() ?? ''));
    rows.push(row);
  }
  return rows;
}

// ─── In-Memory Cache ──────────────────────────────────────────────────────────
interface CacheEntry<T> {
  data: T;
  ts: number;
}
const cache = new Map<string, CacheEntry<unknown>>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function cacheGet<T>(key: string): T | undefined {
  const entry = cache.get(key) as CacheEntry<T> | undefined;
  if (!entry) return undefined;
  if (Date.now() - entry.ts > CACHE_TTL_MS) { cache.delete(key); return undefined; }
  return entry.data;
}
function cacheSet<T>(key: string, data: T): void {
  cache.set(key, { data, ts: Date.now() });
}

// ─── Stock CSV Reader ─────────────────────────────────────────────────────────
export function readStockCSV(symbol: string): OHLCVRow[] {
  const cacheKey = `stock:${symbol}`;
  const hit = cacheGet<OHLCVRow[]>(cacheKey);
  if (hit) return hit;

  const filePath = path.join(DATA_DIR, `${symbol}_Daily_2Y.csv`);
  if (!fs.existsSync(filePath)) return [];

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const rows = parseCSV(content);
    const parsed: OHLCVRow[] = rows
      .filter((r) => r.Datetime && r.Close && !isNaN(parseFloat(r.Close)))
      .map((r) => ({
        date: r.Datetime.slice(0, 10),
        open: parseFloat(r.Open) || 0,
        high: parseFloat(r.High) || 0,
        low: parseFloat(r.Low) || 0,
        close: parseFloat(r.Close),
        volume: parseFloat(r.Volume) || 0,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // Apply live-quote patch so today's data is accurate during market hours.
    //
    // Two cases handled:
    // 1. CSV doesn't have today's row at all → append the live quote row.
    // 2. CSV has today's row but `close` equals yesterday's close (Dhan API
    //    returns the previous session's settlement price until EOD processing)
    //    → replace today's close with the live LTP so 1D% is meaningful.
    const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const todayDay = new Date(todayIST + 'T00:00:00').getDay(); // 0=Sun,6=Sat
    const isTradingDay = todayDay >= 1 && todayDay <= 5;
    const last = parsed.length > 0 ? parsed[parsed.length - 1] : null;
    const prev = parsed.length > 1 ? parsed[parsed.length - 2] : null;

    const todayMissingFromCSV = !last || last.date < todayIST;
    const todayCloseStale = last?.date === todayIST && prev !== null && last.close === prev.close;

    // Never inject/patch a "today" row on a non-trading day (weekend) — the
    // live quotes file can carry a stale Saturday/Sunday snapshot forward.
    if (isTradingDay && (todayMissingFromCSV || todayCloseStale)) {
      const liveRow = getTodayQuoteRow(symbol);
      if (liveRow) {
        if (todayMissingFromCSV) {
          parsed.push(liveRow);
        } else {
          // Update close (and volume) in-place; keep CSV open/high/low
          // as they may already reflect the full intraday range.
          parsed[parsed.length - 1] = {
            ...last!,
            close: liveRow.close,
            high: Math.max(last!.high, liveRow.high),
            low: last!.low > 0 ? Math.min(last!.low, liveRow.low) : liveRow.low,
            volume: liveRow.volume > 0 ? liveRow.volume : last!.volume,
          };
        }
      }
    }

    cacheSet(cacheKey, parsed);
    return parsed;
  } catch {
    return [];
  }
}

// ─── Nifty 50 Index Reader ────────────────────────────────────────────────────

/** Pick the date field regardless of whether the CSV index column is named or blank. */
function pickDate(r: Record<string, string>): string {
  return (r.Datetime || r.Date || r[''] || '').slice(0, 10);
}

function parseNifty50CSV(filePath: string): OHLCVRow[] {
  if (!fs.existsSync(filePath)) return [];
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const rows = parseCSV(content);
    return rows
      .filter((r) => pickDate(r) && r.Close && !isNaN(parseFloat(r.Close)))
      .map((r) => ({
        date: pickDate(r),
        open: parseFloat(r.Open) || 0,
        high: parseFloat(r.High) || 0,
        low: parseFloat(r.Low) || 0,
        close: parseFloat(r.Close),
        volume: parseFloat(r.Volume) || 0,
      }));
  } catch {
    return [];
  }
}

export function readNifty50Index(): OHLCVRow[] {
  const cacheKey = 'index:nifty50';
  const hit = cacheGet<OHLCVRow[]>(cacheKey);
  if (hit) return hit;

  // Merge all available Nifty 50 daily files for maximum history coverage.
  // This handles the case where the 5Y file was accidentally truncated.
  const merged = new Map<string, OHLCVRow>();
  for (const filePath of [NIFTY50_1Y_CSV, NIFTY50_5Y_CSV]) {
    for (const row of parseNifty50CSV(filePath)) {
      merged.set(row.date, row); // later files overwrite older ones for same date
    }
  }

  const parsed = Array.from(merged.values()).sort((a, b) => a.date.localeCompare(b.date));

  // If the benchmark CSV is one day behind (common before daily refresh runs),
  // patch today's row using the live Nifty 50 quote from today_quotes.json
  // (_NIFTY50_INDEX key written by fetch_today_quotes.py), or carry forward
  // the last close as a fallback so stock data for today is not dropped by alignByDate.
  const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const last = parsed.length > 0 ? parsed[parsed.length - 1] : null;
  if (last && last.date < todayIST) {
    const todayDay = new Date(todayIST + 'T00:00:00').getDay(); // 0=Sun,6=Sat
    if (todayDay >= 1 && todayDay <= 5) {
      const liveIdx = getTodayQuoteRow('_NIFTY50_INDEX');
      if (liveIdx) {
        parsed.push({ ...liveIdx, date: todayIST });
      } else {
        // Carry forward last known close until real data arrives
        parsed.push({ ...last, date: todayIST });
      }
    }
  }

  if (parsed.length > 0) cacheSet(cacheKey, parsed);
  return parsed;
}

// ─── Nifty 500 Index ─────────────────────────────────────────────────────────
// Prefers saved CSV; falls back to equal-weighted synthetic from 500 CSVs.
let nifty500Promise: Promise<OHLCVRow[]> | null = null;

export async function readNifty500Index(symbols: string[]): Promise<OHLCVRow[]> {
  const cacheKey = 'index:nifty500';
  const hit = cacheGet<OHLCVRow[]>(cacheKey);
  if (hit) return hit;

  // Return existing promise if in-flight (prevents stampede)
  if (nifty500Promise) return nifty500Promise;

  nifty500Promise = (async () => {
    // 1. Try pre-downloaded CSV first
    if (fs.existsSync(NIFTY500_INDEX_CSV)) {
      try {
        const content = fs.readFileSync(NIFTY500_INDEX_CSV, 'utf-8');
        const rows = parseCSV(content);
        const parsed: OHLCVRow[] = rows
          .filter((r) => pickDate(r) && r.Close && !isNaN(parseFloat(r.Close)))
          .map((r) => ({
            date: pickDate(r),
            open: parseFloat(r.Open) || 0,
            high: parseFloat(r.High) || 0,
            low: parseFloat(r.Low) || 0,
            close: parseFloat(r.Close),
            volume: parseFloat(r.Volume) || 0,
          }))
          .sort((a, b) => a.date.localeCompare(b.date));
        if (parsed.length > 0) {
          const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
          const last500 = parsed[parsed.length - 1];
          if (last500 && last500.date < todayIST) {
            const todayDay = new Date(todayIST + 'T00:00:00').getDay();
            if (todayDay >= 1 && todayDay <= 5) {
              const liveIdx = getTodayQuoteRow('_NIFTY500_INDEX');
              if (liveIdx) {
                parsed.push({ ...liveIdx, date: todayIST });
              } else {
                parsed.push({ ...last500, date: todayIST });
              }
            }
          }
          cacheSet(cacheKey, parsed);
          nifty500Promise = null;
          return parsed;
        }
      } catch { /* fall through to synthetic */ }
    }

    // 2. Compute equal-weighted synthetic index
    console.log('[dataLoader] Computing synthetic Nifty 500 index...');
    const BATCH = 50;
    const dateMap = new Map<string, { sum: number; count: number }>();

    for (let i = 0; i < symbols.length; i += BATCH) {
      const batch = symbols.slice(i, i + BATCH);
      await Promise.all(
        batch.map((sym) => {
          const rows = readStockCSV(sym);
          for (const row of rows) {
            const entry = dateMap.get(row.date) ?? { sum: 0, count: 0 };
            entry.sum += row.close;
            entry.count += 1;
            dateMap.set(row.date, entry);
          }
        })
      );
    }

    const sorted = Array.from(dateMap.entries())
      .filter(([, v]) => v.count > symbols.length * 0.5) // need at least 50% of stocks
      .sort(([a], [b]) => a.localeCompare(b));

    if (sorted.length === 0) { nifty500Promise = null; return []; }

    // Normalize: first date average = 10000 (arbitrary base)
    const base = sorted[0][1].sum / sorted[0][1].count;
    const parsed: OHLCVRow[] = sorted.map(([date, v]) => {
      const avg = v.sum / v.count;
      const normalized = (avg / base) * 10000;
      return { date, open: normalized, high: normalized, low: normalized, close: normalized, volume: 0 };
    });

    cacheSet(cacheKey, parsed);
    nifty500Promise = null;
    return parsed;
  })();

  return nifty500Promise;
}

// ─── Today's live quote patch ─────────────────────────────────────────────────
interface TodayQuote { open: number; high: number; low: number; close: number; volume: number; }
interface TodayQuotesFile { date: string; updated_at: string; count?: number; quotes: Record<string, TodayQuote>; }

let _todayQuotesCache: { data: TodayQuotesFile | null; ts: number } | null = null;
const TODAY_QUOTES_TTL = 60 * 1000; // re-read file at most once per minute

function readTodayQuotesFile(): TodayQuotesFile | null {
  const now = Date.now();
  if (_todayQuotesCache && now - _todayQuotesCache.ts < TODAY_QUOTES_TTL) {
    return _todayQuotesCache.data;
  }
  try {
    if (!fs.existsSync(TODAY_QUOTES_JSON)) {
      _todayQuotesCache = { data: null, ts: now };
      return null;
    }
    const raw = fs.readFileSync(TODAY_QUOTES_JSON, 'utf-8');
    const parsed = JSON.parse(raw) as TodayQuotesFile;
    _todayQuotesCache = { data: parsed, ts: now };
    return parsed;
  } catch {
    _todayQuotesCache = { data: null, ts: now };
    return null;
  }
}

/** Returns today's OHLCV row for a symbol from the live quotes file, or null if unavailable. */
export function getTodayQuoteRow(symbol: string): OHLCVRow | null {
  const file = readTodayQuotesFile();
  if (!file) return null;

  // Only use quotes from today's date
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // YYYY-MM-DD
  if (file.date !== today) return null;

  const q = file.quotes[symbol];
  if (!q || q.close <= 0) return null;

  return {
    date: today,
    open:   q.open,
    high:   q.high,
    low:    q.low,
    close:  q.close,
    volume: q.volume,
  };
}

/** Returns metadata about the today_quotes.json file for UI display. */
export function getTodayQuotesMeta(): { date: string; updatedAt: string; count: number } | null {
  const file = readTodayQuotesFile();
  if (!file) return null;
  return { date: file.date, updatedAt: file.updated_at, count: file.count ?? Object.keys(file.quotes).length };
}

// ─── Cache invalidation ───────────────────────────────────────────────────────
export function clearCache(): void {
  cache.clear();
  _allSymbolsCache = null;
  _nifty500ListCache = null;
  _todayQuotesCache = null;
  nifty500Promise = null;

  // Clear breadth daily cache file if exists
  try {
    const breadthCacheFile = path.join(DEBUG_DIR, 'breadth_daily_cache.json');
    if (fs.existsSync(breadthCacheFile)) {
      fs.unlinkSync(breadthCacheFile);
    }
  } catch { /* ignore */ }
}

// ─── List all available symbols from the data directory ───────────────────────
let _allSymbolsCache: string[] | null = null;
export function listAvailableSymbols(): string[] {
  if (_allSymbolsCache) return _allSymbolsCache;
  try {
    const files = fs.readdirSync(DATA_DIR);
    _allSymbolsCache = files
      .filter((f) => f.endsWith('_Daily_2Y.csv'))
      .map((f) => f.replace('_Daily_2Y.csv', ''))
      .filter((s) => s.length > 0);
    return _allSymbolsCache;
  } catch {
    return [];
  }
}

// ─── Sector Indices ───────────────────────────────────────────────────────────
const INDICES_DIR = path.join(HIST_DIR, 'Indices');

export interface IndexMeta {
  key: string;
  label: string;
  file: string | null; // null = use readNifty50Index()
}

export const KNOWN_INDICES: IndexMeta[] = [
  { key: 'NIFTY50',           label: 'Nifty 50',          file: null },
  { key: 'NIFTY_100',         label: 'Nifty 100',          file: 'NIFTY_100.csv' },
  { key: 'NIFTY_200',         label: 'Nifty 200',          file: 'NIFTY_200.csv' },
  { key: 'NIFTY_500',         label: 'Nifty 500',          file: 'NIFTY_500_Daily.csv' }, // top-level
  { key: 'NIFTY_NEXT50',      label: 'Nifty Next 50',      file: 'NIFTY_NEXT50.csv' },
  { key: 'NIFTY_MIDCAP100',   label: 'Nifty Midcap 100',   file: 'NIFTY_MIDCAP100.csv' },
  { key: 'NIFTY_SMALLCAP100', label: 'Nifty Smallcap 100', file: 'NIFTY_SMALLCAP100.csv' },
  { key: 'BANKNIFTY',         label: 'Bank Nifty',         file: 'BANKNIFTY.csv' },
  { key: 'FINNIFTY',          label: 'Fin Nifty',          file: 'FINNIFTY.csv' },
  { key: 'NIFTYIT',           label: 'Nifty IT',           file: 'NIFTYIT.csv' },
  { key: 'NIFTY_AUTO',        label: 'Nifty Auto',         file: 'NIFTY_AUTO.csv' },
  { key: 'NIFTY_PHARMA',      label: 'Nifty Pharma',       file: 'NIFTY_PHARMA.csv' },
  { key: 'NIFTY_FMCG',        label: 'Nifty FMCG',         file: 'NIFTY_FMCG.csv' },
  { key: 'NIFTY_METAL',       label: 'Nifty Metal',        file: 'NIFTY_METAL.csv' },
  { key: 'NIFTY_ENERGY',      label: 'Nifty Energy',       file: 'NIFTY_ENERGY.csv' },
  { key: 'NIFTY_INFRA',       label: 'Nifty Infra',        file: 'NIFTY_INFRA.csv' },
  { key: 'NIFTY_REALTY',      label: 'Nifty Realty',       file: 'NIFTY_REALTY.csv' },
  { key: 'NIFTY_PSU_BANK',    label: 'Nifty PSU Bank',              file: 'NIFTY_PSU_BANK.csv' },
  { key: 'NIFTY_PVT_BANK',    label: 'Nifty Pvt Bank',              file: 'NIFTY_PVT_BANK.csv' },
  { key: 'NIFTY_MEDIA',       label: 'Nifty Media',                 file: 'NIFTY_MEDIA.csv' },
  { key: 'NIFTY_HEALTHCARE',  label: 'Nifty Healthcare',            file: 'NIFTY_HEALTHCARE.csv' },
  { key: 'NIFTY_CONSR_DURBL', label: 'Nifty Consumer Durables',     file: 'NIFTY_CONSR_DURBL.csv' },
  { key: 'NIFTY_FINSRV25_50', label: 'Nifty Fin Services 25/50',   file: 'NIFTY_FINSRV25_50.csv' },
  { key: 'NIFTY_OIL_GAS',     label: 'Nifty Oil and Gas',          file: 'NIFTY_OIL_GAS.csv' },
  { key: 'NIFTY_MIDSML_HLTH', label: 'Nifty MidSmall Healthcare',  file: 'NIFTY_MIDSML_HLTH.csv' },
  { key: 'NIFTY_FINSEREXBNK', label: 'Nifty Fin Services Ex-Bank', file: 'NIFTY_FINSEREXBNK.csv' },
  { key: 'NIFTY_MS_FIN',      label: 'Nifty MidSmall Fin Services',file: 'NIFTY_MS_FIN.csv' },
  { key: 'NIFTY_MS_IT_TELCM', label: 'Nifty MidSmall IT & Telecom',file: 'NIFTY_MS_IT_TELCM.csv' },
  { key: 'INDIA_VIX',         label: 'India VIX',                  file: 'INDIA_VIX.csv' },
];

export function readIndexCSV(meta: IndexMeta): OHLCVRow[] {
  if (meta.file === null) return readNifty50Index();

  const cacheKey = `idx-file:${meta.file}`;
  const hit = cacheGet<OHLCVRow[]>(cacheKey);
  if (hit) return hit;

  // NIFTY_500 top-level CSV lives one level up from INDICES_DIR
  const filePath = meta.key === 'NIFTY_500'
    ? path.join(HIST_DIR, meta.file)
    : path.join(INDICES_DIR, meta.file);

  if (!fs.existsSync(filePath)) return [];

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const rows = parseCSV(content);
    const parsed: OHLCVRow[] = rows
      .filter((r) => r.Datetime && r.Close && !isNaN(parseFloat(r.Close)))
      .map((r) => ({
        date: r.Datetime.slice(0, 10),
        open:   parseFloat(r.Open)   || 0,
        high:   parseFloat(r.High)   || 0,
        low:    parseFloat(r.Low)    || 0,
        close:  parseFloat(r.Close),
        volume: parseFloat(r.Volume) || 0,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // Carry forward/patch today's row so that alignByDate doesn't drop today's data point
    const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const last = parsed.length > 0 ? parsed[parsed.length - 1] : null;
    if (last && last.date < todayIST) {
      const todayDay = new Date(todayIST + 'T00:00:00').getDay();
      if (todayDay >= 1 && todayDay <= 5) {
        const liveIdx = getTodayQuoteRow(meta.key);
        if (liveIdx) {
          parsed.push({ ...liveIdx, date: todayIST });
        } else {
          parsed.push({ ...last, date: todayIST });
        }
      }
    }

    cacheSet(cacheKey, parsed);
    return parsed;
  } catch {
    return [];
  }
}

// ─── Read Nifty500 watchlist CSV ──────────────────────────────────────────────
let _nifty500ListCache: string[] | null = null;
export function readNifty500List(): string[] {
  if (_nifty500ListCache) return _nifty500ListCache;
  const listPath = path.join(process.cwd(), '..', 'MW-NIFTY-500-25-Jan-2026.csv');
  try {
    const content = fs.readFileSync(listPath, 'utf-8');
    const rows = parseCSV(content);
    _nifty500ListCache = rows
      .map((r) => (r.SYMBOL || '').trim())
      .filter(Boolean);
    return _nifty500ListCache;
  } catch {
    // Fall back to all available symbols
    _nifty500ListCache = listAvailableSymbols().slice(0, 500);
    return _nifty500ListCache;
  }
}

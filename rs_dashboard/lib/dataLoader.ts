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
// NSE's official constituent list, kept current by scripts/download_nifty500_symbols.py.
const NIFTY500_LIST_CSV = path.join(process.cwd(), '..', 'ind_nifty500list.csv');
const CORPORATE_ACTIONS_JSON = path.join(process.cwd(), '..', 'scripts', 'downloader', 'corporate_actions.json');

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

function isWeekend(dateStr: string): boolean {
  if (!dateStr || dateStr.length < 10) return false;
  const day = new Date(dateStr.slice(0, 10) + 'T00:00:00').getDay();
  return day === 0 || day === 6; // 0=Sun, 6=Sat
}

// ─── Stock CSV Reader ─────────────────────────────────────────────────────────
/**
 * True if a live-quote row looks like real intraday OHLC rather than a bare
 * LTP snapshot — mirrors scripts/downloader/fetch_today_quotes.py's own
 * `_is_genuine_ohlc` exactly, because both sides read the same
 * debug/today_quotes.json and need to agree on what counts as "no real
 * session yet." Two shapes show up pre-market, depending on which fallback
 * the Python side took for that symbol: stocks read back open/high/low all
 * 0 with only `close` populated (Dhan's per-equity OHLC batch endpoint has
 * nothing to report before the 09:15 bell); indices instead read back
 * open === high === low === close with volume 0 (the script's own
 * `_ltp_to_ohlcv` fallback). Per dhan-prevclose-pct-change: before there is
 * a real "today", don't treat one as if it existed.
 */
function isGenuineQuoteRow(row: OHLCVRow): boolean {
  if (row.open <= 0 || row.high <= 0 || row.low <= 0) return false;
  if (row.open === row.high && row.high === row.low && row.low === row.close && row.volume === 0) return false;
  return true;
}

/**
 * yfinance returns a zero-volume, flat-OHLC bar for every NSE holiday, and the
 * Yahoo sync used to merge them into the stock CSVs (2,401 rows across 495
 * files as of 2026-09-29). The downloaders now drop them on write
 * (lib/market_data_hygiene.py); this read-side check covers older files. Kept,
 * they dilute the 20-day volume average, add a zero-range "day" to NR4/NR7,
 * and a zero-change bar to RSI. Stock CSVs only — some index readers below
 * build flat, zero-volume rows from close-only data on purpose.
 */
function isHolidayPlaceholder(r: OHLCVRow): boolean {
  return r.volume === 0 && r.open === r.high && r.high === r.low && r.low === r.close;
}

// ─── Corporate-action price adjustments ──────────────────────────────────────
// The stock CSVs are stored raw, so a split, bonus or demerger shows up as a
// one-day -33% to -64% "crash" in every return, 52-week range and moving
// average that spans it. scripts/downloader/corporate_actions.json lists the
// confirmed ones; each entry scales the rows before its break onto the
// post-event basis. See that file's _readme for the fields.

interface PriceAdjustment {
  symbol: string;
  from_date?: string;
  break_date: string;
  factor: number;
  adjust_volume?: boolean;
}

// Every registered break is a 30%+ jump, so a 3% band can't mistake an
// already-adjusted series (ratio ~1) for a raw one.
const JUMP_TOLERANCE = 0.03;

let _adjustments: { mtimeMs: number; bySymbol: Map<string, PriceAdjustment[]> } | null = null;
const _staleAdjustmentWarned = new Set<string>();

function priceAdjustmentsFor(symbol: string): PriceAdjustment[] {
  try {
    const { mtimeMs } = fs.statSync(CORPORATE_ACTIONS_JSON);
    if (!_adjustments || _adjustments.mtimeMs !== mtimeMs) {
      const raw = JSON.parse(fs.readFileSync(CORPORATE_ACTIONS_JSON, 'utf-8'));
      const bySymbol = new Map<string, PriceAdjustment[]>();
      for (const a of Array.isArray(raw?.price_adjustments) ? raw.price_adjustments : []) {
        if (typeof a?.symbol !== 'string' || typeof a.break_date !== 'string') continue;
        if (typeof a.factor !== 'number' || !(a.factor > 0)) continue;
        bySymbol.set(a.symbol, [...(bySymbol.get(a.symbol) ?? []), a]);
      }
      _adjustments = { mtimeMs, bySymbol };
    }
    return _adjustments.bySymbol.get(symbol) ?? [];
  } catch {
    return [];
  }
}

function opensAtRatio(prev: OHLCVRow, cur: OHLCVRow, ratio: number): boolean {
  return prev.close > 0 && Math.abs(cur.open / prev.close / ratio - 1) <= JUMP_TOLERANCE;
}

function applyPriceAdjustments(symbol: string, rows: OHLCVRow[]): OHLCVRow[] {
  let out = rows;
  for (const a of priceAdjustmentsFor(symbol)) {
    const bi = out.findIndex(r => r.date === a.break_date);
    // Only while the break is still in the data: if a re-download already
    // adjusted this history, applying the factor again would double it.
    if (bi <= 0 || !opensAtRatio(out[bi - 1], out[bi], a.factor)) {
      const key = `${symbol}:${a.break_date}`;
      if (!_staleAdjustmentWarned.has(key)) {
        _staleAdjustmentWarned.add(key);
        console.warn(`[dataLoader] corporate_actions.json: no ${a.factor} break on ${a.break_date} for ${symbol} — entry skipped`);
      }
      continue;
    }
    let start = 0;
    if (a.from_date) {
      // Rows before from_date came from a download that had already adjusted
      // for this action (visible as a ~1/factor jump up at from_date). Leave
      // them alone while that's still true; otherwise scale everything.
      const si = out.findIndex(r => r.date === a.from_date);
      if (si > 0 && si < bi && opensAtRatio(out[si - 1], out[si], 1 / a.factor)) start = si;
    }
    const f = a.factor;
    const volF = a.adjust_volume ? 1 / f : 1;
    out = out.map((r, k) => (k >= start && k < bi
      ? { ...r, open: r.open * f, high: r.high * f, low: r.low * f, close: r.close * f, volume: r.volume * volF }
      : r));
  }
  return out;
}

function parseAndPatchStockRows(symbol: string, content: string): OHLCVRow[] {
  try {
    const rows = parseCSV(content);
    const parsed: OHLCVRow[] = applyPriceAdjustments(symbol, rows
      .filter((r) => r.Datetime && r.Close && !isNaN(parseFloat(r.Close)))
      .map((r) => ({
        date: r.Datetime.slice(0, 10),
        open: parseFloat(r.Open) || 0,
        high: parseFloat(r.High) || 0,
        low: parseFloat(r.Low) || 0,
        close: parseFloat(r.Close),
        volume: parseFloat(r.Volume) || 0,
      }))
      .filter((r) => !isWeekend(r.date) && !isHolidayPlaceholder(r))
      .sort((a, b) => a.date.localeCompare(b.date)));

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
      // Pre-market (before Dhan computes a real intraday range), the feed's
      // open/high/low read back 0 with only `close` populated — a bare LTP
      // snapshot, not a genuine session (see fetch_today_quotes.py's own
      // _is_genuine_ohlc, which this mirrors). Same principle as
      // dhan-prevclose-pct-change: before there is a real "today", don't
      // synthesize one. Treating that as a real row here made every mover's
      // 1D% collapse to 0.00% (close === prev.close, open/high/low all 0 so
      // every fallback in pctChg1D bottoms out at "no data"), and worse,
      // patched a literal 0 into `low`, corrupting 52-week-low and NR4/NR7
      // for every symbol until the real intraday range showed up.
      const isGenuineSession = !!liveRow && isGenuineQuoteRow(liveRow);
      if (liveRow && isGenuineSession) {
        if (todayMissingFromCSV) {
          // Live quotes never carry a meaningful intraday volume figure (the
          // feed reports 0) — fall back to the last known day's volume so
          // volumeRatio isn't computed against a 0 and forced to 0.
          parsed.push({
            ...liveRow,
            volume: liveRow.volume > 0 ? liveRow.volume : (last?.volume ?? liveRow.volume),
          });
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
      } else if (liveRow && todayCloseStale) {
        // Not a genuine session, but the CSV already has a (stale-close) row
        // for today — still worth refreshing just the close/volume from the
        // live LTP so 1D% reflects the latest price, without touching
        // high/low from a payload that carries no real range.
        parsed[parsed.length - 1] = {
          ...last!,
          close: liveRow.close,
          volume: liveRow.volume > 0 ? liveRow.volume : last!.volume,
        };
      }
      // todayMissingFromCSV + !isGenuineSession: leave `parsed` ending at the
      // last real completed session. Every downstream calc (1D%, 52W hi/lo,
      // NR4/NR7) then naturally compares that session against the one before
      // it — exactly the dhan-prevclose-pct-change pre-market pattern — with
      // no special-casing needed at the call site.
    }

    return parsed;
  } catch {
    return [];
  }
}

export function readStockCSV(symbol: string): OHLCVRow[] {
  const cacheKey = `stock:${symbol}`;
  const hit = cacheGet<OHLCVRow[]>(cacheKey);
  if (hit) return hit;

  const filePath = path.join(DATA_DIR, `${symbol}_Daily_2Y.csv`);
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }
  const parsed = parseAndPatchStockRows(symbol, content);
  cacheSet(cacheKey, parsed);
  return parsed;
}

// True-async variant: fs.promises.readFile never blocks the event loop, so
// cold-cache fan-outs over ~500 symbols (Promise.all in the screener routes)
// actually overlap I/O instead of running one long synchronous burst.
// Shares the same cache as readStockCSV; in-flight map prevents concurrent
// routes from double-reading the same file.
const stockInflight = new Map<string, Promise<OHLCVRow[]>>();

export function readStockCSVAsync(symbol: string): Promise<OHLCVRow[]> {
  const cacheKey = `stock:${symbol}`;
  const hit = cacheGet<OHLCVRow[]>(cacheKey);
  if (hit) return Promise.resolve(hit);

  const existing = stockInflight.get(symbol);
  if (existing) return existing;

  const p = (async () => {
    const filePath = path.join(DATA_DIR, `${symbol}_Daily_2Y.csv`);
    let content: string;
    try {
      content = await fs.promises.readFile(filePath, 'utf-8');
    } catch {
      return [];
    }
    const parsed = parseAndPatchStockRows(symbol, content);
    cacheSet(cacheKey, parsed);
    return parsed;
  })().finally(() => stockInflight.delete(symbol));

  stockInflight.set(symbol, p);
  return p;
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
      }))
      .filter((r) => !isWeekend(r.date));
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
      if (liveIdx && isGenuineQuoteRow(liveIdx)) {
        parsed.push({ ...liveIdx, date: todayIST });
      } else {
        // No real session yet (pre-market bare-LTP snapshot, or no quote at
        // all) — carry forward last known close rather than pushing a
        // flat/degenerate row that would corrupt RS-vs-index calculations.
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
          .filter((r) => !isWeekend(r.date))
          .sort((a, b) => a.date.localeCompare(b.date));
        if (parsed.length > 0) {
          const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
          const last500 = parsed[parsed.length - 1];
          if (last500 && last500.date < todayIST) {
            const todayDay = new Date(todayIST + 'T00:00:00').getDay();
            if (todayDay >= 1 && todayDay <= 5) {
              const liveIdx = getTodayQuoteRow('_NIFTY500_INDEX');
              if (liveIdx && isGenuineQuoteRow(liveIdx)) {
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
        batch.map(async (sym) => {
          const rows = await readStockCSVAsync(sym);
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

export function readNifty500IndexSync(): OHLCVRow[] {
  const cacheKey = 'index:nifty500:sync';
  const hit = cacheGet<OHLCVRow[]>(cacheKey);
  if (hit) return hit;

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
            if (liveIdx && isGenuineQuoteRow(liveIdx)) {
              parsed.push({ ...liveIdx, date: todayIST });
            } else {
              parsed.push({ ...last500, date: todayIST });
            }
          }
        }
        cacheSet(cacheKey, parsed);
        return parsed;
      }
    } catch { /* ignore fallback */ }
  }
  return readNifty50Index(); // Fallback to Nifty 50 if 500 CSV absent
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
  { key: 'NIFTY_SMALLCAP250', label: 'Nifty Smallcap 250', file: 'NIFTY_SMALLCAP250.csv' },
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
      .filter((r) => !isWeekend(r.date))
      .sort((a, b) => a.date.localeCompare(b.date));

    // Carry forward/patch today's row so that alignByDate doesn't drop today's data point
    const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const last = parsed.length > 0 ? parsed[parsed.length - 1] : null;
    if (last && last.date < todayIST) {
      const todayDay = new Date(todayIST + 'T00:00:00').getDay();
      if (todayDay >= 1 && todayDay <= 5) {
        const liveIdx = getTodayQuoteRow(meta.key);
        if (liveIdx && isGenuineQuoteRow(liveIdx)) {
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
  if (_nifty500ListCache && _nifty500ListCache.length > 0) return _nifty500ListCache;
  try {
    const syms = parseConstituentSymbols(fs.readFileSync(NIFTY500_LIST_CSV, 'utf-8'));
    // A truncated download must not silently shrink the universe.
    if (syms.length >= 400) {
      _nifty500ListCache = syms;
      return _nifty500ListCache;
    }
  } catch { /* fall through */ }
  _nifty500ListCache = listAvailableSymbols().slice(0, 500);
  return _nifty500ListCache;
}

// NSE's file: Company Name, Industry, Symbol, Series, ISIN Code. The symbol is
// read counting from the end so a comma inside a company name can't shift a
// wrong value into it, and anything that isn't ticker-shaped is dropped.
// DUMMY<parent> rows are NSE's placeholders for a spun-off business during a
// demerger (DUMMYHEG in 2026-09); they have no price history.
export function parseConstituentSymbols(content: string): string[] {
  const lines = content.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const header = lines[0].split(',').map(h => h.trim().toUpperCase());
  const fromEnd = header.length - header.indexOf('SYMBOL');
  if (fromEnd > header.length) return [];
  const out: string[] = [];
  for (const line of lines.slice(1)) {
    const vals = line.split(',');
    const sym = (vals[vals.length - fromEnd] ?? '').trim();
    if (/^[A-Z0-9][A-Z0-9&-]*$/.test(sym) && !sym.startsWith('DUMMY')) out.push(sym);
  }
  return out;
}

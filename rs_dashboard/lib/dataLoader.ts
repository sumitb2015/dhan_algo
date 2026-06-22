import fs from 'fs';
import path from 'path';
import { OHLCVRow } from './rs';

// ─── Paths ────────────────────────────────────────────────────────────────────
const DATA_DIR = path.join(process.cwd(), '..', 'Daily_Historical_Data_Fresh');
const HIST_DIR = path.join(process.cwd(), '..', 'Historical Data');
const NIFTY50_INDEX_CSV = path.join(HIST_DIR, 'NIFTY_50_Daily_5Y.csv');
const NIFTY500_INDEX_CSV = path.join(HIST_DIR, 'NIFTY_500_Daily.csv');

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

    cacheSet(cacheKey, parsed);
    return parsed;
  } catch {
    return [];
  }
}

// ─── Nifty 50 Index Reader ────────────────────────────────────────────────────
export function readNifty50Index(): OHLCVRow[] {
  const cacheKey = 'index:nifty50';
  const hit = cacheGet<OHLCVRow[]>(cacheKey);
  if (hit) return hit;

  try {
    const content = fs.readFileSync(NIFTY50_INDEX_CSV, 'utf-8');
    const rows = parseCSV(content);
    const parsed: OHLCVRow[] = rows
      .filter((r) => (r.Datetime || r.Date) && r.Close && !isNaN(parseFloat(r.Close)))
      .map((r) => ({
        date: (r.Datetime || r.Date).slice(0, 10),
        open: parseFloat(r.Open) || 0,
        high: parseFloat(r.High) || 0,
        low: parseFloat(r.Low) || 0,
        close: parseFloat(r.Close),
        volume: parseFloat(r.Volume) || 0,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    cacheSet(cacheKey, parsed);
    return parsed;
  } catch {
    return [];
  }
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
          .filter((r) => (r.Datetime || r.Date) && r.Close && !isNaN(parseFloat(r.Close)))
          .map((r) => ({
            date: (r.Datetime || r.Date).slice(0, 10),
            open: parseFloat(r.Open) || 0,
            high: parseFloat(r.High) || 0,
            low: parseFloat(r.Low) || 0,
            close: parseFloat(r.Close),
            volume: parseFloat(r.Volume) || 0,
          }))
          .sort((a, b) => a.date.localeCompare(b.date));
        if (parsed.length > 0) {
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

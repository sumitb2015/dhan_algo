import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { OHLCVRow } from '@/lib/rs';

// ─── Index catalogue ──────────────────────────────────────────────────────────

export type IndexCategory = 'Broad Market' | 'Sectoral' | 'Volatility';

export interface IndexMeta {
  symbol: string;   // short display key
  label: string;    // full display name
  category: IndexCategory;
  csvPath: string;  // absolute path to CSV
}

const HIST_DIR    = path.join(process.cwd(), '..', 'Historical Data');
const INDICES_DIR = path.join(HIST_DIR, 'Indices');

const INDEX_LIST: IndexMeta[] = [
  // ── Broad Market ─────────────────────────────────────────────────────────
  { symbol: 'NIFTY50',       label: 'Nifty 50',              category: 'Broad Market', csvPath: path.join(HIST_DIR, 'NIFTY_50_Daily_5Y.csv') },
  { symbol: 'NIFTYNXT50',    label: 'Nifty Next 50',         category: 'Broad Market', csvPath: path.join(INDICES_DIR, 'NIFTY_NEXT50.csv') },
  { symbol: 'NIFTY100',      label: 'Nifty 100',             category: 'Broad Market', csvPath: path.join(INDICES_DIR, 'NIFTY_100.csv') },
  { symbol: 'NIFTY200',      label: 'Nifty 200',             category: 'Broad Market', csvPath: path.join(INDICES_DIR, 'NIFTY_200.csv') },
  { symbol: 'NIFTY500',      label: 'Nifty 500',             category: 'Broad Market', csvPath: path.join(HIST_DIR, 'NIFTY_500_Daily.csv') },
  { symbol: 'MIDCAP100',     label: 'Nifty Midcap 100',      category: 'Broad Market', csvPath: path.join(INDICES_DIR, 'NIFTY_MIDCAP100.csv') },
  { symbol: 'SMALLCAP100',   label: 'Nifty Smallcap 100',    category: 'Broad Market', csvPath: path.join(INDICES_DIR, 'NIFTY_SMALLCAP100.csv') },
  // ── Sectoral ──────────────────────────────────────────────────────────────
  { symbol: 'BANKNIFTY',     label: 'Nifty Bank',            category: 'Sectoral', csvPath: path.join(INDICES_DIR, 'BANKNIFTY.csv') },
  { symbol: 'NIFTYIT',       label: 'Nifty IT',              category: 'Sectoral', csvPath: path.join(INDICES_DIR, 'NIFTYIT.csv') },
  { symbol: 'NIFTYFMCG',     label: 'Nifty FMCG',           category: 'Sectoral', csvPath: path.join(INDICES_DIR, 'NIFTY_FMCG.csv') },
  { symbol: 'NIFTYAUTO',     label: 'Nifty Auto',            category: 'Sectoral', csvPath: path.join(INDICES_DIR, 'NIFTY_AUTO.csv') },
  { symbol: 'NIFTYPHARMA',   label: 'Nifty Pharma',          category: 'Sectoral', csvPath: path.join(INDICES_DIR, 'NIFTY_PHARMA.csv') },
  { symbol: 'NIFTYMETAL',    label: 'Nifty Metal',           category: 'Sectoral', csvPath: path.join(INDICES_DIR, 'NIFTY_METAL.csv') },
  { symbol: 'NIFTYREALTY',   label: 'Nifty Realty',          category: 'Sectoral', csvPath: path.join(INDICES_DIR, 'NIFTY_REALTY.csv') },
  { symbol: 'NIFTYPSUBANK',  label: 'Nifty PSU Bank',        category: 'Sectoral', csvPath: path.join(INDICES_DIR, 'NIFTY_PSU_BANK.csv') },
  { symbol: 'NIFTYPVTBANK',  label: 'Nifty Private Bank',    category: 'Sectoral', csvPath: path.join(INDICES_DIR, 'NIFTY_PVT_BANK.csv') },
  { symbol: 'FINNIFTY',      label: 'Nifty Fin Services',    category: 'Sectoral', csvPath: path.join(INDICES_DIR, 'FINNIFTY.csv') },
  { symbol: 'NIFTYENERGY',   label: 'Nifty Energy',          category: 'Sectoral', csvPath: path.join(INDICES_DIR, 'NIFTY_ENERGY.csv') },
  { symbol: 'NIFTYINFRA',    label: 'Nifty Infra',           category: 'Sectoral', csvPath: path.join(INDICES_DIR, 'NIFTY_INFRA.csv') },
  // ── Volatility ────────────────────────────────────────────────────────────
  { symbol: 'INDIAVIX',      label: 'India VIX',             category: 'Volatility', csvPath: path.join(INDICES_DIR, 'INDIA_VIX.csv') },
];

// ─── CSV parsing ──────────────────────────────────────────────────────────────

function parseCSV(content: string): Record<string, string>[] {
  const lines = content.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const vals = line.split(',');
    const row: Record<string, string> = {};
    headers.forEach((h, i) => (row[h] = vals[i]?.trim() ?? ''));
    return row;
  }).filter((r) => Object.values(r).some(Boolean));
}

function pickDate(r: Record<string, string>): string {
  return (r.Datetime || r.Date || r[''] || '').slice(0, 10);
}

function readIndexCSV(csvPath: string): OHLCVRow[] {
  if (!fs.existsSync(csvPath)) return [];
  try {
    const rows = parseCSV(fs.readFileSync(csvPath, 'utf-8'));
    return rows
      .filter((r) => pickDate(r) && r.Close && !isNaN(parseFloat(r.Close)))
      .map((r) => ({
        date:   pickDate(r),
        open:   parseFloat(r.Open)   || 0,
        high:   parseFloat(r.High)   || 0,
        low:    parseFloat(r.Low)    || 0,
        close:  parseFloat(r.Close),
        volume: parseFloat(r.Volume) || 0,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
  } catch {
    return [];
  }
}

// ─── Metric helpers ───────────────────────────────────────────────────────────

function simpleMA(closes: number[], period: number): number {
  if (closes.length < period) return 0;
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function wilderRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff; else avgLoss += Math.abs(diff);
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? Math.abs(diff) : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function pctChg(rows: OHLCVRow[], n: number): number {
  if (rows.length < 2) return 0;
  const slice = rows.slice(-Math.min(n, rows.length));
  const first = slice[0].close;
  const last  = slice[slice.length - 1].close;
  if (first === 0) return 0;
  return ((last - first) / first) * 100;
}

function pctChg1D(rows: OHLCVRow[]): number {
  if (rows.length < 2) return 0;
  const curr = rows[rows.length - 1];
  const prev = rows[rows.length - 2];
  if (prev.close === 0) return 0;
  let currPrice = curr.close;
  if (currPrice === prev.close && curr.open > 0) currPrice = curr.open;
  return ((currPrice - prev.close) / prev.close) * 100;
}

// ─── Result type ──────────────────────────────────────────────────────────────

export interface IndexResult {
  symbol: string;
  label: string;
  category: IndexCategory;
  latestClose: number;
  latestDate: string;
  priceChange1D: number;
  priceChange1W: number;
  priceChange1M: number;
  priceChange3M: number;
  priceChange1Y: number;
  high52W: number;
  low52W: number;
  pctFrom52WHigh: number;
  pctFrom52WLow: number;
  ma50: number;
  ma200: number;
  aboveMa50: boolean;
  aboveMa200: boolean;
  rsi14: number;
  hasData: boolean;
}

export interface IndicesResponse {
  indices: IndexResult[];
  dataDate: string;
  missingCsvs: string[];
}

// ─── Cache ────────────────────────────────────────────────────────────────────

let _cache: { data: IndicesResponse; ts: number } | null = null;
const CACHE_TTL = 30 * 1000; // 30 s — CSVs update once/day; short TTL avoids stale reads

export function clearIndicesCache() { _cache = null; }

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  const bust = new URL(req.url).searchParams.has('bust');
  if (bust) _cache = null;

  if (_cache && Date.now() - _cache.ts < CACHE_TTL) {
    return NextResponse.json({ success: true, data: _cache.data });
  }

  const results: IndexResult[] = [];
  const missingCsvs: string[] = [];
  let latestDate = '';

  for (const meta of INDEX_LIST) {
    const rows = readIndexCSV(meta.csvPath);

    if (rows.length < 22) {
      missingCsvs.push(meta.label);
      results.push({
        symbol: meta.symbol,
        label: meta.label,
        category: meta.category,
        latestClose: 0,
        latestDate: '',
        priceChange1D: 0,
        priceChange1W: 0,
        priceChange1M: 0,
        priceChange3M: 0,
        priceChange1Y: 0,
        high52W: 0,
        low52W: 0,
        pctFrom52WHigh: 0,
        pctFrom52WLow: 0,
        ma50: 0,
        ma200: 0,
        aboveMa50: false,
        aboveMa200: false,
        rsi14: 50,
        hasData: false,
      });
      continue;
    }

    const latest  = rows[rows.length - 1];
    const closes  = rows.map((r) => r.close);
    const last252 = rows.slice(-252);

    const high52W = Math.max(...last252.map((r) => r.high));
    const low52W  = Math.min(...last252.map((r) => r.low));
    const ma50    = simpleMA(closes, 50);
    const ma200   = simpleMA(closes, 200);

    if (latest.date > latestDate) latestDate = latest.date;

    results.push({
      symbol: meta.symbol,
      label: meta.label,
      category: meta.category,
      latestClose: latest.close,
      latestDate: latest.date,
      priceChange1D: pctChg1D(rows),
      priceChange1W: pctChg(rows, 6),
      priceChange1M: pctChg(rows, 22),
      priceChange3M: pctChg(rows, 65),
      priceChange1Y: pctChg(rows, 252),
      high52W,
      low52W,
      pctFrom52WHigh: high52W > 0 ? ((latest.close - high52W) / high52W) * 100 : 0,
      pctFrom52WLow:  low52W  > 0 ? ((latest.close - low52W)  / low52W)  * 100 : 0,
      ma50,
      ma200,
      aboveMa50:  ma50  > 0 && latest.close > ma50,
      aboveMa200: ma200 > 0 && latest.close > ma200,
      rsi14: wilderRSI(closes.slice(-60)),
      hasData: true,
    });
  }

  const response: IndicesResponse = { indices: results, dataDate: latestDate, missingCsvs };
  _cache = { data: response, ts: Date.now() };
  return NextResponse.json({ success: true, data: response });
}

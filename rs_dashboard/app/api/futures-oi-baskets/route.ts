import { NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { NIFTY50_SYMBOLS } from '@/lib/nifty50';
import { SENSEX_SYMBOLS } from '@/lib/sensex';
import { BANKNIFTY_SYMBOLS } from '@/lib/banknifty';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');

// ─── Types ────────────────────────────────────────────────────────────────────

interface SnapshotRow {
  symbol: string;
  price: number;
  priceChgPct: number;
  oi: number;
  oiChgPct: number;
  category: string;
  volume: number;
  turnover: number | null;
  turnoverPrev: number | null;
  dataDate: string;
}

export interface BasketStats {
  key: string;
  label: string;
  totalScanned: number;
  turnoverCr: number;
  turnoverChgPct: number | null;
  shortBuildupCount: number;
  largestOiAdditions: string[];
}

export interface FuturesOiBasketsResponse {
  success: boolean;
  dataDate: string;
  baskets: BasketStats[];
  error?: string;
}

const BASKETS: { key: string; label: string; symbols: string[] }[] = [
  { key: 'nifty50', label: 'Nifty 50 stocks', symbols: NIFTY50_SYMBOLS },
  { key: 'sensex', label: 'Sensex stocks', symbols: SENSEX_SYMBOLS },
  { key: 'banknifty', label: 'Bank Nifty stocks', symbols: BANKNIFTY_SYMBOLS },
];

// ─── CSV parser ───────────────────────────────────────────────────────────────

let snapCache: { mtimeMs: number; rows: SnapshotRow[] } | null = null;

async function parseSnapshot(filePath: string, stat: fs.Stats): Promise<SnapshotRow[]> {
  const content = await fs.promises.readFile(filePath, 'utf-8');
  const lines = content.trim().split('\n');
  const rows: SnapshotRow[] = [];
  if (lines.length >= 2) {
    const headers = lines[0].split(',').map(h => h.trim());
    const idx = (col: string) => headers.indexOf(col);
    for (const line of lines.slice(1)) {
      const v = line.split(',');
      const get = (col: string) => (v[idx(col)] ?? '').trim();
      const symbol = get('Symbol');
      if (!symbol) continue;
      rows.push({
        symbol,
        price: parseFloat(get('Price')) || 0,
        priceChgPct: parseFloat(get('PriceChgPct')) || 0,
        oi: parseInt(get('OI'), 10) || 0,
        oiChgPct: parseFloat(get('OIChgPct')) || 0,
        category: get('Category'),
        volume: parseInt(get('Volume'), 10) || 0,
        // Blank when the source day had zero traded volume — kept as null (not 0) so
        // basket rollups can exclude it instead of treating "no trade" as "no turnover".
        turnover: get('Turnover') === '' ? null : parseFloat(get('Turnover')),
        turnoverPrev: get('TurnoverPrev') === '' ? null : parseFloat(get('TurnoverPrev')),
        dataDate: get('DataDate'),
      });
    }
  }

  snapCache = { mtimeMs: stat.mtimeMs, rows };
  return rows;
}

function computeBasket(key: string, label: string, symbols: string[], allRows: SnapshotRow[]): BasketStats {
  const symbolSet = new Set(symbols);
  const rows = allRows.filter(r => symbolSet.has(r.symbol));

  // Only stocks with a valid turnover figure for both days count toward the sum —
  // a zero-volume day is "unknown", not "zero", so it must not silently deflate the basket.
  const turnoverRows = rows.filter(r => r.turnover !== null && r.turnoverPrev !== null);
  const turnover = turnoverRows.reduce((sum, r) => sum + (r.turnover as number), 0);
  const turnoverPrev = turnoverRows.reduce((sum, r) => sum + (r.turnoverPrev as number), 0);
  const turnoverChgPct = turnoverPrev > 0 ? ((turnover - turnoverPrev) / turnoverPrev) * 100 : null;

  const shortBuildupCount = rows.filter(r => r.category === 'SHORT_BUILDUP').length;

  // Only stocks that genuinely added OI qualify — never show the "least negative" ones.
  const largestOiAdditions = rows
    .filter(r => r.oiChgPct > 0)
    .sort((a, b) => b.oiChgPct - a.oiChgPct)
    .slice(0, 3)
    .map(r => r.symbol);

  return {
    key,
    label,
    totalScanned: rows.length,
    turnoverCr: turnover / 1e7,
    turnoverChgPct,
    shortBuildupCount,
    largestOiAdditions,
  };
}

// Each row's DataDate is resolved independently per stock in the downloader, so a
// single lagging stock could skew a naive "first row" pick — use whichever date the
// majority of rows actually carry.
function majorityDataDate(rows: SnapshotRow[]): string {
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (!r.dataDate) continue;
    counts.set(r.dataDate, (counts.get(r.dataDate) ?? 0) + 1);
  }
  let best = '';
  let bestCount = 0;
  for (const [date, count] of counts) {
    if (count > bestCount) { best = date; bestCount = count; }
  }
  return best;
}

// ─── GET handler ──────────────────────────────────────────────────────────────

export async function GET() {
  const filePath = path.join(PROJECT_ROOT, 'Historical Data', 'FUTSTK_OI_Snapshot.csv');

  try {
    const stat = await fs.promises.stat(filePath);
    const allRows = snapCache && snapCache.mtimeMs === stat.mtimeMs
      ? snapCache.rows
      : await parseSnapshot(filePath, stat);
    const dataDate = majorityDataDate(allRows) || stat.mtime.toISOString().split('T')[0];

    return NextResponse.json<FuturesOiBasketsResponse>({
      success: true,
      dataDate,
      baskets: BASKETS.map(b => computeBasket(b.key, b.label, b.symbols, allRows)),
    });
  } catch (e: unknown) {
    const notFound = (e as NodeJS.ErrnoException)?.code === 'ENOENT';
    return NextResponse.json<FuturesOiBasketsResponse>({
      success: false,
      dataDate: '',
      baskets: [],
      error: notFound
        ? 'No snapshot found. Click "Download Data" to fetch stock futures OI.'
        : e instanceof Error ? e.message : 'Unknown error',
    });
  }
}

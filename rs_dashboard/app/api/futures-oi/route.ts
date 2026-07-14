import { NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OIRow {
  symbol: string;
  expiry: string;
  price: number;
  priceChgPct: number;
  oi: number;
  oiChgPct: number;
  category?: string;
  dataDate?: string;
}

export interface OIBuildupResponse {
  success: boolean;
  dataDate: string;
  longBuildup: OIRow[];
  shortBuildup: OIRow[];
  shortCovering: OIRow[];
  longUnwinding: OIRow[];
  error?: string;
}

// ─── CSV parser ───────────────────────────────────────────────────────────────

// Re-parse only when the snapshot file's mtime changes; polls in between
// serve the cached rows without touching the filesystem beyond a stat.
let snapCache: { mtimeMs: number; rows: (OIRow & { category: string; dataDate: string })[] } | null = null;

async function parseSnapshot(filePath: string): Promise<(OIRow & { category: string; dataDate: string })[]> {
  const stat = await fs.promises.stat(filePath);
  if (snapCache && snapCache.mtimeMs === stat.mtimeMs) return snapCache.rows;

  const content = await fs.promises.readFile(filePath, 'utf-8');
  const rows = parseSnapshotContent(content);
  snapCache = { mtimeMs: stat.mtimeMs, rows };
  return rows;
}

function parseSnapshotContent(content: string): (OIRow & { category: string; dataDate: string })[] {
  const lines = content.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim());
  const idx = (col: string) => headers.indexOf(col);
  return lines.slice(1).flatMap(line => {
    const v = line.split(',');
    const get = (col: string) => (v[idx(col)] ?? '').trim();
    const symbol = get('Symbol');
    if (!symbol) return [];
    return [{
      symbol,
      expiry:      get('Expiry'),
      price:       parseFloat(get('Price')) || 0,
      priceChgPct: parseFloat(get('PriceChgPct')) || 0,
      oi:          parseInt(get('OI'), 10) || 0,
      oiChgPct:    parseFloat(get('OIChgPct')) || 0,
      category:    get('Category'),
      dataDate:    get('DataDate'),
    }];
  });
}

function sortByAbsOI(rows: OIRow[]): OIRow[] {
  return [...rows].sort((a, b) => Math.abs(b.oiChgPct) - Math.abs(a.oiChgPct));
}

// ─── GET handler ──────────────────────────────────────────────────────────────

export async function GET() {
  const filePath = path.join(PROJECT_ROOT, 'Historical Data', 'FUTSTK_OI_Snapshot.csv');

  if (!fs.existsSync(filePath)) {
    return NextResponse.json<OIBuildupResponse>({
      success: false,
      dataDate: '',
      longBuildup: [], shortBuildup: [], shortCovering: [], longUnwinding: [],
      error: 'No snapshot found. Click "Download Data" to fetch stock futures OI.',
    });
  }

  try {
    const allRows = await parseSnapshot(filePath);
    const filterSort = (cat: string): OIRow[] =>
      sortByAbsOI(allRows.filter(r => r.category === cat));

    const dataDate = allRows[0]?.dataDate ?? new Date((await fs.promises.stat(filePath)).mtime)
      .toISOString().split('T')[0];

    return NextResponse.json<OIBuildupResponse>({
      success: true,
      dataDate,
      longBuildup:   filterSort('LONG_BUILDUP'),
      shortBuildup:  filterSort('SHORT_BUILDUP'),
      shortCovering: filterSort('SHORT_COVERING'),
      longUnwinding: filterSort('LONG_UNWINDING'),
    });
  } catch (e: unknown) {
    return NextResponse.json<OIBuildupResponse>({
      success: false,
      dataDate: '',
      longBuildup: [], shortBuildup: [], shortCovering: [], longUnwinding: [],
      error: e instanceof Error ? e.message : 'Unknown error',
    });
  }
}

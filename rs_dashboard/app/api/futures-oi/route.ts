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

function parseSnapshot(filePath: string): (OIRow & { category: string })[] {
  const content = fs.readFileSync(filePath, 'utf-8');
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
      oi:          parseInt(get('OI')) || 0,
      oiChgPct:    parseFloat(get('OIChgPct')) || 0,
      category:    get('Category'),
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
    const allRows = parseSnapshot(filePath);
    const filterSort = (cat: string): OIRow[] =>
      sortByAbsOI(allRows.filter(r => r.category === cat));

    const dataDate = new Date(fs.statSync(filePath).mtime)
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

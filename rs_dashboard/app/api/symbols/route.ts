import { NextResponse } from 'next/server';
import { readNifty500List, listAvailableSymbols, KNOWN_INDICES } from '@/lib/dataLoader';

export interface IndexOption {
  key: string;
  label: string;
}

export interface SymbolsResponse {
  success: boolean;
  symbols: string[];
  indices: IndexOption[];
  commodities: IndexOption[];
}

// CRUDEOIL/CRUDEOILM aren't backed by a CSV like the equity/index lists — they resolve to the
// nearest non-expired MCX future at request time (see scripts/tools/level_chart_fetch.py).
const COMMODITIES: IndexOption[] = [
  { key: 'CRUDEOIL', label: 'Crude Oil' },
  { key: 'CRUDEOILM', label: 'Crude Oil Mini' },
];

// Nifty 500 constituents that actually have historical CSV data on disk —
// the watchlist CSV can include names not yet backfilled by the downloader.
export async function GET() {
  const available = new Set(listAvailableSymbols());
  const symbols = readNifty500List()
    .filter((s) => available.has(s))
    .sort();

  const indices: IndexOption[] = KNOWN_INDICES.map((m) => ({ key: m.key, label: m.label }));

  return NextResponse.json({ success: true, symbols, indices, commodities: COMMODITIES } satisfies SymbolsResponse);
}

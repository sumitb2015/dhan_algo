import { NextResponse } from 'next/server';
import { readNifty500List, listAvailableSymbols } from '@/lib/dataLoader';

export interface SymbolsResponse {
  success: boolean;
  symbols: string[];
}

// Nifty 500 constituents that actually have historical CSV data on disk —
// the watchlist CSV can include names not yet backfilled by the downloader.
export async function GET() {
  const available = new Set(listAvailableSymbols());
  const symbols = readNifty500List()
    .filter((s) => available.has(s))
    .sort();

  return NextResponse.json({ success: true, symbols } satisfies SymbolsResponse);
}

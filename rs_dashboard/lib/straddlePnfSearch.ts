// Instrument choices for the Straddle P&F search box: the NSE indices that have intraday bars, then NSE cash equities.
// Pure matching lives here so it is testable; the equity list comes from the route.

/** A search result: an index or a stock to chart directly, or an F&O underlying (its contract is picked next). */
export type PnfPick = { kind: 'index' | 'equity' | 'futures' | 'options'; symbol: string; name: string };

export const PNF_INDICES: PnfPick[] = [
  { kind: 'index', symbol: 'NIFTY', name: 'Nifty 50' },
  { kind: 'index', symbol: 'BANKNIFTY', name: 'Nifty Bank' },
  { kind: 'index', symbol: 'FINNIFTY', name: 'Nifty Financial Services' },
];

const SYMBOL_RE = /^[A-Z0-9&-]{1,20}$/;

/** A user-typed query reduced to what the master list can match, or null when it is empty or has unusable characters. */
export function cleanQuery(raw: string): string | null {
  const q = raw.trim().toUpperCase();
  return q.length >= 1 && q.length <= 30 && /^[A-Z0-9 &.\-]+$/.test(q) ? q : null;
}

export function matchIndices(q: string): PnfPick[] {
  return PNF_INDICES.filter(i => i.symbol.startsWith(q) || i.name.toUpperCase().includes(q));
}

export const isIndexSymbol = (s: string) => PNF_INDICES.some(i => i.symbol === s);
export const isSymbol = (s: string) => SYMBOL_RE.test(s);

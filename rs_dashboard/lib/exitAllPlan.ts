// Which Dhan positions the scalper terminals' EXIT ALL (`/api/exit-all`, scope 'fno') closes, and in what order.
//
// Scope is every derivatives segment the terminals trade: NSE_FNO, BSE_FNO and MCX_COMM. A bare "contains FNO" test
// left MCX crude legs open while the toast said every F&O position was liquidated. Cash equity (NSE_EQ / BSE_EQ) stays
// out: that is what scope 'fno' exists for.
//
// Shorts first (most-short first, longs last), the same order as Kotak's exit-all: buying back a short before selling
// its long hedge keeps the book covered the whole way down.

/** True for a Dhan derivatives segment the F&O-scoped exit owns. */
export function isDhanFnoSegment(segment: unknown): boolean {
  if (typeof segment !== 'string') return false;
  const s = segment.toUpperCase();
  return s.includes('FNO') || s === 'MCX_COMM';
}

/** Open F&O rows, shorts before longs. Never mutates its input. */
export function planFnoExits<T extends Record<string, unknown>>(positions: T[]): T[] {
  return positions
    .filter(p => Number(p.netQty ?? 0) !== 0 && isDhanFnoSegment(p.exchangeSegment))
    .sort((a, b) => Number(a.netQty) - Number(b.netQty));
}

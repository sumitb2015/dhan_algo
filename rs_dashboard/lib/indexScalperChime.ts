// Index Scalper trade chimes: which sound a change in the position book deserves. Pure (no audio), so it is testable;
// the terminal plays the sound.
//
// Classified from the book, not from the button that was pressed: SIM fills, REAL fills seen on the 3 s positions poll,
// a TP / SL bracket filled at the broker, the chip's "+" / "-", a reverse, Exit / Exit All all land here the same way.

export type TradeChime = 'entry' | 'exit' | null;

/** Signed open quantity per leg id. */
export type QtyBook = ReadonlyMap<string, number>;

export function qtyBook(legs: readonly { id: string; netQty: number }[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of legs) if (Number.isFinite(l.netQty) && l.netQty !== 0) m.set(l.id, (m.get(l.id) ?? 0) + l.netQty);
  return m;
}

/** Compares two books. Any leg reduced, closed or flipped through zero is an exit; otherwise any leg opened or added to
 *  is an entry. An exit wins inside one change (a reverse sounds like the close it starts with), so a burst never hides
 *  a close behind the entry sound. */
export function tradeChimeFor(prev: QtyBook, cur: QtyBook): TradeChime {
  let entry = false;
  const ids = new Set([...prev.keys(), ...cur.keys()]);
  for (const id of ids) {
    const p = prev.get(id) ?? 0;
    const q = cur.get(id) ?? 0;
    if (p === q) continue;
    if (p !== 0 && (q === 0 || Math.sign(q) !== Math.sign(p) || Math.abs(q) < Math.abs(p))) return 'exit';
    entry = true;
  }
  return entry ? 'entry' : null;
}

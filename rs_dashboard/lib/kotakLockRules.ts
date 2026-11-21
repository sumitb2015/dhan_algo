// Pure rule for the Kotak day lock (no imports, so node --test can load it). The order path is lib/kotakDayLock.ts.

/** Would this order take |net| of the leg further from flat (open, add, or flip through zero)? */
export function orderAddsExposure(side: 'B' | 'S', qty: number, netQty: number): boolean {
  if (!(qty > 0)) return false;
  if (netQty === 0) return true;
  const sameDirection = (side === 'B') === (netQty > 0);
  if (sameDirection) return true;
  return qty > Math.abs(netQty);   // an oversize reducing order flips the position: the excess is a new position
}

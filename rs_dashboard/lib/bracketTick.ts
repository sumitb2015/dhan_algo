// Client side: the contract's tick size for bracket pricing, fetched once per contract and cached.
const cache = new Map<string, number>();

/** Tick in rupees, or null when it could not be read (callers must then refuse to price a bracket). */
export async function fetchBracketTick(securityId: string, exchangeSegment: string): Promise<number | null> {
  const key = `${exchangeSegment}|${securityId}`;
  const hit = cache.get(key);
  if (hit) return hit;
  try {
    const j = await (await fetch(`/api/super-order/tick?securityId=${encodeURIComponent(securityId)}&segment=${encodeURIComponent(exchangeSegment)}`)).json() as { success?: boolean; tick?: number };
    if (j.success && typeof j.tick === 'number' && j.tick > 0 && j.tick <= 1) { cache.set(key, j.tick); return j.tick; }
  } catch { /* fall through */ }
  return null;
}

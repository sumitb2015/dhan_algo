// Which Dhan-fed contracts the Advanced Scalper asks the live bridge to price for open Kotak legs.
//
// Kotak's positions payload carries a trading symbol and no usable price (see kotakShape.ts), so every open leg —
// on any underlying, any expiry, option or future — is sent to the running bridge by its Kotak trading symbol and
// priced from Dhan's feed (/api/options/live `watchContracts`, quotes.contracts[symbol]).

export type KotakSide = 'CE' | 'PE' | 'FUT';

/** Kotak trading symbol -> its contract, from the Kotak instrument cache (one fetch per underlying). */
export type KotakSymbolMap = Record<string, { underlying: string; expiry: string; strike: number; side: KotakSide }>;

/** Underlyings the bridge can resolve (live_options_ws.py UNDERLYING_EXCHANGE). Longest first: CRUDEOILM before
 *  CRUDEOIL, BANKNIFTY / FINNIFTY before NIFTY. */
const UNDERLYINGS = ['CRUDEOILM', 'BANKNIFTY', 'FINNIFTY', 'CRUDEOIL', 'SENSEX', 'NIFTY'];

/** The underlying a Kotak F&O trading symbol is on, or null. Only a first guess for which caches to load: a leg is
 *  priced only once that underlying's cache confirms the exact symbol. */
export function kotakUnderlyingOf(symbol: string): string | null {
  const s = symbol.toUpperCase();
  for (const u of UNDERLYINGS) {
    // The root must be followed by a digit (expiry), so NIFTYBEES is not read as NIFTY.
    if (s.startsWith(u) && /\d/.test(s.charAt(u.length))) return u;
  }
  return null;
}

export interface KotakContractRequest { key: string; underlying: string; expiry: string; strike: number; side: KotakSide }

/** One request per open leg the map knows, deduplicated, in a stable order (so an unchanged book is not re-sent). */
export function kotakContractRequests(
  positions: { tradingSymbol?: unknown; netQty?: unknown }[],
  map: KotakSymbolMap,
): KotakContractRequest[] {
  const out = new Map<string, KotakContractRequest>();
  for (const pos of positions) {
    if (!Number(pos.netQty)) continue;
    const key = String(pos.tradingSymbol ?? '');
    const info = map[key];
    if (!info || out.has(key)) continue;
    out.set(key, { key, underlying: info.underlying, expiry: info.expiry, strike: info.side === 'FUT' ? 0 : info.strike, side: info.side });
  }
  return [...out.values()].sort((a, b) => a.key.localeCompare(b.key));
}

import { sourceLotCapError, snapToTick } from './kotakOrderRules.ts';
import { kotakUnderlyingOf } from './kotakPositionContracts.ts';

/** One row of debug/zerodha_<underlying>_instruments.json (scripts/tools/zerodha_instruments_cache.py). */
export interface ZerodhaCachedContract { tradingsymbol: string; lot_size?: number; tick_size?: number }
export interface ZerodhaContractInfo { lotSize: number | null; tick: number | null }

/** The contract's lot size and tick, or null when the symbol is not in the cache rows. Pure. */
export function zerodhaContractFromRows(rows: ZerodhaCachedContract[], symbol: string): ZerodhaContractInfo | null {
  const row = rows.find(r => r.tradingsymbol === symbol);
  if (!row) return null;
  return { lotSize: row.lot_size && row.lot_size > 0 ? row.lot_size : null, tick: row.tick_size && row.tick_size > 0 ? row.tick_size : null };
}

/** Underlying root of a Kite option symbol (NIFTY2610624500CE -> NIFTY); the root must be followed by a digit. */
export const zerodhaUnderlyingOf = kotakUnderlyingOf;

/** Why an opening order must be refused under its source's lot cap, or null. Fails closed when the contract is unknown. */
export function zerodhaLotCapError(qty: number, source: string | undefined, symbol: string, contract: ZerodhaContractInfo | null): string | null {
  return sourceLotCapError(qty, source, symbol, contract?.lotSize ?? null, 'Zerodha');
}

/** A LIMIT price on the contract's own tick (0.05 when the cache predates tick_size), as a number for Kite. */
export function zerodhaSnapPrice(price: number, contract: ZerodhaContractInfo | null): number {
  return Number(snapToTick(price, contract?.tick));
}

/** Exchange freeze quantity per underlying, in contract units. Kite's instrument dump carries none, so these are the
 *  conservative figures the Focus Tool already uses (lib/focusToolUnderlyings.ts FALLBACK_FREEZE_UNITS; the Dhan master
 *  listed NIFTY 3511 on 2026-10-18, so 1800 stays under it). An order above the real limit is rejected outright. */
export const ZERODHA_FREEZE_UNITS: Record<string, number> = { NIFTY: 1800, BANKNIFTY: 900, FINNIFTY: 1800, SENSEX: 1000 };

/**
 * `qty` cut into whole-lot orders under the freeze quantity (largest first, remainder last). One order when it already
 * fits, or when the underlying or lot size is unknown (nothing safe to slice by - never guess a lot).
 */
export function zerodhaOrderSlices(qty: number, underlying: string | null, lotSize: number | null): number[] {
  const freeze = underlying ? ZERODHA_FREEZE_UNITS[underlying] : undefined;
  if (!(qty > 0) || !freeze || !(lotSize && lotSize > 0)) return [qty];
  const per = Math.max(1, Math.floor(freeze / lotSize)) * lotSize;
  if (qty <= per) return [qty];
  const out: number[] = [];
  for (let left = qty; left > 0; left -= per) out.push(Math.min(per, left));
  return out;
}

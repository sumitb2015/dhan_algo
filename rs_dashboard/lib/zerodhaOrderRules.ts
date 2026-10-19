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

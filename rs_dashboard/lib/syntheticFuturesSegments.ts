/**
 * Single source of truth for the broker/underlying -> exchange-segment mapping
 * used by the Synthetic Futures scalper (order route + component). Previously
 * duplicated as two independently-maintained ternary chains, which risked one
 * being updated (e.g. a new underlying, a corrected MCX code) without the
 * other. Pure string logic, no I/O, so it's safe to import from both the
 * server route and the client component.
 */

export type SyntheticFuturesBroker = 'dhan' | 'zerodha' | 'kotak';
export type SyntheticFuturesUnderlying = 'NIFTY' | 'SENSEX' | 'BANKNIFTY' | 'CRUDEOIL' | 'CRUDEOILM';

export function isCrudeUnderlying(underlying: string): boolean {
  return underlying === 'CRUDEOIL' || underlying === 'CRUDEOILM';
}

/**
 * Zerodha has no MCX crude contracts (confirmed: /api/options/expiries 400s
 * CRUDEOIL/CRUDEOILM for it) — callers must reject broker 'zerodha' for a
 * crude underlying before relying on this function's output for it.
 */
export function exchangeSegmentFor(broker: SyntheticFuturesBroker, underlying: SyntheticFuturesUnderlying): string {
  if (isCrudeUnderlying(underlying)) {
    return broker === 'kotak' ? 'mcx_fo' : 'MCX_COMM'; // dhan default; zerodha unsupported and blocked upstream
  }
  const isSensex = underlying === 'SENSEX';
  if (broker === 'kotak') return isSensex ? 'bse_fo' : 'nse_fo';
  if (broker === 'zerodha') return isSensex ? 'BFO' : 'NFO';
  return isSensex ? 'BSE_FNO' : 'NSE_FNO';
}

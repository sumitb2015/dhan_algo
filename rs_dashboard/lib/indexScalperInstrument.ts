// Pure instrument definitions and quantity/P&L unit converters for /index-scalper.
// No React, no fetch, no fs. Tested in indexScalperInstrument.test.ts.

import { MCX_LOT_MULTIPLIER } from './positionPnl.ts';

export type Underlying = 'NIFTY' | 'CRUDEOILM';

export interface InstrumentSpec {
  underlying: Underlying;
  displayName: string;
  dhanSegment: 'NSE_FNO' | 'MCX_COMM';
  kotakExchange: 'nse_fo' | 'mcx_fo';
  strikeStep: number;
  futTick: number;
  candleSegment: 'IDX_I' | 'MCX_COMM';
  candleInstrument: 'INDEX' | 'FUTCOM';
  defaultLots: number;
  maxLots: number;
}

export const INSTRUMENTS: Record<Underlying, InstrumentSpec> = {
  NIFTY: {
    underlying: 'NIFTY',
    displayName: 'NIFTY 50',
    dhanSegment: 'NSE_FNO',
    kotakExchange: 'nse_fo',
    strikeStep: 50,
    futTick: 0.05,
    candleSegment: 'IDX_I',
    candleInstrument: 'INDEX',
    defaultLots: 1,
    maxLots: 50,
  },
  CRUDEOILM: {
    underlying: 'CRUDEOILM',
    displayName: 'CRUDEOILM (MCX)',
    dhanSegment: 'MCX_COMM',
    kotakExchange: 'mcx_fo',
    strikeStep: 50,
    futTick: 1.0,
    candleSegment: 'MCX_COMM',
    candleInstrument: 'FUTCOM',
    defaultLots: 1,
    maxLots: 20,
  },
};

/** Dhan order quantity:
 *  - NIFTY: lots * dhanLot (e.g. 1 lot * 65 = 65 units)
 *  - CRUDEOILM: lots (Dhan order quantity for MCX is LOTS, master list LOT_SIZE is 1)
 */
export function dhanOrderQty(underlying: Underlying, lots: number, lotSize: number): number {
  if (lots <= 0) return 0;
  if (underlying === 'CRUDEOILM') return lots;
  return lots * (lotSize > 0 ? lotSize : 65);
}

/** Kotak order quantity:
 *  - NIFTY: lots * 65 units
 *  - CRUDEOILM: lots * 10 barrels (Kotak order quantity for MCX is absolute units)
 */
export function kotakOrderQty(underlying: Underlying, lots: number, lotSize: number): number {
  if (lots <= 0) return 0;
  if (underlying === 'CRUDEOILM') return lots * 10;
  return lots * (lotSize > 0 ? lotSize : 65);
}

/** P&L multiplier (rupees per point per netQty unit):
 *  - Dhan: NIFTY is 1 (netQty in units). CRUDEOILM is 10 (netQty in lots, 10 bbl/lot).
 *  - Kotak: NIFTY is 1 (netQty in units). CRUDEOILM is 1 (netQty in barrels).
 *  - SIM: NIFTY is 1 (netQty in units). CRUDEOILM is 10 if sim qty is in lots, or 1 if barrels.
 *    We standardize SIM paper ledger on display units (NIFTY 65 units, CRUDEOILM 10 barrels, mult 1).
 */
export function pnlMultiplier(underlying: Underlying, broker: string): number {
  if (underlying === 'CRUDEOILM' && broker.toLowerCase() === 'dhan') {
    return MCX_LOT_MULTIPLIER.CRUDEOILM ?? 10;
  }
  return 1;
}

/** Display units per lot for the UI and SIM paper ledger:
 *  - NIFTY: 65 units
 *  - CRUDEOILM: 10 barrels
 */
export function displayLotUnits(underlying: Underlying, lotSize?: number | null): number {
  if (underlying === 'CRUDEOILM') return 10;
  return lotSize && lotSize > 0 ? lotSize : 65;
}

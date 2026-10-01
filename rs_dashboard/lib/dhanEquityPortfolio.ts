import { dhanGet } from './dhanToken';
import { getCachedPositions } from './brokerPositionsCache';
import { findEquityById } from './equityMaster';
import { pendingSellQty } from './equityOrder';

// Read-side Dhan holdings + intraday equity positions, joined per symbol for the order ticket.

export interface EquityPosition {
  product: string; // CNC | INTRADAY | MARGIN ...
  netQty: number;
}

export interface EquityHolding {
  symbol: string;
  securityId: string;
  totalQty: number;
  availableQty: number;
  avgCost: number;
  positions: EquityPosition[]; // today's NSE_EQ positions (net quantity per product)
}

type Row = Record<string, unknown>;
const num = (v: unknown) => Number(v ?? 0) || 0;

/** Dhan answers an empty portfolio with an error body rather than []. */
function isEmptyError(e: unknown): boolean {
  return /no holding|DH-1111|no data/i.test(String(e));
}

/** Always live — use for any decision that gates an order (e.g. a delivery sell). */
export async function fetchHoldingsLive(): Promise<Row[]> {
  try {
    const raw = await dhanGet('/holdings');
    return Array.isArray(raw) ? (raw as Row[]) : [];
  } catch (e) {
    if (isEmptyError(e)) return [];
    throw e;
  }
}

export function sellableQty(rows: Row[], securityId: string): { totalQty: number; availableQty: number; avgCost: number } {
  const r = rows.find((x) => String(x.securityId) === String(securityId));
  if (!r) return { totalQty: 0, availableQty: 0, avgCost: 0 };
  const totalQty = num(r.totalQty);
  // availableQty excludes pledged/collateral shares; fall back to dpQty on older payloads.
  const availableQty = r.availableQty !== undefined ? num(r.availableQty) : num(r.dpQty ?? totalQty);
  return { totalQty, availableQty, avgCost: num(r.avgCostPrice) };
}

/** Always live: today's open long Intraday (MIS) net quantity for one NSE equity security. */
export async function fetchIntradayLongQty(securityId: string): Promise<number> {
  const raw = await dhanGet('/positions');
  const rows = Array.isArray(raw) ? (raw as Row[]) : [];
  return rows
    .filter((p) => String(p.securityId) === String(securityId) && String(p.exchangeSegment) === 'NSE_EQ' && String(p.productType) === 'INTRADAY')
    .reduce((sum, p) => sum + Math.max(0, num(p.netQty)), 0);
}

/** Always live: shares already committed to OPEN sell orders for one NSE equity security + product. */
export async function fetchPendingSellQty(securityId: string, product: 'CNC' | 'INTRADAY'): Promise<number> {
  const raw = await dhanGet('/orders');
  return pendingSellQty(Array.isArray(raw) ? (raw as Row[]) : [], securityId, product);
}

/** Display read: holdings live, positions through the shared 2 s broker cache. */
export async function readEquityPortfolio(): Promise<Record<string, EquityHolding>> {
  const [holdings, positions] = await Promise.all([
    fetchHoldingsLive(),
    getCachedPositions('dhan', async () => {
      const raw = await dhanGet('/positions');
      return Array.isArray(raw) ? (raw as Row[]) : [];
    }),
  ]);

  const out: Record<string, EquityHolding> = {};
  const symbolOf = (r: Row): string => {
    const id = String(r.securityId ?? '');
    return findEquityById(id)?.symbol ?? String(r.tradingSymbol ?? '').replace(/-EQ$/, '').toUpperCase();
  };
  const entry = (r: Row): EquityHolding => {
    const symbol = symbolOf(r);
    return (out[symbol] ??= { symbol, securityId: String(r.securityId ?? ''), totalQty: 0, availableQty: 0, avgCost: 0, positions: [] });
  };

  for (const h of holdings) {
    const e = entry(h);
    const s = sellableQty([h], String(h.securityId));
    e.totalQty = s.totalQty;
    e.availableQty = s.availableQty;
    e.avgCost = s.avgCost;
  }
  for (const p of positions) {
    if (String(p.exchangeSegment) !== 'NSE_EQ') continue;
    const netQty = num(p.netQty);
    if (netQty === 0) continue;
    entry(p).positions.push({ product: String(p.productType ?? ''), netQty });
  }
  return out;
}

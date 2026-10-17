import { kotakGet, kotakRows, KOTAK_PATHS } from '@/lib/kotakToken';
import { shapeKotakPosition, kotakPendingSellQty } from '@/lib/kotakShape';
import { kotakHoldings } from '@/lib/kotakContracts';
import { getCachedPositions } from '@/lib/brokerPositionsCache';
import { findEquity } from '@/lib/equityMaster';
import type { EquityHolding } from '@/lib/dhanEquityPortfolio';

// The Kotak twin of lib/dhanEquityPortfolio.ts, in the same shapes, for the equity order ticket and the Held column.
// Every function here that gates a SELL reads live and throws when it cannot read: the caller then sells nothing.

const plain = (tradingSymbol: string) => tradingSymbol.trim().toUpperCase().replace(/-(EQ|BE|BZ|BL|SM|ST)$/, '');

/** Always live: what can be sold from Kotak holdings now (sellable, i.e. not pledged / blocked). */
export async function kotakSellable(symbol: string): Promise<{ totalQty: number; availableQty: number; avgCost: number }> {
  const h = (await kotakHoldings()).find((x) => x.symbol === symbol.toUpperCase());
  return h ? { totalQty: h.qty, availableQty: h.sellableQty, avgCost: h.avgPrice } : { totalQty: 0, availableQty: 0, avgCost: 0 };
}

/** Always live: today's open long intraday (MIS) quantity on one NSE cash symbol. */
export async function kotakIntradayLongQty(symbol: string): Promise<number> {
  const rows = kotakRows(await kotakGet(KOTAK_PATHS.positions)).map(shapeKotakPosition);
  return rows
    .filter((p) => plain(p.tradingSymbol) === symbol.toUpperCase() && /_cm$/i.test(p.exchange) && p.productType.toUpperCase() === 'MIS')
    .reduce((s, p) => s + Math.max(0, p.netQty), 0);
}

/** Always live: shares already committed to open Kotak sell orders on that contract + product. */
export async function kotakOpenSellQty(kotakTradingSymbol: string, product: 'CNC' | 'INTRADAY'): Promise<number> {
  return kotakPendingSellQty(kotakRows(await kotakGet(KOTAK_PATHS.orderBook)), kotakTradingSymbol, product);
}

/** Display read: Kotak holdings live, positions through the shared broker cache. Keyed by plain NSE symbol. */
export async function readKotakEquityPortfolio(): Promise<Record<string, EquityHolding>> {
  const [holdings, positionsRaw] = await Promise.all([
    kotakHoldings(),
    getCachedPositions('kotak', () => kotakGet(KOTAK_PATHS.positions)),
  ]);
  const out: Record<string, EquityHolding> = {};
  const entry = (symbol: string): EquityHolding =>
    (out[symbol] ??= { symbol, securityId: findEquity(symbol)?.securityId ?? '', totalQty: 0, availableQty: 0, avgCost: 0, positions: [] });
  for (const h of holdings) {
    const e = entry(h.symbol);
    e.totalQty = h.qty;
    e.availableQty = h.sellableQty;
    e.avgCost = h.avgPrice;
  }
  for (const p of kotakRows(positionsRaw as Record<string, unknown>).map(shapeKotakPosition)) {
    if (!/_cm$/i.test(p.exchange) || p.netQty === 0) continue;
    // Same product words as the Dhan read (CNC / INTRADAY), so the ticket shows one vocabulary.
    const prod = p.productType.toUpperCase() === 'MIS' ? 'INTRADAY' : p.productType.toUpperCase();
    entry(plain(p.tradingSymbol)).positions.push({ product: prod, netQty: p.netQty });
  }
  return out;
}

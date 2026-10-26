// Estimated charges on a day's executed orders, for the Price Ladder's "Net P&L" chip (account P&L minus these).
// Pure. An ESTIMATE from published rate tables, not the broker's contract note: brokerage is per executed ORDER (fills of one
// order share one charge), the statutory rates below are the repo's own table (lib/algoLab/costs.ts for NSE options) plus
// the usual MCX / futures rates. Unconfirmed against a contract note (2026-10-26): STT / CTT / exchange rates may have been
// revised, and Dhan's "Rs 20 or 0.03%, whichever is lower" is applied as a flat Rs 20 as the user asked.

export type ChargeBroker = 'dhan' | 'kotak' | 'zerodha';

/** Brokerage per executed order (Rs): Dhan 20, Kotak 0 (as stated by the user); Zerodha's F&O flat 20. */
export const BROKERAGE_PER_ORDER: Record<ChargeBroker, number> = { dhan: 20, kotak: 0, zerodha: 20 };

/** A trade-book row in the dashboard's shaped form (Dhan's field names; Kotak / Zerodha rows are shaped to it). */
export interface TradeRow {
  tradingSymbol?: unknown; transactionType?: unknown; tradedQuantity?: unknown; tradedPrice?: unknown;
  exchangeSegment?: unknown; orderId?: unknown; createTime?: unknown;
}

interface Rates { exchangePct: number; sellTaxPct: number; stampBuyPct: number }
const RATES = {
  nseOption: { exchangePct: 0.05, sellTaxPct: 0.1, stampBuyPct: 0.003 },
  nseFuture: { exchangePct: 0.00173, sellTaxPct: 0.02, stampBuyPct: 0.002 },
  mcxOption: { exchangePct: 0.0418, sellTaxPct: 0.05, stampBuyPct: 0.003 },
  mcxFuture: { exchangePct: 0.0021, sellTaxPct: 0.01, stampBuyPct: 0.002 },
} as const satisfies Record<string, Rates>;
const SEBI_PER_CRORE = 10;
const GST_PCT = 18;

const MCX_BBL_PER_LOT: Record<string, number> = { CRUDEOILM: 10, CRUDEOIL: 100 };
const MCX_ROOT = /^(CRUDEOILM|CRUDEOIL|NATURALGAS|GOLD|SILVER|COPPER|ZINC|LEAD|NICKEL|ALUMINIUM)/i;

/** The contract's underlying root, from a Dhan (`CRUDEOILM-17Nov2026-9000-PE`) or compact (`CRUDEOILM17NOV269000CE`) symbol. */
function rootOf(symbol: string): string {
  const m = MCX_ROOT.exec(symbol.trim());
  return m ? m[1].toUpperCase() : symbol.split('-')[0].toUpperCase();
}
const isOptionSymbol = (s: string) => /(?:-|\d)(CE|PE)$/i.test(s.trim());

export interface ChargeBreakdown { brokerage: number; stt: number; exchange: number; gst: number; stamp: number; sebi: number }
export interface ChargesResult { total: number; orders: number; breakdown: ChargeBreakdown }

/**
 * Charges on `rows`. `mcxQtyInLots`: Dhan and Zerodha report MCX quantity in lots (turnover = lots x barrels per lot x price),
 * Kotak in barrels already. Rows with a non-positive quantity or price are skipped. Fills of one order (same `orderId`, else
 * same symbol + side + time) are one order: one brokerage, and its turnover is the sum of its fills.
 */
export function computeCharges(rows: readonly TradeRow[], broker: ChargeBroker, mcxQtyInLots: boolean): ChargesResult {
  const orders = new Map<string, { side: 'BUY' | 'SELL'; turnover: number; mcx: boolean; option: boolean }>();
  for (const r of rows) {
    const symbol = String(r.tradingSymbol ?? '');
    const side = String(r.transactionType ?? '').toUpperCase().startsWith('S') ? 'SELL' : 'BUY';
    const qty = Number(r.tradedQuantity), price = Number(r.tradedPrice);
    if (!symbol || !(qty > 0) || !(price > 0)) continue;
    const mcx = String(r.exchangeSegment ?? '') === 'MCX_COMM' || MCX_ROOT.test(symbol.trim());
    const mult = mcx && mcxQtyInLots ? (MCX_BBL_PER_LOT[rootOf(symbol)] ?? 1) : 1;
    const key = r.orderId != null && String(r.orderId) !== '' ? String(r.orderId) : `${symbol}|${side}|${String(r.createTime ?? '')}`;
    const o = orders.get(key) ?? { side, turnover: 0, mcx, option: isOptionSymbol(symbol) };
    o.turnover += qty * price * mult;
    orders.set(key, o);
  }
  const b: ChargeBreakdown = { brokerage: 0, stt: 0, exchange: 0, gst: 0, stamp: 0, sebi: 0 };
  for (const o of orders.values()) {
    const rates = RATES[`${o.mcx ? 'mcx' : 'nse'}${o.option ? 'Option' : 'Future'}` as keyof typeof RATES];
    const brokerage = BROKERAGE_PER_ORDER[broker];
    const exchange = (o.turnover * rates.exchangePct) / 100;
    const sebi = (o.turnover * SEBI_PER_CRORE) / 1e7;
    b.brokerage += brokerage; b.exchange += exchange; b.sebi += sebi;
    b.gst += ((brokerage + exchange + sebi) * GST_PCT) / 100;
    if (o.side === 'SELL') b.stt += (o.turnover * rates.sellTaxPct) / 100; else b.stamp += (o.turnover * rates.stampBuyPct) / 100;
  }
  const total = b.brokerage + b.stt + b.exchange + b.gst + b.stamp + b.sebi;
  return { total: Math.round(total * 100) / 100, orders: orders.size, breakdown: Object.fromEntries(Object.entries(b).map(([k, v]) => [k, Math.round(v * 100) / 100])) as unknown as ChargeBreakdown };
}

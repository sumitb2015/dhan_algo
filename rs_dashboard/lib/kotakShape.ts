import type { ScalperPosition, ScalperOrder, ScalperTrade } from './zerodhaShape';

// Kotak Neo -> the Dhan-shaped scalper interfaces, mirroring lib/zerodhaShape.ts.
//
// Kotak's position payload is the awkward one: it reports day (`fl*`) and
// carry-forward (`cf*`) legs separately and NEVER a net quantity, so net has to
// be computed. Getting it wrong makes an open position render as flat.

/* eslint-disable @typescript-eslint/no-explicit-any */

function num(row: Record<string, any>, ...keys: string[]): number {
  let total = 0;
  for (const key of keys) {
    const v = Number(row[key]);
    if (Number.isFinite(v)) total += v;
  }
  return total;
}

function first(row: Record<string, any>, ...keys: string[]): number {
  for (const key of keys) {
    const v = Number(row[key]);
    if (Number.isFinite(v) && v !== 0) return v;
  }
  return 0;
}

export function shapeKotakPosition(p: Record<string, any>): ScalperPosition {
  // No net-qty field exists — sum the four legs. Carry-forward first so an
  // overnight position that traded again today still nets correctly.
  const buyQty = num(p, 'cfBuyQty', 'flBuyQty');
  const sellQty = num(p, 'cfSellQty', 'flSellQty');
  const netQty = buyQty - sellQty;

  const buyAmt = num(p, 'cfBuyAmt', 'buyAmt');
  const sellAmt = num(p, 'cfSellAmt', 'sellAmt');
  const buyAvg = buyQty ? buyAmt / buyQty : 0;
  const sellAvg = sellQty ? sellAmt / sellQty : 0;
  const lastPrice = first(p, 'ltp', 'stkPrc', 'lastPrice');

  // Same split rule as the Zerodha shaper: the open quantity's mark-to-market is
  // unrealized, everything else is realized. Summing broker-reported realized
  // and unrealized instead would double-count a closed intraday position.
  const totalPnl = sellAmt - buyAmt + netQty * lastPrice;
  const unrealized = netQty === 0 ? 0 : netQty * (lastPrice - (netQty > 0 ? buyAvg : sellAvg));

  return {
    tradingSymbol: String(p.trdSym ?? p.sym ?? ''),
    securityId: String(p.tok ?? ''),
    exchange: String(p.exSeg ?? 'nse_fo'),
    netQty,
    buyQty,
    sellQty,
    buyAvg,
    sellAvg,
    lastTradedPrice: lastPrice,
    realizedProfit: totalPnl - unrealized,
    unrealizedProfit: unrealized,
    productType: String(p.prod ?? p.prd ?? ''),
  };
}

/** Kotak's single-letter transaction type -> the BUY/SELL the UI expects. */
function txnType(raw: any): string {
  const t = String(raw ?? '').trim().toUpperCase();
  if (t === 'B' || t === 'BUY') return 'BUY';
  if (t === 'S' || t === 'SELL') return 'SELL';
  return t;
}

export function shapeKotakOrder(o: Record<string, any>): ScalperOrder {
  const priceType = String(o.prcTp ?? '').toUpperCase();
  return {
    tradingSymbol: String(o.trdSym ?? ''),
    orderStatus: String(o.ordSt ?? '').toUpperCase(),
    transactionType: txnType(o.trnsTp),
    quantity: Number(o.qty) || 0,
    price: Number(o.prc) || 0,
    orderType: priceType === 'MKT' ? 'MARKET' : priceType === 'L' ? 'LIMIT' : priceType,
    createTime: String(o.ordTm ?? ''),
  };
}

export function shapeKotakTrade(t: Record<string, any>): ScalperTrade {
  return {
    tradingSymbol: String(t.trdSym ?? ''),
    transactionType: txnType(t.trnsTp),
    tradedQuantity: Number(t.fldQty ?? t.qty) || 0,
    tradedPrice: Number(t.avgPrc ?? t.prc) || 0,
    createTime: String(t.flTm ?? ''),
  };
}

/**
 * Funds/limits, shaped like the Dhan funds payload the scalper's FundsView reads.
 *
 * `Net` is NOT cash. Kotak reports `Net = Collateral + CollateralValue + cash`,
 * and on a collateral-only account the whole balance is pledged-holdings value
 * after haircut — measured on a real account: Net 9,54,701.99 = Collateral
 * 9,25,581.66 + CollateralValue 29,120.33, cash 0.00, backed by ~10.3L of
 * equity holdings.
 *
 * Both collateral fields must be ADDED. Subtracting only `Collateral` reported
 * Rs 29,120 of cash on an account holding none.
 *
 * `availableBalance` stays as `Net` because that is the margin an option WRITE
 * is checked against (and it matches how the Zerodha route reports equity.net),
 * but `cashBalance` is surfaced alongside it so a collateral-only account is
 * visibly distinct from a funded one.
 */
export function shapeKotakFunds(res: Record<string, any>) {
  const net = Number(res.Net ?? res.net) || 0;
  const collateral = (Number(res.Collateral ?? 0) || 0) + (Number(res.CollateralValue ?? 0) || 0);
  const cash = Math.max(0, net - collateral);
  return {
    availableBalance: net,
    // Real money: what option premium on a BUY can be paid from. Collateral
    // cannot pay premium, so this is the ceiling on buying.
    cashBalance: cash,
    withdrawableBalance: cash,
    utilizedAmount: Number(res.MarginUsed ?? res.marginUsed) || 0,
    collateralAmount: collateral,
  };
}

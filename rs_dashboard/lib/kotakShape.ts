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
  const cfBuyQty = num(p, 'cfBuyQty');
  const cfSellQty = num(p, 'cfSellQty');
  const cfBuyAmt = num(p, 'cfBuyAmt');
  const cfSellAmt = num(p, 'cfSellAmt');

  const buyQty = num(p, 'cfBuyQty', 'flBuyQty');
  const sellQty = num(p, 'cfSellQty', 'flSellQty');
  const netQty = buyQty - sellQty;

  const buyAmt = num(p, 'cfBuyAmt', 'buyAmt');
  const sellAmt = num(p, 'cfSellAmt', 'sellAmt');
  const buyAvg = buyQty ? buyAmt / buyQty : 0;
  const sellAvg = sellQty ? sellAmt / sellQty : 0;

  // Kotak's positions payload carries NO last-traded price at all. `stkPrc` is
  // the option's STRIKE — reading it as an LTP marks a 4.40 option at 24300 and
  // reports lakhs of phantom P&L, which the target/SL guards would then act on.
  // 0 means "unknown": the UI joins live quotes onto the row by trading symbol.
  const lastPrice = first(p, 'ltp', 'lastPrice');

  // Realized is the matched (round-tripped) quantity only; the open quantity's
  // mark-to-market is unrealized. Deriving realized as total-minus-unrealized
  // instead would fold the whole open leg into realized whenever LTP is unknown.
  const matchedQty = Math.min(buyQty, sellQty);
  const realized = matchedQty * (sellAvg - buyAvg);
  const unrealized = netQty === 0 || lastPrice <= 0
    ? 0
    : netQty * (lastPrice - (netQty > 0 ? buyAvg : sellAvg));

  const base: ScalperPosition = {
    tradingSymbol: String(p.trdSym ?? p.sym ?? ''),
    securityId: String(p.tok ?? ''),
    exchange: String(p.exSeg ?? 'nse_fo'),
    netQty,
    buyQty,
    sellQty,
    buyAvg,
    sellAvg,
    lastTradedPrice: lastPrice,
    realizedProfit: realized,
    unrealizedProfit: unrealized,
    productType: String(p.prod ?? p.prd ?? ''),
  };
  if (cfBuyQty > 0 || cfSellQty > 0) {
    base.cfBuyQty = cfBuyQty;
    base.cfSellQty = cfSellQty;
    base.cfBuyAmt = cfBuyAmt;
    base.cfSellAmt = cfSellAmt;
    base.carryForwardBuyQty = cfBuyQty;
    base.carryForwardSellQty = cfSellQty;
    base.carryForwardBuyValue = cfBuyAmt;
    base.carryForwardSellValue = cfSellAmt;
  }
  return base;
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
    tradingSymbol: String(o.trdSym ?? o.sym ?? ''),
    orderStatus: String(o.ordSt ?? o.st ?? '').toUpperCase(),
    transactionType: txnType(o.trnsTp),
    quantity: Number(o.qty ?? o.ordQty) || 0,
    price: Number(o.prc ?? o.ordPrc) || 0,
    orderType: priceType === 'MKT' ? 'MARKET' : priceType === 'L' ? 'LIMIT' : priceType,
    createTime: String(o.ordEntTm ?? o.ordDtTm ?? o.ordTm ?? o.exCfmTm ?? o.orderDateTime ?? o.orderTimestamp ?? o.createTime ?? ''),
  };
}

export function shapeKotakTrade(t: Record<string, any>): ScalperTrade {
  return {
    tradingSymbol: String(t.trdSym ?? t.sym ?? ''),
    transactionType: txnType(t.trnsTp),
    tradedQuantity: Number(t.fldQty ?? t.qty) || 0,
    tradedPrice: Number(t.avgPrc ?? t.prc) || 0,
    createTime: String(t.flTm ?? t.exTm ?? t.trdTm ?? t.ordEntTm ?? t.ordDtTm ?? t.createTime ?? ''),
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

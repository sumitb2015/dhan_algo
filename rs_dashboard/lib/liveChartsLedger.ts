// Ownership ledger for orders placed from the Live Options Charts trading desk
// (OptionOrderModal + LiveTradingDesk). Dhan nets positions by security ID, so the
// broker's own position book can never answer "did MY basket open this, or is it
// someone else's leg / another running strategy on the same strike" — see the
// dhan-terminal-position-ownership skill. This ledger is the source of truth for
// what this page's own baskets opened; the broker position book is only ever
// consulted to shrink it (clamp down), never to originate or grow it.

export type LedgerOptionType = 'CE' | 'PE';
/** The account a basket was placed on. Missing = Dhan (every basket before Kotak support). */
export type LedgerBroker = 'dhan' | 'kotak';
export type LedgerAction = 'BUY' | 'SELL';
export type LedgerProductType = 'INTRADAY' | 'MARGIN';

export interface LedgerLeg {
  securityId: string;
  exchangeSegment: string;
  tradingSymbol?: string;
  strike: number;
  optionType: LedgerOptionType;
  action: LedgerAction;
  productType: LedgerProductType;
  /** Quantity (in underlying units, already lot-size multiplied) this basket itself opened,
   *  minus whatever it has since exited. Never adjusted upward from a broker read. */
  qty: number;
  /** THIS leg's own entry order(s) — one per leg since 2026-10-01 (it used to
   *  hold every order of the basket, so no leg knew its own fills). */
  entryOrderIds: string[];
  exitOrderIds: string[];
  /** Average fill price of this leg's own entry orders, from the trade book
   *  (stampOwnEntries). The broker's buyAvg/sellAvg is pooled across every
   *  basket and trade on the contract, so it is only a fallback. */
  entryPrice?: number;
  /** Timestamp of the most recent order placed against this leg (entry or exit). Used to
   *  hold off reconciliation for a grace window after each order - see reconcileBasket. */
  lastOrderAt: number;
}

/** A freshly-placed (or freshly-exited) leg can still read as flat in the broker's position
 *  book for a short window - order ack races the position-book write (same shape as
 *  dhan-terminal-position-ownership's Invariant 2/6 grace window for FocusTool/MultiLegFocus).
 *  Reconciling immediately would read that as "closed" and zero out a genuinely live leg,
 *  which can never be undone since the ledger only ever clamps down. */
export const RECONCILE_GRACE_MS = 15_000;

export interface LedgerBasket {
  id: string;
  /** Where this basket's orders went; its exits, reconcile and P&L read that broker's book only. */
  broker?: LedgerBroker;
  title: string;
  underlying: string;
  expiry: string;
  createdAt: number;
  legs: LedgerLeg[];
}

/** A broker /positions row, typed loosely since Dhan's payload is passed straight through. */
export type BrokerPositionRow = Record<string, unknown>;

export const basketBroker = (b: Pick<LedgerBasket, 'broker'>): LedgerBroker => b.broker ?? 'dhan';

/** A contract's identifier on a broker: Dhan's numeric securityId, Kotak's trading symbol (Kotak's own
 *  `securityId` field is its instrument token, unrelated to Dhan's). */
export function legIdent(leg: Pick<LedgerLeg, 'securityId' | 'tradingSymbol'>, broker: LedgerBroker = 'dhan'): string {
  return String((broker === 'kotak' ? leg.tradingSymbol : leg.securityId) ?? '');
}
export function rowIdent(row: BrokerPositionRow, broker: LedgerBroker = 'dhan'): string {
  return String((broker === 'kotak' ? row.tradingSymbol ?? row.trading_symbol : row.securityId ?? row.security_id) ?? '');
}
/** One product vocabulary: Kotak / Zerodha report MIS / NRML for Dhan's INTRADAY / MARGIN. */
export function normProduct(p: unknown): string {
  const u = String(p ?? '').trim().toUpperCase();
  return u === 'MIS' ? 'INTRADAY' : u === 'NRML' ? 'MARGIN' : u;
}

/** Find the live broker position row for a ledger leg by contract identifier + product (Dhan's numeric
 *  securityId or Kotak's trading symbol — see legIdent). */
export function findBrokerRow(rows: BrokerPositionRow[], leg: LedgerLeg, broker: LedgerBroker = 'dhan'): BrokerPositionRow | null {
  const ident = legIdent(leg, broker);
  if (!ident) return null;
  const product = normProduct(leg.productType);
  return rows.find((r) => rowIdent(r, broker) === ident && normProduct(r.productType ?? r.product) === product) ?? null;
}

/** How much of this leg is still live at the broker, clamped DOWN to what the broker actually
 *  shows (never trusted upward - see dhan-terminal-position-ownership Invariant 6). A missing
 *  broker row (position fully closed, or broker read failed) reads as 0 remaining, not "unknown
 *  keep the full ledger qty" - the exit button must never offer to close more than the broker
 *  can actually confirm holding right now. */
export function liveLegQty(row: BrokerPositionRow | null, leg: LedgerLeg): number {
  if (!row) return 0;
  const netQty = Number(row.netQty ?? row.net_qty ?? 0);
  if (!Number.isFinite(netQty) || netQty === 0) return 0;

  // A SELL-entry leg is short (negative netQty at the broker); a BUY-entry leg is long
  // (positive netQty). Direction mismatch means the broker's book at this security+product
  // has since flipped sides (someone else closed and reversed it) - nothing of THIS leg
  // survives that.
  const brokerIsShort = netQty < 0;
  const legIsShort = leg.action === 'SELL';
  if (brokerIsShort !== legIsShort) return 0;

  return Math.min(leg.qty, Math.abs(netQty));
}

/** This leg's entry price: its own fills (`entryPrice`) when the trade book has
 *  them, else the broker's buyAvg (BUY-entry) / sellAvg (SELL-entry) — pooled
 *  across everything on the contract, so only a fallback (see legEntryIsOwn). */
export function legEntryPrice(row: BrokerPositionRow | null, leg: LedgerLeg): number {
  if (leg.entryPrice != null && leg.entryPrice > 0) return leg.entryPrice;
  if (!row) return 0;
  const isBuy = leg.action === 'BUY';
  const avg = Number(isBuy ? (row.buyAvg ?? row.buy_avg) : (row.sellAvg ?? row.sell_avg));
  return Number.isFinite(avg) ? avg : 0;
}

/** This leg's proportional share of the broker's reported unrealized P&L for that security+
 *  product, scaled by how much of the broker's own net quantity this ledger leg still owns.
 *  Proportional scaling (rather than recomputing from LTP/avg price) keeps sign and MCX
 *  multiplier handling identical to whatever the broker already applied - the caller is
 *  expected to have run the row through scaleBrokerPnl() first for MCX rows. */
export function legUnrealizedPnl(row: BrokerPositionRow | null, ownQty: number): number {
  if (!row || ownQty <= 0) return 0;
  const netQty = Number(row.netQty ?? row.net_qty ?? 0);
  const unrealized = Number(row.unrealizedProfit ?? row.unrealized_profit ?? 0);
  if (!Number.isFinite(netQty) || netQty === 0 || !Number.isFinite(unrealized)) return 0;
  return unrealized * (ownQty / Math.abs(netQty));
}

/** Reconcile a basket's own ledger legs against a freshly-fetched positions payload,
 *  clamping every leg's qty down to what the broker still shows (never up). Legs already
 *  at 0 stay at 0. A leg within RECONCILE_GRACE_MS of its last order is left untouched -
 *  the broker's book may not have caught up yet, and reading that as "closed" would be
 *  unrecoverable (down-only). Pure function - callers own persisting the result into state. */
export function reconcileBasket(
  basket: LedgerBasket, rows: BrokerPositionRow[], now: number = Date.now(),
  /** Whose book `rows` is. Another broker's book says nothing about this basket: it is left as it is. */
  rowsBroker: LedgerBroker = 'dhan',
): LedgerBasket {
  if (basketBroker(basket) !== rowsBroker) return basket;
  return {
    ...basket,
    legs: basket.legs.map((leg) => {
      if (leg.qty <= 0) return leg;
      if (now - leg.lastOrderAt < RECONCILE_GRACE_MS) return leg;
      const row = findBrokerRow(rows, leg, rowsBroker);
      const live = liveLegQty(row, leg);
      return live < leg.qty ? { ...leg, qty: live } : leg;
    }),
  };
}

export function basketIsFlat(basket: LedgerBasket): boolean {
  return basket.legs.every((l) => l.qty <= 0);
}

/** True when legEntryPrice is this leg's own fill price, not the contract average. */
export function legEntryIsOwn(leg: LedgerLeg): boolean {
  return leg.entryPrice != null && leg.entryPrice > 0;
}

/** Trade-book row fields used to price a leg's own entry. */
export interface LedgerTrade { orderId: string; securityId: string; tradingSymbol?: string; tradedQuantity: number; tradedPrice: number }

/** Average fill of this leg's own entry orders, or null when none are in the
 *  trade book yet. Matched on the contract as well as the order id: legs from
 *  before 2026-10-01 (or an unmapped one) hold every order id of their basket,
 *  and a CE at 100 and a PE at 80 would otherwise both read 90. */
export function ownEntryFromTrades(leg: LedgerLeg, trades: LedgerTrade[], broker: LedgerBroker = 'dhan'): number | null {
  const ids = new Set(leg.entryOrderIds);
  const ident = legIdent(leg, broker);
  let qty = 0;
  let value = 0;
  for (const t of trades) {
    if (!ids.has(t.orderId) || legIdent(t, broker) !== ident) continue;
    if (!(t.tradedQuantity > 0) || !(t.tradedPrice > 0)) continue;
    qty += t.tradedQuantity;
    value += t.tradedQuantity * t.tradedPrice;
  }
  return qty > 0 ? value / qty : null;
}

/** Stamps each leg's own entry price from the trade book of `tradesBroker` (other brokers' baskets are left alone).
 *  Returns `baskets` itself when nothing changed. */
export function stampOwnEntries(baskets: LedgerBasket[], trades: LedgerTrade[], tradesBroker: LedgerBroker = 'dhan'): LedgerBasket[] {
  let changed = false;
  const next = baskets.map((b) => {
    if (basketBroker(b) !== tradesBroker) return b;
    let bChanged = false;
    const legs = b.legs.map((leg) => {
      const px = ownEntryFromTrades(leg, trades, tradesBroker);
      if (px == null || px === leg.entryPrice) return leg;
      bChanged = true;
      return { ...leg, entryPrice: px };
    });
    if (!bChanged) return b;
    changed = true;
    return { ...b, legs };
  });
  return changed ? next : baskets;
}

/** Key of a ledger leg: `${basketId}:${index in basket.legs}`. */
export function ledgerLegKey(basketId: string, legIdx: number): string {
  return `${basketId}:${legIdx}`;
}

/**
 * How much of the broker's position each ledger leg still owns, sharing one
 * contract's (security + product) position out across every basket holding it,
 * oldest basket first. liveLegQty clamps each leg against the WHOLE position
 * on its own, so two baskets on one contract both claimed it and the desk
 * counted its P&L twice (2026-10-01 audit). Keyed by ledgerLegKey.
 */
export function allocateLiveQty(baskets: LedgerBasket[], rows: BrokerPositionRow[], rowsBroker: LedgerBroker = 'dhan'): Map<string, number> {
  const out = new Map<string, number>();
  const remaining = new Map<string, number>();
  const ordered = [...baskets].sort((a, b) => a.createdAt - b.createdAt);
  for (const b of ordered) {
    // A basket on another broker owns nothing in this book.
    const own = basketBroker(b) === rowsBroker;
    b.legs.forEach((leg, i) => {
      const key = ledgerLegKey(b.id, i);
      if (leg.qty <= 0 || !own) { out.set(key, 0); return; }
      const row = findBrokerRow(rows, leg, rowsBroker);
      const contract = `${legIdent(leg, rowsBroker)}|${normProduct(leg.productType)}|${leg.action}`;
      const pool = remaining.has(contract) ? remaining.get(contract)! : liveLegQty(row, { ...leg, qty: Number.MAX_SAFE_INTEGER });
      const take = Math.min(leg.qty, pool);
      remaining.set(contract, pool - take);
      out.set(key, take);
    });
  }
  return out;
}

/**
 * Kotak position rows priced from Dhan's option chain. Kotak's positions payload carries no usable price, so
 * shapeKotakPosition reports unrealizedProfit 0 — read as-is, every Kotak leg showed ₹0 P&L. A row whose contract is
 * known (drv fields from lib/kotakPositionContracts.ts:withKotakContracts) and whose chain quote is in gets
 * `lastTradedPrice` and `unrealizedProfit = (ltp − the row's own-side average) × netQty`; any other open row is marked
 * `pnlUnknown` so the desk shows "—", never a fabricated zero. An estimate: the chain is a cached snapshot.
 */
export function priceRowsFromChain(
  rows: BrokerPositionRow[],
  ltpOf: (underlying: string, expiry: string, strike: number, opt: 'CE' | 'PE') => number | null,
  underlyingOf: (tradingSymbol: string) => string | null,
): BrokerPositionRow[] {
  return rows.map((row) => {
    const netQty = Number(row.netQty ?? 0);
    if (!Number.isFinite(netQty) || netQty === 0) return row;
    const opt = row.drvOptionType === 'CALL' ? 'CE' : row.drvOptionType === 'PUT' ? 'PE' : null;
    const strike = Number(row.drvStrikePrice);
    const expiry = String(row.drvExpiryDate ?? '');
    const underlying = underlyingOf(String(row.tradingSymbol ?? ''));
    const ltp = opt && strike > 0 && expiry && underlying ? ltpOf(underlying, expiry, strike, opt) : null;
    const avg = Number(netQty < 0 ? row.sellAvg : row.buyAvg) || 0;
    if (!(ltp != null && ltp > 0) || !(avg > 0)) return { ...row, pnlUnknown: true };
    return { ...row, lastTradedPrice: ltp, unrealizedProfit: (ltp - avg) * netQty, pnlEstimated: true };
  });
}

/** True when this row's P&L could not be priced (see priceRowsFromChain). */
export const rowPnlUnknown = (row: BrokerPositionRow | null): boolean => row?.pnlUnknown === true;

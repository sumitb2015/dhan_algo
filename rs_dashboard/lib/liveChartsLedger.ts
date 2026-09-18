// Ownership ledger for orders placed from the Live Options Charts trading desk
// (OptionOrderModal + LiveTradingDesk). Dhan nets positions by security ID, so the
// broker's own position book can never answer "did MY basket open this, or is it
// someone else's leg / another running strategy on the same strike" — see the
// dhan-terminal-position-ownership skill. This ledger is the source of truth for
// what this page's own baskets opened; the broker position book is only ever
// consulted to shrink it (clamp down), never to originate or grow it.

export type LedgerOptionType = 'CE' | 'PE';
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
  entryOrderIds: string[];
  exitOrderIds: string[];
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
  title: string;
  underlying: string;
  expiry: string;
  createdAt: number;
  legs: LedgerLeg[];
}

/** A broker /positions row, typed loosely since Dhan's payload is passed straight through. */
export type BrokerPositionRow = Record<string, unknown>;

/** Find the live broker position row for a ledger leg by securityId + product (Dhan's numeric
 *  securityId is a stable per-contract identifier - no symbol-matching ambiguity here, unlike
 *  Zerodha/Kotak). */
export function findBrokerRow(rows: BrokerPositionRow[], leg: LedgerLeg): BrokerPositionRow | null {
  const productUpper = leg.productType.toUpperCase();
  return (
    rows.find((r) => {
      const secId = String(r.securityId ?? r.security_id ?? '');
      if (secId !== String(leg.securityId)) return false;
      const product = String(r.productType ?? r.product ?? '').trim().toUpperCase();
      return product === productUpper;
    }) ?? null
  );
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

/** This leg's entry price - the broker's buyAvg for a BUY-entry leg, sellAvg for a SELL-entry
 *  leg. Read directly off the row rather than scaled by ownQty (unlike P&L, an average price
 *  isn't diluted by how much of the broker's net qty this ledger leg still owns). */
export function legEntryPrice(row: BrokerPositionRow | null, leg: LedgerLeg): number {
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
export function reconcileBasket(basket: LedgerBasket, rows: BrokerPositionRow[], now: number = Date.now()): LedgerBasket {
  return {
    ...basket,
    legs: basket.legs.map((leg) => {
      if (leg.qty <= 0) return leg;
      if (now - leg.lastOrderAt < RECONCILE_GRACE_MS) return leg;
      const row = findBrokerRow(rows, leg);
      const live = liveLegQty(row, leg);
      return live < leg.qty ? { ...leg, qty: live } : leg;
    }),
  };
}

export function basketIsFlat(basket: LedgerBasket): boolean {
  return basket.legs.every((l) => l.qty <= 0);
}

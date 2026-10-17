// Software equivalents of two Dhan server-side protections, for brokers that have no such API (Kotak):
//  - the account P&L Guard (Dhan POST /pnlExit: exit everything when day P&L reaches a target or a loss), and
//  - the bracket (Dhan Super Order: a target and stop-loss that rest at the broker with the entry).
// They run in the open browser tab, like every other Kotak/Zerodha stop in this app (see CLAUDE.md, Strategy Broker
// Selector). Pure functions only: the terminal owns the state, the timers and the orders.

export type GuardProduct = 'INTRADAY' | 'MARGIN' | 'CNC' | '';

/** A broker product name onto the three chips the P&L Guard offers (Dhan INTRADAY/MARGIN/CNC, Kite+Neo MIS/NRML/CNC). */
export function guardProductOf(raw: unknown): GuardProduct {
  const p = String(raw ?? '').trim().toUpperCase();
  if (p === 'INTRADAY' || p === 'MIS') return 'INTRADAY';
  if (p === 'MARGIN' || p === 'NRML') return 'MARGIN';
  if (p === 'CNC' || p === 'DELIVERY') return 'CNC';
  return '';
}

export interface SoftPnlGuard {
  /** Exit when P&L reaches this (rupees, > 0), or 0 for none. */
  profit: number;
  /** Exit when P&L falls to minus this (rupees, a positive magnitude), or 0 for none. */
  loss: number;
  /** Products in scope (INTRADAY / MARGIN / CNC). */
  products: string[];
  /** IST calendar day it was set; a guard from an earlier day is discarded, never fired. */
  date: string;
}

export type SoftPnlVerdict = { fire: false } | { fire: true; reason: string };

/**
 * Whether the guard fires at this P&L. `pnl` must be the realised + unrealised day P&L of the in-scope products only.
 * Never fires on a stale guard, or without a configured level; a level of 0 is "not set". With `allPriced` false only the
 * loss limit can fire (see below).
 */
export function evaluateSoftPnlGuard(
  guard: SoftPnlGuard | null, pnl: number, today: string,
  /** False when some in-scope open leg has no live price: its P&L is counted as 0, so the sum is only a partial figure. */
  allPriced = true,
): SoftPnlVerdict {
  if (!guard || guard.date !== today || !Number.isFinite(pnl)) return { fire: false };
  // A partial sum may only act on the side where acting early is the safe error. A loss limit can fire (an unpriced
  // hedge could be hiding part of it, but missing a stop is worse than a premature exit); a profit target cannot, because
  // an unpriced short in loss would make a false profit.
  if (allPriced && guard.profit > 0 && pnl >= guard.profit) {
    return { fire: true, reason: `P&L Guard target ₹${guard.profit} reached (P&L ${pnl.toFixed(0)})` };
  }
  if (guard.loss > 0 && pnl <= -guard.loss) {
    return { fire: true, reason: `P&L Guard loss limit ₹${guard.loss} reached (P&L ${pnl.toFixed(0)})` };
  }
  return { fire: false };
}

/** Validates what the user typed. Returns an error message, or null when the guard can be armed. */
export function validateSoftPnlGuard(profit: number, loss: number, products: string[]): string | null {
  if (!(profit > 0) && !(loss > 0)) return 'Enter a profit target or loss limit';
  if (products.length === 0) return 'Select at least one product for the guard';
  return null;
}

export interface SoftBracketInput {
  side: 'BUY' | 'SELL';
  /** Price the levels hang from: the limit price, or the live price for a market order. */
  ref: number;
  targetPts: number;
  slPts: number;
  /** Contract tick in rupees (the levels are rounded to it). */
  tick: number;
}

/**
 * Target and stop-loss prices for a software bracket. A long targets above its entry and stops below it; a short is the
 * mirror image. Refuses (rather than guessing) on a missing price/tick, a non-positive distance, or a level that
 * would land at or below zero.
 */
export function softBracketLevels(i: SoftBracketInput): { ok: true; target: number; sl: number } | { ok: false; error: string } {
  if (!(i.tick > 0)) return { ok: false, error: 'Tick size of this contract is unknown - cannot price a bracket' };
  if (!(i.ref > 0)) return { ok: false, error: 'No live price for this strike yet - cannot price a bracket' };
  if (!(i.targetPts > 0)) return { ok: false, error: 'Bracket target must be a positive number of points' };
  if (!(i.slPts > 0)) return { ok: false, error: 'Bracket SL must be a positive number of points' };
  const dir = i.side === 'BUY' ? 1 : -1;
  const round = (v: number) => Number((Math.round(v / i.tick) * i.tick).toFixed(4));
  const target = round(i.ref + dir * i.targetPts);
  const sl = round(i.ref - dir * i.slPts);
  if (!(target > 0)) return { ok: false, error: `Bracket target ${target} is not above zero - use fewer points` };
  if (!(sl > 0)) return { ok: false, error: `Bracket SL ${sl} is not above zero - use fewer points` };
  return { ok: true, target, sl };
}

/** A software bracket waiting for its entry to show up in the position book, then turned into a position guard. */
export interface PendingSoftBracket {
  symbol: string;
  /** INTRADAY or MARGIN: the product the entry was sent under. */
  product: GuardProduct;
  /** Direction of the position the entry opens: +1 long (BUY), -1 short (SELL). */
  dir: 1 | -1;
  target: number;
  sl: number;
  trail: boolean;
  /** Epoch ms the entry was sent. */
  at: number;
  /** How long this bracket may wait for its fill (a market order that never shows up was rejected; a resting limit can wait). */
  ttlMs: number;
  /**
   * Signed net quantity of this symbol+product when the entry was sent (0 when flat). The bracket attaches only once the
   * position has GROWN in the entry's direction past this - so a rejected entry can never hand its levels to the position
   * that was already open, and an add re-levels only after the added lots are in.
   */
  qtyBefore: number;
}

/** A market entry that has not shown in the book after this long was rejected or never reached the exchange. */
export const SOFT_BRACKET_MARKET_TTL_MS = 3 * 60 * 1000;

/** How long an unfilled entry keeps its bracket waiting (a resting limit can take a while; EOD is the outer bound). */
export const SOFT_BRACKET_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * The pending bracket matching an open position row, if any: same symbol, same product, and a position in the direction
 * the entry opens. A row the bracket was not for (opposite side, other product) is never matched.
 */
export function matchPendingBracket(
  pending: PendingSoftBracket[], pos: { tradingSymbol?: unknown; productType?: unknown; product?: unknown; netQty?: unknown },
): PendingSoftBracket | null {
  const qty = Number(pos.netQty) || 0;
  if (qty === 0) return null;
  const sym = String(pos.tradingSymbol ?? '');
  const prod = guardProductOf(pos.productType ?? pos.product);
  const dir = qty > 0 ? 1 : -1;
  // Exposure in the entry's direction must have grown past what it was when the entry was sent.
  return pending.find(p => p.symbol === sym && p.product === prod && p.dir === dir && dir * qty > dir * p.qtyBefore) ?? null;
}

/**
 * Whether an order of `qty` on `side` against a position of signed net `open` (same symbol + product) only CLOSES it, or
 * OPENS/ADDS to exposure. A bracket belongs to the second. An order bigger than the opposite position flips it: the
 * reducing part is a close, but the remainder opens a fresh position that deserves its own bracket.
 */
export function softEntryEffect(side: 'BUY' | 'SELL', qty: number, open: number): 'opens' | 'closes' {
  if (side === 'SELL' && open > 0 && qty <= open) return 'closes';
  if (side === 'BUY' && open < 0 && qty <= -open) return 'closes';
  return 'opens';
}

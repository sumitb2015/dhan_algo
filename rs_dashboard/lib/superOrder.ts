/**
 * Pure rules for Dhan Super Orders (POST /super/orders): one entry order with a resting
 * target leg, stop-loss leg and optional trailing jump, held at the broker so the exits
 * survive a dashboard or strategy crash. Mirrored in Python by `lib/super_order.py`.
 *
 * UNCONFIRMED against a live account (written without docs access): field names,
 * leg names and the price-ordering rules below are from the published API shape.
 * Verify with ONE minimal order before pointing a terminal at this.
 */

export type SuperLeg = 'ENTRY_LEG' | 'TARGET_LEG' | 'STOP_LOSS_LEG';

export const SUPER_PRODUCTS = new Set(['INTRADAY', 'MARGIN', 'CNC']);
// Derivatives only. Cash-equity is deliberately excluded: equity-order/ enforces a rupee cap, owned-quantity
// sells and no shorting, and a super order would bypass all three.
export const SUPER_SEGMENTS = new Set(['NSE_FNO', 'BSE_FNO', 'MCX_COMM']);
/** Units per order. Same backstop as fast-order's Triple Straddle cap (50 lots x 75). */
export const SUPER_MAX_QTY = 3750;

export interface SuperOrderInput {
  securityId: string;
  exchangeSegment: string;
  side: string;
  productType: string;
  orderType?: string;
  quantity: number;
  /** Entry limit price (LIMIT only). */
  price?: number;
  targetPrice: number;
  stopLossPrice: number;
  /** Trailing step for the stop; 0 / omitted = fixed stop. */
  trailingJump?: number;
  /** Current LTP, used ONLY to validate target/stop around a MARKET entry. Never sent. */
  refPrice?: number;
}

const pos = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n > 0;

/** Returns an error string, or null when the order is acceptable. */
export function validateSuperOrder(i: SuperOrderInput): string | null {
  if (!i.securityId || !/^\d+$/.test(String(i.securityId))) return 'securityId must be a numeric string';
  if (!SUPER_SEGMENTS.has(i.exchangeSegment)) return `Unsupported exchangeSegment: ${i.exchangeSegment}`;
  if (!SUPER_PRODUCTS.has(i.productType)) return `Unsupported productType: ${i.productType} (expected ${[...SUPER_PRODUCTS].join(' / ')})`;
  const side = String(i.side).toUpperCase();
  if (side !== 'BUY' && side !== 'SELL') return `Invalid side: ${i.side}`;
  if (!Number.isInteger(i.quantity) || i.quantity <= 0) return `Invalid quantity: ${i.quantity} (positive integer required)`;
  if (i.quantity > SUPER_MAX_QTY) return `Quantity ${i.quantity} exceeds the super-order cap of ${SUPER_MAX_QTY}`;

  const ot = String(i.orderType ?? 'LIMIT').toUpperCase();
  if (ot !== 'LIMIT' && ot !== 'MARKET') return `Invalid orderType: ${i.orderType} (LIMIT or MARKET)`;
  const entry = ot === 'LIMIT' ? i.price : i.refPrice;
  if (!pos(entry)) return ot === 'LIMIT' ? `LIMIT entry needs a positive price` : 'MARKET entry needs refPrice (current LTP) to validate target/stop';
  if (!pos(i.targetPrice)) return `Invalid targetPrice: ${i.targetPrice}`;
  if (!pos(i.stopLossPrice)) return `Invalid stopLossPrice: ${i.stopLossPrice}`;

  const e = entry as number;
  if (side === 'BUY' && !(i.stopLossPrice < e && e < i.targetPrice)) return `BUY needs stopLossPrice < entry < targetPrice (got ${i.stopLossPrice} / ${e} / ${i.targetPrice})`;
  if (side === 'SELL' && !(i.targetPrice < e && e < i.stopLossPrice)) return `SELL needs targetPrice < entry < stopLossPrice (got ${i.targetPrice} / ${e} / ${i.stopLossPrice})`;

  const tj = i.trailingJump ?? 0;
  if (!(typeof tj === 'number' && Number.isFinite(tj) && tj >= 0)) return `Invalid trailingJump: ${i.trailingJump}`;
  if (tj > 0 && tj >= Math.abs(e - i.stopLossPrice)) return `trailingJump ${tj} must be smaller than the entry-to-stop distance ${Math.abs(e - i.stopLossPrice)}`;
  return null;
}

export function buildPlacePayload(i: SuperOrderInput, correlationId: string): Record<string, unknown> {
  const ot = String(i.orderType ?? 'LIMIT').toUpperCase();
  return {
    correlationId,
    transactionType: String(i.side).toUpperCase(),
    exchangeSegment: i.exchangeSegment,
    productType: i.productType,
    orderType: ot,
    securityId: String(i.securityId),
    quantity: i.quantity,
    // Dhan's own SDK refuses a super order with price 0, so a MARKET entry carries the reference price
    // (the order type, not this field, decides how it fills).
    price: ot === 'LIMIT' ? i.price : i.refPrice,
    targetPrice: i.targetPrice,
    stopLossPrice: i.stopLossPrice,
    trailingJump: i.trailingJump ?? 0,
  };
}

export interface SuperModifyInput {
  legName: SuperLeg;
  /** Required for ENTRY_LEG (Dhan's modify carries it); ignored for the exit legs. */
  orderType?: string;
  quantity?: number;
  price?: number;
  targetPrice?: number;
  stopLossPrice?: number;
  trailingJump?: number;
}

/** Each leg only accepts its own fields; sending others is a caller bug, so reject rather than strip. */
export function validateModify(m: SuperModifyInput): string | null {
  const keys = (['quantity', 'price', 'targetPrice', 'stopLossPrice', 'trailingJump'] as const).filter(k => m[k] !== undefined);
  if (m.legName === 'ENTRY_LEG' && m.orderType !== 'LIMIT' && m.orderType !== 'MARKET') return 'ENTRY_LEG modify needs orderType LIMIT or MARKET';
  const allowed: Record<SuperLeg, readonly string[]> = {
    ENTRY_LEG: ['quantity', 'price', 'targetPrice', 'stopLossPrice', 'trailingJump'],
    TARGET_LEG: ['targetPrice'],
    STOP_LOSS_LEG: ['stopLossPrice', 'trailingJump'],
  };
  if (!allowed[m.legName]) return `Invalid legName: ${m.legName}`;
  if (keys.length === 0) return 'Nothing to modify';
  const bad = keys.filter(k => !allowed[m.legName].includes(k));
  if (bad.length) return `${m.legName} cannot change ${bad.join(', ')}`;
  for (const k of keys) {
    const v = m[k] as number;
    if (!(typeof v === 'number' && Number.isFinite(v) && (k === 'trailingJump' ? v >= 0 : v > 0))) return `Invalid ${k}: ${v}`;
  }
  if (m.quantity !== undefined && (!Number.isInteger(m.quantity) || m.quantity > SUPER_MAX_QTY)) return `Invalid quantity: ${m.quantity}`;
  return null;
}

// ─── Scalper ticket helpers ───────────────────────────────────────────────

const TICK = 0.05;
const roundTick = (n: number) => Math.round(Math.round(n / TICK) * TICK * 100) / 100;

export interface BracketPoints {
  /** Target / stop distance from the entry reference, in option points. */
  targetPts: number;
  slPts: number;
  /** Trailing step in points; 0 = fixed stop. */
  trailPts: number;
}

/**
 * Turn the ticket's point offsets into the absolute prices a super order needs, then run the
 * shared validator. The entry reference is the limit price for LIMIT and the live LTP for
 * MARKET (the actual fill can differ - the levels are absolute, set once at placement).
 */
export function resolveBracket(i: {
  securityId: string; exchangeSegment: string; productType: string;
  side: 'BUY' | 'SELL'; orderType: 'MARKET' | 'LIMIT'; quantity: number;
  limitPrice?: number; ltp: number;
} & BracketPoints): { ok: true; order: SuperOrderInput } | { ok: false; error: string } {
  const ref = i.orderType === 'LIMIT' ? i.limitPrice ?? 0 : i.ltp;
  if (!pos(ref)) return { ok: false, error: i.orderType === 'LIMIT' ? 'Enter a limit price for the bracket' : 'No live price for this strike yet - cannot place a bracket' };
  if (!pos(i.targetPts)) return { ok: false, error: 'Bracket target must be a positive number of points' };
  if (!pos(i.slPts)) return { ok: false, error: 'Bracket SL must be a positive number of points' };
  if (!(Number.isFinite(i.trailPts) && i.trailPts >= 0)) return { ok: false, error: 'Bracket trail must be 0 or more points' };
  const dir = i.side === 'BUY' ? 1 : -1;
  const order: SuperOrderInput = {
    securityId: i.securityId, exchangeSegment: i.exchangeSegment, side: i.side, productType: i.productType,
    orderType: i.orderType, quantity: i.quantity,
    ...(i.orderType === 'LIMIT' ? { price: roundTick(ref) } : { refPrice: roundTick(ref) }),
    targetPrice: roundTick(ref + dir * i.targetPts),
    stopLossPrice: roundTick(ref - dir * i.slPts),
    trailingJump: i.trailPts > 0 ? roundTick(i.trailPts) : 0,
  };
  const err = validateSuperOrder(order);
  return err ? { ok: false, error: err } : { ok: true, order };
}

const ACTIVE = new Set(['PENDING', 'TRANSIT', 'OPEN', 'TRIGGER_PENDING', 'PART_TRADED']);
const up = (v: unknown) => String(v ?? '').toUpperCase();

/**
 * Which legs to cancel to take down every live bracket on one security: resting target and
 * stop legs, plus the entry leg if it has not fully traded. Used after the terminal closes
 * a position by hand, so a surviving stop/target cannot re-open the opposite side.
 * Rows are the raw GET /super/orders payload; unknown shapes fall back to the entry leg.
 */
export function legsToCancel(rows: Record<string, unknown>[], securityId: string): { orderId: string; leg: SuperLeg }[] {
  const out: { orderId: string; leg: SuperLeg }[] = [];
  for (const r of rows) {
    const orderId = String(r.orderId ?? '');
    if (!orderId || String(r.securityId ?? '') !== securityId) continue;
    const legs = Array.isArray(r.legDetails) ? (r.legDetails as Record<string, unknown>[]) : null;
    if (!legs) {
      if (ACTIVE.has(up(r.orderStatus))) out.push({ orderId, leg: 'ENTRY_LEG' });
      continue;
    }
    for (const l of legs) {
      const name = up(l.legName) as SuperLeg;
      if (LEG_NAMES.has(name) && ACTIVE.has(up(l.orderStatus))) out.push({ orderId, leg: name });
    }
  }
  return out;
}
const LEG_NAMES = new Set<string>(['ENTRY_LEG', 'TARGET_LEG', 'STOP_LOSS_LEG']);

/**
 * True when some live bracket row carries no securityId, so legsToCancel can never match it.
 * Callers should warn rather than conclude "nothing to cancel".
 */
export function hasUnmatchableActive(rows: Record<string, unknown>[]): boolean {
  return rows.some(r => {
    if (String(r.securityId ?? '') !== '') return false;
    const legs = Array.isArray(r.legDetails) ? (r.legDetails as Record<string, unknown>[]) : [];
    return ACTIVE.has(up(r.orderStatus)) || legs.some(l => ACTIVE.has(up(l.orderStatus)));
  });
}

// ─── Position-row display ─────────────────────────────────────────────────

/** The resting exit levels of one live bracket, for showing on a position row. */
export interface BracketLevels {
  orderId: string;
  /** Product the bracket was placed under (INTRADAY / MARGIN / CNC), null when the row does not say. */
  productType: string | null;
  /** True while the ENTRY leg has not fully traded: the exit legs exist but protect nothing yet. */
  entryPending: boolean;
  /** Resting target price, null when that leg is not live or carries no readable price. */
  target: number | null;
  /** Resting stop-loss price, null when that leg is not live or carries no readable price. */
  stop: number | null;
  /** Trailing step in points when the stop trails, else null. With a trail the level shown may be the initial stop. */
  trail: number | null;
}

const posNum = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
};

/** Lookup key for one contract under one product. An empty product is the "product unknown" bucket. */
export const bracketRowKey = (securityId: unknown, productType: unknown): string =>
  `${String(securityId ?? '')}|${String(productType ?? '').trim().toUpperCase()}`;

/**
 * Live brackets keyed by `bracketRowKey(securityId, product)`, from the raw GET /super/orders rows. A bracket is "live"
 * for display while its TARGET and/or STOP leg is still resting (ACTIVE); a filled or cancelled leg shows no level.
 * Each level prefers the leg's own price (what is actually resting, and what a trailing stop moves) and falls back to
 * the order's `targetPrice` / `stopLossPrice`. UNCONFIRMED against a live account (same caveat as the rest of this
 * file): a level that cannot be read is null and the row shows "-", never a guess.
 */
export function bracketLevelsByContract(rows: Record<string, unknown>[]): Record<string, BracketLevels[]> {
  const out: Record<string, BracketLevels[]> = {};
  for (const r of rows) {
    const orderId = String(r.orderId ?? '');
    const securityId = String(r.securityId ?? '');
    const legs = Array.isArray(r.legDetails) ? (r.legDetails as Record<string, unknown>[]) : [];
    if (!orderId || !securityId || legs.length === 0) continue;
    const find = (name: SuperLeg) => legs.find(l => up(l.legName) === name);
    const tl = find('TARGET_LEG');
    const sl = find('STOP_LOSS_LEG');
    const entry = find('ENTRY_LEG');
    const tLive = !!tl && ACTIVE.has(up(tl.orderStatus));
    const sLive = !!sl && ACTIVE.has(up(sl.orderStatus));
    if (!tLive && !sLive) continue;
    const product = up(r.productType);
    (out[bracketRowKey(securityId, product)] ??= []).push({
      orderId,
      productType: product || null,
      entryPending: !!entry && ACTIVE.has(up(entry.orderStatus)),
      target: tLive ? (posNum(tl!.price) ?? posNum(tl!.triggerPrice) ?? posNum(r.targetPrice)) : null,
      stop: sLive ? (posNum(sl!.triggerPrice) ?? posNum(sl!.price) ?? posNum(r.stopLossPrice)) : null,
      trail: posNum(sl?.trailingJump) ?? posNum(r.trailingJump),
    });
  }
  return out;
}

/** The brackets for one position row: its own product's, plus any whose product the order row did not report. */
export function bracketsForRow(map: Record<string, BracketLevels[]> | undefined, securityId: unknown, productType: unknown): BracketLevels[] | undefined {
  if (!map) return undefined;
  const own = map[bracketRowKey(securityId, productType)];
  const unknown = map[bracketRowKey(securityId, '')];
  if (own && unknown) return [...own, ...unknown];   // rare; a fresh array is fine, it only happens with unlabeled rows
  return own ?? unknown;
}

/**
 * Next levels map that keeps the PREVIOUS array for every contract whose levels did not change, and returns `prev`
 * itself when nothing changed. Position rows are memoized on array identity, so one contract's change re-renders one row.
 */
export function reuseUnchanged(prev: Record<string, BracketLevels[]>, next: Record<string, BracketLevels[]>): Record<string, BracketLevels[]> {
  const nk = Object.keys(next);
  let same = nk.length === Object.keys(prev).length;
  const out: Record<string, BracketLevels[]> = {};
  for (const k of nk) {
    if (prev[k] && JSON.stringify(prev[k]) === JSON.stringify(next[k])) out[k] = prev[k];
    else { out[k] = next[k]; same = false; }
  }
  return same ? prev : out;
}

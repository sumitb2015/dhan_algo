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
export const SUPER_SEGMENTS = new Set(['NSE_EQ', 'BSE_EQ', 'NSE_FNO', 'BSE_FNO', 'MCX_COMM']);
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
    price: ot === 'LIMIT' ? i.price : 0,
    targetPrice: i.targetPrice,
    stopLossPrice: i.stopLossPrice,
    trailingJump: i.trailingJump ?? 0,
  };
}

export interface SuperModifyInput {
  legName: SuperLeg;
  quantity?: number;
  price?: number;
  targetPrice?: number;
  stopLossPrice?: number;
  trailingJump?: number;
}

/** Each leg only accepts its own fields; sending others is a caller bug, so reject rather than strip. */
export function validateModify(m: SuperModifyInput): string | null {
  const keys = (['quantity', 'price', 'targetPrice', 'stopLossPrice', 'trailingJump'] as const).filter(k => m[k] !== undefined);
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

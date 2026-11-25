// Request checks for PATCH /api/scalper/orders (modify a working order), kept pure so they are unit-tested
// (orderModifyRules.test.ts). Shared by every page that modifies orders; the per-source cap applies only to callers
// that name a source (the Index Scalper sends 'isx'), like the place-order routes.

/** Why a modify's price / trigger must be refused (null = fine). An SL-M carries no limit price (0) but needs a
 *  trigger; every other type needs a positive price. */
export function modifyPriceError(orderType: string, price: unknown, trigger: unknown): string | null {
  const type = String(orderType ?? 'LIMIT').toUpperCase();
  const p = Number(price);
  const t = Number(trigger);
  if (type === 'STOP_LOSS_MARKET' || type === 'SL-M') {
    return Number.isFinite(t) && t > 0 ? null : `Invalid trigger price: ${trigger}`;
  }
  if (!Number.isFinite(p) || p <= 0) return `Invalid price: ${price}`;
  if ((type === 'STOP_LOSS' || type === 'SL') && !(Number.isFinite(t) && t > 0)) return `Invalid trigger price: ${trigger}`;
  return null;
}

/** Kotak Neo's price-type code for a Dhan-vocabulary order type. */
export function kotakPriceType(orderType: string): 'MKT' | 'L' | 'SL' | 'SL-M' {
  const type = String(orderType ?? '').toUpperCase();
  if (type === 'MARKET') return 'MKT';
  if (type === 'STOP_LOSS_MARKET' || type === 'SL-M') return 'SL-M';
  if (type === 'STOP_LOSS' || type === 'SL') return 'SL';
  return 'L';
}

import { kiteGet, kitePut } from '@/lib/zerodhaToken';
import { cachedZerodhaContract } from '@/lib/zerodhaContracts';
import { zerodhaSnapPrice } from '@/lib/zerodhaOrderRules';
import { invalidateBrokerCache } from '@/lib/brokerPositionsCache';

const DONE = new Set(['COMPLETE', 'CANCELLED', 'CANCELED', 'REJECTED']);

export type ModifyResult = { ok: true; data: unknown } | { ok: false; status: number; error: string };

/**
 * Re-price / re-size a resting Zerodha LIMIT order. The order is read first: its own symbol sets the tick the price snaps to,
 * a finished order or any other order type is refused (never turned into a LIMIT), and the caller gets Kite's reason on a
 * rejection. Shared by /api/scalper/zerodha/orders and the broker switch in /api/scalper/orders.
 */
export async function modifyZerodhaLimitOrder(input: { orderId?: unknown; price?: unknown; quantity?: unknown }): Promise<ModifyResult> {
  const id = String(input.orderId ?? '');
  if (!/^[A-Za-z0-9-]+$/.test(id)) return { ok: false, status: 400, error: 'orderId is required' };
  const newPrice = Number(input.price);
  if (!(newPrice > 0)) return { ok: false, status: 400, error: `Invalid price: ${input.price}` };
  const qty = Number(input.quantity);
  if (!Number.isInteger(qty) || qty <= 0) return { ok: false, status: 400, error: `Invalid quantity: ${input.quantity}` };

  const book = await kiteGet('/orders') as Record<string, unknown>[];
  const order = (Array.isArray(book) ? book : []).find((o) => String(o.order_id) === id);
  if (!order) return { ok: false, status: 404, error: 'Order not found' };
  if (DONE.has(String(order.status).toUpperCase())) return { ok: false, status: 409, error: `Order is already ${String(order.status).toLowerCase()} — nothing to modify` };
  if (String(order.order_type).toUpperCase() !== 'LIMIT') {
    return { ok: false, status: 400, error: `Only a resting LIMIT order can be modified (this one is ${order.order_type})` };
  }
  const data = await kitePut(`/orders/regular/${encodeURIComponent(id)}`, {
    quantity: qty,
    price: zerodhaSnapPrice(newPrice, cachedZerodhaContract(String(order.tradingsymbol))),
    order_type: 'LIMIT',
    validity: 'DAY',
  });
  invalidateBrokerCache('zerodha');
  return { ok: true, data };
}

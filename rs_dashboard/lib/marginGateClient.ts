/**
 * Browser-side REAL pre-trade margin gate for an order that ADDS exposure. Fails CLOSED: if the margin or the available
 * funds cannot be read, the order is blocked (a rejected add is harmless, a wrongly allowed one is not).
 *
 * Dhan only: it reads `/api/multi-leg-focus/margin` (Dhan's calculator, or the route's flat estimate when that is
 * down) and `/api/scalper/funds`. The Triple Straddle desk has its own twin for two-leg baskets
 * (tripleStraddleClient.checkMarginGate); this one takes any legs.
 */

export interface GateLeg {
  id: string;
  side: 'B' | 'S';
  option: 'CE' | 'PE';
  strike: number;
  expiry: string;
  lots: number;
  /** Units (lots × lot size). */
  quantity: number;
  price: number;
  securityId?: string;
}

export interface MarginVerdict { ok: boolean; message: string }

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

/** Pure: required margin against available funds. Anything unreadable blocks. */
export function marginGateVerdict(required: number | null | undefined, available: number | null | undefined): MarginVerdict {
  if (required == null || !Number.isFinite(required)) return { ok: false, message: 'Margin could not be verified — order blocked' };
  if (available == null || !Number.isFinite(available)) return { ok: false, message: 'Available funds could not be read — order blocked' };
  if (required > available) return { ok: false, message: `Insufficient margin: needs ~${inr(required)}, available ${inr(available)}` };
  return { ok: true, message: '' };
}

export async function checkOrderMarginGate(p: {
  underlying: string; expiry: string; legs: GateLeg[];
}): Promise<MarginVerdict & { required?: number; available?: number; estimate?: boolean }> {
  try {
    const [mr, fr] = await Promise.all([
      fetch('/api/multi-leg-focus/margin', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ underlying: p.underlying, expiry: p.expiry, broker: 'dhan', legs: p.legs }),
      }),
      fetch('/api/scalper/funds'),
    ]);
    const mj = await mr.json() as { success: boolean; data?: { basketMargin?: number; basketMarginSource?: string } };
    const fj = await fr.json() as { success: boolean; data?: Record<string, unknown> };
    const required = mj.success ? mj.data?.basketMargin : undefined;
    const available = fj.success ? Number(fj.data?.availabelBalance ?? fj.data?.availableBalance ?? NaN) : NaN;
    const v = marginGateVerdict(required, available);
    return { ...v, required, available: Number.isFinite(available) ? available : undefined, estimate: mj.data?.basketMarginSource === 'estimate' };
  } catch (e) {
    return { ok: false, message: `Margin check failed (${String(e)}) — order blocked` };
  }
}

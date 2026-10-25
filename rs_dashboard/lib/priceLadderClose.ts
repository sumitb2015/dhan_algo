import { fractionUnits } from './partialQty.ts';

// Closing a broker position straight from the Price Ladder's positions window. Pure rules; the route does the IO.
// The browser names a position (broker + key + product) and a share of it. Everything else — side, quantity, segment —
// is derived from the broker's own book at the moment of the request, and the order can only REDUCE what is there.

export const CLOSE_PCTS = [25, 50, 75, 100] as const;
export type ClosePctChoice = typeof CLOSE_PCTS[number];

export const isClosePct = (v: unknown): v is ClosePctChoice => CLOSE_PCTS.includes(Number(v) as ClosePctChoice);

/**
 * The closing order for a position with broker net quantity `net`: the opposite side, `pct` of it rounded DOWN to whole
 * lots (100 = all of |net|, so a non-lot remainder stays closable). Error text when nothing can be sent.
 */
export function planClose(net: number, lotSize: number | null, pct: number): { side: 'BUY' | 'SELL'; qty: number } | string {
  const n = Number(net);
  if (!Number.isFinite(n) || n === 0) return 'That position is already flat at the broker';
  if (!isClosePct(pct)) return 'pct must be 25, 50, 75 or 100';
  const side = n > 0 ? 'SELL' : 'BUY';
  if (Number(pct) === 100) return { side, qty: Math.abs(n) };
  if (!(Number(lotSize) > 0)) return 'Lot size unknown for this contract — close the whole position instead';
  const qty = fractionUnits(n, Number(lotSize), Number(pct) / 100);
  if (qty <= 0) return `${pct}% is less than one lot — pick a larger share`;
  return { side, qty };
}

/** One close per position at a time, and a short cooldown after one is sent (the broker book lags a fresh fill). */
export const CLOSE_COOLDOWN_MS = 8_000;

export class CloseGuard {
  private busy = new Set<string>();
  private last = new Map<string, number>();
  /** True if this caller now owns the position's close; false when one is running or just went out. */
  tryStart(key: string, now: number): boolean {
    if (this.busy.has(key)) return false;
    const at = this.last.get(key);
    if (at != null && now - at < CLOSE_COOLDOWN_MS) return false;
    this.busy.add(key);
    return true;
  }
  /** `sent` = an order went out (or may have): start the cooldown. */
  finish(key: string, now: number, sent: boolean): void {
    this.busy.delete(key);
    if (sent) this.last.set(key, now);
    for (const [k, at] of this.last) if (now - at > 60_000) this.last.delete(k);
  }
}

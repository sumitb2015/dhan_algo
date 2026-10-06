// Client-side execution for the Triple Straddle page. Dhan only (the page's panels
// and ledger carry numeric security ids). SIM never touches an order route.
//
// Safety rules (see dhan-terminal-position-ownership / dhan-order-tickets):
//  - an ACK is not a fill: every REAL order is confirmed against the order book;
//  - if one leg of a straddle fails, a CONFIRMED-filled sibling is reversed; an
//    unconfirmed one is never auto-reversed (it may not exist) and is surfaced;
//  - exits close this ledger's own qty, clamped down to what the broker still shows;
//  - exits use the same product as the entry.

import { classifyDhanOrder, type DhanOrderPhase } from './multiLegFocus.ts';
import {
  brokerCapacity, exitQtyForLeg, TS_FILL_GRACE_MS, TS_ORDER_SOURCE,
  type TsLeg, type TsMode, type TsPosition, type TsProduct, type TsSide,
} from './tripleStraddle.ts';

export const TS_TRADABLE = ['NIFTY', 'BANKNIFTY', 'SENSEX'] as const;
export const isTsTradable = (u: string): boolean => (TS_TRADABLE as readonly string[]).includes(u);

export interface TsLookup { lotSize: number; ids: { ceId?: string; peId?: string } }
export interface TsChainLookup { lotSize: number; strikes: Record<string, { ceId?: string; peId?: string }> }

/** One lookup per (underlying, expiry): lot size and the whole strike -> id map. */
export async function fetchChainLookup(underlying: string, expiry: string): Promise<TsChainLookup | null> {
  try {
    const r = await fetch(`/api/scalper/lookup?underlying=${underlying}&expiry=${expiry}`);
    const j = await r.json() as { success: boolean; data?: { lotSize?: number; strikes?: Record<string, { ceId?: string; peId?: string }> } };
    if (!j.success || !j.data?.lotSize || !j.data.strikes) return null;
    return { lotSize: j.data.lotSize, strikes: j.data.strikes };
  } catch { return null; }
}

/** Live CE/PE prices for a set of strikes from the option chain. */
export async function fetchChainPrices(
  underlying: string, expiry: string,
): Promise<Record<string, { CE: number; PE: number }> | null> {
  try {
    const r = await fetch(`/api/options/chain?underlying=${underlying}&expiry=${expiry}&broker=dhan`);
    const j = await r.json() as { success: boolean; data?: { chain?: { oc?: Record<string, unknown> } | Record<string, unknown> } };
    if (!j.success || !j.data) return null;
    const oc = ((j.data.chain as { oc?: Record<string, unknown> })?.oc ?? j.data.chain) as Record<string, unknown> | undefined;
    if (!oc || typeof oc !== 'object') return null;
    const out: Record<string, { CE: number; PE: number }> = {};
    for (const [sk, raw] of Object.entries(oc)) {
      const k = Math.round(parseFloat(sk));
      if (!Number.isFinite(k)) continue;
      const e = raw as { ce?: { last_price?: number; ltp?: number }; pe?: { last_price?: number; ltp?: number } };
      // No previous-close fallback: a stale close must not be shown as a live price.
      out[String(k)] = {
        CE: Number(e?.ce?.last_price || e?.ce?.ltp || 0),
        PE: Number(e?.pe?.last_price || e?.pe?.ltp || 0),
      };
    }
    return out;
  } catch { return null; }
}

async function confirmOrder(orderId: string, timeoutMs = 6000): Promise<{ phase: DhanOrderPhase; filledQty: number; avgPrice: number; reason: string }> {
  const deadline = Date.now() + timeoutMs;
  let last = { phase: 'pending' as DhanOrderPhase, filledQty: 0, avgPrice: 0, reason: '' };
  for (;;) {
    try {
      const res = await fetch(`/api/scalper/orders?orderId=${encodeURIComponent(orderId)}`);
      const j = await res.json() as { success: boolean; data?: { orderStatus: string; filledQty: number; averageTradedPrice: number; reason: string } };
      if (j.success && j.data) {
        last = { phase: classifyDhanOrder(j.data.orderStatus, 'MARKET'), filledQty: j.data.filledQty, avgPrice: j.data.averageTradedPrice, reason: j.data.reason };
        if (last.phase !== 'pending') return last;
      }
    } catch { /* retry until the deadline */ }
    if (Date.now() + 400 > deadline) return last;
    await new Promise((r) => setTimeout(r, 400));
  }
}

interface SendResult { ok: boolean; orderId?: string; error?: string; unknown?: boolean }

async function sendOrder(
  underlying: string, securityId: string, qty: number, side: TsSide, product: TsProduct, key: string,
): Promise<SendResult> {
  try {
    const res = await fetch('/api/scalper/fast-order', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        securityId, quantity: qty, side: side === 'B' ? 'BUY' : 'SELL', orderType: 'MARKET',
        exchangeSegment: underlying === 'SENSEX' ? 'BSE_FNO' : 'NSE_FNO',
        productType: product, source: TS_ORDER_SOURCE, idempotencyKey: key,
      }),
    });
    const j = await res.json() as { success: boolean; order_id?: string; error?: string };
    if (j.success) return { ok: true, orderId: j.order_id ? String(j.order_id) : undefined };
    // 504 = status unknown: the order may exist. Never treat it as a clean failure.
    return { ok: false, error: j.error ?? `HTTP ${res.status}`, unknown: res.status === 504 };
  } catch (e) {
    return { ok: false, error: String(e), unknown: true };
  }
}

export interface EntryParams {
  slot: TsPosition['slot']; underlying: string; expiry: string; strike: number; side: TsSide;
  lots: number; lotSize: number; product: TsProduct; mode: TsMode;
  ids: { ceId?: string; peId?: string };
  /** Live prices used for SIM fills and as the REAL fallback when the book has no average. */
  prices: { CE: number; PE: number };
  risk: TsPosition['risk'];
  /** REAL only: persist a record BEFORE any order is sent, so a closed tab or crash mid-entry
   *  never leaves live legs the ledger does not know about. Returns false if it could not
   *  be saved, in which case no order is placed. */
  onIntent?: (position: TsPosition) => Promise<boolean>;
}

export interface EntryOutcome {
  position: TsPosition | null;
  /** Messages for the user (errors, partial states). */
  notes: string[];
  ok: boolean;
}

function newId(slot: string): string { return `ts_${slot}_${Date.now().toString(36)}`; }

export async function enterStraddle(p: EntryParams): Promise<EntryOutcome> {
  const notes: string[] = [];
  const qty = p.lots * p.lotSize;
  const id = newId(p.slot);
  const openedAt = Date.now();
  // Entry always starts from a real quote (never 0): an unknown-fill leg must not read
  // as a free leg in the P&L.
  const mk = (option: 'CE' | 'PE', extra: Partial<TsLeg> = {}): TsLeg => ({
    option, qty, entry: p.prices[option], orderIds: [], securityId: option === 'CE' ? p.ids.ceId : p.ids.peId, ...extra,
  });
  const base = {
    id, slot: p.slot, mode: p.mode, side: p.side, underlying: p.underlying, expiry: p.expiry, strike: p.strike,
    lots: p.lots, lotSize: p.lotSize, product: p.product, risk: p.risk, openedAt,
  };

  if (!(p.prices.CE > 0) || !(p.prices.PE > 0)) return { position: null, ok: false, notes: ['No live price for both legs yet'] };

  if (p.mode === 'SIM') {
    return { ok: true, notes: [], position: { ...base, status: 'OPEN', legs: [mk('CE'), mk('PE')] } };
  }

  if (!p.ids.ceId || !p.ids.peId) return { position: null, ok: false, notes: ['Security ids not resolved for this strike'] };

  // Checkpoint before any order leaves: both legs "unconfirmed" until proven otherwise.
  const intent: TsPosition = { ...base, status: 'OPEN', risk: { ...p.risk, armed: false }, legs: [mk('CE', { unconfirmed: true }), mk('PE', { unconfirmed: true })] };
  if (!p.onIntent || !(await p.onIntent(intent))) {
    return { position: null, ok: false, notes: ['Could not save the position record first — no order was placed'] };
  }

  const sent = await Promise.all((['CE', 'PE'] as const).map(async (opt) => ({
    opt,
    r: await sendOrder(p.underlying, opt === 'CE' ? p.ids.ceId! : p.ids.peId!, qty, p.side, p.product, `ts-${id}-${opt}-in`),
  })));

  const legs: TsLeg[] = [];
  const filled: { opt: 'CE' | 'PE'; secId: string }[] = [];
  let failed = false;
  for (const { opt, r } of sent) {
    const secId = opt === 'CE' ? p.ids.ceId! : p.ids.peId!;
    const ids = (oid?: string) => (oid ? [oid] : []);
    if (!r.ok) {
      failed = true;
      notes.push(`${opt} order ${r.unknown ? 'status UNKNOWN' : 'rejected'}: ${r.error}${r.unknown ? ' — check Orders before acting' : ''}`);
      legs.push(r.unknown ? mk(opt, { unconfirmed: true }) : mk(opt, { qty: 0, closed: true, exit: p.prices[opt] }));
      continue;
    }
    const c = r.orderId ? await confirmOrder(r.orderId) : { phase: 'pending' as DhanOrderPhase, filledQty: 0, avgPrice: 0, reason: '' };
    if (c.phase === 'dead') {
      failed = true;
      notes.push(`${opt} rejected after acceptance: ${c.reason || 'broker rejected'}`);
      legs.push(mk(opt, { qty: 0, closed: true, exit: p.prices[opt], orderIds: ids(r.orderId) }));
    } else if (c.phase === 'filled') {
      filled.push({ opt, secId });
      legs.push(mk(opt, { entry: c.avgPrice > 0 ? c.avgPrice : p.prices[opt], qty: c.filledQty > 0 ? c.filledQty : qty, orderIds: ids(r.orderId) }));
    } else {
      failed = true;
      notes.push(`${opt} fill NOT confirmed (order ${r.orderId}); tracked, will not be auto-reversed. Check Orders.`);
      legs.push(mk(opt, { unconfirmed: true, orderIds: ids(r.orderId) }));
    }
  }

  if (failed) {
    // Reverse only legs CONFIRMED filled, and confirm the reversal too: an accepted reverse
    // can still be rejected, which would leave a naked leg while the ledger says flat.
    for (const f of filled) {
      const i = legs.findIndex((l) => l.option === f.opt);
      const leg = legs[i];
      const rev = await sendOrder(p.underlying, f.secId, leg.qty, p.side === 'S' ? 'B' : 'S', p.product, `ts-${id}-${f.opt}-rb`);
      if (!rev.ok) { notes.push(`Could not reverse ${f.opt} (${rev.error}) — close it manually`); continue; }
      const c = rev.orderId ? await confirmOrder(rev.orderId) : null;
      if (c?.phase === 'filled') {
        legs[i] = { ...leg, closed: true, exit: c.avgPrice > 0 ? c.avgPrice : p.prices[f.opt], orderIds: [...leg.orderIds, ...(rev.orderId ? [rev.orderId] : [])] };
        notes.push(`Reversed ${f.opt} so no single leg is left open`);
      } else {
        legs[i] = { ...leg, pendingExit: rev.orderId ? { orderId: rev.orderId, at: Date.now() } : undefined, orderIds: [...leg.orderIds, ...(rev.orderId ? [rev.orderId] : [])] };
        notes.push(`${f.opt} reversal not confirmed (order ${rev.orderId}) — check Orders; the leg stays tracked as open`);
      }
    }
    const allClosed = legs.every((l) => l.closed);
    return {
      ok: false, notes,
      position: allClosed
        ? { ...base, status: 'CLOSED', closedAt: Date.now(), exitReason: 'MANUAL', legs: legs as [TsLeg, TsLeg], risk: { ...p.risk, armed: false } }
        // Something is (or may be) live at the broker: stays OPEN on the ledger, never orphaned.
        : { ...base, status: 'OPEN', legs: legs as [TsLeg, TsLeg], risk: { ...p.risk, armed: false } },
    };
  }
  return { ok: true, notes, position: { ...base, status: 'OPEN', legs: legs as [TsLeg, TsLeg] } };
}

export interface ExitOutcome { position: TsPosition; notes: string[]; ok: boolean }

/** Close every still-open leg of a position. SIM closes at the supplied live prices. */
export async function exitStraddle(
  pos: TsPosition, prices: { CE?: number; PE?: number }, reason: NonNullable<TsPosition['exitReason']>,
): Promise<ExitOutcome> {
  const notes: string[] = [];
  const closeSide: TsSide = pos.side === 'S' ? 'B' : 'S';
  const now = Date.now();
  const finish = (legs: TsLeg[]): ExitOutcome => {
    const done = legs.every((l) => l.closed);
    return {
      ok: done, notes,
      position: { ...pos, legs: legs as [TsLeg, TsLeg], ...(done ? { status: 'CLOSED' as const, closedAt: now, exitReason: reason } : {}) },
    };
  };

  if (pos.mode === 'SIM') {
    const legs = pos.legs.map((l) => {
      if (l.closed) return l;
      const px = prices[l.option];
      return px && px > 0 ? { ...l, closed: true, exit: px } : l;
    });
    if (!legs.every((l) => l.closed)) notes.push('No live price for a leg — SIM exit incomplete');
    return finish(legs);
  }

  // Broker truth is used only to CLAMP the exit size down and to detect an already-flat leg.
  let rows: Record<string, unknown>[] | null = null;
  try {
    const r = await fetch('/api/scalper/positions');
    const j = await r.json() as { success: boolean; data?: Record<string, unknown>[] };
    if (j.success && Array.isArray(j.data)) rows = j.data;
  } catch { /* unreadable: handled below as "fail open" */ }

  const legs = await Promise.all(pos.legs.map(async (leg): Promise<TsLeg> => {
    if (leg.closed) return leg;
    if (leg.unconfirmed || !leg.securityId) {
      notes.push(`${leg.option}: ${leg.unconfirmed ? 'entry unconfirmed' : 'no security id'} — verify in Orders/Positions, then use Resolve`);
      return leg;
    }

    // A previous exit order is still unsettled: look at IT, never send another on top of it.
    let current = leg;
    if (leg.pendingExit) {
      const c = await confirmOrder(leg.pendingExit.orderId, 0);
      if (c.phase === 'filled') {
        return { ...leg, closed: true, exit: c.avgPrice > 0 ? c.avgPrice : (prices[leg.option] ?? leg.entry), pendingExit: undefined };
      }
      if (c.phase !== 'dead') {
        notes.push(`${leg.option}: earlier exit order ${leg.pendingExit.orderId} is still unsettled — not re-sending. Check Orders.`);
        return leg;
      }
      current = { ...leg, pendingExit: undefined };   // that order died; a fresh exit is safe
    }

    const cap = brokerCapacity(rows, leg.securityId, pos.product, pos.side);
    if (cap.kind === 'flat') {
      notes.push(`${leg.option}: broker shows it already flat — marked closed at the last price`);
      return { ...current, closed: true, exit: prices[leg.option] ?? current.entry };
    }
    if (cap.kind === 'opposite') {
      notes.push(`${leg.option}: broker shows only the opposite side open — not closing. Verify in Positions, then use Resolve.`);
      return current;
    }
    // No matching row: the book may lag (fresh fill) or be incomplete. Right after entry we
    // still exit our own qty; later, an absent row is not proof of anything, so stop and ask.
    // A positions call that FAILED outright fails open: an exit only reduces risk.
    if (cap.kind === 'unknown' && rows !== null && now - pos.openedAt > TS_FILL_GRACE_MS) {
      notes.push(`${leg.option}: broker position not visible — not sending an order that could open the opposite side. Verify in Positions, then use Resolve.`);
      return current;
    }
    const qty = exitQtyForLeg(current.qty, cap.kind === 'qty' ? cap.qty : null);
    const r = await sendOrder(pos.underlying, current.securityId!, qty, closeSide, pos.product, `ts-${pos.id}-${leg.option}-out-${current.orderIds.length}`);
    if (!r.ok) {
      notes.push(`${leg.option} exit ${r.unknown ? 'status UNKNOWN' : 'rejected'}: ${r.error}`);
      return current;
    }
    const orderIds = [...current.orderIds, ...(r.orderId ? [r.orderId] : [])];
    const c = r.orderId ? await confirmOrder(r.orderId) : null;
    if (c?.phase === 'filled') {
      return { ...current, closed: true, exit: c.avgPrice > 0 ? c.avgPrice : (prices[leg.option] ?? current.entry), orderIds };
    }
    notes.push(`${leg.option} exit not confirmed (${c?.reason || 'pending'}) — leg stays open on the ledger; it will be re-checked, not re-sent`);
    return { ...current, orderIds, pendingExit: r.orderId ? { orderId: r.orderId, at: Date.now() } : undefined };
  }));
  return finish(legs);
}

/** REAL pre-trade gate. Fails CLOSED: unknown margin or funds blocks the order. */
export async function checkMarginGate(p: {
  underlying: string; expiry: string; strike: number; side: TsSide; lots: number; lotSize: number;
  ids: { ceId?: string; peId?: string }; prices: { CE: number; PE: number };
}): Promise<{ ok: boolean; message: string; estimate: boolean; required?: number; available?: number }> {
  try {
    const legs = (['CE', 'PE'] as const).map((option) => ({
      id: option, side: p.side, option, strike: p.strike, expiry: p.expiry, lots: p.lots,
      quantity: p.lots * p.lotSize, price: p.prices[option], securityId: option === 'CE' ? p.ids.ceId : p.ids.peId,
    }));
    const [mr, fr] = await Promise.all([
      fetch('/api/multi-leg-focus/margin', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ underlying: p.underlying, expiry: p.expiry, broker: 'dhan', legs }),
      }),
      fetch('/api/scalper/funds'),
    ]);
    const mj = await mr.json() as { success: boolean; data?: { basketMargin?: number; basketMarginSource?: string } };
    const fj = await fr.json() as { success: boolean; data?: Record<string, unknown> };
    const required = mj.data?.basketMargin;
    if (!mj.success || required == null) return { ok: false, estimate: false, message: 'Margin could not be verified — order blocked' };
    const available = Number(fj.data?.availabelBalance ?? fj.data?.availableBalance ?? NaN);
    if (!fj.success || !Number.isFinite(available)) return { ok: false, estimate: false, required, message: 'Available funds could not be read — order blocked' };
    if (required > available) return { ok: false, estimate: false, required, available, message: `Insufficient margin: needs ~₹${Math.round(required).toLocaleString('en-IN')}, available ₹${Math.round(available).toLocaleString('en-IN')}` };
    return { ok: true, estimate: mj.data?.basketMarginSource === 'estimate', required, available, message: '' };
  } catch (e) {
    return { ok: false, estimate: false, message: `Margin check failed (${String(e)}) — order blocked` };
  }
}

export async function saveTsPosition(position: TsPosition): Promise<boolean> {
  try {
    const r = await fetch('/api/triple-straddle/state', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ position }),
    });
    const j = await r.json() as { success: boolean };
    return r.ok && j.success;
  } catch { return false; }
}

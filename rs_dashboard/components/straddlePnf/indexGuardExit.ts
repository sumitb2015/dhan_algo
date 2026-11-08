'use client';

import { BROKER_LABELS, type Broker } from '@/hooks/useBrokerSelector';
import type { HeldRow } from '@/lib/pnfIndexHeld';
import type { PnfAction } from '@/lib/pnfOrderLogic';
import { targetKey, targetLabel, type Target } from '@/lib/pnfTarget';
import type { PnfScope } from '@/lib/pnfScope';
import type { HeldOps } from './useIndexHeld';

// The MTM guard's exit of the option units a Renko INDEX chart opened by hand (trade bar / Scalper): the same reserve -> send -> settle
// path as the bar's Close (usePnfTrade changeHeld), so the guard and a click on either chart, in any tab, are serialised by the held
// ledger (a reserve is refused while another order on the row is out). It sends exactly the chart's OWN units (exitOwn, clamped by the
// server to the broker row), never the broker's net, and an unclear reply is 'unknown' - settled by the user, never resent.

type Reply = { success?: boolean; outcome?: string; message?: string; error?: string };

export type HeldExitResult =
  /** Nothing of this chart's is open by hand any more (PAPER closed, or nothing held). */
  | 'done'
  /** A REAL close went out (or the broker showed nothing): the guard settles once the held ledger reads flat. */
  | 'sent'
  /** Not sent this time, said in `why`; the guard retries. */
  | { blocked: string };

export async function closeHeldForGuard(d: {
  held: HeldRow;
  ops: HeldOps;
  broker: Broker;
  mode: 'PAPER' | 'REAL';
  scope: PnfScope;
  /** The option's live premium (PAPER fill price, REAL marker estimate). */
  ltp: number | null;
  /** The option's exchange lot (PAPER units per lot) and rupees per point per lot. */
  lot: number | null;
  unitsPerLot: number | null;
  /** PAPER: book the close in the page's paper book (key = the option's targetKey). */
  paperClose: (key: string, deltaLots: number, price: number, unitsPerLot: number) => void;
  marker: (target: Target, action: PnfAction, price: number, lots: number, mode: 'PAPER' | 'REAL', estimate: boolean) => void;
  say: (kind: 'success' | 'warn' | 'info', text: string) => void;
}): Promise<HeldExitResult> {
  const h = d.held;
  if (!(h.units > 0)) return 'done';
  if (h.state !== 'open') return { blocked: `the last order on its option is ${h.state === 'unknown' ? 'UNKNOWN' : 'still being sent'} - settle it on the bar` };
  const side: PnfAction = h.action === 'BUY' ? 'SELL' : 'BUY';
  const what = `MTM guard close: ${side} ${h.units} units ${targetLabel(h.traded)}`;
  if (d.mode === 'PAPER') {
    const lots = d.lot && d.lot > 0 ? h.units / d.lot : 0;
    if (!(Number.isInteger(lots) && lots > 0) || !(d.unitsPerLot && d.unitsPerLot > 0)) return { blocked: 'the option\'s lot size is not known yet' };
    if (!(d.ltp != null && d.ltp > 0)) return { blocked: 'no live premium for its option yet' };
    const b = await d.ops.begin(h.id, -h.units);
    if (typeof b === 'string' || !b) return { blocked: b || 'the held-option ledger gave no row' };
    d.paperClose(targetKey(h.traded), side === 'BUY' ? lots : -lots, d.ltp, d.unitsPerLot);
    await d.ops.confirm(h.id);
    d.marker(h.traded, side, d.ltp, lots, 'PAPER', false);
    d.say('success', `[PAPER] ${what} @ ${d.ltp.toFixed(2)}`);
    return 'done';
  }
  const b = await d.ops.begin(h.id, -h.units);
  if (typeof b === 'string' || !b) return { blocked: b || 'the held-option ledger gave no row' };
  let j: Reply;
  try {
    const res = await fetch('/api/straddle-pnf/order', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ broker: d.broker, mode: 'REAL', target: h.traded, scope: d.scope, exitOwn: { side, units: [h.units], product: h.product } }),
    });
    j = await res.json() as Reply;
  } catch (err) {
    const msg = (err as Error).message;
    await d.ops.unknown(h.id, msg);
    d.say('warn', `${what}: status unknown - check Orders/Positions, then settle it on the bar (${msg})`);
    return 'sent';
  }
  const msg = j.message ?? j.error ?? j.outcome ?? 'no reply';
  if (j.outcome === 'placed') {
    const c = await d.ops.confirm(h.id);
    if (typeof c === 'string') d.say('warn', `${what} went through, but the held-option ledger could not be updated (${c}) - check Orders/Positions`);
    d.say('success', `[${BROKER_LABELS[d.broker].toUpperCase()}] ${what}. ${msg}`);
    if (d.ltp != null && d.ltp > 0) d.marker(h.traded, side, d.ltp, d.lot && d.lot > 0 ? h.units / d.lot : 1, 'REAL', true);
    return 'sent';
  }
  if (j.outcome === 'flat') {
    // the broker shows none of it in that direction: nothing of this chart's is open there - the row is forgotten
    const c = await d.ops.confirm(h.id);
    if (c && typeof c !== 'string') await d.ops.clear(h.id);
    d.say('info', `${what}: nothing of this chart's is open at ${BROKER_LABELS[d.broker]} - nothing was sent, the held option is forgotten`);
    return 'sent';
  }
  if (j.outcome === 'rejected' || (!j.success && !j.outcome)) {
    await d.ops.void(h.id);
    return { blocked: `the close was refused (${msg})` };
  }
  await d.ops.unknown(h.id, msg);
  d.say('warn', `${what}: ${msg} - check Orders/Positions, then settle it on the bar`);
  return 'sent';
}

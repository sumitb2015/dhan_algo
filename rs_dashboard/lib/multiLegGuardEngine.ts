// One evaluation pass of a basket's guards, as a pure function: it reads state, mutates only the small runtime maps it is
// handed (debounce clocks, retry spacing, announce-once state) and returns the EFFECTS the page should apply. Keeping the
// decisions here (not inside a React effect) is what lets the sequencing be tested; MultiLegFocus.tsx only supplies the
// inputs and performs the effects.

import type { MultiLegLeg } from './multiLegFocus.ts';
import {
  expireStaleGuards, guardsArmed, legsSettling, shortsSettling, spotActionLegs, stepSpotTrigger, stepGuard, readGreekBand,
  confirmBreach, lossLevel, lossRecovered, marginUtilisationPct, marginLevel, marginRecovered, nextAlarmState, GUARD_EXIT_RETRY_MS,
  type AlarmLevel, type BasketGuards, type NetGreeks,
} from './multiLegGuards.ts';

export interface GuardRuntime {
  since: Map<string, number>;
  lastAttempt: Map<string, number>;
  alarm: Map<string, AlarmLevel>;
  alerted: Set<string>;
}
export const newGuardRuntime = (): GuardRuntime => ({ since: new Map(), lastAttempt: new Map(), alarm: new Map(), alerted: new Set() });

export type GuardEffect =
  | { kind: 'patch'; fn: (g: BasketGuards) => BasketGuards }
  | { kind: 'toast'; title: string; detail: string }
  | { kind: 'exitAll' }
  | { kind: 'exitSide'; scope: MultiLegLeg[] };

export interface GuardInput {
  basketId: string;
  label: string;
  underlying: string;
  broker: string;
  legs: MultiLegLeg[];
  guards: BasketGuards;
  now: number;
  /** IST day (YYYY-MM-DD) of `now`. */
  today: string;
  /** Fresh underlying price, 0 when unknown or stale. */
  spot: number;
  /** An order action (place / exit / scale) is in flight on this row. */
  busy: boolean;
  /** Lazy: only called when a band needs it. Null when any open leg is unpriced or on an assumed IV. */
  netGreeks: () => NetGreeks | null;
  /** Lazy: strategy P&L in rupees on the given scope, null while any open leg is unpriced. */
  pnlRupees: (scope: 'today' | 'total') => number | null;
  /** Account funds for THIS basket's broker, null when unknown or that broker is not the one being polled. */
  funds: { available: number; used: number } | null;
  fmtMoney: (n: number) => string;
}

const dec = (n: number, metric: string) => n.toFixed(metric === 'gamma' ? 4 : 0);

export function evaluateBasketGuards(inp: GuardInput, rt: GuardRuntime): GuardEffect[] {
  const fx: GuardEffect[] = [];
  const { now, label, basketId } = inp;
  const iso = new Date(now).toISOString();
  const toast = (title: string, detail: string) => fx.push({ kind: 'toast', title, detail });
  let g = inp.guards;
  if (!guardsArmed(g)) return fx;

  // Day roll: yesterday's armed guards do not carry into today.
  const fresh = expireStaleGuards(g, inp.today);
  if (fresh) {
    fx.push({ kind: 'patch', fn: cur => expireStaleGuards(cur, inp.today) ?? cur });
    toast(`${label}: guards from an earlier day were disarmed`, 'Spot triggers, Greek bands and the loss alarm do not carry over a day. Re-arm them if you still want them.');
    g = fresh;
    if (!guardsArmed(g)) return fx;
  }

  const openLegs = inp.legs.filter(l => l.status === 'OPEN' && l.fill);
  if (openLegs.length === 0) {
    // Nothing left to protect: a guard that was already firing is done; the rest wait for a position. Not while an exit is
    // unconfirmed: it flips legs CLOSED on ACK and a rejection reopens them, which the guard must still see.
    if (legsSettling(inp.legs, 'EXIT_ALL', now)) return fx;
    if ((g.spotTriggers ?? []).some(t => t.armed && t.firedAt) || (g.greekBands ?? []).some(b => b.armed && b.firedAt) || (g.alarm?.armed && g.alarm.firedAt)) {
      fx.push({
        kind: 'patch', fn: gg => ({
          ...gg,
          spotTriggers: gg.spotTriggers?.map(t => (t.firedAt && t.armed ? { ...t, armed: false } : t)),
          greekBands: gg.greekBands?.map(b => (b.firedAt && b.armed ? { ...b, armed: false } : b)),
          ...(gg.alarm ? { alarm: gg.alarm.firedAt && gg.alarm.armed ? { ...gg.alarm, armed: false } : gg.alarm } : {}),
        }),
      });
    }
    return fx;
  }

  // 1. Spot triggers
  for (const t of g.spotTriggers ?? []) {
    const key = `${basketId}:${t.id}`;
    const scope = spotActionLegs(inp.legs, t.action);
    const step = stepSpotTrigger(t, inp.spot, now, {
      since: rt.since.get(key), lastAttempt: rt.lastAttempt.get(key), scopeOpen: scope.length, settling: legsSettling(inp.legs, t.action, now),
    });
    if (step.kind === 'watch') { rt.since.set(key, step.since); continue; }
    if (step.kind === 'idle') { if (!t.firedAt) rt.since.delete(key); continue; }
    if (step.kind === 'finish') {
      fx.push({ kind: 'patch', fn: gg => ({ ...gg, spotTriggers: gg.spotTriggers?.map(x => (x.id === t.id ? { ...x, armed: false } : x)) }) });
      rt.since.delete(key); rt.lastAttempt.delete(key);
      continue;
    }
    if (inp.busy) continue;   // an order action is in flight on this row: re-evaluate next tick
    const exits = t.action !== 'ALERT';
    // Only hedges left while a short's exit is still unconfirmed: wait, a rejection would reopen the short.
    if (exits && scope.length > 0 && scope.every(l => l.side === 'B') && shortsSettling(inp.legs, t.action, now)) continue;
    if (step.kind === 'fire') {
      rt.since.delete(key);
      fx.push({ kind: 'patch', fn: gg => ({ ...gg, spotTriggers: gg.spotTriggers?.map(x => (x.id === t.id ? { ...x, firedAt: iso } : x)) }) });
      const what = !exits ? 'alert'
        : t.action === 'EXIT_ALL' ? 'closing the whole strategy'
        : scope.length === 0 ? 'nothing open on that side'
        : `closing the ${t.action === 'EXIT_CE' ? 'call' : 'put'} side`;
      toast(`${label}: ${inp.underlying} ${t.dir} ${t.level} (spot ${inp.spot})`, `Spot trigger hit: ${what}.`);
      if (!exits || scope.length === 0) continue;
    }
    // fire (exit actions) and retry both send the exit now.
    rt.lastAttempt.set(key, now);
    fx.push(t.action === 'EXIT_ALL' ? { kind: 'exitAll' } : { kind: 'exitSide', scope });
  }

  // 2. Net-Greek bands
  const bands = (g.greekBands ?? []).filter(b => b.armed);
  if (bands.length) {
    const net = inp.netGreeks();
    for (const b of bands) {
      const key = `${basketId}:${b.id}`;
      const reading = readGreekBand(b, net);
      if (b.action === 'ALERT') {
        // Unknown Greeks (a leg briefly unpriced) change nothing: no reset, so the same breach is not announced twice.
        if (reading == null) continue;
        // A band is a standing monitor: announce once per breach, re-announce after it returns inside.
        const c = confirmBreach(rt.since.get(key), reading.breached, now);
        if (c.since == null) rt.since.delete(key); else rt.since.set(key, c.since);
        if (!reading.breached) rt.alerted.delete(key);
        else if (c.fire && !rt.alerted.has(key)) {
          rt.alerted.add(key);
          toast(`${label}: net ${b.metric} outside its band`, `Now ${dec(reading.value, b.metric)} (${reading.side === 'min' ? 'below min' : 'above max'} ${reading.side === 'min' ? b.min : b.max}).`);
        }
        continue;
      }
      const step = stepGuard(b, reading?.breached ?? false, true, now, {
        since: rt.since.get(key), lastAttempt: rt.lastAttempt.get(key), scopeOpen: openLegs.length, settling: legsSettling(inp.legs, 'EXIT_ALL', now),
      });
      if (step.kind === 'watch') { rt.since.set(key, step.since); continue; }
      if (step.kind === 'idle') { if (!b.firedAt) rt.since.delete(key); continue; }
      if (step.kind === 'finish') {
        fx.push({ kind: 'patch', fn: gg => ({ ...gg, greekBands: gg.greekBands?.map(x => (x.id === b.id ? { ...x, armed: false } : x)) }) });
        continue;
      }
      if (inp.busy) continue;
      if (openLegs.every(l => l.side === 'B') && shortsSettling(inp.legs, 'EXIT_ALL', now)) continue;
      if (step.kind === 'fire') {
        rt.since.delete(key);
        fx.push({ kind: 'patch', fn: gg => ({ ...gg, greekBands: gg.greekBands?.map(x => (x.id === b.id ? { ...x, firedAt: iso } : x)) }) });
        toast(`${label}: net ${b.metric} outside its band`, `Closing the whole strategy (now ${reading ? dec(reading.value, b.metric) : '?'}).`);
      }
      rt.lastAttempt.set(key, now);
      fx.push({ kind: 'exitAll' });
    }
  }

  // 3. Max-loss and margin alarm
  const alarm = g.alarm;
  if (alarm?.armed && alarm.firedAt) {
    // Closing: the max-loss exit has started. Finish it whatever the P&L does now; the no-open-legs branch above disarms the
    // alarm once it is flat and settled, so a leg added later is not closed by a loss that was already realized.
    const lossKey = `loss:${basketId}`;
    // Only hedges left while a short's exit is still unconfirmed: wait, a rejection would reopen the short.
    if (openLegs.every(l => l.side === 'B') && shortsSettling(inp.legs, 'EXIT_ALL', now)) return fx;
    const last = rt.lastAttempt.get(lossKey);
    if (!inp.busy && (last == null || now - last >= GUARD_EXIT_RETRY_MS)) { rt.lastAttempt.set(lossKey, now); fx.push({ kind: 'exitAll' }); }
    return fx;
  }
  if (alarm?.armed) {
    const lossKey = `loss:${basketId}`;
    const pnl = inp.pnlRupees(alarm.lossScope ?? 'today');
    if (pnl != null) {
      const level = lossLevel(pnl, alarm);
      const prev = rt.alarm.get(lossKey) ?? 'ok';
      const { state, announce } = nextAlarmState(prev, level, lossRecovered(pnl, alarm, prev));
      rt.alarm.set(lossKey, state);
      if (announce) {
        toast(level === 'breach' ? `${label}: MAX LOSS reached` : `${label}: approaching max loss`,
          `P&L ${inp.fmtMoney(pnl)} against a max loss of ${inp.fmtMoney(alarm.maxLoss ?? 0)}.${level === 'breach' && alarm.exitAtMaxLoss ? ' Closing the strategy.' : ''}`);
      }
      if (level === 'breach' && alarm.exitAtMaxLoss && !inp.busy) {
        rt.lastAttempt.set(lossKey, now);
        fx.push({ kind: 'patch', fn: gg => (gg.alarm ? { ...gg, alarm: { ...gg.alarm, firedAt: iso } } : gg) });
        fx.push({ kind: 'exitAll' });
      }
    }
    if (alarm.marginWarnPct != null && inp.funds) {
      // Per basket, not per broker: two baskets with different thresholds each keep their own announce state, so one
      // cannot reset the other's every tick.
      const mKey = `margin:${basketId}`;
      const util = marginUtilisationPct(inp.funds);
      const level = marginLevel(util, alarm);
      const prev = rt.alarm.get(mKey) ?? 'ok';
      const { state, announce } = nextAlarmState(prev, level, util == null ? false : marginRecovered(util, alarm));
      rt.alarm.set(mKey, state);
      if (announce && util != null) {
        toast(`${label}: margin buffer thin on ${inp.broker}`, `${util.toFixed(0)}% of margin is in use (alarm at ${alarm.marginWarnPct}%). ${inp.fmtMoney(inp.funds.available)} still available.`);
      }
    }
  }
  return fx;
}

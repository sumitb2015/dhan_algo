// One evaluation pass of a basket's guards, as a pure function: it reads state, mutates only the small runtime maps it is
// handed (debounce clocks, retry spacing, announce-once state) and returns the EFFECTS the page should apply. Keeping the
// decisions here (not inside a React effect) is what lets the sequencing be tested; MultiLegFocus.tsx only supplies the
// inputs and performs the effects.

import type { MultiLegLeg } from './multiLegFocus.ts';
import {
  expireStaleGuards, guardsArmed, normalizeGuards, lossRuleDisarmedByMigration, legsSettling, shortsSettling, spotActionLegs, stepSpotTrigger, stepGuard, readGreekBand,
  confirmBreach, legRuleTargetable, legRuleLabel, legLevelBreached, hedgeHeldOpen, lossLevel, lossRecovered, marginUtilisationPct, marginLevel, marginRecovered, nextAlarmState, GUARD_EXIT_RETRY_MS, DEFAULT_WARN_PCT,
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
  | { kind: 'exitSide'; scope: MultiLegLeg[] }
  | { kind: 'exitLeg'; leg: MultiLegLeg };

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
  /** Lazy: today's strategy P&L in rupees (open legs plus legs closed today), null while any open leg is unpriced. */
  pnlToday: () => number | null;
  /** Account funds for THIS basket's broker, null when unknown or that broker is not the one being polled. */
  funds: { available: number; used: number } | null;
  fmtMoney: (n: number) => string;
  /** Live price of one leg, 0 when unknown. */
  legLtp: (leg: MultiLegLeg) => number;
  /** One open leg's P&L in rupees (multiplier applied), null while it has no live price. */
  legPnl: (leg: MultiLegLeg) => number | null;
  /** An exit is already in flight on this leg (any surface). */
  legBusy: (legId: string) => boolean;
}

const dec = (n: number, metric: string) => n.toFixed(metric === 'gamma' ? 4 : 0);

export function evaluateBasketGuards(inp: GuardInput, rt: GuardRuntime): GuardEffect[] {
  const fx: GuardEffect[] = [];
  const { now, label, basketId } = inp;
  const iso = new Date(now).toISOString();
  const toast = (title: string, detail: string) => fx.push({ kind: 'toast', title, detail });
  if (!guardsArmed(inp.guards)) return fx;

  // Older saves: move margin out of the loss rule, drop the retired knobs (see normalizeGuards) and store the result.
  let g = normalizeGuards(inp.guards);
  if (g !== inp.guards) {
    fx.push({ kind: 'patch', fn: cur => normalizeGuards(cur) });
    if (lossRuleDisarmedByMigration(inp.guards, g)) {
      toast(`${label}: max-loss rule turned off`, `It now counts today's P&L only and gives a heads-up at ${DEFAULT_WARN_PCT}%. Check it and turn it on again.`);
    }
    if (!guardsArmed(g)) return fx;
  }

  // Day roll: yesterday's armed guards do not carry into today.
  const fresh = expireStaleGuards(g, inp.today);
  if (fresh) {
    fx.push({ kind: 'patch', fn: cur => expireStaleGuards(cur, inp.today) ?? cur });
    toast(`${label}: yesterday's risk rules were turned off`, 'Rules do not carry over to a new day. Turn them on again if you still want them.');
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
    // A leg rule's leg is closed too: nothing left to watch.
    if ((g.legRules ?? []).some(r => r.armed)) {
      fx.push({ kind: 'patch', fn: gg => ({ ...gg, legRules: gg.legRules?.map(r => (r.armed ? { ...r, armed: false } : r)) }) });
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
      toast(`${label}: ${inp.underlying} ${t.dir} ${t.level} (spot ${inp.spot})`, `Spot rule hit: ${what}.`);
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
          toast(`${label}: net ${b.metric} outside its limits`, `Now ${dec(reading.value, b.metric)} (${reading.side === 'min' ? 'below the lower limit' : 'above the upper limit'} ${reading.side === 'min' ? b.min : b.max}).`);
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
        toast(`${label}: net ${b.metric} outside its limits`, `Closing the whole strategy (now ${reading ? dec(reading.value, b.metric) : '?'}).`);
      }
      rt.lastAttempt.set(key, now);
      fx.push({ kind: 'exitAll' });
    }
  }

  // 3. Leg rules: one leg, its own reading, and an exit that closes only that leg.
  for (const r of g.legRules ?? []) {
    if (!r.armed) continue;
    const key = `leg:${basketId}:${r.id}`;
    const leg = inp.legs.find(l => l.id === r.legId);
    if (!legRuleTargetable(leg)) {
      // The leg closed (or moved to another group): nothing left to watch. Not while its exit is still unconfirmed, a
      // rejected exit reopens it and a firing rule must still be there to retry.
      if (leg && legsSettling([leg], 'EXIT_ALL', now)) continue;
      fx.push({ kind: 'patch', fn: gg => ({ ...gg, legRules: gg.legRules?.map(x => (x.id === r.id ? { ...x, armed: false } : x)) }) });
      rt.since.delete(key); rt.lastAttempt.delete(key); rt.alarm.delete(key); rt.alerted.delete(key); rt.alerted.delete(`${key}:held`);
      continue;
    }
    const name = `${label}: ${legRuleLabel(leg)}`;
    const legBusy = inp.busy || inp.legBusy(leg.id);
    /** Sends the exit for this leg, spaced by the retry window. A hedge waits (one notice) while a short on its side is open. */
    const sendExit = () => {
      if (legBusy) return;
      if (hedgeHeldOpen(leg, inp.legs)) {
        if (!rt.alerted.has(`${key}:held`)) {
          rt.alerted.add(`${key}:held`);
          toast(`${name}: waiting to close`, 'A short on the same side is still open, so this hedge stays until that short is closed.');
        }
        return;
      }
      rt.alerted.delete(`${key}:held`);
      const last = rt.lastAttempt.get(key);
      if (last != null && now - last < GUARD_EXIT_RETRY_MS) return;
      rt.lastAttempt.set(key, now);
      fx.push({ kind: 'exitLeg', leg });
    };
    const stamp = () => fx.push({ kind: 'patch', fn: gg => ({ ...gg, legRules: gg.legRules?.map(x => (x.id === r.id ? { ...x, firedAt: iso } : x)) }) });

    // Firing: keep closing until the leg is flat (the branch above turns the rule off then), whatever the reading does now.
    if (r.firedAt) {
      if (r.action === 'EXIT_LEG') sendExit();
      continue;
    }

    if (r.kind === 'loss') {
      const pnl = inp.legPnl(leg);
      if (pnl == null) continue;
      const limit = { maxLoss: r.level };
      const level = lossLevel(pnl, limit);
      const prev = rt.alarm.get(key) ?? 'ok';
      const { state, announce } = nextAlarmState(prev, level, lossRecovered(pnl, limit, prev));
      rt.alarm.set(key, state);
      const exits = r.action === 'EXIT_LEG';
      if (announce) {
        toast(level === 'breach' ? `${name}: loss limit reached` : `${name}: approaching its loss limit`,
          `Leg P&L ${inp.fmtMoney(pnl)} against a limit of ${inp.fmtMoney(r.level ?? 0)}.${level === 'breach' && exits ? ' Closing this leg.' : ''}`);
      }
      if (level === 'breach' && exits && !legBusy) { stamp(); sendExit(); }
      continue;
    }

    const reading = r.kind === 'spot' ? inp.spot : inp.legLtp(leg);
    // Unknown reading: restart the confirmation clock (a breach seen before a price gap must be seen again for the full
    // window before it acts) but keep the announce-once state, so the same crossing is not announced twice.
    if (!(reading > 0)) { rt.since.delete(key); continue; }
    const breached = legLevelBreached(r, reading);
    const c = confirmBreach(rt.since.get(key), breached, now);
    if (c.since == null) rt.since.delete(key); else rt.since.set(key, c.since);
    if (!breached) { rt.alerted.delete(key); continue; }
    if (!c.fire) continue;
    const what = `${r.kind === 'spot' ? `${inp.underlying} spot` : 'Leg price'} ${(r.dir ?? 'above') === 'above' ? 'above' : 'below'} ${r.level} (now ${reading})`;
    if (r.action === 'ALERT') {
      // A standing monitor: announce once per crossing, again after it comes back.
      if (!rt.alerted.has(key)) { rt.alerted.add(key); toast(`${name}: ${what}`, 'Leg rule hit (alert only).'); }
      continue;
    }
    if (legBusy) continue;   // re-evaluated next tick; the breach clock keeps running
    rt.since.delete(key);
    stamp();
    toast(`${name}: ${what}`, 'Leg rule hit: closing this leg.');
    sendExit();
  }

  // 4. Margin-use alert (account-wide, alert only). Per basket, not per broker: two baskets with different levels each keep
  // their own announce state, so one cannot reset the other's every tick.
  const m = g.marginAlarm;
  if (m?.armed && m.pct != null && m.pct > 0 && inp.funds) {
    const mKey = `margin:${basketId}`;
    const util = marginUtilisationPct(inp.funds);
    const level = marginLevel(util, m);
    const prev = rt.alarm.get(mKey) ?? 'ok';
    const { state, announce } = nextAlarmState(prev, level, util == null ? false : marginRecovered(util, m));
    rt.alarm.set(mKey, state);
    if (announce && util != null) {
      toast(`${label}: margin buffer thin on ${inp.broker}`, `${util.toFixed(0)}% of margin is in use (alert at ${m.pct}%). ${inp.fmtMoney(inp.funds.available)} still available.`);
    }
  }

  // 5. Max-loss rule
  const alarm = g.alarm;
  const lossKey = `loss:${basketId}`;
  if (alarm?.armed && alarm.firedAt) {
    // Closing: the max-loss exit has started. Finish it whatever the P&L does now; the no-open-legs branch above disarms the
    // alarm once it is flat and settled, so a leg added later is not closed by a loss that was already realized.
    // Only hedges left while a short's exit is still unconfirmed: wait, a rejection would reopen the short.
    if (openLegs.every(l => l.side === 'B') && shortsSettling(inp.legs, 'EXIT_ALL', now)) return fx;
    const last = rt.lastAttempt.get(lossKey);
    if (!inp.busy && (last == null || now - last >= GUARD_EXIT_RETRY_MS)) { rt.lastAttempt.set(lossKey, now); fx.push({ kind: 'exitAll' }); }
    return fx;
  }
  if (alarm?.armed) {
    const pnl = inp.pnlToday();
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
  }
  return fx;
}

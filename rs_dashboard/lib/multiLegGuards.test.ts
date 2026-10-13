import test from 'node:test';
import assert from 'node:assert/strict';
import {
  spotBreached, spotArmBlocker, spotActionLegs, confirmBreach, stepSpotTrigger, stepGuard, readGreekBand, greekBandInvalid,
  lossLevel, marginUtilisationPct, marginLevel, nextAlarmState, lossRecovered, marginRecovered, guardsArmed, disarmGuards,
  SPOT_CONFIRM_MS, GUARD_EXIT_RETRY_MS, type SpotTrigger,
} from './multiLegGuards.ts';
import { LEG_FILL_GRACE_MS, type MultiLegLeg } from './multiLegFocus.ts';
import {
  legsSettling, shortsSettling, exitSide, addSpotTrigger, removeSpotTrigger, editSpotTrigger, setSpotArmed,
  addGreekBand, editGreekBand, setBandArmed, editAlarm, setAlarmArmed, type BasketGuards, type SideExitDeps,
} from './multiLegGuards.ts';


const leg = (id: string, side: 'B' | 'S', option: 'CE' | 'PE' | 'FUT', status = 'OPEN', fill = true) =>
  ({ id, side, option, strike: 24000, status, fill: fill ? { qty: 75, avgPrice: 100 } : undefined, lots: 1 }) as unknown as MultiLegLeg;

const trig = (o: Partial<SpotTrigger> = {}): SpotTrigger => ({ id: 't', level: 24500, dir: 'above', action: 'EXIT_CE', armed: true, ...o });

test('spotBreached: direction, inclusive edge, unknown spot is never a breach', () => {
  assert.equal(spotBreached(trig(), 24499.9), false);
  assert.equal(spotBreached(trig(), 24500), true);
  assert.equal(spotBreached(trig({ dir: 'below', level: 24000 }), 24000), true);
  assert.equal(spotBreached(trig({ dir: 'below', level: 24000 }), 24001), false);
  for (const bad of [0, -1, NaN, undefined, null]) assert.equal(spotBreached(trig(), bad as number), false);
  assert.equal(spotBreached(trig({ level: 0 }), 24600), false);
});

test('spotArmBlocker refuses a level already crossed, a missing spot and a bad level', () => {
  assert.match(spotArmBlocker(trig(), 24600)!, /already above/);
  assert.match(spotArmBlocker(trig(), 0)!, /No live spot/);
  assert.match(spotArmBlocker(trig({ level: 0 }), 24000)!, /level/);
  assert.equal(spotArmBlocker(trig(), 24000), null);
});

test('spotActionLegs: scope by side, shorts first, only open filled option legs', () => {
  const legs = [leg('a', 'B', 'CE'), leg('b', 'S', 'CE'), leg('c', 'S', 'PE'), leg('d', 'S', 'CE', 'CLOSED'),
    leg('e', 'S', 'CE', 'OPEN', false), leg('f', 'S', 'FUT')];
  assert.deepEqual(spotActionLegs(legs, 'EXIT_CE').map(l => l.id), ['b', 'a']);
  assert.deepEqual(spotActionLegs(legs, 'EXIT_PE').map(l => l.id), ['c']);
  assert.deepEqual(spotActionLegs(legs, 'EXIT_ALL').map(l => l.id), ['b', 'c', 'a']);
  assert.deepEqual(spotActionLegs(legs, 'ALERT'), []);
});

test('confirmBreach needs the breach to last, and resets when it clears', () => {
  assert.deepEqual(confirmBreach(undefined, true, 1000), { since: 1000, fire: false });
  assert.equal(confirmBreach(1000, true, 1000 + SPOT_CONFIRM_MS).fire, true);
  assert.deepEqual(confirmBreach(1000, false, 2000), { since: undefined, fire: false });
});

test('stepSpotTrigger: watch -> fire -> retry spacing -> finish', () => {
  const t = trig();
  assert.deepEqual(stepSpotTrigger(t, 24000, 0, { scopeOpen: 2 }), { kind: 'idle' });
  assert.deepEqual(stepSpotTrigger(t, 24600, 0, { scopeOpen: 2 }), { kind: 'watch', since: 0 });
  assert.deepEqual(stepSpotTrigger(t, 24600, SPOT_CONFIRM_MS, { since: 0, scopeOpen: 2 }), { kind: 'fire' });
  // a bounce back under the level before confirmation cancels the watch
  assert.deepEqual(stepSpotTrigger(t, 24400, 1000, { since: 0, scopeOpen: 2 }), { kind: 'idle' });
  const fired = trig({ firedAt: 'x' });
  // firing ignores spot: keep exiting even if it came back under the level
  assert.deepEqual(stepSpotTrigger(fired, 24000, 100, { lastAttempt: 100, scopeOpen: 1 }), { kind: 'idle' });
  assert.deepEqual(stepSpotTrigger(fired, 24000, 100 + GUARD_EXIT_RETRY_MS, { lastAttempt: 100, scopeOpen: 1 }), { kind: 'retry' });
  assert.deepEqual(stepSpotTrigger(fired, 24000, 0, { scopeOpen: 0 }), { kind: 'finish' });
  assert.deepEqual(stepSpotTrigger(trig({ armed: false }), 24600, 0, { scopeOpen: 1 }), { kind: 'idle' });
});

test('an ALERT trigger finishes right after it fires', () => {
  assert.deepEqual(stepSpotTrigger(trig({ action: 'ALERT', firedAt: 'x' }), 24000, 0, { scopeOpen: 0 }), { kind: 'finish' });
  assert.deepEqual(stepGuard({ armed: true, firedAt: 'x' }, false, false, 0, { scopeOpen: 5 }), { kind: 'finish' });
});

test('readGreekBand: min/max/both, unknown net, NaN', () => {
  const net = { delta: -120, gamma: 0.5, theta: 4000, vega: -9000 };
  assert.deepEqual(readGreekBand({ metric: 'delta', min: -100 }, net), { value: -120, breached: true, side: 'min' });
  assert.deepEqual(readGreekBand({ metric: 'delta', min: -200, max: 50 }, net), { value: -120, breached: false });
  assert.deepEqual(readGreekBand({ metric: 'vega', max: -10000 }, net), { value: -9000, breached: true, side: 'max' });
  assert.equal(readGreekBand({ metric: 'delta', min: -1 }, null), null);
  assert.equal(readGreekBand({ metric: 'delta', min: -1 }, { ...net, delta: NaN }), null);
  assert.deepEqual(readGreekBand({ metric: 'delta' }, net), { value: -120, breached: false });
});

test('greekBandInvalid', () => {
  assert.match(greekBandInvalid({})!, /min, a max/);
  assert.match(greekBandInvalid({ min: 5, max: 1 })!, /above max/);
  assert.equal(greekBandInvalid({ min: -5, max: 5 }), null);
  assert.equal(greekBandInvalid({ max: 0 }), null);
});

test('lossLevel: warn at warnPct, breach at maxLoss, unknown reads ok', () => {
  const a = { maxLoss: 10000, warnPct: 80 };
  assert.equal(lossLevel(-7999, a), 'ok');
  assert.equal(lossLevel(-8000, a), 'warn');
  assert.equal(lossLevel(-10000, a), 'breach');
  assert.equal(lossLevel(5000, a), 'ok');
  assert.equal(lossLevel(NaN, a), 'ok');
  assert.equal(lossLevel(-99999, { maxLoss: 0 }), 'ok');
  assert.equal(lossLevel(-8000, { maxLoss: 10000 }), 'warn');           // default 80
  assert.equal(lossLevel(-5000, { maxLoss: 10000, warnPct: 50 }), 'warn');
  assert.equal(lossLevel(-5000, { maxLoss: 10000, warnPct: 120 }), 'ok'); // nonsense warnPct falls back to the default
});

test('margin utilisation and level', () => {
  assert.equal(marginUtilisationPct({ available: 20000, used: 80000 }), 80);
  assert.equal(marginUtilisationPct({ available: 0, used: 0 }), null);
  assert.equal(marginUtilisationPct({ available: -1, used: 5 }), null);
  assert.equal(marginUtilisationPct(null), null);
  assert.equal(marginLevel(80, { marginWarnPct: 80 }), 'warn');
  assert.equal(marginLevel(79.9, { marginWarnPct: 80 }), 'ok');
  assert.equal(marginLevel(null, { marginWarnPct: 80 }), 'ok');
  assert.equal(marginLevel(99, {}), 'ok');
});

test('nextAlarmState announces escalations once and needs recovery to step down', () => {
  assert.deepEqual(nextAlarmState('ok', 'warn', false), { state: 'warn', announce: true });
  assert.deepEqual(nextAlarmState('warn', 'warn', false), { state: 'warn', announce: false });
  assert.deepEqual(nextAlarmState('warn', 'breach', false), { state: 'breach', announce: true });
  assert.deepEqual(nextAlarmState('warn', 'ok', false), { state: 'warn', announce: false });   // hovering: stays announced
  assert.deepEqual(nextAlarmState('warn', 'ok', true), { state: 'ok', announce: false });
  assert.deepEqual(nextAlarmState('ok', 'warn', false), { state: 'warn', announce: true });    // after recovery it announces again
});

test('hysteresis helpers', () => {
  const a = { maxLoss: 10000, warnPct: 80 };
  assert.equal(lossRecovered(-7900, a, 'warn'), false);   // 79% > 75%
  assert.equal(lossRecovered(-7500, a, 'warn'), true);
  assert.equal(lossRecovered(-9600, a, 'breach'), false); // 96% > 95%
  assert.equal(lossRecovered(-9500, a, 'breach'), true);
  assert.equal(marginRecovered(76, { marginWarnPct: 80 }), false);
  assert.equal(marginRecovered(75, { marginWarnPct: 80 }), true);
});

test('guardsArmed / disarmGuards: everything off, firedAt cleared, config kept', () => {
  assert.equal(guardsArmed(undefined), false);
  const g = {
    spotTriggers: [trig({ firedAt: 'x' })],
    greekBands: [{ id: 'b', metric: 'delta' as const, max: 5, action: 'ALERT' as const, armed: true }],
    alarm: { armed: true, maxLoss: 100 },
  };
  assert.equal(guardsArmed(g), true);
  const off = disarmGuards(g)!;
  assert.equal(guardsArmed(off), false);
  assert.equal(off.spotTriggers![0].firedAt, undefined);
  assert.equal(off.spotTriggers![0].level, 24500);
  assert.equal(off.alarm!.maxLoss, 100);
  assert.equal(disarmGuards(undefined), undefined);
});

// ── Review fixes: confirmed hedge exits, settle-before-finish, no whole-object edits ──

const NOW = 1_800_000_000_000;
const withLeg = (id: string, side: 'B' | 'S', option: 'CE' | 'PE', o: Record<string, unknown> = {}) =>
  ({ ...leg(id, side, option), ...o }) as unknown as MultiLegLeg;

test('legsSettling: a pending order or a just-closed leg is settling, scoped to the side', () => {
  const pend = withLeg('a', 'S', 'CE', { status: 'CLOSED', pendingOrders: [{ kind: 'exit' }] });
  const fresh = withLeg('b', 'S', 'PE', { status: 'CLOSED', closedAt: NOW - 1000 });
  const old = withLeg('c', 'S', 'CE', { status: 'CLOSED', closedAt: NOW - LEG_FILL_GRACE_MS - 1 });
  assert.equal(legsSettling([pend], 'EXIT_CE', NOW), true);
  assert.equal(legsSettling([pend], 'EXIT_PE', NOW), false);          // other side
  assert.equal(legsSettling([pend], 'EXIT_ALL', NOW), true);
  assert.equal(legsSettling([fresh], 'EXIT_PE', NOW), true);
  assert.equal(legsSettling([old], 'EXIT_CE', NOW), false);
  assert.equal(legsSettling([withLeg('d', 'S', 'CE', { status: 'OPEN' })], 'EXIT_CE', NOW), false);
  // A resting limit exit leaves the leg OPEN and must not hold a guard back.
  assert.equal(legsSettling([withLeg('r', 'S', 'CE', { status: 'OPEN', pendingOrders: [{ kind: 'exit', resting: true }] })], 'EXIT_CE', NOW), false);
  assert.equal(legsSettling([withLeg('f', 'S', 'FUT' as 'CE', { pendingOrders: [{}] })], 'EXIT_ALL', NOW), false);
});

test('stepGuard: an exit that is flat but still settling does not finish; it finishes once settled', () => {
  const fired = trig({ firedAt: 'x' });
  assert.deepEqual(stepSpotTrigger(fired, 24000, NOW, { scopeOpen: 0, settling: true }), { kind: 'idle' });
  assert.deepEqual(stepSpotTrigger(fired, 24000, NOW, { scopeOpen: 0, settling: false }), { kind: 'finish' });
  assert.deepEqual(stepSpotTrigger(fired, 24000, NOW, { scopeOpen: 0 }), { kind: 'finish' });
  // a rejected exit reopens the leg: scope is open again, so the trigger retries instead of having disarmed
  assert.deepEqual(stepSpotTrigger(fired, 24000, NOW, { scopeOpen: 1, settling: false, lastAttempt: NOW - GUARD_EXIT_RETRY_MS }), { kind: 'retry' });
  // an alert never waits
  assert.deepEqual(stepSpotTrigger(trig({ action: 'ALERT', firedAt: 'x' }), 24000, NOW, { scopeOpen: 0, settling: true }), { kind: 'finish' });
});

test('shortsSettling only looks at short legs', () => {
  const longPending = withLeg('l', 'B', 'CE', { status: 'CLOSED', pendingOrders: [{}] });
  const shortPending = withLeg('s', 'S', 'CE', { status: 'CLOSED', pendingOrders: [{}] });
  assert.equal(shortsSettling([longPending], 'EXIT_CE', NOW), false);
  assert.equal(shortsSettling([longPending, shortPending], 'EXIT_CE', NOW), true);
});

type L = { id: string; side: 'B' | 'S' };
function sideDeps(over: Partial<SideExitDeps<L>> & { results?: Record<string, { closed: boolean; maxAfter?: number }> } = {}) {
  const sent: string[] = [];
  const confirmed: string[][] = [];
  const deps: SideExitDeps<L> = {
    exitLeg: async l => { sent.push(l.id); return over.results?.[l.id] ?? { closed: true, maxAfter: 0 }; },
    isBusy: over.isBusy ?? (() => false),
    confirmShortsDown: over.confirmShortsDown ?? (async items => { confirmed.push(items.map(i => i.leg.id)); return true; }),
  };
  return { deps, sent, confirmed };
}
const S1: L = { id: 's1', side: 'S' }, S2: L = { id: 's2', side: 'S' }, H1: L = { id: 'h1', side: 'B' };

test('exitSide: shorts exit first, hedge only after the broker confirms the shorts are down', async () => {
  const { deps, sent, confirmed } = sideDeps();
  assert.equal(await exitSide([H1, S1, S2], deps), 'done');
  assert.deepEqual(sent, ['s1', 's2', 'h1']);
  assert.deepEqual(confirmed, [['s1', 's2']]);
});

test('exitSide: a short that is not ACKed closed keeps every hedge', async () => {
  const { deps, sent } = sideDeps({ results: { s2: { closed: false } } });
  assert.equal(await exitSide([S1, S2, H1], deps), 'short_not_closed');
  assert.ok(!sent.includes('h1'));
});

test('exitSide: ACKed but not confirmed at the broker keeps the hedge (the rejected-exit case)', async () => {
  const { deps, sent } = sideDeps({ confirmShortsDown: async () => false });
  assert.equal(await exitSide([S1, H1], deps), 'shorts_unconfirmed');
  assert.deepEqual(sent, ['s1']);
});

test('exitSide: a short already being exited elsewhere is busy and keeps the hedge', async () => {
  const { deps, sent } = sideDeps({ isBusy: l => l.id === 's1' });
  assert.equal(await exitSide([S1, H1], deps), 'short_busy');
  assert.deepEqual(sent, []);
});

test('exitSide: a throwing exit is a failed exit, not an unhandled rejection', async () => {
  const { deps, sent } = sideDeps();
  deps.exitLeg = async l => { sent.push(l.id); throw new Error('boom'); };
  assert.equal(await exitSide([S1, H1], deps), 'short_not_closed');
  assert.deepEqual(sent, ['s1']);
});

test('exitSide: no hedges means no confirmation round trip; a flat short (no order sent) needs none', async () => {
  const a = sideDeps();
  assert.equal(await exitSide([S1], a.deps), 'done');
  assert.deepEqual(a.confirmed, []);
  const b = sideDeps({ results: { s1: { closed: true } } });          // already flat: no maxAfter
  assert.equal(await exitSide([S1, H1], b.deps), 'done');
  assert.deepEqual(b.confirmed, []);
  assert.deepEqual(b.sent, ['s1', 'h1']);
});

test('exitSide: hedges only (shorts closed on an earlier attempt) still exit', async () => {
  const { deps, sent } = sideDeps();
  assert.equal(await exitSide([H1], deps), 'done');
  assert.deepEqual(sent, ['h1']);
});

test('reducers touch only the named item, so an edit cannot revert what the watcher wrote', () => {
  // The watcher fired T1 (firedAt set) and a stale panel then edits band B1. T1 must come through untouched.
  const watcherWrote: BasketGuards = {
    spotTriggers: [trig({ id: 'T1', firedAt: 'iso', armed: true }), trig({ id: 'T2', armed: true })],
    greekBands: [{ id: 'B1', metric: 'delta', max: 5, action: 'ALERT', armed: true }],
    alarm: { armed: true, maxLoss: 100 },
  };
  const edited = editGreekBand(watcherWrote, 'B1', { max: 9 });
  assert.equal(edited.spotTriggers, watcherWrote.spotTriggers);        // same reference: untouched
  assert.equal(edited.alarm, watcherWrote.alarm);
  assert.equal(edited.greekBands![0].max, 9);
  assert.equal(edited.greekBands![0].armed, false);                    // any edit disarms

  const t2 = editSpotTrigger(watcherWrote, 'T2', { level: 25000 });
  assert.equal(t2.spotTriggers![0], watcherWrote.spotTriggers![0]);    // T1 (firing) is the same object
  assert.equal(t2.spotTriggers![0].firedAt, 'iso');
  assert.equal(t2.spotTriggers![1].armed, false);
  assert.equal(t2.greekBands, watcherWrote.greekBands);
});

test('reducers: add / remove / arm / alarm', () => {
  let g: BasketGuards = {};
  g = addSpotTrigger(g, trig({ id: 'a', armed: false, firedAt: 'x' }));
  g = setSpotArmed(g, 'a', true);
  assert.equal(g.spotTriggers![0].armed, true);
  assert.equal(g.spotTriggers![0].firedAt, undefined);                 // re-arming clears the old firing
  g = removeSpotTrigger(g, 'a');
  assert.deepEqual(g.spotTriggers, []);
  g = addGreekBand(g, { id: 'b', metric: 'delta', action: 'ALERT', armed: false });
  g = setBandArmed(g, 'b', true);
  assert.equal(g.greekBands![0].armed, true);
  g = editAlarm(g, { maxLoss: 500 });
  assert.equal(g.alarm!.armed, false);
  assert.equal(g.alarm!.maxLoss, 500);
  g = setAlarmArmed(g, true);
  assert.equal(g.alarm!.armed, true);
  g = editAlarm(g, { warnPct: 70 });
  assert.equal(g.alarm!.armed, false);
  assert.equal(g.alarm!.maxLoss, 500);
});

import { expireStaleGuards, istDayOf } from './multiLegGuards.ts';

test('istDayOf rolls at IST midnight', () => {
  assert.equal(istDayOf(Date.UTC(2026, 9, 11, 18, 29, 59)), '2026-10-11');
  assert.equal(istDayOf(Date.UTC(2026, 9, 11, 18, 30, 0)), '2026-10-12');
});

test('expireStaleGuards: only armed guards from another day (or unstamped) go off; null when nothing is stale', () => {
  const g: BasketGuards = {
    spotTriggers: [trig({ id: 'a', armedDay: '2026-10-12' }), trig({ id: 'b', armedDay: '2026-10-09', firedAt: 'x' }), trig({ id: 'c', armed: false, armedDay: '2026-10-01' })],
    greekBands: [{ id: 'g', metric: 'delta', max: 5, action: 'ALERT', armed: true }],
    alarm: { armed: true, armedDay: '2026-10-12', maxLoss: 1 },
  };
  const out = expireStaleGuards(g, '2026-10-12')!;
  assert.equal(out.spotTriggers![0], g.spotTriggers![0]);                                   // today's: same object
  assert.equal(out.spotTriggers![1].armed, false);
  assert.equal(out.spotTriggers![1].firedAt, undefined);
  assert.equal(out.greekBands![0].armed, false);                                            // unstamped = stale
  assert.equal(out.alarm, g.alarm);
  assert.equal(expireStaleGuards(out, '2026-10-12'), null);
  assert.equal(expireStaleGuards(undefined, '2026-10-12'), null);
});

test('arming stamps the day; disarming clears it', () => {
  let g: BasketGuards = { spotTriggers: [trig({ id: 'a', armed: false })], greekBands: [{ id: 'b', metric: 'delta', max: 1, action: 'ALERT', armed: false }] };
  g = setSpotArmed(g, 'a', true, '2026-10-12');
  g = setBandArmed(g, 'b', true, '2026-10-12');
  g = setAlarmArmed(g, true, '2026-10-12');
  assert.equal(g.spotTriggers![0].armedDay, '2026-10-12');
  assert.equal(g.greekBands![0].armedDay, '2026-10-12');
  assert.equal(g.alarm!.armedDay, '2026-10-12');
  g = setSpotArmed(g, 'a', false);
  assert.equal(g.spotTriggers![0].armedDay, undefined);
});

test('exitSide: a short already being exited elsewhere is "busy" (not a failure); a real failure still wins', async () => {
  const a = sideDeps({ isBusy: l => l.id === 's1' });
  assert.equal(await exitSide([S1, H1], a.deps), 'short_busy');
  assert.deepEqual(a.sent, []);
  const b = sideDeps({ isBusy: l => l.id === 's1', results: { s2: { closed: false } } });
  assert.equal(await exitSide([S1, S2, H1], b.deps), 'short_not_closed');
  assert.deepEqual(b.sent, ['s2']);                                                                  // the other short was still attempted
});

test('alarm edits and arming clear firedAt; disarmGuards clears it too', () => {
  const g: BasketGuards = { alarm: { armed: true, maxLoss: 100, exitAtMaxLoss: true, firedAt: 'x' } };
  assert.equal(editAlarm(g, { maxLoss: 200 }).alarm!.firedAt, undefined);
  assert.equal(setAlarmArmed(g, true, '2026-10-12').alarm!.firedAt, undefined);
  assert.equal(disarmGuards(g)!.alarm!.firedAt, undefined);
});

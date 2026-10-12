import test from 'node:test';
import assert from 'node:assert/strict';
import {
  spotBreached, spotArmBlocker, spotActionLegs, confirmBreach, stepSpotTrigger, stepGuard, readGreekBand, greekBandInvalid,
  lossLevel, marginUtilisationPct, marginLevel, nextAlarmState, lossRecovered, marginRecovered, guardsArmed, disarmGuards,
  SPOT_CONFIRM_MS, GUARD_EXIT_RETRY_MS, type SpotTrigger,
} from './multiLegGuards.ts';
import type { MultiLegLeg } from './multiLegFocus.ts';

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

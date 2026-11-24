import test from 'node:test';
import assert from 'node:assert/strict';
import { orbAlert, type OrbAlertSnap } from './signalOrbChime.ts';

const s = (x: Partial<OrbAlertSnap> = {}): OrbAlertSnap => ({ signal: 'NEUTRAL', barT: 1000, halt: null, fresh: true, unresolved: null, engineActive: true, ...x });

test('first tick after load is silent; a held state is silent', () => {
  assert.equal(orbAlert(null, s({ signal: 'BULL', halt: 'x' }), false), null);
  assert.equal(orbAlert(s({ signal: 'BULL' }), s({ signal: 'BULL', barT: 1060 }), false), null);
});

test('a colour change on a newer closed bar chimes its colour, unless the engine traded on it', () => {
  assert.equal(orbAlert(s(), s({ signal: 'BULL', barT: 1060 }), false)?.sound, 'bull');
  assert.equal(orbAlert(s({ signal: 'BULL' }), s({ signal: 'BEAR', barT: 1060 }), false)?.sound, 'bear');
  assert.equal(orbAlert(s({ signal: 'BEAR' }), s({ signal: 'NEUTRAL', barT: 1060 }), false)?.sound, 'neutral');
  assert.equal(orbAlert(s(), s({ signal: 'BULL', barT: 1060 }), true), null);
  // a rule edit re-reads the same bar: not a market event
  assert.equal(orbAlert(s(), s({ signal: 'BULL', barT: 1000 }), false), null);
});

test('halt, unresolved row and stale feed warn once, ahead of a colour change', () => {
  const h = orbAlert(s(), s({ signal: 'BULL', barT: 1060, halt: 'loss limit' }), false);
  assert.deepEqual([h?.sound, h?.group], ['warn', 'alert']);
  assert.equal(orbAlert(s({ halt: 'loss limit' }), s({ halt: 'loss limit' }), false), null);
  assert.equal(orbAlert(s(), s({ unresolved: 'row r1 UNKNOWN' }), false)?.sound, 'warn');
  assert.equal(orbAlert(s(), s({ fresh: false }), false)?.sound, 'warn');
  assert.equal(orbAlert(s({ engineActive: false }), s({ fresh: false, engineActive: false }), false), null);
  assert.equal(orbAlert(s({ fresh: false }), s({ fresh: false }), false), null);
});

test('orbNotification: alerts only, leader only, switched on and granted, and only when the page is not in front', async () => {
  const { orbNotification } = await import('./signalOrbChime.ts');
  const on = { enabled: true, permission: 'granted', leader: true, visible: false };
  const halt = { sound: 'warn' as const, group: 'alert' as const, reason: 'Halted: Daily loss limit ₹3000 reached' };
  assert.deepEqual(orbNotification(halt, on), { title: 'Signal Orb - needs you', body: halt.reason, sticky: true });
  assert.equal(orbNotification({ sound: 'bull', group: 'signal', reason: 'Signal NEUTRAL -> BULL' }, on), null);
  assert.equal(orbNotification(halt, { ...on, visible: true }), null);
  assert.equal(orbNotification(halt, { ...on, leader: false }), null);
  assert.equal(orbNotification(halt, { ...on, enabled: false }), null);
  assert.equal(orbNotification(halt, { ...on, permission: 'denied' }), null);
  assert.equal(orbNotification(null, on), null);
  assert.equal(orbNotification({ sound: 'warn', group: 'alert', reason: 'Price feed stale - entries paused' }, on)?.sticky, false);
});

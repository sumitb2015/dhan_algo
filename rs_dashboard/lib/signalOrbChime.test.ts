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

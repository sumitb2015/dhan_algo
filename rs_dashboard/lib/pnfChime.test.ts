import test from 'node:test';
import assert from 'node:assert/strict';
import { pnfChimeFor } from './pnfChime.ts';

test('trades use the Price Ladder sounds: entry rises, exit falls, problems buzz', () => {
  assert.equal(pnfChimeFor({ kind: 'auto', type: 'entry' }), 'entry');
  assert.equal(pnfChimeFor({ kind: 'auto', type: 'exit' }), 'exit');
  assert.equal(pnfChimeFor({ kind: 'auto', type: 'halt' }), 'warn');
  assert.equal(pnfChimeFor({ kind: 'auto', type: 'info' }), 'warn');     // a refused AUTO entry / exit
  assert.equal(pnfChimeFor({ kind: 'manual', outcome: 'placed', close: false }), 'entry');
  assert.equal(pnfChimeFor({ kind: 'manual', outcome: 'placed', close: true }), 'exit');
  for (const outcome of ['rejected', 'unknown', 'partial', 'reversed', undefined]) {
    assert.equal(pnfChimeFor({ kind: 'manual', outcome, close: false }), 'warn', String(outcome));
  }
});

test('a signal is never a trade sound; with AUTO armed it is silent so the trade it triggers rings', () => {
  assert.equal(pnfChimeFor({ kind: 'signal', autoArmed: false }), 'alert');
  assert.equal(pnfChimeFor({ kind: 'signal', autoArmed: true }), null);
});

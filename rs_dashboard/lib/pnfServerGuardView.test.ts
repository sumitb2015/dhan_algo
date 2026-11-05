import test from 'node:test';
import assert from 'node:assert/strict';
import { guardLevelsText, sameGuardLevels, syncGuardFromServer } from './pnfServerGuardView.ts';

const real = { broker: 'kotak', mode: 'REAL' as const, levels: { targetBoxes: 8, stopBoxes: 10 } };
const base = { broker: 'kotak', mode: 'REAL' as const, wasOnServer: false, recentLocalChange: false };

test('a server guard for the page broker + mode switches an OFF card on with its levels', () => {
  assert.deepEqual(syncGuardFromServer({ ...base, card: { on: false }, server: real }), { action: 'adopt', levels: real.levels });
});

test('an ON card with the server levels is left alone; different levels are taken from the server', () => {
  assert.deepEqual(syncGuardFromServer({ ...base, card: { on: true, targetBoxes: 8, stopBoxes: 10 }, server: real }), { action: 'none' });
  assert.deepEqual(syncGuardFromServer({ ...base, card: { on: true, targetBoxes: 5, stopBoxes: 10 }, server: real }), { action: 'adopt', levels: real.levels });
});

test('a guard for another broker or mode is not adopted (the page lists it instead)', () => {
  assert.deepEqual(syncGuardFromServer({ ...base, mode: 'PAPER', card: { on: false }, server: real }), { action: 'none' });
  assert.deepEqual(syncGuardFromServer({ ...base, broker: 'dhan', card: { on: false }, server: real }), { action: 'none' });
});

test('a copy that was on the server and is gone switches the card off; one never synced (box unknown) does not', () => {
  assert.deepEqual(syncGuardFromServer({ ...base, wasOnServer: true, card: { on: true, stopBoxes: 10 }, server: undefined }), { action: 'release' });
  assert.deepEqual(syncGuardFromServer({ ...base, card: { on: true, stopBoxes: 10 }, server: undefined }), { action: 'none' });
});

test('a card changed here moments ago is not overwritten by a poll that predates its sync', () => {
  assert.deepEqual(syncGuardFromServer({ ...base, recentLocalChange: true, card: { on: false }, server: real }), { action: 'none' });
  assert.deepEqual(syncGuardFromServer({ ...base, recentLocalChange: true, wasOnServer: true, card: { on: true }, server: undefined }), { action: 'none' });
});

test('labels and level equality', () => {
  assert.equal(guardLevelsText({ targetBoxes: 8, stopBoxes: 10 }), 'T 8 bx · SL 10 bx');
  assert.equal(guardLevelsText({ stop: 1500, trailBy: 500 }), 'SL ₹1,500 · trail ₹500');
  assert.equal(guardLevelsText({}), 'no levels');
  assert.ok(sameGuardLevels({ stopBoxes: 10 }, { stopBoxes: 10 }));
  assert.ok(!sameGuardLevels({ stopBoxes: 10 }, { stopBoxes: 10, targetBoxes: 8 }));
});

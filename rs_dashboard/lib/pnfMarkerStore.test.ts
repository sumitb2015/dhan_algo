import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeMarkers, encodeMarkers } from './pnfMarkerStore.ts';
import type { PnfExecutionMarker } from './straddlePnf.ts';

const m = (id: string, extra: Partial<PnfExecutionMarker> = {}): PnfExecutionMarker => ({ id, t: 1000, action: 'BUY', price: 9000, lots: 1, mode: 'PAPER', estimate: false, ...extra });

test('a marker list round-trips for its own day, with columns dropped (each chart recomputes them)', () => {
  const raw = encodeMarkers('2026-11-03', [m('a', { col: 7 }), m('b')]);
  const out = decodeMarkers(raw, '2026-11-03');
  assert.deepEqual(out.map(x => x.id), ['a', 'b']);
  assert.equal(out[0].col, undefined);
});

test('another day\'s markers, the old bare-array form, junk and AUTO markers are not returned', () => {
  assert.deepEqual(decodeMarkers(encodeMarkers('2026-11-02', [m('a')]), '2026-11-03'), []);
  assert.deepEqual(decodeMarkers(JSON.stringify([m('a')]), '2026-11-03'), [], 'a list with no day stamp cannot be trusted');
  assert.deepEqual(decodeMarkers('not json', '2026-11-03'), []);
  assert.deepEqual(decodeMarkers(null, '2026-11-03'), []);
  assert.deepEqual(decodeMarkers(encodeMarkers('2026-11-03', [m('auto-1'), m('keep')]), '2026-11-03').map(x => x.id), ['keep']);
});

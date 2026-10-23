import test from 'node:test';
import assert from 'node:assert/strict';
import { oiStrikesFromChain, maxOi, oiAtRow, barPct, oiChangePct, compactOi } from './priceLadderOi.ts';

const oc = {
  '23200.000000': { ce: { oi: 1000, previous_oi: 800 }, pe: { oi: 3000, previous_oi: 0 } },
  '23100': { ce: { oi: 500 }, pe: { oi: 2000, previous_oi: 2500 } },
  '23000': { ce: { oi: 0 }, pe: { oi: 0 } },
  'x': { ce: { oi: 9 } },
};

test('oiStrikesFromChain: ascending, drops empty and non-numeric strikes, no baseline = null', () => {
  const rows = oiStrikesFromChain(oc);
  assert.deepEqual(rows.map(r => r.strike), [23100, 23200]);
  assert.equal(rows[1].peOi, 3000);
  assert.equal(rows[1].pePrev, null);      // previous_oi 0 is no baseline
  assert.equal(rows[0].cePrev, null);      // missing
  assert.deepEqual(oiStrikesFromChain(null), []);
});

test('maxOi / barPct: the chain maximum is 100 %, tiny OI keeps a visible sliver, none is 0', () => {
  const rows = oiStrikesFromChain(oc);
  assert.equal(maxOi(rows), 3000);
  assert.equal(barPct(3000, 3000), 100);
  assert.equal(barPct(1500, 3000), 50);
  assert.equal(barPct(1, 3000), 2);
  assert.equal(barPct(0, 3000), 0);
  assert.equal(barPct(5, 0), 0);
});

test('oiAtRow: matches only a row within half a tick of a strike', () => {
  const rows = oiStrikesFromChain(oc);
  assert.equal(oiAtRow(rows, 23200, 5)?.strike, 23200);
  assert.equal(oiAtRow(rows, 23202, 5)?.strike, 23200);
  assert.equal(oiAtRow(rows, 23205, 5), null);
});

test('oiChangePct / compactOi', () => {
  assert.equal(oiChangePct(1000, 800), 25);
  assert.equal(oiChangePct(1000, null), null);
  assert.equal(compactOi(950), '950');
  assert.equal(compactOi(123456), '1.2L');
  assert.equal(compactOi(4.5e7), '4.5Cr');
});

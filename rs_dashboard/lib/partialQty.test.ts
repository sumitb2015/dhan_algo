import { test } from 'node:test';
import assert from 'node:assert';
import { openLots, fractionUnits, partialCloseChips } from './partialQty.ts';

const LS = 75;

/** [pct, enabled, lots, units] for each chip, for compact assertions. */
const shape = (netQty: number, lotSize: number) =>
  partialCloseChips(netQty, lotSize).map(c => [c.pct, c.enabled, c.lots, c.units]);

test('openLots floors to whole lots and rejects unusable lot sizes', () => {
  assert.strictEqual(openLots(300, LS), 4);
  assert.strictEqual(openLots(190, LS), 2);   // non-multiple → floors
  assert.strictEqual(openLots(-150, LS), 2);  // short leg
  assert.strictEqual(openLots(0, LS), 0);
  assert.strictEqual(openLots(150, 0), 0);
  assert.strictEqual(openLots(150, NaN), 0);
});

test('fractionUnits rounds down to whole lots; full keeps the remainder', () => {
  assert.strictEqual(fractionUnits(150, LS, 0.5), 75);   // 2 lots → 1 lot
  assert.strictEqual(fractionUnits(225, LS, 0.5), 75);   // 3 lots → 1 lot (floor of 1.5)
  assert.strictEqual(fractionUnits(300, LS, 0.5), 150);  // 4 lots → 2 lots
  assert.strictEqual(fractionUnits(75, LS, 0.5), 0);     // 1 lot cannot be halved
  assert.strictEqual(fractionUnits(190, LS, 1), 190);    // full keeps the odd remainder
  assert.strictEqual(fractionUnits(-150, LS, 0.5), 75);  // short leg sizes off |netQty|
  assert.strictEqual(fractionUnits(150, LS, 0), 0);
});

test('1 lot offers only 100%', () => {
  assert.deepStrictEqual(shape(75, LS), [
    [25, false, 0, 0],
    [50, false, 0, 0],
    [75, false, 0, 0],
    [100, true, 1, 75],
  ]);
});

test('2 lots offers 50% and 100% only — 75% is suppressed as a duplicate of 50%', () => {
  assert.deepStrictEqual(shape(150, LS), [
    [25, false, 0, 0],
    [50, true, 1, 75],
    [75, false, 1, 75],
    [100, true, 2, 150],
  ]);
  const chips = partialCloseChips(150, LS);
  assert.match(chips[0].title, /Needs ≥4 lots/);
  assert.match(chips[2].title, /Same as 50%/);
});

test('3 lots offers 50/75/100 with round-down lot counts', () => {
  assert.deepStrictEqual(shape(225, LS), [
    [25, false, 0, 0],
    [50, true, 1, 75],
    [75, true, 2, 150],
    [100, true, 3, 225],
  ]);
});

test('4 lots offers every percentage', () => {
  assert.deepStrictEqual(shape(300, LS), [
    [25, true, 1, 75],
    [50, true, 2, 150],
    [75, true, 3, 225],
    [100, true, 4, 300],
  ]);
});

test('a non-multiple netQty stays fully closable via 100%', () => {
  // 190 units at lotSize 75 = 2 whole lots + a 40-unit stub.
  assert.deepStrictEqual(shape(190, LS), [
    [25, false, 0, 0],
    [50, true, 1, 75],
    [75, false, 1, 75],
    [100, true, 2, 190],   // verbatim |netQty|, stub included
  ]);
});

test('a short position behaves identically to its absolute size', () => {
  assert.deepStrictEqual(shape(-225, LS), shape(225, LS));
});

test('unusable lot size disables the partials but keeps 100%', () => {
  for (const bad of [0, NaN, -75]) {
    const chips = partialCloseChips(150, bad);
    assert.deepStrictEqual(chips.filter(c => c.enabled).map(c => c.pct), [100]);
    assert.strictEqual(chips[3].units, 150);
    assert.match(chips[0].title, /Lot size unknown/);
  }
});

test('a flat position disables every chip', () => {
  const chips = partialCloseChips(0, LS);
  assert.ok(chips.every(c => !c.enabled));
  assert.ok(chips.every(c => c.title === 'No open quantity'));
});

test('lotSize 1 collapses every partial into the full close', () => {
  // 3 units at lotSize 1: 25% floors to 0, 50%→1, 75%→2, 100%→3.
  assert.deepStrictEqual(shape(3, 1), [
    [25, false, 0, 0],
    [50, true, 1, 1],
    [75, true, 2, 2],
    [100, true, 3, 3],
  ]);
  // 1 unit at lotSize 1: only the full close is meaningful.
  assert.deepStrictEqual(partialCloseChips(1, 1).filter(c => c.enabled).map(c => c.pct), [100]);
});

test('every chip carries a title, enabled or not', () => {
  for (const qty of [0, 75, 150, 190, 225, 300]) {
    for (const c of partialCloseChips(qty, LS)) assert.ok(c.title.length > 0, `pct ${c.pct} @ ${qty}`);
  }
});

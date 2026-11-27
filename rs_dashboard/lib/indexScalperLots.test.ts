import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLotMap, contractLot, missingLotIds } from './indexScalperLots.ts';
import { dhanOrderQty, kotakOrderQty, qtyLots } from './indexScalperInstrument.ts';

// SENSEX: Dec 2026 contracts 20 a lot, Jan 2027 contracts 25 (master list and Kotak's, 2026-11-27).
const JAN_SCREEN = buildLotMap({
  screenDhanIds: ['1172001', '1172002'], screenLot: 25,           // the Jan expiry on screen
  screenKotakSymbols: ['SENSEX27J0785000CE'], kotakScreenLot: 25,
  kotakSymbols: { SENSEX26DEC85000CE: { lotSize: 20 }, SENSEX27J0785000CE: { lotSize: 25 }, NOLOT: {} },
  master: { 1165299: 20 },                                         // a held Dec leg, from api/index-scalper/lots
});

test('each contract keeps its own lot: a Dec leg under a Jan screen is 20, never 25', () => {
  assert.equal(contractLot('SENSEX', '1165299', JAN_SCREEN), 20);
  assert.equal(contractLot('SENSEX', '1172001', JAN_SCREEN), 25);
  assert.equal(contractLot('SENSEX', 'SENSEX26DEC85000CE', JAN_SCREEN), 20);
  assert.equal(contractLot('SENSEX', 'SENSEX27J0785000CE', JAN_SCREEN), 25);
  // unknown = null (refused), never the screen's
  assert.equal(contractLot('SENSEX', '9999999', JAN_SCREEN), null);
  assert.equal(contractLot('SENSEX', 'NOLOT', JAN_SCREEN), null);
  assert.equal(contractLot('SENSEX', null, JAN_SCREEN), null);
  // MCX ignores it (barrels per lot are the instrument's)
  assert.equal(contractLot('CRUDEOILM', 'anything', new Map()), 1);
});

test('the bug this fixes: "4 lots" on a Dec order under a Jan screen is 80 units, not 100 (5 Dec lots)', () => {
  const screen = 25, own = contractLot('SENSEX', '1165299', JAN_SCREEN)!;
  assert.equal(dhanOrderQty('SENSEX', 4, screen), 100); // what the screen's lot sent before
  assert.equal(dhanOrderQty('SENSEX', 4, own), 80);     // 4 Dec lots
  assert.equal(kotakOrderQty('SENSEX', 4, own), 80);
  // the chip's lot count of an 80-unit Dec position: 4, not 3 (80 / 25 rounded)
  assert.equal(qtyLots('SENSEX', -80, 1, own), 4);
  assert.equal(qtyLots('SENSEX', -80, 1, screen), null);
});

test('a contract-specific lot wins over the screen expiry\'s', () => {
  const m = buildLotMap({ screenDhanIds: ['1'], screenLot: 25, master: { 1: 20 } });
  assert.equal(m.get('1'), 20);
  const none = buildLotMap({ screenDhanIds: ['1'], screenLot: null });
  assert.equal(none.size, 0); // screen lot unknown: nothing assumed
});

test('missingLotIds asks only for numeric Dhan ids without a lot, sorted and deduped', () => {
  assert.deepEqual(missingLotIds(['1165299', '1172001', '1165401', '1165401', 'SENSEX26DEC85000CE', '', 'SIM-x'], JAN_SCREEN), ['1165401']);
  assert.deepEqual(missingLotIds(['1172001'], JAN_SCREEN), []);
});

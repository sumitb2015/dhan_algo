import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INSTRUMENTS,
  dhanOrderQty,
  kotakOrderQty,
  pnlMultiplier,
  displayLotUnits,
} from './indexScalperInstrument.ts';

test('instrument specifications', () => {
  assert.equal(INSTRUMENTS.NIFTY.dhanSegment, 'NSE_FNO');
  assert.equal(INSTRUMENTS.NIFTY.kotakExchange, 'nse_fo');
  assert.equal(INSTRUMENTS.NIFTY.futTick, 0.05);

  assert.equal(INSTRUMENTS.CRUDEOILM.dhanSegment, 'MCX_COMM');
  assert.equal(INSTRUMENTS.CRUDEOILM.kotakExchange, 'mcx_fo');
  assert.equal(INSTRUMENTS.CRUDEOILM.futTick, 1.0);
});

test('units and order sizing per broker', () => {
  // Dhan: NIFTY in units (lots * 65); CRUDEOILM in LOTS (qty = lots)
  assert.equal(dhanOrderQty('NIFTY', 2, 65), 130);
  assert.equal(dhanOrderQty('CRUDEOILM', 2, 1), 2);
  assert.equal(dhanOrderQty('CRUDEOILM', 5, 10), 5); // always returns lots for Dhan MCX

  // Kotak: NIFTY in units (lots * 65); CRUDEOILM in BARRELS (lots * 10)
  assert.equal(kotakOrderQty('NIFTY', 2, 65), 130);
  assert.equal(kotakOrderQty('CRUDEOILM', 2, 10), 20);
  assert.equal(kotakOrderQty('CRUDEOILM', 5, 10), 50);
});

test('P&L multipliers: both brokers yield identical rupee P&L for a 5-point move', () => {
  // 2 lots of CRUDEOILM, moving by +5 points:
  // Dhan: netQty = 2 (lots), mult = 10 -> 2 * 5 * 10 = +100 Rs
  const dhanQty = 2;
  const dhanMult = pnlMultiplier('CRUDEOILM', 'dhan');
  assert.equal(dhanMult, 10);
  const dhanPnl = 5 * dhanQty * dhanMult;
  assert.equal(dhanPnl, 100);

  // Kotak: netQty = 20 (barrels), mult = 1 -> 20 * 5 * 1 = +100 Rs
  const kotakQty = 20;
  const kotakMult = pnlMultiplier('CRUDEOILM', 'kotak');
  assert.equal(kotakMult, 1);
  const kotakPnl = 5 * kotakQty * kotakMult;
  assert.equal(kotakPnl, 100);

  // NIFTY on either broker has mult 1
  assert.equal(pnlMultiplier('NIFTY', 'dhan'), 1);
  assert.equal(pnlMultiplier('NIFTY', 'kotak'), 1);
});

test('displayLotUnits: 65 for Nifty, 10 for Crude Mini', () => {
  assert.equal(displayLotUnits('NIFTY', 65), 65);
  assert.equal(displayLotUnits('CRUDEOILM'), 10);
});

test('qtyLots: a quantity in the broker\'s own unit -> whole lots, never rounded into a bigger order', async () => {
  const { qtyLots, lotUnits } = await import('./indexScalperInstrument.ts');
  // Dhan MCX netQty is LOTS (mult 10): 2 -> 2 lots.
  assert.equal(qtyLots('CRUDEOILM', 2, 10, 1), 2);
  // Kotak CRUDEOILM netQty is BARRELS (mult 1): 20 -> 2 lots, never 20 (the 10x bracket / reverse bug).
  assert.equal(qtyLots('CRUDEOILM', -20, 1, null), 2);
  // SIM crude legs are barrels too.
  assert.equal(qtyLots('CRUDEOILM', 10, 1, null), 1);
  // NIFTY units / lot size; unknown lot size or a partial lot is refused (null), not guessed.
  assert.equal(qtyLots('NIFTY', 130, 1, 65), 2);
  assert.equal(qtyLots('NIFTY', 130, 1, null), null);
  assert.equal(qtyLots('NIFTY', 100, 1, 65), null);
  assert.equal(qtyLots('CRUDEOILM', 15, 1, null), null);
  assert.equal(lotUnits('NIFTY', null), null);
  assert.equal(lotUnits('CRUDEOILM', null), 10);
});

test('order quantity helpers never guess a NIFTY lot size', () => {
  assert.equal(dhanOrderQty('NIFTY', 2, 0), 0);
  assert.equal(kotakOrderQty('NIFTY', 2, 0), 0);
});

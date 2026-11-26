import test from 'node:test';
import assert from 'node:assert/strict';
import { editLotsError, isEditable, movedLevels, orderEditError, type EditableOrder } from './indexScalperOrderEdit.ts';

const o = (x: Partial<EditableOrder> = {}): EditableOrder => ({
  id: 'O1', side: 'BUY', rawType: 'LIMIT', price: 180, trigger: null, qty: 65, tradedQty: 0, bucket: 'open', own: true, ...x,
});

test('only this page\'s own working Limit / SL / SL-M orders are editable', () => {
  assert.equal(isEditable(o()), true);
  assert.equal(isEditable(o({ rawType: 'STOP_LOSS' })), true);
  assert.equal(isEditable(o({ rawType: 'STOP_LOSS_MARKET' })), true);
  assert.equal(isEditable(o({ own: false })), false); // a strategy's / the mobile app's
  assert.equal(isEditable(o({ rawType: 'MARKET' })), false);
  assert.equal(isEditable(o({ bucket: 'executed' })), false);
});

test('moving the line: Limit moves its price, SL-M its trigger, SL-limit both by the same amount (on the tick)', () => {
  assert.deepEqual(movedLevels(o(), 175.03, 0.05), { price: 175.05, trigger: 0 });
  assert.deepEqual(movedLevels(o({ rawType: 'STOP_LOSS_MARKET', price: null, trigger: 220 }), 225, 0.05), { price: 0, trigger: 225 });
  // SL-limit buy: its line sits at the TRIGGER (220, limit 231 = 5% cushion). Dragged to 230: trigger 230, limit 241,
  // cushion kept. Reading the limit as the line put a stop dragged to 82.00 on screen at 86.10 (2026-11-26).
  assert.deepEqual(movedLevels(o({ rawType: 'STOP_LOSS', price: 231, trigger: 220 }), 230, 0.05), { price: 241, trigger: 230 });
  // the 2026-11-26 order: BUY trigger 82.00 / limit 86.10, line moved to 80.00 -> trigger 80.00, limit 84.10
  assert.deepEqual(movedLevels(o({ rawType: 'STOP_LOSS', price: 86.1, trigger: 82 }), 80, 0.05), { price: 84.1, trigger: 80 });
});

test('edits are checked against the live price like a new order', () => {
  // Limit: a buy must stay below the live price, a sell above (else it fills at once)
  assert.equal(orderEditError('LIMIT', 'BUY', 195, 0, 200, 0.05), null);
  assert.match(orderEditError('LIMIT', 'BUY', 205, 0, 200, 0.05)!, /fills at once/);
  assert.match(orderEditError('LIMIT', 'SELL', 195, 0, 200, 0.05)!, /fills at once/);
  // stops: a buy's trigger above, a sell's below
  assert.equal(orderEditError('STOP_LOSS_MARKET', 'BUY', 0, 205, 200, 0.05), null);
  assert.match(orderEditError('STOP_LOSS_MARKET', 'BUY', 0, 195, 200, 0.05)!, /above the live price/);
  assert.match(orderEditError('STOP_LOSS_MARKET', 'SELL', 0, 205, 200, 0.05)!, /below the live price/);
  // SL-limit: limit at or beyond the trigger in the order's direction
  assert.equal(orderEditError('STOP_LOSS', 'BUY', 206, 205, 200, 0.05), null);
  assert.match(orderEditError('STOP_LOSS', 'BUY', 204, 205, 200, 0.05)!, /at or above its trigger/);
  assert.match(orderEditError('STOP_LOSS', 'SELL', 196, 195, 200, 0.05)!, /at or below its trigger/);
  // off-tick, no live price, market
  assert.match(orderEditError('LIMIT', 'BUY', 195.03, 0, 200, 0.05)!, /tick/);
  assert.match(orderEditError('LIMIT', 'BUY', 195, 0, null, 0.05)!, /No live price/);
  assert.notEqual(orderEditError('MARKET', 'BUY', 0, 0, 200, 0.05), null);
});

test('lots: 1..20 whole lots, and not on a part-filled order', () => {
  assert.equal(editLotsError(3, 0), null);
  assert.notEqual(editLotsError(0, 0), null);
  assert.notEqual(editLotsError(21, 0), null);
  assert.notEqual(editLotsError(1.5, 0), null);
  assert.match(editLotsError(3, 65)!, /part-filled/);
});

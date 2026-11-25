import test from 'node:test';
import assert from 'node:assert/strict';
import { limitMarketable, simOrderRow, simOrderStep, validSimOrders, type SimOrder } from './indexScalperSimOrders.ts';

const base: SimOrder = {
  id: 'SIM-1', underlying: 'CRUDEOIL', securityId: '9001', symbol: 'CRUDEOIL FUT', type: 'FUT', strike: 0, expiry: '2026-12-18', side: 'SELL',
  orderType: 'LIMIT', price: 7728, trigger: null, units: 100, lots: 1, product: 'MARGIN', placedAt: 0, day: '2026-11-25',
};

test('limitMarketable', () => {
  assert.equal(limitMarketable('SELL', 7728, 7709), false);
  assert.equal(limitMarketable('SELL', 7700, 7709), true);
  assert.equal(limitMarketable('BUY', 7710, 7709), true);
});

test('a resting sell limit fills at its own price once the price trades there, not before', () => {
  assert.equal(simOrderStep(base, 7727).fill, null);
  assert.equal(simOrderStep(base, 7728).fill, 7728);
  assert.equal(simOrderStep(base, 7735).fill, 7728); // a jump through it still fills at the limit
  assert.equal(simOrderStep({ ...base, side: 'BUY', price: 7700 }, 7701).fill, null);
  assert.equal(simOrderStep({ ...base, side: 'BUY', price: 7700 }, 7699).fill, 7700);
});

test('SL-M fires at the trigger and fills at the live price', () => {
  const sl: SimOrder = { ...base, orderType: 'STOP_LOSS_MARKET', price: null, trigger: 7690 };
  assert.equal(simOrderStep(sl, 7691).fill, null);
  assert.equal(simOrderStep(sl, 7688).fill, 7688);
  const buyStop: SimOrder = { ...sl, side: 'BUY', trigger: 7720 };
  assert.equal(simOrderStep(buyStop, 7719).fill, null);
  assert.equal(simOrderStep(buyStop, 7722).fill, 7722);
});

test('SL (stop-limit): fires at the trigger, fills now if marketable, else rests as a limit', () => {
  const sl: SimOrder = { ...base, orderType: 'STOP_LOSS', trigger: 7690, price: 7685 };
  assert.equal(simOrderStep(sl, 7695).fill, null);
  assert.equal(simOrderStep(sl, 7688).fill, 7688); // triggered and 7688 >= 7685: marketable
  const gap = simOrderStep(sl, 7680); // gapped below the limit: rests as a sell limit at 7685
  assert.equal(gap.fill, null);
  assert.equal(gap.order.triggered, true);
  assert.equal(simOrderStep(gap.order, 7684).fill, null);
  assert.equal(simOrderStep(gap.order, 7686).fill, 7685);
});

test('the row is own, open, cancellable and editable; a triggered stop-limit edits as a limit', () => {
  const r = simOrderRow(base);
  assert.match(r.symbol, /^CRUDEOIL FUT \(SIM\)$/);
  assert.equal(r.bucket, 'open'); assert.equal(r.own, true); assert.equal(r.cancellable, true); assert.equal(r.rawType, 'LIMIT');
  assert.equal(r.isOption, false);
  assert.equal(simOrderRow({ ...base, underlying: 'NIFTY', type: 'CE', strike: 25350 }).symbol, 'NIFTY 25350 CALL (SIM)');
  assert.equal(simOrderRow({ ...base, orderType: 'STOP_LOSS', triggered: true }).rawType, 'LIMIT');
});

test('validSimOrders keeps today\'s well-formed orders only', () => {
  assert.deepEqual(validSimOrders([base, { ...base, id: 'SIM-2', day: '2026-11-24' }, { ...base, id: 'X' }, null], '2026-11-25'), [base]);
  assert.deepEqual(validSimOrders('x', '2026-11-25'), []);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { netBySecurity, ocoActions, ocoEvents, type OcoOrderLike } from './indexScalperOco.ts';

const m = (...e: [string, number][]) => new Map(e);
const ord = (id: string, p: Partial<OcoOrderLike> = {}): OcoOrderLike => ({
  id, securityId: '302', side: 'SELL', own: true, cancellable: true, rawType: 'STOP_LOSS_MARKET', qty: 130, tradedQty: 0, ...p,
});

test('netBySecurity sums products and drops flat', () => {
  assert.deepEqual([...netBySecurity([{ securityId: 'a', netQty: 65 }, { securityId: 'a', netQty: 65 }, { securityId: 'b', netQty: 65 }, { securityId: 'b', netQty: -65 }])], [['a', 130]]);
});

test('events: flat and reduced only; open, add and flip are not events', () => {
  assert.deepEqual(ocoEvents(m(['302', 130]), m()), [{ securityId: '302', kind: 'flat', closeSide: 'SELL', left: 0 }]);
  assert.deepEqual(ocoEvents(m(['302', -130]), m(['302', -65])), [{ securityId: '302', kind: 'reduced', closeSide: 'BUY', left: 65 }]);
  assert.deepEqual(ocoEvents(m(), m(['302', 65])), []);
  assert.deepEqual(ocoEvents(m(['302', 65]), m(['302', 130])), []);
  assert.deepEqual(ocoEvents(m(['302', 65]), m(['302', -65])), []);
});

test('target filled -> the stop is cancelled (and the reverse)', () => {
  const ev = ocoEvents(m(['302', 130]), m());
  const r = ocoActions(ev, [ord('SL1'), ord('TP1', { rawType: 'LIMIT' })]);
  assert.deepEqual(r.cancel.map(o => o.id), ['SL1', 'TP1']);
  assert.deepEqual(r.resize, []);
});

test('only this page\'s working LIMIT / SL / SL-M orders on the old closing side of that contract', () => {
  const ev = ocoEvents(m(['302', 130]), m());
  const r = ocoActions(ev, [
    ord('foreign', { own: false }), ord('done', { cancellable: false }), ord('other', { securityId: '303' }),
    ord('buy', { side: 'BUY' }), ord('mkt', { rawType: 'MARKET' }), ord('sl', { rawType: 'STOP_LOSS' }),
  ]);
  assert.deepEqual(r.cancel.map(o => o.id), ['sl']);
});

test('reduced: an untouched bigger order is cut to what is left; a part-filled or smaller one is left alone', () => {
  const ev = ocoEvents(m(['302', 130]), m(['302', 65]));
  const r = ocoActions(ev, [ord('SL1'), ord('TP1', { rawType: 'LIMIT', tradedQty: 65 }), ord('SL2', { qty: 65 })]);
  assert.deepEqual(r.cancel, []);
  assert.deepEqual(r.resize.map(x => [x.order.id, x.qty]), [['SL1', 65]]);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveIdsParam, parseLiveIds, withLiveLtps, LIVE_IDS_MAX } from './freshMoneyLivePrices.ts';
import { buildPositions, type FmOrder } from './freshMoneyTrades.ts';

let n = 0;
const ord = (p: Partial<FmOrder>): FmOrder => ({
  id: `o${++n}`, ts: n * 1000, underlying: 'NIFTY', expiry: '2026-11-17', strike: 25000, opt: 'CE', securityId: '111',
  priceId: '111', segment: 'NSE_FNO', lot: 65, mult: 1, side: 'SELL', qty: 130, close: false, correlationId: `fm${n}aaaaaaa`,
  orderId: `X${n}`, state: 'filled', filledQty: 130, avgPrice: 100, ...p,
});

test('re-pricing at a live LTP matches buildPositions at that LTP exactly', () => {
  const orders = [
    ord({}),                                                           // short 130 @ 100
    ord({ side: 'BUY', qty: 65, filledQty: 65, avgPrice: 90, close: true }), // cover 65 @ 90: +650 booked
    ord({ securityId: '222', priceId: '222', strike: 25100, side: 'BUY', qty: 65, filledQty: 65, avgPrice: 40 }),
  ];
  const now = 10_000_000;
  const atServer = buildPositions(orders, { 111: 95, 222: 41 }, now);
  const live = withLiveLtps(atServer, { 111: 80.5, 222: 44 });
  const expected = buildPositions(orders, { 111: 80.5, 222: 44 }, now);
  for (const p of expected) {
    const got = live.find(x => x.key === p.key)!;
    assert.equal(got.ltp, p.ltp);
    assert.equal(got.unrealised, p.unrealised);
    assert.equal(got.pnl, p.pnl);
  }
});

test('no live price, a flat position or an unknown basis: nothing invented', () => {
  const now = 10_000_000;
  const orders = [ord({}), ord({ securityId: '333', priceId: '333', avgPrice: null, state: 'partial' })];
  const base = buildPositions(orders, { 111: 95 }, now);
  assert.equal(withLiveLtps(base, null), base);
  assert.equal(withLiveLtps(base, {}), base, 'same array when nothing changed');
  assert.equal(withLiveLtps(base, { 111: 95 }), base, 'same LTP = unchanged');
  // A position whose average is unknown gets the live LTP but no P&L (never a guess).
  const noAvg = { ...base[0], key: 'k-noavg', priceId: '333', avgPrice: null, ltp: null };
  const repriced = withLiveLtps([noAvg], { 333: 50 })[0];
  assert.equal(repriced.ltp, 50);
  assert.equal(repriced.unrealised, null);
  assert.equal(repriced.pnl, null);
  const flat = buildPositions([ord({}), ord({ side: 'BUY', close: true, avgPrice: 90 })], {}, now);
  assert.equal(withLiveLtps(flat, { 111: 70 })[0], flat[0], 'a flat position keeps its booked P&L untouched');
  assert.equal(withLiveLtps(base, { 111: 0 }), base, 'a zero price is no price');
});

test('ids parameter: built from open positions, validated and capped on the way in', () => {
  const now = 10_000_000;
  const pos = buildPositions([ord({}), ord({ securityId: '9', priceId: '9', segment: 'MCX_COMM', underlying: 'CRUDEOILM' })], {}, now);
  assert.equal(liveIdsParam(pos), 'MCX_COMM:9,NSE_FNO:111');
  assert.deepEqual(parseLiveIds('NSE_FNO:111,BAD:1,NSE_FNO:abc,MCX_COMM:9,NSE_FNO:111'), [
    { segment: 'NSE_FNO', id: '111' }, { segment: 'MCX_COMM', id: '9' },
  ]);
  assert.deepEqual(parseLiveIds(null), []);
  const many = Array.from({ length: 100 }, (_, i) => `NSE_FNO:${i + 1}`).join(',');
  assert.equal(parseLiveIds(many).length, LIVE_IDS_MAX);
});

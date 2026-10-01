import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allocateLiveQty, stampOwnEntries, ownEntryFromTrades, legEntryPrice, legEntryIsOwn, legUnrealizedPnl,
  ledgerLegKey, type LedgerBasket, type LedgerLeg,
} from './liveChartsLedger.ts';

const leg = (over: Partial<LedgerLeg> = {}): LedgerLeg => ({
  securityId: '51321', exchangeSegment: 'NSE_FNO', strike: 22300, optionType: 'PE', action: 'SELL',
  productType: 'INTRADAY', qty: 130, entryOrderIds: ['o1'], exitOrderIds: [], lastOrderAt: 0, ...over,
});
const basket = (id: string, createdAt: number, legs: LedgerLeg[]): LedgerBasket =>
  ({ id, title: id, underlying: 'NIFTY', expiry: '2026-10-27', createdAt, legs });
const row = { securityId: '51321', productType: 'INTRADAY', netQty: -130, sellAvg: 125.13, buyAvg: 0, unrealizedProfit: -1300 };

test('two baskets on one contract share the position instead of both claiming it', () => {
  // One basket's 130 was closed outside; the broker holds 130, both ledgers say 130.
  const a = basket('a', 1, [leg()]);
  const b = basket('b', 2, [leg({ entryOrderIds: ['o2'] })]);
  const alloc = allocateLiveQty([b, a], [row]);
  assert.equal(alloc.get(ledgerLegKey('a', 0)), 130);
  assert.equal(alloc.get(ledgerLegKey('b', 0)), 0);
  // So the P&L shares add up to the broker's figure, not twice it.
  const total = legUnrealizedPnl(row, alloc.get('a:0')!) + legUnrealizedPnl(row, alloc.get('b:0')!);
  assert.equal(total, -1300);
});

test('allocation still clamps to the broker and ignores the opposite direction', () => {
  assert.equal(allocateLiveQty([basket('a', 1, [leg({ qty: 260 })])], [row]).get('a:0'), 130);
  assert.equal(allocateLiveQty([basket('a', 1, [leg({ action: 'BUY' })])], [row]).get('a:0'), 0);
  assert.equal(allocateLiveQty([basket('a', 1, [leg({ qty: 0 })])], [row]).get('a:0'), 0);
});

test('a leg\'s entry is its own fills, the pooled average only as a marked fallback', () => {
  const l = leg({ entryOrderIds: ['o1'] });
  const trades = [
    { orderId: 'o1', tradedQuantity: 65, tradedPrice: 60 },
    { orderId: 'o1', tradedQuantity: 65, tradedPrice: 64 },
    { orderId: 'other', tradedQuantity: 130, tradedPrice: 190 },
  ];
  assert.equal(ownEntryFromTrades(l, trades), 62);
  assert.equal(legEntryPrice(row, l), 125.13);
  assert.equal(legEntryIsOwn(l), false);

  const [b] = stampOwnEntries([basket('a', 1, [l])], trades);
  assert.equal(legEntryPrice(row, b.legs[0]), 62);
  assert.equal(legEntryIsOwn(b.legs[0]), true);
  // Nothing new: same array back.
  const same = [b];
  assert.equal(stampOwnEntries(same, trades), same);
});

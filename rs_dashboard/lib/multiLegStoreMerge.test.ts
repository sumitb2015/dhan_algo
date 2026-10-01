import { test } from 'node:test';
import assert from 'node:assert';
import { mergeBasketWrite, withRevs, noteSaved, adoptServerBasket, stableBody, type RevBook } from './multiLegStoreMerge.ts';
import type { MultiLegBasket, MultiLegLeg } from './multiLegFocus.ts';

const leg = (id: string, over: Partial<MultiLegLeg> = {}): MultiLegLeg => ({
  id, side: 'S', option: 'PE', strike: 22300, lots: 6, type: 'MARKET', status: 'OPEN',
  fill: { qty: 390, avgPrice: 62 }, orderRef: { securityId: '51321' }, ...over,
});
const basket = (legs: MultiLegLeg[], over: Partial<MultiLegBasket> = {}): MultiLegBasket => ({
  id: 'b', name: 'Short Strangle', underlying: 'NIFTY', expiry: '2026-10-27', broker: 'dhan', legs,
  createdAt: 't0', updatedAt: 't0', ...over,
} as MultiLegBasket);

test('a stale tab cannot save its old leg over a newer stored one', () => {
  // Stored: merged to 9 lots (rev 3). The tab still holds the 6-lot copy at rev 2.
  const stored = basket([leg('a', { lots: 9, fill: { qty: 585, avgPrice: 125.13 }, rev: 3 })], { rev: 3 });
  const stale = basket([leg('a', { rev: 2 })], { rev: 2 });
  const { basket: out, conflicts } = mergeBasketWrite(stored, stale);
  assert.strictEqual(out.legs[0].fill?.qty, 585);
  assert.deepStrictEqual(conflicts, []);
});

test('a newer leg wins, and order ids / outside-trade keys are never lost', () => {
  const stored = basket([leg('a', { orderIds: ['o1'], outsideTradeKeys: ['k1'], rev: 1 })], { rev: 1 });
  const incoming = basket([leg('a', { status: 'CLOSED', fill: { qty: 0, avgPrice: 62 }, orderIds: ['o2'], rev: 2 })], { rev: 1 });
  const { basket: out } = mergeBasketWrite(stored, incoming);
  assert.strictEqual(out.legs[0].status, 'CLOSED');
  assert.deepStrictEqual(out.legs[0].orderIds, ['o2', 'o1']);
  assert.deepStrictEqual(out.legs[0].outsideTradeKeys, ['k1']);
});

test('the same rev with different content keeps the stored leg and reports a conflict', () => {
  const stored = basket([leg('a', { lots: 9, rev: 2 })]);
  const incoming = basket([leg('a', { lots: 7, rev: 2 })]);
  const { basket: out, conflicts } = mergeBasketWrite(stored, incoming);
  assert.strictEqual(out.legs[0].lots, 9);
  assert.deepStrictEqual(conflicts, ['a']);
  // Same content at the same rev is just a repeat save: no conflict.
  assert.deepStrictEqual(mergeBasketWrite(stored, basket([leg('a', { lots: 9, rev: 2 })])).conflicts, []);
});

test('a save never drops a traded leg; only a newer save drops a draft leg', () => {
  const stored = basket([leg('open', { rev: 1 }), leg('draft', { status: 'DRAFT', fill: undefined, rev: 1 })], { rev: 4 });
  const staleWithoutBoth = basket([], { rev: 3 });
  assert.deepStrictEqual(mergeBasketWrite(stored, staleWithoutBoth).basket.legs.map(l => l.id), ['open', 'draft']);
  const newerWithoutBoth = basket([], { rev: 5 });
  assert.deepStrictEqual(mergeBasketWrite(stored, newerWithoutBoth).basket.legs.map(l => l.id), ['open']);
  // A leg only the incoming copy has (added in that tab) is kept.
  assert.deepStrictEqual(mergeBasketWrite(stored, basket([leg('new', { rev: 1 })], { rev: 3 })).basket.legs.map(l => l.id), ['new', 'open', 'draft']);
});

test('basket fields follow the newer basket rev', () => {
  const stored = basket([], { name: 'Renamed', rev: 2 });
  assert.strictEqual(mergeBasketWrite(stored, basket([], { name: 'Old', rev: 1 })).basket.name, 'Renamed');
  assert.strictEqual(mergeBasketWrite(stored, basket([], { name: 'New', rev: 3 })).basket.name, 'New');
});

test('withRevs bumps only what changed since the last save', () => {
  const book: RevBook = new Map();
  noteSaved(book, basket([leg('a', { rev: 4 }), leg('b', { option: 'CE', rev: 1 })], { rev: 2 }));
  const sent = withRevs(book, basket([leg('a', { lots: 7 }), leg('b', { option: 'CE' })]));
  assert.deepStrictEqual(sent.legs.map(l => l.rev), [5, 1]);
  assert.strictEqual(sent.rev, 2); // leg ids unchanged, so the basket's own fields are too
  // Saving the same thing again changes no rev.
  assert.deepStrictEqual(withRevs(book, basket([leg('a', { lots: 7 }), leg('b', { option: 'CE' })])).legs.map(l => l.rev), [5, 1]);
  // A brand-new leg starts at its own rev + 1, and changes the basket's leg list.
  const withNew = withRevs(book, basket([leg('a', { lots: 7 }), leg('b', { option: 'CE' }), leg('c')]));
  assert.strictEqual(withNew.legs[2].rev, 1);
  assert.strictEqual(withNew.rev, 3);
});

test('adoptServerBasket takes the server copy only where this tab has not moved on', () => {
  const sent = basket([leg('a', { rev: 2 }), leg('b', { option: 'CE', rev: 1 })]);
  const server = basket([leg('a', { lots: 9, rev: 3 }), leg('b', { option: 'CE', lots: 2, rev: 2 }), leg('x', { strike: 22500, rev: 1 })]);
  // Leg b changed locally while the save was in flight: keep the local change.
  const local = basket([leg('a', { rev: 2 }), leg('b', { option: 'CE', lots: 5, rev: 1 })]);
  const out = adoptServerBasket(local, sent, server);
  assert.strictEqual(out.legs.find(l => l.id === 'a')?.lots, 9);
  assert.strictEqual(out.legs.find(l => l.id === 'b')?.lots, 5);
  assert.ok(out.legs.some(l => l.id === 'x'));
  // Nothing to take: same object back.
  assert.strictEqual(adoptServerBasket(sent, sent, sent), sent);
});

test('stableBody ignores rev, updatedAt and key order', () => {
  const a = { ...leg('a'), rev: 3 };
  const b = { rev: 9, ...leg('a') };
  assert.strictEqual(stableBody(a), stableBody(b));
  assert.strictEqual(stableBody(basket([], { updatedAt: 'x' })), stableBody(basket([], { updatedAt: 'y' })));
});

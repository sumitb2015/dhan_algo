import test from 'node:test';
import assert from 'node:assert/strict';
import { dropResurrectedLegs } from './multiLegStoreMerge.ts';
import type { MultiLegBasket, MultiLegLeg } from './multiLegFocus.ts';

const leg = (id: string): MultiLegLeg => ({ id, side: 'S', option: 'CE', strike: 1, lots: 1, type: 'MARKET', status: 'OPEN' });
const bk = (id: string, ids: string[]): MultiLegBasket => ({ id, underlying: 'NIFTY', expiry: '', broker: 'dhan', legs: ids.map(leg), createdAt: '', updatedAt: '' });

test('a stale save cannot re-add a leg that lives in another basket', () => {
  const all = [bk('A', ['1', '2']), bk('N', ['2'])];
  dropResurrectedLegs(all, 'A', new Set(['1']));
  assert.deepEqual(all.find(b => b.id === 'A')!.legs.map(l => l.id), ['1']);
});

test('a stale save of a removed basket made only of moved legs leaves no empty row', () => {
  const all = [bk('N', ['2']), bk('A', ['2'])];
  dropResurrectedLegs(all, 'A', new Set());
  assert.deepEqual(all.map(b => b.id), ['N']);
});

test('a leg already stored in this basket is never dropped (pre-existing duplicate ids)', () => {
  const all = [bk('A', ['1']), bk('B', ['1'])];
  dropResurrectedLegs(all, 'A', new Set(['1']));
  assert.equal(all.length, 2);
  assert.deepEqual(all[0].legs.map(l => l.id), ['1']);
});

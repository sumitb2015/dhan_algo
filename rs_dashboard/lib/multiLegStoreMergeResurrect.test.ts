import test from 'node:test';
import assert from 'node:assert/strict';
import { relocateResurrectedLegs } from './multiLegStoreMerge.ts';
import type { MultiLegBasket, MultiLegLeg } from './multiLegFocus.ts';

type L = MultiLegLeg & { rev?: number };
const leg = (id: string, o: Partial<L> = {}): L => ({ id, side: 'S', option: 'CE', strike: 1, lots: 1, type: 'MARKET', status: 'OPEN', rev: 1, ...o });
const bk = (id: string, legs: L[]): MultiLegBasket => ({ id, underlying: 'NIFTY', expiry: '', broker: 'dhan', legs, createdAt: '', updatedAt: '' });

test('a stale save cannot re-add a moved leg', () => {
  const all = [bk('A', [leg('1'), leg('2')]), bk('N', [leg('2')])];
  relocateResurrectedLegs(all, 'A', new Set(['1']), 'now');
  assert.deepEqual(all.find(b => b.id === 'A')!.legs.map(l => l.id), ['1']);
});

test('a stale tab\'s newer change to a moved leg lands where the leg lives now', () => {
  const stale = leg('2', { status: 'CLOSING', rev: 2, orderIds: ['x9'] });
  const all = [bk('A', [leg('1'), stale]), bk('N', [leg('2', { orderIds: ['x1'] })])];
  const changed = relocateResurrectedLegs(all, 'A', new Set(['1']), 'now');
  const moved = all.find(b => b.id === 'N')!.legs[0];
  assert.equal(moved.status, 'CLOSING');
  assert.deepEqual(moved.orderIds, ['x9', 'x1']);
  assert.deepEqual(changed, ['N']);
  assert.equal(all.find(b => b.id === 'N')!.updatedAt, 'now');
});

test('an older or equal-rev stale copy does not overwrite the moved leg, but its order ids are kept', () => {
  const all = [bk('A', [leg('2', { status: 'CLOSED', rev: 1, orderIds: ['o'] })]), bk('N', [leg('2', { rev: 3 })])];
  relocateResurrectedLegs(all, 'A', new Set(), 'now');
  assert.deepEqual(all.map(b => b.id), ['N']);
  assert.equal(all[0].legs[0].status, 'OPEN');
  assert.deepEqual(all[0].legs[0].orderIds, ['o']);
});

test('a leg already stored in this basket is never touched (pre-existing duplicate ids)', () => {
  const all = [bk('A', [leg('1')]), bk('B', [leg('1')])];
  relocateResurrectedLegs(all, 'A', new Set(['1']), 'now');
  assert.equal(all.length, 2);
  assert.deepEqual(all[0].legs.map(l => l.id), ['1']);
});

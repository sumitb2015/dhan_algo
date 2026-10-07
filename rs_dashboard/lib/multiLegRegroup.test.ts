import test from 'node:test';
import assert from 'node:assert/strict';
import { regroupBaskets } from './multiLegRegroup.ts';
import { isLooseTrade, type MultiLegBasket, type MultiLegLeg } from './multiLegFocus.ts';

const leg = (id: string, o: Partial<MultiLegLeg> = {}): MultiLegLeg => ({
  id, side: 'S', option: 'CE', strike: 24000, lots: 1, type: 'MARKET', status: 'OPEN', expiry: '2026-10-27', ...o,
});
const bk = (id: string, legs: MultiLegLeg[], o: Partial<MultiLegBasket> = {}): MultiLegBasket => ({
  id, underlying: 'NIFTY', expiry: '2026-10-27', broker: 'dhan', legs, createdAt: '', updatedAt: '', rev: 3, ...o,
});
let n = 0;
const nid = () => `new${++n}`;
const armed = { targetUnit: 'pts' as const, slUnit: 'pts' as const, armed: true };

test('group: picked legs go into a new named basket; source is bumped and disarmed', () => {
  const r = regroupBaskets([bk('A', [leg('1'), leg('2', { option: 'PE' })], { riskConfig: armed })], { op: 'group', legIds: ['2'], name: ' Hedge ' }, nid, 'now');
  assert.ok(r.ok);
  const [src, made] = r.baskets;
  assert.deepEqual(src.legs.map(l => l.id), ['1']);
  assert.equal(src.rev, 4);
  assert.equal(src.riskConfig?.armed, false);
  assert.deepEqual(r.disarmed, ['A']);
  assert.equal(made.groupName, 'Hedge');
  assert.deepEqual(made.legs.map(l => l.id), ['2']);
});

test('group: ledger fields ride along and an emptied source is removed', () => {
  const l = leg('1', { fill: { qty: 65, avgPrice: 30 }, orderIds: ['x'] });
  const r = regroupBaskets([bk('A', [l])], { op: 'group', legIds: ['1'], name: 'N' }, nid, 'now');
  assert.equal(r.baskets.length, 1);
  assert.deepEqual(r.baskets[0].legs[0], l);
});

test('group into an existing basket', () => {
  const r = regroupBaskets([bk('A', [leg('1'), leg('2')]), bk('B', [leg('3')])], { op: 'group', legIds: ['2'], targetBasketId: 'B' }, nid, 'now');
  assert.ok(r.ok);
  assert.deepEqual(r.baskets.find(b => b.id === 'B')!.legs.map(l => l.id), ['3', '2']);
  assert.deepEqual(r.baskets.find(b => b.id === 'A')!.legs.map(l => l.id), ['1']);
  assert.equal(regroupBaskets([bk('A', [leg('1'), leg('2')])], { op: 'group', legIds: ['1'], targetBasketId: 'A' }, nid, 'now').ok, false);
});

test('a group from one row keeps its lot multiplier; from several rows it does not', () => {
  const one = regroupBaskets([bk('A', [leg('1'), leg('2'), leg('3')], { multiplier: 3 })], { op: 'group', legIds: ['1', '2'] }, nid, 'now');
  assert.equal(one.baskets[1].multiplier, 3);
  const two = regroupBaskets([bk('A', [leg('1')], { multiplier: 3 }), bk('B', [leg('2')], { multiplier: 2 })], { op: 'group', legIds: ['1', '2'] }, nid, 'now');
  assert.equal(two.baskets[0].multiplier, undefined);
});

test('refusals: in-flight leg, mixed broker, drafts with traded legs, duplicate ids, nothing picked', () => {
  const no = (bs: MultiLegBasket[], req: Parameters<typeof regroupBaskets>[1]) => assert.equal(regroupBaskets(bs, req, nid, 'now').ok, false);
  no([bk('A', [leg('1', { status: 'CLOSING' })])], { op: 'group', legIds: ['1'] });
  no([bk('A', [leg('1')]), bk('B', [leg('2')], { broker: 'kotak' })], { op: 'group', legIds: ['1', '2'] });
  no([bk('A', [leg('1')]), bk('D', [leg('2', { status: 'DRAFT' })])], { op: 'group', legIds: ['1', '2'] });
  no([bk('A', [leg('1')]), bk('B', [leg('1')])], { op: 'group', legIds: ['1'] });
  no([bk('A', [leg('1')])], { op: 'ungroup', legIds: [] });
});

test('ungroup: each picked leg becomes an ungrouped trade', () => {
  const a = bk('A', [leg('1'), leg('2', { option: 'PE' }), leg('c', { status: 'CLOSED' })], { groupName: 'Mine' });
  const r = regroupBaskets([a], { op: 'ungroup', legIds: ['1', '2'] }, nid, 'now');
  assert.ok(r.ok);
  assert.deepEqual(r.baskets[0].legs.map(l => l.id), ['c']);   // closed leg stays as the group's history
  assert.equal(r.baskets[0].groupName, 'Mine');
  assert.equal(r.baskets.filter(isLooseTrade).length, 2);
});

test('ungroup: a leg alone in a named basket just loses the name', () => {
  const r = regroupBaskets([bk('S', [leg('9')], { groupName: 'Solo' })], { op: 'ungroup', legIds: ['9'] }, nid, 'now');
  assert.ok(r.ok);
  assert.equal(r.baskets.length, 1);
  assert.equal(r.baskets[0].id, 'S');
  assert.ok(isLooseTrade(r.baskets[0]));
});

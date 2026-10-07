import test from 'node:test';
import assert from 'node:assert/strict';
import { regroupBaskets } from './multiLegRegroup.ts';
import type { MultiLegBasket, MultiLegLeg } from './multiLegFocus.ts';

const leg = (id: string, o: Partial<MultiLegLeg> = {}): MultiLegLeg => ({
  id, side: 'S', option: 'CE', strike: 24000, lots: 1, type: 'MARKET', status: 'OPEN', expiry: '2026-10-27', ...o,
});
const bk = (id: string, legs: MultiLegLeg[], o: Partial<MultiLegBasket> = {}): MultiLegBasket => ({
  id, underlying: 'NIFTY', expiry: '2026-10-27', broker: 'dhan', legs, createdAt: '', updatedAt: '', rev: 3, ...o,
});
let n = 0;
const nid = () => `new${++n}`;

test('group moves legs into a new named basket and bumps the source', () => {
  const a = bk('A', [leg('1'), leg('2', { option: 'PE' })], { riskConfig: { targetUnit: 'pts', slUnit: 'pts', armed: true } });
  const r = regroupBaskets([a], { op: 'group', legIds: ['2'], name: ' Hedge ' }, nid, 'now');
  assert.ok(r.ok);
  const [src, made] = r.baskets;
  assert.deepEqual(src.legs.map(l => l.id), ['1']);
  assert.equal(src.rev, 4);
  assert.equal(src.riskConfig?.armed, false);
  assert.deepEqual(r.disarmed, ['A']);
  assert.equal(made.groupName, 'Hedge');
  assert.equal(made.legs[0].id, '2');
});

test('emptied source is removed; ledger fields ride along', () => {
  const l = leg('1', { fill: { qty: 65, avgPrice: 30 }, orderIds: ['x'] });
  const r = regroupBaskets([bk('A', [l])], { op: 'group', legIds: ['1'], name: 'N' }, nid, 'now');
  assert.equal(r.baskets.length, 1);
  assert.deepEqual(r.baskets[0].legs[0], l);
});

test('refuses in-flight legs and mixed broker', () => {
  assert.equal(regroupBaskets([bk('A', [leg('1', { status: 'CLOSING' })])], { op: 'group', legIds: ['1'] }, nid, 'now').ok, false);
  const r = regroupBaskets([bk('A', [leg('1')]), bk('B', [leg('2')], { broker: 'kotak' })], { op: 'group', legIds: ['1', '2'] }, nid, 'now');
  assert.equal(r.ok, false);
});

test('ungroup splits every leg into its own row', () => {
  const r = regroupBaskets([bk('A', [leg('1'), leg('2', { option: 'PE', strike: 22000 })])], { op: 'ungroup', basketId: 'A' }, nid, 'now');
  assert.ok(r.ok);
  assert.equal(r.baskets.length, 2);
  assert.equal(r.baskets[1].groupName, undefined);
});

test('group into an existing basket', () => {
  const r = regroupBaskets([bk('A', [leg('1'), leg('2')]), bk('B', [leg('3')])], { op: 'group', legIds: ['2'], targetBasketId: 'B' }, nid, 'now');
  assert.ok(r.ok);
  assert.deepEqual(r.baskets.find(b => b.id === 'B')!.legs.map(l => l.id), ['3', '2']);
  assert.deepEqual(r.baskets.find(b => b.id === 'A')!.legs.map(l => l.id), ['1']);
});

test('ungroup leaves one-leg rows (and their names) alone', () => {
  const solo = bk('S', [leg('9')], { groupName: 'Mine' });
  const multi = bk('A', [leg('1'), leg('2', { option: 'PE' })]);
  const r = regroupBaskets([solo, multi], { op: 'ungroup', legIds: ['9', '1', '2'] }, nid, 'now');
  assert.ok(r.ok);
  assert.equal(r.baskets.find(b => b.id === 'S')!.groupName, 'Mine');
  assert.equal(r.baskets.length, 3);
  assert.equal(regroupBaskets([solo], { op: 'ungroup', legIds: ['9'] }, nid, 'now').ok, false);
});

test('drafts never share a group with traded legs', () => {
  const r = regroupBaskets([bk('A', [leg('1')]), bk('D', [leg('2', { status: 'DRAFT' })])], { op: 'group', legIds: ['1', '2'] }, nid, 'now');
  assert.equal(r.ok, false);
  const into = regroupBaskets([bk('A', [leg('1')]), bk('D', [leg('2', { status: 'DRAFT' }), leg('3', { status: 'DRAFT' })])],
    { op: 'group', legIds: ['2'], targetBasketId: 'A' }, nid, 'now');
  assert.equal(into.ok, false);
  const drafts = regroupBaskets([bk('D', [leg('2', { status: 'DRAFT' }), leg('3', { status: 'DRAFT' })])], { op: 'group', legIds: ['2', '3'], name: 'x' }, nid, 'now');
  assert.ok(drafts.ok);
});

test('moving trades into the row that already holds them is refused', () => {
  const r = regroupBaskets([bk('A', [leg('1'), leg('2')])], { op: 'group', legIds: ['1'], targetBasketId: 'A' }, nid, 'now');
  assert.equal(r.ok, false);
});

test('a leg id present in two rows is refused, not half-moved', () => {
  const r = regroupBaskets([bk('A', [leg('1')]), bk('B', [leg('1')])], { op: 'group', legIds: ['1'] }, nid, 'now');
  assert.equal(r.ok, false);
  assert.match(r.error!, /more than one row/);
});

test('ungrouping a row keeps its closed legs there as history', () => {
  const a = bk('A', [leg('1'), leg('2', { option: 'PE' }), leg('c', { status: 'CLOSED' })], { groupName: 'Mine' });
  const r = regroupBaskets([a], { op: 'ungroup', basketId: 'A' }, nid, 'now');
  assert.ok(r.ok);
  const orig = r.baskets.find(b => b.id === 'A')!;
  assert.deepEqual(orig.legs.map(l => l.id), ['c']);
  assert.equal(orig.groupName, 'Mine');
  assert.equal(r.baskets.length, 3);
  // fewer than two live legs: nothing to ungroup
  assert.equal(regroupBaskets([bk('B', [leg('1'), leg('c2', { status: 'CLOSED' })])], { op: 'ungroup', basketId: 'B' }, nid, 'now').ok, false);
});

test('a new group from one row keeps that row\'s lot multiplier', () => {
  const r = regroupBaskets([bk('A', [leg('1', { lots: 3, ratio: 1 }), leg('2', { lots: 3, ratio: 1 }), leg('3')], { multiplier: 3 })],
    { op: 'group', legIds: ['1', '2'] }, nid, 'now');
  assert.equal(r.baskets[1].multiplier, 3);
  const mixed = regroupBaskets([bk('A', [leg('1')], { multiplier: 3 }), bk('B', [leg('2')], { multiplier: 2 })], { op: 'group', legIds: ['1', '2'] }, nid, 'now');
  assert.equal(mixed.baskets[0].multiplier, undefined);
});

import { test } from 'node:test';
import assert from 'node:assert';
import { splitStaleClosed, appendToArchive, hasTradeHistory, type ArchivedBasket } from './multiLegArchive.ts';
import type { MultiLegBasket, MultiLegLeg } from './multiLegFocus.ts';

const leg = (status: MultiLegLeg['status'], extra: Partial<MultiLegLeg> = {}): MultiLegLeg =>
  ({ id: `l${Math.random()}`, side: 'S', option: 'CE', strike: 23400, lots: 1, type: 'MARKET', status, ...extra });
const basket = (id: string, updatedAt: string, legs: MultiLegLeg[]): MultiLegBasket =>
  ({ id, underlying: 'NIFTY', expiry: '2026-10-27', broker: 'dhan', legs, createdAt: updatedAt, updatedAt });
const traded = { orderRef: { securityId: '51368' }, closedFill: { qty: 65, exitPrice: 100 } };

test('splitStaleClosed retires only fully closed baskets last touched before today (IST)', () => {
  const b = [
    basket('old-closed', '2026-09-28T09:00:00Z', [leg('CLOSED', traded)]),
    basket('today-closed', '2026-09-29T09:00:00Z', [leg('CLOSED', traded)]),
    basket('old-open', '2026-09-20T09:00:00Z', [leg('CLOSED', traded), leg('OPEN', traded)]),
    // 23:30 IST on 09-28 is 18:00Z: still the 28th in IST.
    basket('late-night', '2026-09-28T18:00:00Z', [leg('CLOSED', traded)]),
    basket('empty', '2026-09-01T00:00:00Z', []),
  ];
  const { keep, retire } = splitStaleClosed(b, '2026-09-29');
  assert.deepStrictEqual(retire.map(x => x.id), ['old-closed', 'late-night']);
  assert.deepStrictEqual(keep.map(x => x.id), ['today-closed', 'old-open', 'empty']);
});

test('appendToArchive stamps archivedAt, skips never-traded drafts, and is idempotent by id', () => {
  const a = basket('a', '2026-09-28T09:00:00Z', [leg('CLOSED', traded)]);
  const draft = basket('d', '2026-09-28T09:00:00Z', [leg('CLOSED')]);
  assert.strictEqual(hasTradeHistory(draft), false);
  const once = appendToArchive([], [a, draft], '2026-09-30T00:00:00Z');
  assert.deepStrictEqual(once.map(x => [x.id, x.archivedAt]), [['a', '2026-09-30T00:00:00Z']]);
  const prior: ArchivedBasket[] = [{ ...basket('z', '2026-09-01T00:00:00Z', [leg('CLOSED', traded)]), archivedAt: '2026-09-02T00:00:00Z' }];
  const twice = appendToArchive([...prior, ...once], [a], '2026-09-30T00:05:00Z');
  assert.deepStrictEqual(twice.map(x => x.id), ['z', 'a']);
  assert.strictEqual(twice[1].archivedAt, '2026-09-30T00:05:00Z');
  assert.strictEqual(appendToArchive(prior, [draft], 'x'), prior);
});

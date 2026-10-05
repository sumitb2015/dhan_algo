import { test } from 'node:test';
import assert from 'node:assert';
import { splitEarlierDayLegs, mergeHistoryRecord, splitStaleClosed, appendToArchive, hasTradeHistory, summarizeArchived, type ArchivedBasket } from './multiLegArchive.ts';
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

test('summarizeArchived sums realized P&L, applies the Dhan MCX multiplier, and counts unpriced closes', () => {
  const closedLeg = (side: 'B' | 'S', entry: number, exit: number, qty: number, closedAt?: number): MultiLegLeg =>
    leg('CLOSED', { side, fill: { qty: 0, avgPrice: entry }, closedFill: { qty, exitPrice: exit }, closedAt });
  const b = basket('s', '2026-09-29T10:00:00Z', [
    closedLeg('S', 31.45, 170.675, 260, 1_000),
    closedLeg('B', 36, 192.05, 130, 2_000),
    leg('CLOSED', { fill: { qty: 0, avgPrice: 50 } }),
  ]);
  const s = summarizeArchived(b);
  assert.ok(Math.abs(s.realized - ((31.45 - 170.675) * 260 + (192.05 - 36) * 130)) < 1e-6);
  assert.strictEqual(s.closedAt, 2_000);
  assert.strictEqual(s.unpricedLegs, 1);
  const crude = { ...basket('c', '2026-09-29T10:00:00Z', [closedLeg('B', 100, 110, 2)]), underlying: 'CRUDEOIL' };
  assert.strictEqual(summarizeArchived(crude).realized, 2000);
  assert.strictEqual(summarizeArchived({ ...crude, broker: 'kotak' }).realized, 20);
  assert.strictEqual(summarizeArchived(basket('u', '2026-09-28T10:00:00Z', [])).closedAt, Date.parse('2026-09-28T10:00:00Z'));
});


test('splitEarlierDayLegs sheds earlier-day closed legs of a live basket, keeps today\'s and open ones', () => {
  const now = Date.parse('2026-10-05T08:00:00Z');
  const earlier = leg('CLOSED', { ...traded, closedAt: Date.parse('2026-10-01T09:00:00Z') });
  const noStamp = leg('CLOSED', traded);
  const today = leg('CLOSED', { ...traded, closedAt: Date.parse('2026-10-05T04:00:00Z') });
  const open = leg('OPEN', traded);
  const b = basket('live', '2026-10-05T08:00:00Z', [earlier, noStamp, today, open]);
  const { keep, retired } = splitEarlierDayLegs(b, now);
  assert.deepStrictEqual(retired.map(l => l.id), [earlier.id, noStamp.id]);
  assert.deepStrictEqual(keep.legs.map(l => l.id), [today.id, open.id]);
  // Fully closed baskets are left to splitStaleClosed.
  const allClosed = basket('done', '2026-10-05T08:00:00Z', [earlier]);
  assert.strictEqual(splitEarlierDayLegs(allClosed, now).keep, allClosed);
});

test('mergeHistoryRecord creates then extends one history record, idempotent by leg id', () => {
  const src = { ...basket('live', '2026-10-05T08:00:00Z', []), name: 'Short Strangle' };
  const a = leg('CLOSED', traded), c = leg('CLOSED', traded);
  const first = mergeHistoryRecord(undefined, src, [a], '2026-10-05T09:00:00Z');
  assert.strictEqual(first.id, 'live__history');
  assert.strictEqual(first.retiredFrom, 'live');
  const second = mergeHistoryRecord(first, src, [a, c], '2026-10-06T09:00:00Z');
  assert.deepStrictEqual(second.legs.map(l => l.id), [a.id, c.id]);
});

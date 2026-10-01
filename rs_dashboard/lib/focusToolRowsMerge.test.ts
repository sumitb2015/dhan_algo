import { test } from 'node:test';
import assert from 'node:assert';
import { mergeFocusConfigWrite, DELETED_ROW_CAP } from './focusToolRowsMerge.ts';
import type { FocusRow, FocusToolConfig } from './focusToolRows.ts';

const row = (id: string, over: Partial<FocusRow> = {}): FocusRow => ({ id, ...over } as FocusRow);
const cfg = (rows: FocusRow[], over: Partial<FocusToolConfig> = {}): FocusToolConfig =>
  ({ groups: [], rows, riskEnabled: false, targetRupees: '', stopRupees: '', trailEnabled: false,
    triggerRupees: '', lockRupees: '', liveRealMoney: false, liveArmedOn: '', updatedAt: 't', ...over } as FocusToolConfig);
const fill = (ceQty: number) => ({ ceStrike: 22300, peStrike: null, ceQty, peQty: 0 }) as FocusRow['fill'];

test('a stale tab save cannot roll back another row\'s fill ledger', () => {
  const stored = cfg([row('a', { fill: fill(130), rev: 4 }), row('b', { fill: fill(65), rev: 2 })]);
  // Tab saved its own change to row b, but still holds row a's old (flat) ledger.
  const { config } = mergeFocusConfigWrite(stored, { rows: [row('a', { fill: fill(0), rev: 3 }), row('b', { fill: fill(0), rev: 3 })] });
  assert.strictEqual(config.rows.find(r => r.id === 'a')?.fill?.ceQty, 130);
  assert.strictEqual(config.rows.find(r => r.id === 'b')?.fill?.ceQty, 0);
});

test('rows leave only through deleteRowIds, never while holding a position, and stay deleted', () => {
  const stored = cfg([row('open', { fill: fill(65), rev: 1 }), row('flat', { rev: 1 })]);
  assert.deepStrictEqual(mergeFocusConfigWrite(stored, { rows: [] }).config.rows.map(r => r.id), ['open', 'flat']);

  const del = mergeFocusConfigWrite(stored, { rows: [row('open', { fill: fill(65), rev: 1 })], deleteRowIds: ['flat', 'open'] });
  assert.deepStrictEqual(del.config.rows.map(r => r.id), ['open']);
  assert.deepStrictEqual(del.refusedDeletes, ['open']);
  assert.deepStrictEqual(del.config.deletedRowIds, ['flat']);

  // A stale tab still holding the deleted row can't bring it back.
  const stale = mergeFocusConfigWrite(del.config, { rows: [row('flat', { rev: 5 })] });
  assert.deepStrictEqual(stale.config.rows.map(r => r.id), ['open']);
});

test('the tombstone list is server-owned and capped', () => {
  const many = Array.from({ length: DELETED_ROW_CAP }, (_, i) => `x${i}`);
  const stored = cfg([], { deletedRowIds: many });
  const out = mergeFocusConfigWrite(stored, { deletedRowIds: [], deleteRowIds: ['y'] } as never).config;
  assert.strictEqual(out.deletedRowIds?.length, DELETED_ROW_CAP);
  assert.strictEqual(out.deletedRowIds?.at(-1), 'y');
  assert.strictEqual(out.deletedRowIds?.[0], 'x1');
});

test('other fields stay last-write-wins, only when the save carries them', () => {
  const stored = cfg([row('a', { rev: 1 })], { riskEnabled: true, targetRupees: '5000' });
  const out = mergeFocusConfigWrite(stored, { targetRupees: '8000' }).config;
  assert.strictEqual(out.targetRupees, '8000');
  assert.strictEqual(out.riskEnabled, true);
  assert.deepStrictEqual(out.rows.map(r => r.id), ['a']);
});

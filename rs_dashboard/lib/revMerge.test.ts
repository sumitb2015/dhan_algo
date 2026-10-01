import { test } from 'node:test';
import assert from 'node:assert';
import { mergeRevItems, stampItems, noteItems, adoptItems, itemBody, type RevBook } from './revMerge.ts';

type Row = { id: string; rev?: number; qty: number; updatedAt?: string };

test('mergeRevItems keeps the higher rev per item and reports same-rev conflicts', () => {
  const stored: Row[] = [{ id: 'a', rev: 3, qty: 585 }, { id: 'b', rev: 1, qty: 65 }];
  const incoming: Row[] = [{ id: 'a', rev: 2, qty: 390 }, { id: 'b', rev: 2, qty: 130 }];
  assert.deepStrictEqual(mergeRevItems(stored, incoming).items, [{ id: 'a', rev: 3, qty: 585 }, { id: 'b', rev: 2, qty: 130 }]);
  const tie = mergeRevItems(stored, [{ id: 'a', rev: 3, qty: 1 }]);
  assert.strictEqual(tie.items[0].qty, 585);
  assert.deepStrictEqual(tie.conflicts, ['a']);
  assert.deepStrictEqual(mergeRevItems(stored, [{ id: 'a', rev: 3, qty: 585, updatedAt: 'x' }]).conflicts, []);
});

test('mergeRevItems keeps items a save left out, skips tombstones, honours dropMissing', () => {
  const stored: Row[] = [{ id: 'a', rev: 1, qty: 1 }, { id: 'b', rev: 1, qty: 2 }];
  assert.deepStrictEqual(mergeRevItems(stored, []).items.map(r => r.id), ['a', 'b']);
  assert.deepStrictEqual(mergeRevItems(stored, [{ id: 'z', rev: 1, qty: 9 }], { tombstones: new Set(['z']) }).items.map(r => r.id), ['a', 'b']);
  assert.deepStrictEqual(mergeRevItems(stored, [], { dropMissing: r => r.id === 'b' }).items.map(r => r.id), ['a']);
});

test('stampItems bumps only changed items, relative to the last save', () => {
  const book: RevBook = new Map();
  noteItems(book, 'r:', [{ id: 'a', rev: 4, qty: 1 }, { id: 'b', rev: 2, qty: 2 }] as Row[]);
  const sent = stampItems(book, 'r:', [{ id: 'a', qty: 5 }, { id: 'b', qty: 2 }, { id: 'c', qty: 3 }] as Row[]);
  assert.deepStrictEqual(sent.map(r => r.rev), [5, 2, 1]);
  assert.deepStrictEqual(stampItems(book, 'r:', sent).map(r => r.rev), [5, 2, 1]);
});

test('adoptItems takes server rows the tab has not changed, keeps in-flight local changes', () => {
  const sent: Row[] = [{ id: 'a', qty: 1 }, { id: 'b', qty: 2 }, { id: 'gone', qty: 0 }];
  const server: Row[] = [{ id: 'a', rev: 9, qty: 100 }, { id: 'b', rev: 9, qty: 200 }, { id: 'new', rev: 1, qty: 7 }];
  const local: Row[] = [{ id: 'a', qty: 1 }, { id: 'b', qty: 3 }, { id: 'gone', qty: 0 }];
  const out = adoptItems(local, sent, server);
  assert.deepStrictEqual(out.map(r => [r.id, r.qty]), [['a', 100], ['b', 3], ['new', 7]]);
  assert.strictEqual(adoptItems(sent, sent, sent), sent);
});

test('itemBody ignores rev, updatedAt and key order', () => {
  assert.strictEqual(itemBody({ id: 'a', qty: 1, rev: 2, updatedAt: 'x' }), itemBody({ qty: 1, id: 'a' }));
});

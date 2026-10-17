import { test } from 'node:test';
import assert from 'node:assert';
import { loadOwnOrders, rememberOwnOrder, type OwnOrderStore } from './focusOwnOrders.ts';

const mem = (): OwnOrderStore & { m: Map<string, string> } => {
  const m = new Map<string, string>();
  return { m, getItem: k => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); } };
};

test('own order ids persist for the day and per broker', () => {
  const s = mem();
  rememberOwnOrder(s, 'kotak', '2026-10-17', '111');
  rememberOwnOrder(s, 'kotak', '2026-10-17', '222');
  rememberOwnOrder(s, 'kotak', '2026-10-17', '111');
  assert.deepStrictEqual([...loadOwnOrders(s, 'kotak', '2026-10-17')], ['111', '222']);
  assert.strictEqual(loadOwnOrders(s, 'dhan', '2026-10-17').size, 0);
});

test('ids from an earlier day are dropped, and a corrupt entry reads as empty', () => {
  const s = mem();
  rememberOwnOrder(s, 'kotak', '2026-10-16', '111');
  assert.strictEqual(loadOwnOrders(s, 'kotak', '2026-10-17').size, 0);
  rememberOwnOrder(s, 'kotak', '2026-10-17', '333');
  assert.deepStrictEqual([...loadOwnOrders(s, 'kotak', '2026-10-17')], ['333']);
  s.m.set('focus_tool_own_orders_v1_kotak', '{not json');
  assert.strictEqual(loadOwnOrders(s, 'kotak', '2026-10-17').size, 0);
});

test('an unusable store does not throw', () => {
  const broken: OwnOrderStore = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } };
  assert.doesNotThrow(() => rememberOwnOrder(broken, 'kotak', '2026-10-17', '1'));
  assert.strictEqual(loadOwnOrders(broken, 'kotak', '2026-10-17').size, 0);
});

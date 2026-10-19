import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findOrderByTag, newOrderTag } from './zerodhaPlaceOrder.ts';

test('newOrderTag is alphanumeric and within Kite\'s 20-char limit', () => {
  const t = newOrderTag();
  assert.match(t, /^[A-Za-z0-9]{1,20}$/);
  assert.notEqual(t, newOrderTag());
});

test('findOrderByTag matches only the tagged order', () => {
  const book = [{ order_id: '1', tag: 'other' }, { order_id: 22, tag: 'DXabc' }, { order_id: '3' }];
  assert.equal(findOrderByTag(book, 'DXabc'), '22');
  assert.equal(findOrderByTag(book, 'missing'), null);
  assert.equal(findOrderByTag(null, 'DXabc'), null);
});

import { test } from 'node:test';
import assert from 'node:assert';
import { classifyOrderReply, openHoldReason, UNKNOWN_NO_REPLY } from './focusToolOrderOutcome.ts';

test('a booked order is placed, with or without an id', () => {
  assert.deepStrictEqual(classifyOrderReply(200, { success: true, order_id: 'K1' }), { kind: 'placed', orderId: 'K1' });
  assert.deepStrictEqual(classifyOrderReply(200, { success: true, order_id: 123, reconciled: true }), { kind: 'placed', orderId: '123' });
  assert.deepStrictEqual(classifyOrderReply(200, { success: true }), { kind: 'placed', orderId: null });
});

test('Kotak unknown (504 + unknown:true) and Dhan unknown (504, no flag) are unknown, never rejected', () => {
  assert.equal(classifyOrderReply(504, { success: false, unknown: true, error: 'Order status unknown - Kotak' }).kind, 'unknown');
  const dhan = classifyOrderReply(504, { success: false, error: 'Order status unknown — Dhan did not confirm in time.' });
  assert.deepStrictEqual(dhan, { kind: 'unknown', error: 'Order status unknown — Dhan did not confirm in time.' });
  // The flag alone is enough, whatever the status.
  assert.equal(classifyOrderReply(200, { success: false, unknown: true }).kind, 'unknown');
});

test('no reply at all, or a crashed route with no JSON, is unknown', () => {
  assert.deepStrictEqual(classifyOrderReply(null, undefined), { kind: 'unknown', error: UNKNOWN_NO_REPLY });
  assert.equal(classifyOrderReply(500, undefined).kind, 'unknown');
  assert.equal(classifyOrderReply(502, undefined).kind, 'unknown');
});

test('a clean JSON refusal is rejected: validation, lot cap, credentials, broker rejection, a missing route', () => {
  assert.deepStrictEqual(classifyOrderReply(400, { success: false, error: 'Invalid quantity' }), { kind: 'rejected', error: 'Invalid quantity' });
  assert.equal(classifyOrderReply(200, { success: false, error: 'RMS: margin exceeds' }).kind, 'rejected');
  assert.equal(classifyOrderReply(500, { success: false, error: 'access_token.json missing' }).kind, 'rejected', 'sent nothing: credentials failed before the request');
  assert.equal(classifyOrderReply(404, undefined).kind, 'rejected', 'an HTML 404 never reached a broker');
  assert.deepStrictEqual(classifyOrderReply(200, { success: false }), { kind: 'rejected', error: 'Unknown broker error' });
});

test('openHoldReason holds opens only while the row carries an unknown order', () => {
  assert.equal(openHoldReason({}), null);
  assert.match(openHoldReason({ orderUnknown: { leg: 'CE', kind: 'open', at: 'x' } }) ?? '', /CE order's status is unknown/);
  assert.match(openHoldReason({ orderUnknown: { leg: 'PE', kind: 'ladder', at: 'x' } }) ?? '', /limit-ladder/);
});

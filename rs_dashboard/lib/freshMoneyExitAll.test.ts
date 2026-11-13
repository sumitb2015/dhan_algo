import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runExitAll, type ExitAllPos } from './freshMoneyExitAll.ts';
import type { CloseResult } from './freshMoneyExits.ts';

const p = (key: string, netQty: number): ExitAllPos => ({ key, netQty, underlying: 'NIFTY', strike: 25000, opt: 'PE', broker: 'dhan' });
const placed: CloseResult = { kind: 'placed', orderId: 'x' };

test('nothing open: no close sent, outcome none', async () => {
  const sent: string[] = [];
  const r = await runExitAll([p('a', 0)], async k => { sent.push(k); return placed; });
  assert.deepEqual(sent, []);
  assert.equal(r.outcome, 'none');
});

test('closes every open position, shorts before longs', async () => {
  const sent: string[] = [];
  const r = await runExitAll([p('long', 65), p('flat', 0), p('short', -65)], async k => { sent.push(k); return placed; });
  assert.deepEqual(sent, ['short', 'long']);
  assert.equal(r.outcome, 'sent');
});

test('a short whose cover did not go out stops the hedges', async () => {
  const sent: string[] = [];
  const r = await runExitAll([p('hedge', 65), p('short', -65)], async k => {
    sent.push(k);
    return { kind: 'refused', error: 'market closed', http: 409 };
  });
  assert.deepEqual(sent, ['short']);
  assert.deepEqual(r.items.map(i => i.kind), ['refused', 'skipped']);
  assert.equal(r.outcome, 'failed');
});

test('UNKNOWN or a throw = unknown outcome, never retried; a mix = incomplete', async () => {
  let n = 0;
  const r = await runExitAll([p('s1', -65), p('s2', -65)], async () => { if (n++ === 0) throw new Error('timeout'); return placed; });
  assert.equal(n, 1, 'stops after the UNKNOWN short cover');
  assert.equal(r.outcome, 'unknown');
  const mix = await runExitAll([p('l1', 65), p('l2', 65)], async k => (k === 'l1' ? placed : { kind: 'rejected', error: 'no', http: 200 }));
  assert.equal(mix.outcome, 'incomplete');
});

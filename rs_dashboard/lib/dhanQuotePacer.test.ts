import { test } from 'node:test';
import assert from 'node:assert';
import { pacedQuoteCall } from './dhanQuotePacer.ts';

test('a third concurrent caller is rejected as busy instead of queueing', async () => {
  const gate = new Promise<void>(r => setTimeout(r, 50));
  const first = pacedQuoteCall(async () => { await gate; return 1; });
  const second = pacedQuoteCall(async () => 2);
  await assert.rejects(pacedQuoteCall(async () => 3), (e: { busy?: boolean }) => e.busy === true);
  assert.strictEqual(await first, 1);
  assert.strictEqual(await second, 2);
});

test('the gap delays the NEXT caller, not the one that already has its answer', async () => {
  await new Promise(r => setTimeout(r, 1300));          // let the previous test's gap drain
  const t0 = Date.now();
  const a = await pacedQuoteCall(async () => 'a');
  assert.strictEqual(a, 'a');
  assert.ok(Date.now() - t0 < 300, 'first call must not wait out its own gap');
  const t1 = Date.now();
  await pacedQuoteCall(async () => 'b');
  assert.ok(Date.now() - t1 >= 900, 'second call waits for the previous call\'s gap');
});

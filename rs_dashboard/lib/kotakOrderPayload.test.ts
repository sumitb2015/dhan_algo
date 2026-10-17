import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildKotakOrderPayload } from './kotakOrderPayload.ts';

// The Kotak place-order body both /api/scalper/kotak/order and /api/options/order (broker 'kotak') send.

const ok = (r: ReturnType<typeof buildKotakOrderPayload>) => {
  assert.ok('payload' in r, 'error' in r ? r.error : '');
  return (r as { payload: Record<string, string> }).payload;
};

test('a market order: absolute quantity, MIS when no product is sent, no price', () => {
  assert.deepEqual(ok(buildKotakOrderPayload({ tradingsymbol: 'NIFTY26O1923150CE', quantity: 65, side: 'sell' }, null)), {
    es: 'nse_fo', pc: 'MIS', pr: '0', pt: 'MKT', qt: '65', rt: 'DAY', ts: 'NIFTY26O1923150CE', tt: 'S',
    am: 'NO', dq: '0', mp: '0', pf: 'N', tp: '0', os: 'NEOTRADEAPI',
  });
});

test('product: NRML kept, an unknown product refused (never coerced to MIS)', () => {
  assert.equal(ok(buildKotakOrderPayload({ tradingsymbol: 'X', quantity: 10, side: 'BUY', product: 'nrml', exchange: 'mcx_fo' }, null)).pc, 'NRML');
  const r = buildKotakOrderPayload({ tradingsymbol: 'X', quantity: 10, side: 'BUY', product: 'BO' }, null);
  assert.ok('error' in r && /Unsupported product/.test(r.error));
});

test('limit and stop prices snap to the contract tick; a stop without a trigger is refused', () => {
  const lim = ok(buildKotakOrderPayload({ tradingsymbol: 'CRUDEOILM19NOV26FUT', quantity: 10, side: 'BUY', orderType: 'LIMIT', price: 8721.4, exchange: 'mcx_fo' }, { lotSize: 10, tick: 1 }));
  assert.deepEqual([lim.pt, lim.pr], ['L', '8721.00']);
  const slm = ok(buildKotakOrderPayload({ tradingsymbol: 'X', quantity: 65, side: 'BUY', orderType: 'SL-M', triggerPrice: 101.03 }, null));
  assert.deepEqual([slm.pt, slm.tp, slm.pr], ['SL-M', '101.05', '0']);
  const bad = buildKotakOrderPayload({ tradingsymbol: 'X', quantity: 65, side: 'BUY', orderType: 'SL', price: 100 }, null);
  assert.ok('error' in bad && /triggerPrice/.test(bad.error));
  const wrongSide = buildKotakOrderPayload({ tradingsymbol: 'X', quantity: 65, side: 'BUY', orderType: 'SL', price: 99, triggerPrice: 100 }, null);
  assert.ok('error' in wrongSide && /must be >=/.test(wrongSide.error));
});

test('quantity and side are validated; the per-source lot cap applies only to a named source', () => {
  assert.ok('error' in buildKotakOrderPayload({ tradingsymbol: 'X', quantity: 6.5, side: 'BUY' }, null));
  assert.ok('error' in buildKotakOrderPayload({ tradingsymbol: 'X', quantity: 65, side: 'HOLD' }, null));
  const capped = buildKotakOrderPayload({ tradingsymbol: 'NIFTY26O1923150CE', quantity: 65 * 101, side: 'BUY', source: 'as' }, { lotSize: 65, tick: 0.05 });
  assert.ok('error' in capped && /cap/.test(capped.error));
  ok(buildKotakOrderPayload({ tradingsymbol: 'NIFTY26O1923150CE', quantity: 65 * 101, side: 'BUY' }, { lotSize: 65, tick: 0.05 }));
});

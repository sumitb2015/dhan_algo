import test from 'node:test';
import assert from 'node:assert/strict';
import { UNDERLYING_META, FOCUS_UNDERLYINGS, orderQuantity, toInternalQty, isMcxUnderlying } from './focusToolUnderlyings.ts';
import { reentryWindowClosed } from './focusToolRules.ts';

test('NSE/BSE quantities pass through unchanged', () => {
  for (const u of ['NIFTY', 'BANKNIFTY', 'SENSEX'] as const) {
    assert.equal(orderQuantity(u, 130), 130);
    assert.equal(toInternalQty(u, 130), 130);
    assert.equal(isMcxUnderlying(u), false);
  }
});

test('CRUDEOILM: page works in barrels, orders go out in lots', () => {
  assert.equal(toInternalQty('CRUDEOILM', 2), 20);       // 2 lots on the broker book = 20 barrels
  assert.equal(orderQuantity('CRUDEOILM', 20), 2);       // 20 barrels = 2 lots on the wire
  assert.equal(orderQuantity('CRUDEOILM', 10), 1);
  assert.equal(orderQuantity('CRUDEOILM', 4), 0);        // sub-lot: refuse, never round UP past what the row owns
  assert.equal(orderQuantity('CRUDEOILM', 25), 2);       // remainder dropped, not rounded up
  assert.equal(orderQuantity('CRUDEOILM', 0), 0);
  assert.equal(orderQuantity('CRUDEOILM', toInternalQty('CRUDEOILM', 7)), 7);   // round trip
});

test('every underlying has coherent time windows and a segment', () => {
  for (const u of FOCUS_UNDERLYINGS) {
    const m = UNDERLYING_META[u];
    assert.ok(m.entryMinHm < m.entryMaxHm && m.exitMinHm < m.exitMaxHm, u);
    assert.ok(m.strikeStep > 0 && m.unitsPerLot >= 1, u);
  }
});

test('the 15:17 NSE backstop does not apply to an MCX row, its own backstop does', () => {
  const ctx = { nowHm: '16:00', product: 'INTRADAY' as const, groupEnabled: true };
  const row = { exitTime: '', noReEntryAfter: '' };
  assert.match(reentryWindowClosed(row, ctx) ?? '', /15:17/);
  assert.equal(reentryWindowClosed(row, { ...ctx, backstopHm: UNDERLYING_META.CRUDEOILM.backstopHm }), null);
  assert.match(reentryWindowClosed(row, { ...ctx, nowHm: '23:20', backstopHm: '23:15' }) ?? '', /23:15/);
});

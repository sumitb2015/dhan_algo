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

test('premium criteria ignore a dead strike whose last print is stale (zero OI)', async () => {
  const { resolveCriteriaStrike, closestPremiumStrike } = await import('./focusToolRules.ts');
  const oc = {
    '6750': { ce: 1124, pe: 144.35, ceOi: 0, peOi: 0 },        // dead: stale print
    '8700': { ce: 441, pe: 143.4, ceOi: 5, peOi: 34934 },
    '8750': { ce: 408, pe: 160.4, ceOi: 5, peOi: 15080 },
    '9000': { ce: 274, pe: 250, ceOi: 5, peOi: 5 },
  };
  const ctx = { atm: 9000, step: 50, oc };
  assert.equal(resolveCriteriaStrike('PREM_LTE', 'PE', { a: '150', b: '' }, ctx), 8700);
  assert.equal(closestPremiumStrike(oc, 'PE', 144), 8700);
  // No OI information at all: behaves as before.
  const bare = { '6750': { ce: 1, pe: 144.35 }, '8700': { ce: 1, pe: 143.4 } };
  assert.equal(resolveCriteriaStrike('PREM_LTE', 'PE', { a: '150', b: '' }, { atm: 9000, step: 50, oc: bare }), 6750);
});

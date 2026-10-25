import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeDefaults, resolveDefaults, BUILT_IN_DEFAULTS } from './priceLadderDefaults.ts';

test('sanitize keeps valid fields and drops the rest', () => {
  const d = sanitizeDefaults({ mode: 'pair', product: 'NRML', underlying: 'BANKNIFTY', zones: 'anywhere', orderType: 'SL', style: 'Cover',
    tgtPts: 25.555, slPts: 20, trailOn: true, trailPts: 10, lots: 3, opt1: 'PE', opt2: 'CE' });
  assert.deepEqual(d, { mode: 'pair', product: 'NRML', underlying: 'BANKNIFTY', zones: 'anywhere', orderType: 'SL', style: 'Cover',
    tgtPts: 25.56, slPts: 20, trailOn: true, trailPts: 10, lots: 3, opt1: 'PE', opt2: 'CE' });
  assert.deepEqual(sanitizeDefaults({ mode: 'bogus', product: 7, underlying: 'TSLA', tgtPts: -1, slPts: NaN, lots: 99, trailOn: 'yes', opt1: 'XX' }), {});
  assert.deepEqual(sanitizeDefaults(null), {});
  assert.deepEqual(sanitizeDefaults('x'), {});
});

test('lots must be a whole number within the cap', () => {
  assert.equal(sanitizeDefaults({ lots: 2.5 }).lots, undefined);
  assert.equal(sanitizeDefaults({ lots: 0 }).lots, undefined);
  assert.equal(sanitizeDefaults({ lots: 20 }).lots, 20);
  assert.equal(sanitizeDefaults({ lots: 21 }).lots, undefined);
});

test('resolve lays saved values over the built-in ones', () => {
  assert.deepEqual(resolveDefaults({}), BUILT_IN_DEFAULTS);
  assert.equal(resolveDefaults({ tgtPts: 55 }).tgtPts, 55);
  assert.equal(resolveDefaults({ tgtPts: 55 }).slPts, BUILT_IN_DEFAULTS.slPts);
});

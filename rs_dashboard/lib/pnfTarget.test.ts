import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TARGETS, alertId, isComplete, parseTarget, readTargets, targetKey, targetLabel, targetQuery } from './pnfTarget.ts';

test('parseTarget keeps valid fields per segment and drops the rest', () => {
  assert.deepEqual(parseTarget({ kind: 'index', symbol: 'NIFTY', name: 'Nifty 50', expiry: '2026-11-03' }), { kind: 'index', symbol: 'NIFTY', name: 'Nifty 50' });
  assert.deepEqual(parseTarget({ kind: 'options', symbol: 'NIFTY', expiry: '2026-11-03', strike: 23000, side: 'STRADDLE' }),
    { kind: 'options', symbol: 'NIFTY', name: 'NIFTY', expiry: '2026-11-03', strike: 23000, side: 'STRADDLE' });
  assert.deepEqual(parseTarget({ kind: 'options', symbol: 'NIFTY', expiry: 'soon', strike: -5, side: 'XX' }), { kind: 'options', symbol: 'NIFTY', name: 'NIFTY', side: 'CE' });
  for (const bad of [null, 'x', { kind: 'bond', symbol: 'NIFTY' }, { kind: 'index', symbol: 'nifty 50' }, { kind: 'equity' }]) assert.equal(parseTarget(bad), null);
});

test('readTargets restores each segment, falling back to its default', () => {
  const stored = JSON.stringify({ equity: { kind: 'equity', symbol: 'TCS', name: 'TCS' }, futures: { kind: 'options', symbol: 'NIFTY' }, options: 'junk' });
  const t = readTargets(stored);
  assert.equal(t.equity.symbol, 'TCS');
  assert.deepEqual(t.futures, DEFAULT_TARGETS.futures);          // a target filed under the wrong segment is not used
  assert.deepEqual(t.options, DEFAULT_TARGETS.options);
  assert.deepEqual(readTargets('{nope'), DEFAULT_TARGETS);
});

test('a target loads only once its contract is chosen, and maps to the history query', () => {
  assert.equal(isComplete(DEFAULT_TARGETS.index), true);
  assert.equal(isComplete(DEFAULT_TARGETS.futures), false);
  assert.equal(isComplete({ ...DEFAULT_TARGETS.options, expiry: '2026-11-03' }), false);
  const opt = { kind: 'options' as const, symbol: 'NIFTY', name: 'NIFTY', expiry: '2026-11-03', strike: 23000, side: 'STRADDLE' as const };
  assert.equal(isComplete(opt), true);
  assert.equal(targetQuery(DEFAULT_TARGETS.index), 'mode=price&kind=index&symbol=NIFTY');
  assert.equal(targetQuery({ kind: 'futures', symbol: 'M&M', name: 'M&M', expiry: '2026-11-24' }), 'mode=contract&kind=futures&underlying=M%26M&expiry=2026-11-24');
  assert.equal(targetQuery(opt), 'mode=contract&kind=options&underlying=NIFTY&expiry=2026-11-03&strike=23000&type=STRADDLE');
});

test('labels and identity', () => {
  assert.equal(targetLabel({ kind: 'futures', symbol: 'NIFTY', name: '', expiry: '2026-11-24' }), 'NIFTY FUT 24 Nov 26');
  assert.equal(targetLabel({ kind: 'options', symbol: 'NIFTY', name: '', expiry: '2026-11-03', strike: 23000, side: 'STRADDLE' }), 'NIFTY 23000 CE+PE 03 Nov 26');
  assert.equal(targetLabel(DEFAULT_TARGETS.index), 'NIFTY');
  assert.notEqual(targetKey({ ...DEFAULT_TARGETS.options, strike: 1 }), targetKey({ ...DEFAULT_TARGETS.options, strike: 2 }));
});

test('alertId tells contracts apart: two strikes, CE vs PE, or two expiries on the same bar are different entries', () => {
  const ce = { kind: 'options' as const, symbol: 'NIFTY', name: 'NIFTY', expiry: '2026-11-03', strike: 23000, side: 'CE' as const };
  const t = 1793334840;
  const ids = [ce, { ...ce, strike: 23050 }, { ...ce, side: 'PE' as const }, { ...ce, side: 'STRADDLE' as const }, { ...ce, expiry: '2026-11-10' }]
    .map(x => alertId(x, 'DOUBLE_BOTTOM_SELL', t));
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(alertId(ce, 'DOUBLE_BOTTOM_SELL', t), alertId({ ...ce }, 'DOUBLE_BOTTOM_SELL', t));   // the same signal is one entry
  assert.notEqual(alertId(ce, 'DOUBLE_BOTTOM_SELL', t), alertId(ce, 'DOUBLE_TOP_BUY', t));
});

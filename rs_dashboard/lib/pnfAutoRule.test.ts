import test from 'node:test';
import assert from 'node:assert/strict';
import { modelForRule, ruleText, withSide, type AutoRule } from './pnfAutoRule.ts';
import type { PnfSignal } from './straddlePnf.ts';

const sig = (id: string): PnfSignal => ({ id, kind: 'RENKO_BUY', col: 0, bar: 0, t: 0, price: 1, belowVwap: false });
const m = { signals: [sig('n')], trend: [sig('t')], twoBack: [sig('2')], oneBack: [sig('1')], stSignals: [sig('s')], other: 7 };

test('every rule maps to its own signal set and keeps the rest of the model', () => {
  const ids: Record<AutoRule, string> = { nbrick: 'n', trend: 't', twoback: '2', oneback: '1', supertrend: 's' };
  for (const [rule, id] of Object.entries(ids) as [AutoRule, string][]) {
    const out = modelForRule(rule, m);
    assert.equal(out.signals[0].id, id, rule);
    assert.equal(out.other, 7);
  }
  assert.equal(modelForRule('nbrick', m), m, 'the plain rule is the model itself');
});

test('every rule has its own description, naming N where it matters', () => {
  const texts = (['nbrick', 'trend', 'twoback', 'oneback', 'supertrend'] as const).map(r => ruleText(r, 3));
  assert.equal(new Set(texts).size, 5);
  assert.match(ruleText('trend', 3), /completes 3 same-colour/);
  assert.match(ruleText('nbrick', 2), /after 2 confirming bricks/);
});

test('withSide keeps only the allowed side\'s signals; both is the model itself; exits are the engine\'s, not filtered here', () => {
  const buy = sig('b'); const sell = { ...sig('s'), kind: 'RENKO_SELL' as const };
  const pnfSell = { ...sig('p'), kind: 'DOUBLE_BOTTOM_SELL' as const };
  const model = { signals: [buy, sell, pnfSell], other: 1 };
  assert.equal(withSide(model, 'both'), model);
  assert.deepEqual(withSide(model, 'buy').signals.map(s => s.id), ['b']);
  assert.deepEqual(withSide(model, 'sell').signals.map(s => s.id), ['s', 'p']);
  assert.equal(withSide(model, 'buy').other, 1);
});

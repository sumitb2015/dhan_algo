import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRuleNum } from './ruleNum.ts';

test('unsigned (every SL / target / lots box): only numbers above 0, original parseFloat behaviour', () => {
  assert.deepEqual(parseRuleNum('25'), { kind: 'value', n: 25 });
  assert.deepEqual(parseRuleNum(' 0.5 '), { kind: 'value', n: 0.5 });
  assert.deepEqual(parseRuleNum('12abc'), { kind: 'value', n: 12 });   // unchanged legacy behaviour
  assert.deepEqual(parseRuleNum(''), { kind: 'empty' });
  assert.deepEqual(parseRuleNum('   '), { kind: 'empty' });
  for (const bad of ['0', '-5', 'abc', '-']) assert.deepEqual(parseRuleNum(bad), { kind: 'invalid' }, bad);
});

test('signed (Greek bands): negatives and zero are values, typos are not', () => {
  assert.deepEqual(parseRuleNum('-150', true), { kind: 'value', n: -150 });
  assert.deepEqual(parseRuleNum('0', true), { kind: 'value', n: 0 });
  assert.deepEqual(parseRuleNum('-0.004', true), { kind: 'value', n: -0.004 });
  assert.deepEqual(parseRuleNum('150', true), { kind: 'value', n: 150 });
  assert.deepEqual(parseRuleNum('', true), { kind: 'empty' });
  for (const bad of ['-', 'abc', '-12abc', '1e', 'Infinity', 'NaN']) assert.deepEqual(parseRuleNum(bad, true), { kind: 'invalid' }, bad);
});

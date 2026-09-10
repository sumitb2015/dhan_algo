import { test } from 'node:test';
import assert from 'node:assert';
import { classifyStructure, type GroupLeg } from './positionStructure.ts';

function leg(strike: number, type: 'CE' | 'PE', side: 'BUY' | 'SELL', qty: number): GroupLeg {
  return { strike, type, side, qty, avgPrice: 10, securityId: null, symbol: null };
}

test('classifyStructure: symmetric 1:2:1 Call Butterfly is recognized as defined-risk', () => {
  const legs = [leg(80, 'CE', 'BUY', 1), leg(100, 'CE', 'SELL', 2), leg(120, 'CE', 'BUY', 1)];
  const result = classifyStructure(legs);
  assert.strictEqual(result.structure, 'Call Butterfly');
  assert.strictEqual(result.riskType, 'defined');
});

test('classifyStructure: symmetric 1:2:1 Put Butterfly is recognized as defined-risk', () => {
  const legs = [leg(120, 'PE', 'BUY', 1), leg(100, 'PE', 'SELL', 2), leg(80, 'PE', 'BUY', 1)];
  const result = classifyStructure(legs);
  assert.strictEqual(result.structure, 'Put Butterfly');
  assert.strictEqual(result.riskType, 'defined');
});

test('classifyStructure: scaled 1:2:1 Butterfly (2 lots each wing) still recognized', () => {
  const legs = [leg(80, 'CE', 'BUY', 2), leg(100, 'CE', 'SELL', 4), leg(120, 'CE', 'BUY', 2)];
  const result = classifyStructure(legs);
  assert.strictEqual(result.structure, 'Call Butterfly');
});

test('classifyStructure: asymmetric wings (broken wing) is NOT mis-labeled a Butterfly', () => {
  const legs = [leg(80, 'CE', 'BUY', 1), leg(100, 'CE', 'SELL', 2), leg(130, 'CE', 'BUY', 1)];
  const result = classifyStructure(legs);
  assert.notStrictEqual(result.structure, 'Call Butterfly');
});

test('classifyStructure: mismatched quantity ratio is NOT mis-labeled a Butterfly', () => {
  const legs = [leg(80, 'CE', 'BUY', 1), leg(100, 'CE', 'SELL', 1), leg(120, 'CE', 'BUY', 1)];
  const result = classifyStructure(legs);
  assert.notStrictEqual(result.structure, 'Call Butterfly');
});

test('classifyStructure: Iron Condor and Batman are unaffected by the Butterfly check', () => {
  const ic = classifyStructure([
    leg(110, 'CE', 'SELL', 1), leg(120, 'CE', 'BUY', 1),
    leg(90, 'PE', 'SELL', 1), leg(80, 'PE', 'BUY', 1),
  ]);
  assert.strictEqual(ic.structure, 'Iron Condor');

  const batman = classifyStructure([
    leg(110, 'CE', 'BUY', 1), leg(120, 'CE', 'SELL', 2),
    leg(90, 'PE', 'BUY', 1), leg(80, 'PE', 'SELL', 2),
  ]);
  assert.strictEqual(batman.structure, 'Batman');
});

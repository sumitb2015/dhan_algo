import test from 'node:test';
import assert from 'node:assert/strict';
import { withAutoLegRisk, autoReentryStrike, autoRollAllowed, autoRuleOwns, DEFAULT_AUTO_LEG_RULE, type MultiLegLeg } from './multiLegFocus.ts';

const rule = { ...DEFAULT_AUTO_LEG_RULE, enabled: true };
const leg = (o: Partial<MultiLegLeg>) => ({ id: 'a', side: 'S', option: 'CE', strike: 24000, ...o }) as MultiLegLeg;

test('defaults fill only short legs without their own SL/TP', () => {
  const l = withAutoLegRisk(leg({}), rule);
  assert.equal(l.sl, 20); assert.equal(l.slType, 'pct'); assert.equal(l.tp, 40);
  assert.equal(withAutoLegRisk(leg({ sl: 10, slType: 'pts' }), rule).sl, 10);
  assert.equal(withAutoLegRisk(leg({ side: 'B' }), rule).sl, undefined);
  assert.equal(withAutoLegRisk(leg({}), { ...rule, enabled: false }).sl, undefined);
  assert.equal(withAutoLegRisk(leg({ option: 'FUT' as MultiLegLeg['option'], strike: 0 }), rule).sl, undefined);
  assert.equal(autoRuleOwns(leg({ sl: 5 }), 'SL'), false);
});

test('re-entry strike is OTM-outward from ATM', () => {
  const st = [23900, 23950, 24000, 24050, 24100];
  assert.equal(autoReentryStrike(st, 24010, 'CE', 1), 24050);
  assert.equal(autoReentryStrike(st, 24010, 'PE', 1), 23950);
  assert.equal(autoReentryStrike(st, 24010, 'CE', 0), 24000);
  assert.equal(autoReentryStrike(st, 24010, 'CE', 9), null);
});

test('roll cap and 15:17 cutoff', () => {
  assert.equal(autoRollAllowed({ autoRolls: 1 }, rule, '10:00'), true);
  assert.equal(autoRollAllowed({ autoRolls: 2 }, rule, '10:00'), false);
  assert.equal(autoRollAllowed({}, rule, '15:17'), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { withAutoLegRisk, autoReentryStrike, autoReentryStrikeByDistance, autoReentryStrikeByPremium, avoidSameStrike, autoRollAllowed, autoRuleOwns, DEFAULT_AUTO_LEG_RULE, type MultiLegLeg } from './multiLegFocus.ts';

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

test('same-distance re-entry snaps to the chain and refuses off-chain targets', () => {
  const st = [23900, 23950, 24000, 24050, 24100];
  assert.equal(autoReentryStrikeByDistance(st, 24010, 'CE', 90), 24100);
  assert.equal(autoReentryStrikeByDistance(st, 24010, 'PE', 60), 23950);
  assert.equal(autoReentryStrikeByDistance(st, 24010, 'CE', 500), null);
  assert.equal(autoReentryStrikeByDistance(st, 0, 'CE', 50), null);
});

test('match-premium re-entry picks the closest priced strike at or beyond ATM', () => {
  const q = { '24000': { ce: 100, pe: 90 }, '24050': { ce: 70, pe: 120 }, '24100': { ce: 45, pe: 150 }, '23950': { ce: 140, pe: 65 } };
  assert.equal(autoReentryStrikeByPremium(q, 24010, 'CE', 72), 24050);
  assert.equal(autoReentryStrikeByPremium(q, 24010, 'PE', 64), 23950);
  assert.equal(autoReentryStrikeByPremium(q, 24010, 'CE', 500), 24000); // never ITM
  assert.equal(autoReentryStrikeByPremium(q, 24010, 'CE', 0), null);
});

test('avoidSameStrike steps one strike OTM only when the strike did not change', () => {
  const st = [23950, 24000, 24050];
  assert.equal(avoidSameStrike(st, 24000, 24050, 'CE'), 24000);
  assert.equal(avoidSameStrike(st, 24000, 24000, 'CE'), 24050);
  assert.equal(avoidSameStrike(st, 24000, 24000, 'PE'), 23950);
  assert.equal(avoidSameStrike(st, 24050, 24050, 'CE'), null);
});

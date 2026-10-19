import { test } from 'node:test';
import assert from 'node:assert';
import { calcLegsFromGreekLegs } from './deltaCalcLegs.ts';
import type { GreekLeg } from './multiLegGreeks.ts';

const base = { unitsPerLot: 10, price: 9445, isFutures: true, fallbackIv: 0.5 };

test('sell legs become negative lots and the future keeps its own sign', () => {
  const legs: GreekLeg[] = [
    { legId: 'f', side: 'S', option: 'FUT', strike: 0, expiry: '2026-11-19', units: 100 },
    { legId: 'p', side: 'S', option: 'PE', strike: 9000, expiry: '2026-11-17', units: 150 },
  ];
  const out = calcLegsFromGreekLegs(legs, { ...base, markOf: l => (l.legId === 'p' ? 333 : undefined) });
  assert.deepStrictEqual(out.map(l => [l.key, l.kind, l.liveLots]), [['f', 'FUT', -10], ['p', 'PE', -15]]);
});

test('IV is solved from the leg mark, and falls back when there is no mark', () => {
  const put: GreekLeg = { legId: 'p', side: 'S', option: 'PE', strike: 9000, expiry: '2027-12-17', units: 150 };
  const marked = calcLegsFromGreekLegs([put], { ...base, markOf: () => 700 })[0];
  assert.ok(marked.liveIv > 5 && marked.liveIv < 200 && marked.liveIv !== 50);
  const unmarked = calcLegsFromGreekLegs([put], { ...base, markOf: () => undefined })[0];
  assert.strictEqual(unmarked.liveIv, 50);
});

test('a leg with no units or a zero lot size is dropped', () => {
  const l: GreekLeg = { legId: 'x', side: 'B', option: 'CE', strike: 9000, expiry: '2026-11-17', units: 0 };
  assert.deepStrictEqual(calcLegsFromGreekLegs([l], { ...base, markOf: () => 1 }), []);
  assert.deepStrictEqual(calcLegsFromGreekLegs([{ ...l, units: 10 }], { ...base, unitsPerLot: 0, markOf: () => 1 }), []);
});

import { test } from 'node:test';
import assert from 'node:assert';
import {
  legPnlAtExpiry, computePayoff, nearestStrike, strikeStep, daysToExpiry, STRATEGY_CATEGORIES,
} from './basketStrategies.ts';
import type { OptionLegModel } from './optionsMonitorMath.ts';

test('legPnlAtExpiry: short call ITM loses intrinsic minus premium collected', () => {
  const leg = { side: 'S' as const, option: 'CE' as const, strike: 100, premium: 5, qty: 1 };
  assert.strictEqual(legPnlAtExpiry(leg, 120), -15); // premium(5) - intrinsic(20) = -15
});

test('legPnlAtExpiry: long put OTM loses only the premium paid', () => {
  const leg = { side: 'B' as const, option: 'PE' as const, strike: 100, premium: 5, qty: 2 };
  assert.strictEqual(legPnlAtExpiry(leg, 120), -10); // (0 - 5) * qty(2)
});

test('computePayoff: short straddle has bounded profit and unlimited loss on BOTH sides', () => {
  const legs = [
    { side: 'S' as const, option: 'CE' as const, strike: 100, premium: 5, qty: 1 },
    { side: 'S' as const, option: 'PE' as const, strike: 100, premium: 5, qty: 1 },
  ];
  const result = computePayoff(legs, 50, 150, 101);
  assert.strictEqual(result.netPremium, 10);
  assert.strictEqual(result.maxProfitUnlimited, false);
  assert.strictEqual(result.maxLossUnlimited, true);
  assert.strictEqual(result.rightWing, 'loss');
  // Net short puts carry unlimited loss on the downside too (a position fact
  // derived from net signed quantity, not the sampled curve's finite shape) —
  // matches the convention in lib/optionsStrategy.ts used elsewhere in the app.
  assert.strictEqual(result.leftWing, 'loss');
  assert.ok(Math.abs(result.maxProfit - 10) < 1e-6);
  assert.strictEqual(result.breakevens.length, 2);
  assert.ok(Math.abs(result.breakevens[0] - 90) < 1);
  assert.ok(Math.abs(result.breakevens[1] - 110) < 1);
});

test('computePayoff: bull call spread has bounded profit AND bounded loss', () => {
  const legs = [
    { side: 'B' as const, option: 'CE' as const, strike: 100, premium: 8, qty: 1 },
    { side: 'S' as const, option: 'CE' as const, strike: 120, premium: 3, qty: 1 },
  ];
  const result = computePayoff(legs, 50, 150, 101);
  assert.strictEqual(result.maxProfitUnlimited, false);
  assert.strictEqual(result.maxLossUnlimited, false);
  assert.ok(Math.abs(result.maxLoss - -5) < 1e-6);   // net debit paid
  assert.ok(Math.abs(result.maxProfit - 15) < 1e-6); // (120-100) - 5 net debit
});

test('computePayoff: long put profit is bounded by the zero underlying floor, no unlimited case either side', () => {
  const result = computePayoff([
    { side: 'B' as const, option: 'PE' as const, strike: 100, premium: 5, qty: 1 },
  ], 50, 150, 101);
  assert.strictEqual(result.maxProfitUnlimited, false);
  assert.strictEqual(result.maxLossUnlimited, false);
  assert.strictEqual(result.maxProfit, 95);
  assert.strictEqual(result.maxLoss, -5);
  assert.strictEqual(result.rightWing, null);
  assert.strictEqual(result.leftWing, null);
});

// A naked short put carries unlimited loss on the downside by the same
// position-fact convention as a naked short call on the upside — spot=0 is a
// technical floor, not a risk ceiling a trader should see as "bounded."
test('computePayoff: short put has unlimited left-side (downside) loss', () => {
  const result = computePayoff([
    { side: 'S' as const, option: 'PE' as const, strike: 100, premium: 5, qty: 1 },
  ], 50, 150, 101);
  assert.strictEqual(result.maxProfitUnlimited, false);
  assert.strictEqual(result.maxLossUnlimited, true);
  assert.strictEqual(result.maxProfit, 5);
  assert.strictEqual(result.rightWing, null);
  assert.strictEqual(result.leftWing, 'loss');
});

test('computePayoff: short call keeps unlimited right-side loss, no left-side case', () => {
  const result = computePayoff([
    { side: 'S' as const, option: 'CE' as const, strike: 100, premium: 5, qty: 1 },
  ], 50, 150, 101);
  assert.strictEqual(result.maxLossUnlimited, true);
  assert.strictEqual(result.rightWing, 'loss');
  assert.strictEqual(result.leftWing, null);
});

test('nearestStrike picks the closest listed strike', () => {
  assert.strictEqual(nearestStrike([100, 150, 200], 170), 150);
});

test('nearestStrike returns null for an empty strike list', () => {
  assert.strictEqual(nearestStrike([], 100), null);
});

test('strikeStep returns the median gap between strikes', () => {
  assert.strictEqual(strikeStep([100, 150, 200, 250]), 50);
});

test('strikeStep defaults to 50 with fewer than two strikes', () => {
  assert.strictEqual(strikeStep([100]), 50);
});

test('daysToExpiry counts calendar days, 0 on the expiry date itself', () => {
  const now = new Date(2026, 6, 21); // 2026-07-21
  assert.strictEqual(daysToExpiry('2026-07-21', now), 0);
  assert.strictEqual(daysToExpiry('2026-07-24', now), 3);
});

test('daysToExpiry returns null for an unparseable expiry string', () => {
  assert.strictEqual(daysToExpiry('not-a-date'), null);
});

test('STRATEGY_CATEGORIES: Range Bound includes Batman alongside Iron Condor', () => {
  const rangeBound = STRATEGY_CATEGORIES['Range Bound'];
  const icIndex = rangeBound.findIndex((s: any) => s.key === 'iron-condor');
  const batmanIndex = rangeBound.findIndex((s: any) => s.key === 'batman');
  assert.ok(icIndex >= 0, 'iron-condor must exist in Range Bound');
  assert.ok(batmanIndex >= 0, 'batman must exist in Range Bound');
  const batman = rangeBound[batmanIndex];
  assert.strictEqual(batman.name, 'Batman');
  assert.strictEqual(batman.legs.length, 4);
});

test('computePayoff: Batman strategy has dual profit peaks (ears) and undefined tail risk', () => {
  const batmanLegs = [
    { side: 'B' as const, option: 'CE' as const, strike: 110, premium: 5, qty: 1 },
    { side: 'S' as const, option: 'CE' as const, strike: 120, premium: 2, qty: 2 },
    { side: 'B' as const, option: 'PE' as const, strike: 90,  premium: 5, qty: 1 },
    { side: 'S' as const, option: 'PE' as const, strike: 80,  premium: 2, qty: 2 },
  ];
  const res = computePayoff(batmanLegs, 60, 140, 81);
  assert.strictEqual(res.maxLossUnlimited, true);
  assert.strictEqual(res.leftWing, 'loss');
  assert.strictEqual(res.rightWing, 'loss');

  // Peak at lower short strike (80)
  const p80 = res.points.find(p => Math.abs(p.x - 80) < 0.1);
  // Peak at upper short strike (120)
  const p120 = res.points.find(p => Math.abs(p.x - 120) < 0.1);
  // Valley / plateau at ATM (100)
  const p100 = res.points.find(p => Math.abs(p.x - 100) < 0.1);

  assert.ok(p80 && p120 && p100);
  assert.ok(p80.y > p100.y, 'Lower short strike (80) must be a peak above center');
  assert.ok(p120.y > p100.y, 'Upper short strike (120) must be a peak above center');
  assert.strictEqual(p80.y, p120.y, 'Symmetric Batman strategy has equal height ears');
});

test('STRATEGY_CATEGORIES: Range Bound includes single-type Call and Put Butterfly', () => {
  const rangeBound = STRATEGY_CATEGORIES['Range Bound'];
  const callBfly = rangeBound.find((s: any) => s.key === 'call-butterfly');
  const putBfly = rangeBound.find((s: any) => s.key === 'put-butterfly');
  assert.ok(callBfly, 'call-butterfly must exist in Range Bound');
  assert.ok(putBfly, 'put-butterfly must exist in Range Bound');
  assert.ok(callBfly!.legs.every((l: any) => l.option === 'CE'), 'Call Butterfly must use only calls');
  assert.ok(putBfly!.legs.every((l: any) => l.option === 'PE'), 'Put Butterfly must use only puts');
  assert.strictEqual(callBfly!.legs.length, 3);
  assert.strictEqual(putBfly!.legs.length, 3);
});

test('computePayoff: Call Butterfly is defined-risk with a single peak at the body strike', () => {
  const callButterflyLegs = [
    { side: 'B' as const, option: 'CE' as const, strike: 80,  premium: 22, qty: 1 },
    { side: 'S' as const, option: 'CE' as const, strike: 100, premium: 6,  qty: 2 },
    { side: 'B' as const, option: 'CE' as const, strike: 120, premium: 1,  qty: 1 },
  ];
  const res = computePayoff(callButterflyLegs, 60, 140, 81);
  assert.strictEqual(res.maxProfitUnlimited, false);
  assert.strictEqual(res.maxLossUnlimited, false);
  assert.strictEqual(res.leftWing, null);
  assert.strictEqual(res.rightWing, null);

  const p80 = res.points.find(p => Math.abs(p.x - 80) < 0.1);
  const p100 = res.points.find(p => Math.abs(p.x - 100) < 0.1);
  const p120 = res.points.find(p => Math.abs(p.x - 120) < 0.1);
  assert.ok(p80 && p100 && p120);
  assert.ok(p100.y > p80.y && p100.y > p120.y, 'Body strike (100) must be the peak');
});

test('STRATEGY_CATEGORIES: Short Strangle template uses offset 2 to match Options Monitor benchmark', () => {
  const rangeBound = STRATEGY_CATEGORIES['Range Bound'];
  const strangle = rangeBound.find((s: any) => s.key === 'short-strangle');
  assert.ok(strangle, 'short-strangle must exist in Range Bound');
  const ceLeg = strangle!.legs.find(l => l.option === 'CE');
  const peLeg = strangle!.legs.find(l => l.option === 'PE');
  assert.ok(ceLeg && peLeg);
  assert.strictEqual(ceLeg!.offset, 2, 'CE leg must be offset +2 from ATM (23500 CE at 23400 ATM)');
  assert.strictEqual(peLeg!.offset, -2, 'PE leg must be offset -2 from ATM (23300 PE at 23400 ATM)');
});

test('Sensibull & Options Monitor Parity: Baskets Short Strangle generates identical payoff curve', async () => {
  const { generatePayoffCurve } = await import('./optionsMonitorMath.ts');

  const spot = 23398.10;
  const futurePrice = 23463.60;
  const tYears = 4.0 / 365;
  const baseIv = 0.1313;
  const lotSize = 65;
  const strikeStep = 50;

  // Options Monitor reference strangle
  const omLegs: OptionLegModel[] = [
    { id: 'leg_ce', type: 'CE', side: 'SELL', strike: 23500, lots: 1, qty: 65, entryPrice: 61.20, ltp: 61.20, delta: -0.19, gamma: -0.0016, theta: 730, vega: -578, iv: 0.095 },
    { id: 'leg_pe', type: 'PE', side: 'SELL', strike: 23300, lots: 1, qty: 65, entryPrice: 55.65, ltp: 55.65, delta: 0.02, gamma: -0.0013, theta: 737, vega: -579, iv: 0.110 },
  ];

  // Baskets monitorLegs configured for the strangle
  const basketLegs: OptionLegModel[] = [
    { id: 'leg-default-pe', type: 'PE', side: 'SELL', strike: 23300, lots: 1, qty: 65, entryPrice: 55.65, ltp: 55.65, delta: 0.02, gamma: -0.0013, theta: 737, vega: -579, iv: 0.110 },
    { id: 'leg-default-ce', type: 'CE', side: 'SELL', strike: 23500, lots: 1, qty: 65, entryPrice: 61.20, ltp: 61.20, delta: -0.19, gamma: -0.0016, theta: 730, vega: -578, iv: 0.095 },
  ];

  const omCurve = generatePayoffCurve(omLegs, spot, lotSize, tYears, baseIv, strikeStep, futurePrice, tYears);
  const basketCurve = generatePayoffCurve(basketLegs, spot, lotSize, tYears, baseIv, strikeStep, futurePrice, tYears);

  // Exact point count match
  assert.strictEqual(basketCurve.points.length, omCurve.points.length);
  assert.strictEqual(omCurve.points.length, 124);

  // Exact Breakevens match
  assert.deepStrictEqual(basketCurve.breakevens, [23183, 23617]);
  assert.deepStrictEqual(basketCurve.breakevens, omCurve.breakevens);

  // Exact SD Levels match
  assert.deepStrictEqual(basketCurve.sdLevels, omCurve.sdLevels);
  assert.strictEqual(basketCurve.sdLevels?.exactLo1, 23076.5);
  assert.strictEqual(basketCurve.sdLevels?.exactHi1, 23719.7);
  assert.strictEqual(basketCurve.sdLevels?.exactLo2, 22754.9);
  assert.strictEqual(basketCurve.sdLevels?.exactHi2, 24041.3);

  // Exact point-by-point match for both pnlExpiry and pnlToday (the blue line)
  for (let i = 0; i < omCurve.points.length; i++) {
    const ptOM = omCurve.points[i];
    const ptBasket = basketCurve.points[i];
    assert.strictEqual(ptBasket.spot, ptOM.spot, `Spot mismatch at index ${i}`);
    assert.strictEqual(ptBasket.pnlExpiry, ptOM.pnlExpiry, `Expiry PnL mismatch at spot ${ptOM.spot}`);
    assert.strictEqual(ptBasket.pnlToday, ptOM.pnlToday, `T+0 Blue line PnL mismatch at spot ${ptOM.spot}`);
  }

  // Exact projected PnL at spot: -260 (matches user screenshot)
  const spotPt = basketCurve.points.find(p => p.spot === Math.round(spot));
  assert.ok(spotPt);
  assert.strictEqual(spotPt.pnlToday, -260);
  assert.strictEqual(spotPt.pnlExpiry, 7595);
});

test('double-calendar template: short front / long far at ATM ±300 pts on a 50-pt step', () => {
  const tpl = STRATEGY_CATEGORIES.Calendar.find(t => t.key === 'double-calendar');
  assert.ok(tpl, 'double-calendar template must exist under Calendar');
  const legs = tpl!.legs;
  assert.strictEqual(legs.length, 4);
  for (const opt of ['PE', 'CE'] as const) {
    const sign = opt === 'CE' ? 1 : -1;
    const front = legs.find(l => l.option === opt && l.expiryRole === 'front')!;
    const far = legs.find(l => l.option === opt && l.expiryRole === 'far')!;
    assert.strictEqual(front.side, 'S');
    assert.strictEqual(far.side, 'B');
    assert.strictEqual(front.offset, far.offset);          // same strike = calendar, not diagonal
    assert.strictEqual(front.offset * 50, sign * 300);     // 300 pts either side of ATM
  }
});

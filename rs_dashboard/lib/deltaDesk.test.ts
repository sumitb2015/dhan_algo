import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, enrichLegs, deskLegsToPayoffLegs, RISK_FREE_RATE, type DeskLeg, type RawLeg } from './deltaDesk.ts';
import { calculateTimeToExpiryYears, spotFromFutures, priceOption } from './optionsPricing.ts';
import { buildPayoffModel } from './optionsPayoff.ts';

const EXP = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10); // 30 days out, like a real monthly
const leg = (o: Partial<DeskLeg>): DeskLeg => ({
  securityId: '1', symbol: 'X', displayName: 'X', underlying: 'NIFTY', expiry: EXP,
  strike: 22500, type: 'CE', side: 'SELL', netQty: -65, lotSize: 65, ltp: 100, entryPrice: 100,
  pnl: 0, spot: 22500, delta: 0.5, iv: 14, forward: 22500, ...o,
});

describe('deltaDesk aggregation bases', () => {
  const legs = [
    leg({ securityId: 'a', type: 'CE', netQty: -195, delta: 0.1 }),
    leg({ securityId: 'b', type: 'PE', netQty: -390, delta: -0.3 }),
  ];
  it('index units weight by signed qty, lots by qty/lot, broker by sign only', () => {
    assert.ok(Math.abs(aggregate(legs, 'exposure').delta - (-195 * 0.1 + -390 * -0.3)) < 1e-9);
    assert.ok(Math.abs(aggregate(legs, 'lots').delta - (-3 * 0.1 + -6 * -0.3)) < 1e-9);
    assert.ok(Math.abs(aggregate(legs, 'broker').delta - (-0.1 + 0.3)) < 1e-9);
  });
});

describe('enrichLegs: raw market data to Greeks through the shared library', () => {
  const FUT_EXP = new Date(Date.now() + 22 * 86_400_000).toISOString().slice(0, 10);
  const NEAR_EXP = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
  const raw = (o: Partial<RawLeg>): RawLeg => ({
    securityId: '1', symbol: 'X', displayName: 'X', underlying: 'NIFTY', expiry: FUT_EXP, strike: 22800, type: 'CE', side: 'SELL',
    netQty: -260, lotSize: 65, ltp: 222.5, entryPrice: 225.4, pnl: 754, spot: 22555.75, futPrice: 22623.7, futExpiry: FUT_EXP, ...o,
  });

  it('solves IV so the model reproduces each leg\'s own live price', () => {
    const legs = enrichLegs([raw({}), raw({ securityId: '2', strike: 22200, type: 'PE', ltp: 158.2, netQty: -390 })]);
    for (const l of legs) {
      assert.equal(l.greeksSource, 'black76');
      const model = priceOption(l.type, l.forward!, l.strike, calculateTimeToExpiryYears(l.expiry), l.iv! / 100, RISK_FREE_RATE, true);
      assert.ok(Math.abs(model - l.ltp) < 0.01, `${l.strike}${l.type}: model ${model} vs ltp ${l.ltp}`);
    }
  });

  it('fills the full Greeks profile, including the second-order ones', () => {
    const [l] = enrichLegs([raw({})]);
    for (const k of ['delta', 'gamma', 'theta', 'vega', 'rho', 'vanna', 'charm', 'vomma'] as const) assert.ok(Number.isFinite(l[k]), `${k} missing`);
  });

  it('rolls the future to each leg\'s own expiry', () => {
    const [far, near] = enrichLegs([raw({}), raw({ securityId: '2', expiry: NEAR_EXP })]);
    assert.equal(far.forward, 22623.7);
    assert.ok(near.forward! < far.forward! && far.forward! - near.forward! < 40);
  });

  it('uses one spot per underlying and estimates it from the future only when none is given (and flags it)', () => {
    const shared = enrichLegs([raw({ spot: 0 }), raw({ securityId: '2', spot: 22555.75 })]);
    assert.equal(shared[0].spot, 22555.75);
    assert.equal(shared[0].spotSource, undefined);
    const est = enrichLegs([raw({ spot: 0 })])[0];
    assert.equal(est.spotSource, 'futures');
    assert.ok(Math.abs(est.spot - spotFromFutures(22623.7, FUT_EXP)) < 1e-6);
  });

  it('falls back to Dhan chain Greeks when a leg has no live price, leaving second-order Greeks blank', () => {
    const [l] = enrichLegs([raw({ ltp: 0, chainGreeks: { delta: 0.44, gamma: 0.0006, theta: -8.7, vega: 22, iv: 12.2 } })]);
    assert.equal(l.greeksSource, 'chain');
    assert.equal(l.delta, 0.44);
    assert.equal(l.rho, undefined);
  });

  it('uses a synthetic forward (spot·e^{rT}) when there is no future', () => {
    const [l] = enrichLegs([raw({ futPrice: undefined, futExpiry: undefined })]);
    const expected = 22555.75 * Math.exp(RISK_FREE_RATE * calculateTimeToExpiryYears(FUT_EXP));
    assert.ok(Math.abs(l.forward! - expected) < 1e-6);
  });
});

describe('deskLegsToPayoffLegs: Portfolio Greeks to the payoff library', () => {
  it('feeds the library so the book\'s T+0 P&L at the current spot equals its open P&L', () => {
    const FUT = new Date(Date.now() + 22 * 86_400_000).toISOString().slice(0, 10);
    const raw: RawLeg = {
      securityId: '1', symbol: 'X', displayName: 'X', underlying: 'NIFTY', expiry: FUT, strike: 22800, type: 'CE', side: 'SELL',
      netQty: -260, lotSize: 65, ltp: 222.5, entryPrice: 225.4, pnl: 754, spot: 22555.75, futPrice: 22623.7, futExpiry: FUT,
    };
    const legs = enrichLegs([raw]);
    const m = buildPayoffModel({ spot: legs[0].spot, legs: deskLegsToPayoffLegs(legs) })!;
    assert.ok(Math.abs(m.nowPnl - (222.5 - 225.4) * -260) < 1, `T+0 ${m.nowPnl}`);
  });
});


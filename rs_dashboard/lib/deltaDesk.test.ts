import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeBsGreeks } from './optionsMonitorMath.ts';
import { b76, payoff, ladder, aggregate, RISK_FREE_RATE, type DeskLeg } from './deltaDesk.ts';

const EXP = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10); // 30 days out, like a real monthly
const leg = (o: Partial<DeskLeg>): DeskLeg => ({
  securityId: '1', symbol: 'X', displayName: 'X', underlying: 'NIFTY', expiry: EXP,
  strike: 22500, type: 'CE', side: 'SELL', netQty: -65, lotSize: 65, ltp: 100, entryPrice: 100,
  pnl: 0, spot: 22500, delta: 0.5, iv: 14, forward: 22500, ...o,
});

describe('deltaDesk Black-76 parity with optionsMonitorMath', () => {
  it('uses the same default rate', () => assert.equal(RISK_FREE_RATE, 0.065));

  it('prices and deltas agree with computeBsGreeks (futures branch) to its rounding', () => {
    for (const [type, K, iv, T] of [['CE', 22800, 13.6, 22 / 365], ['PE', 22200, 14.9, 22 / 365], ['CE', 23300, 13.2, 14 / 365]] as const) {
      const mine = b76(type, 22620, K, T, iv);
      const canon = computeBsGreeks(type, 22620, K, T, iv / 100, 65, 0.065, true);
      assert.ok(Math.abs(mine.price - canon.price) <= 0.03, `${type} ${K} price ${mine.price} vs ${canon.price}`);
      assert.ok(Math.abs(mine.delta - canon.delta) <= 0.005, `${type} ${K} delta ${mine.delta} vs ${canon.delta}`);
    }
  });

  it('satisfies put-call parity on the forward', () => {
    const T = 30 / 365, F = 22600, K = 22500, iv = 15;
    const c = b76('CE', F, K, T, iv).price;
    const p = b76('PE', F, K, T, iv).price;
    assert.ok(Math.abs(c - p - Math.exp(-RISK_FREE_RATE * T) * (F - K)) < 1e-6);
  });
});

describe('deltaDesk payoff', () => {
  const straddle = [
    leg({ securityId: 'c', type: 'CE', entryPrice: 100, ltp: 100 }),
    leg({ securityId: 'p', type: 'PE', entryPrice: 90, ltp: 90 }),
  ];

  it('finds exact expiry breakevens (strike ± total premium) regardless of sampling', () => {
    const r = payoff(straddle, 22500, 0);
    assert.equal(r.breakevens.length, 2);
    assert.ok(Math.abs(r.breakevens[0] - (22500 - 190)) < 0.01);
    assert.ok(Math.abs(r.breakevens[1] - (22500 + 190)) < 0.01);
  });

  it('includes every strike in the sampled spots', () => {
    const r = payoff(straddle, 22500, 0);
    assert.ok(r.points.some(p => p.spot === 22500));
  });

  it('flags unlimited risk from net signed quantity, not from the curve tail', () => {
    assert.equal(payoff(straddle, 22500, 0).unlimitedLossUp, true);
    assert.equal(payoff(straddle, 22500, 0).unlimitedLossDown, true);
    const longCall = [leg({ side: 'BUY', netQty: 65 })];
    const r = payoff(longCall, 22500, 0);
    assert.equal(r.unlimitedGainUp, true);
    assert.equal(r.unlimitedLossUp, false);
  });

  it('T+0 repricing at the live level reproduces the leg\'s own mark (IV was solved from it)', () => {
    const l = leg({ netQty: -65 });
    const tYears = (new Date(`${EXP}T10:10:00Z`).getTime() - Date.now()) / (365 * 86400000);
    const mark = b76('CE', l.forward!, l.strike, tYears, l.iv!).price;
    const marked = leg({ ltp: mark, entryPrice: mark });
    const row = ladder([marked], 22500).find(r => r.movePct === 0)!;
    assert.equal(row.pnlToday, 0);
  });

  it('ladder is monotone for a short straddle: bigger moves lose more', () => {
    const rows = ladder(straddle, 22500);
    const at = (m: number) => rows.find(r => r.movePct === m)!.pnlDelta;
    assert.ok(at(4) < at(2) && at(2) < at(1) && at(-4) < at(-2) && at(-2) < at(-1));
  });
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

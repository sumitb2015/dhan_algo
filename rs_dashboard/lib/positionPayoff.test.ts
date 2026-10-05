import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { positionPayoff, positionNetGreeks, withSolvedIv, toPayoffLegs, type PositionLegLike } from './positionPayoff.ts';
import { buildPayoffModel } from './optionsPayoff.ts';
import { priceOption, calculateTimeToExpiryYears, RISK_FREE_RATE } from './optionsPricing.ts';

// One pinned clock for the file: two calls that each read Date.now() differ by a millisecond and that flips rounded values.
const NOW = Date.now();
const day = (n: number) => new Date(NOW + n * 86_400_000).toISOString().slice(0, 10);
const NEAR = day(14);
const FAR = day(22);
const SPOT = 22555.75;

const mk = (o: Partial<PositionLegLike>): PositionLegLike => ({
  strike: 22800, type: 'CE', side: 'SELL', qtyLots: 260, price: 225.4, delta: null, iv: null, vega: null, securityId: null,
  expiry: FAR, display: { ltp: 222.5 }, ...o,
});
const book = [
  mk({ strike: 23300, expiry: NEAR, qtyLots: 195, price: 33.93, display: { ltp: 33.4 } }),
  mk({ strike: 22200, type: 'PE', expiry: FAR, qtyLots: 390, price: 150.73, display: { ltp: 158.2 } }),
  mk({}),
];
const opts = { strikeStep: 50, spanPct: 0.08, defaultExpiry: null as string | null, now: NOW };

describe('positionPayoff: position book through the central library', () => {
  it('values a mixed-expiry book as of the NEAREST expiry, from each leg\'s own expiry', () => {
    const r = positionPayoff(book, SPOT, opts)!;
    assert.equal(r.model.frontExpiry, NEAR);
    assert.deepEqual(r.model.laterExpiries, [FAR]);
  });

  it('T+0 is the real open P&L: IV solved from the live mark, not forced to zero', () => {
    const r = positionPayoff(book, SPOT, { ...opts, targetDays: 0 })!;
    const open = book.reduce((s, l) => s + (l.side === 'SELL' ? -1 : 1) * l.qtyLots * (l.display!.ltp! - l.price), 0);
    const atSpot = r.targetCurve!.find((p) => p.spot === SPOT)!;
    assert.ok(Math.abs(atSpot.pnl - open) < 5, `T+0 at spot ${atSpot.pnl} vs open P&L ${open}`);
  });

  it('chain IV is only a fallback: a leg with a live mark ignores a wrong chain IV', () => {
    const wrong = book.map((l) => ({ ...l, iv: 0.05 }));
    const a = positionPayoff(book, SPOT, { ...opts, targetDays: 0 })!;
    const b = positionPayoff(wrong, SPOT, { ...opts, targetDays: 0 })!;
    assert.deepEqual(a.targetCurve!.map((p) => Math.round(p.pnl)), b.targetCurve!.map((p) => Math.round(p.pnl)));
  });

  it('a leg with no mark and no IV is priced at intrinsic and reported, never on a guessed volatility', () => {
    const legs = [mk({ display: { ltp: null }, iv: null })];
    const r = positionPayoff(legs, SPOT, { ...opts, targetDays: 0 })!;
    assert.deepEqual(r.missingIv, [0]);
    assert.equal(r.model.ivAssumed, 1);
    // intrinsic only: today's curve equals the expiry curve for a single-expiry book
    assert.deepEqual(r.targetCurve!.map((p) => Math.round(p.pnl)), r.expiryCurve.map((p) => Math.round(p.pnl)));
  });

  it('builds the PayoffStats the strips read: unlimited flags, exact break-evens, window extremes', () => {
    const r = positionPayoff(book, SPOT, opts)!;
    assert.equal(r.stats.maxLoss, 'Unlimited');           // net short calls
    assert.equal(r.stats.breakevensExpiry.length, 2);
    assert.ok(r.stats.rangeLo < SPOT && r.stats.rangeHi > SPOT);
    assert.ok(r.stats.maxLossInRange <= 0);
    assert.equal(r.stats.netPremium, 195 * 33.93 + 390 * 150.73 + 260 * 225.4);
  });

  it('single-expiry defined-risk book: bounded exact extremes and a reward:risk', () => {
    const condor = [
      mk({ strike: 22700, expiry: NEAR, qtyLots: 65, price: 80, display: { ltp: 80 } }),
      mk({ strike: 22900, expiry: NEAR, qtyLots: 65, price: 30, side: 'BUY', display: { ltp: 30 } }),
      mk({ strike: 22300, type: 'PE', expiry: NEAR, qtyLots: 65, price: 70, display: { ltp: 70 } }),
      mk({ strike: 22100, type: 'PE', expiry: NEAR, qtyLots: 65, price: 25, side: 'BUY', display: { ltp: 25 } }),
    ];
    const r = positionPayoff(condor, SPOT, opts)!;
    assert.equal(typeof r.stats.maxProfit, 'number');
    assert.equal(typeof r.stats.maxLoss, 'number');
    assert.ok(r.stats.rewardRisk !== null);
  });

  it('draft overlay: adding a leg changes the curve', () => {
    const base = positionPayoff(book, SPOT, opts)!;
    const withDraft = positionPayoff([...book, mk({ strike: 23500, expiry: NEAR, side: 'BUY', qtyLots: 130, price: 10, display: { ltp: 10 } })], SPOT, opts)!;
    assert.notDeepEqual(base.expiryCurve.map((p) => Math.round(p.pnl)), withDraft.expiryCurve.map((p) => Math.round(p.pnl)));
  });

  it('uses the futures forward when supplied; a single-expiry book settled against the index is unaffected by the basis', () => {
    const single = [mk({ expiry: FAR }), mk({ strike: 22200, type: 'PE', expiry: FAR, display: { ltp: 158.2 } })];
    const withFut = positionPayoff(single, SPOT, { ...opts, targetDays: 0, future: { price: 22623.7, expiry: FAR } })!;
    const without = positionPayoff(single, SPOT, { ...opts, targetDays: 0 })!;
    assert.deepEqual(withFut.expiryCurve.map((p) => Math.round(p.pnl)), without.expiryCurve.map((p) => Math.round(p.pnl)));
    // ...but T+0 does move with the forward
    assert.notDeepEqual(withFut.targetCurve!.map((p) => Math.round(p.pnl)), without.targetCurve!.map((p) => Math.round(p.pnl)));
  });

  it('matches buildPayoffModel called directly (the adapter adds no maths)', () => {
    const now = NOW;
    const r = positionPayoff(book, SPOT, { ...opts, targetDays: 0, now })!;
    const direct = buildPayoffModel({ spot: SPOT, now, legs: toPayoffLegs(book, SPOT, { now }), rangePct: 0.08, strikeStep: 50, daysForward: 0, fallbackIv: 0 })!;
    assert.deepEqual(r.model.breakevens, direct.breakevens);
    assert.equal(r.model.nowPnl, direct.nowPnl);
  });
});

describe('withSolvedIv', () => {
  it('solves IV from the live mark through the library (round-trips a known IV)', () => {
    const T = calculateTimeToExpiryYears(FAR);
    const iv = 0.14;
    const mark = priceOption('CE', SPOT * Math.exp(RISK_FREE_RATE * T), 22800, T, iv, RISK_FREE_RATE, true);
    const [l] = withSolvedIv([mk({ display: { ltp: mark }, iv: 0.3 })], SPOT);
    assert.ok(Math.abs(l.iv! - iv) < 1e-4, `${l.iv}`);
  });
  it('leaves a leg alone when there is no mark to invert', () => {
    const l = mk({ display: { ltp: null }, iv: 0.3 });
    assert.equal(withSolvedIv([l], SPOT)[0].iv, 0.3);
  });
});

describe('positionNetGreeks', () => {
  it('computes net and per-leg Greeks from the live marks and flags legs it had to assume', () => {
    const g = positionNetGreeks([...book, mk({ strike: 22000, type: 'PE', display: { ltp: null }, iv: null })], SPOT);
    assert.equal(g.perLeg.length, 4);
    assert.equal(g.assumed.length, 1);
    assert.ok(g.gamma < 0 && g.theta > 0);                 // a short-option book
    assert.ok(g.perLeg.slice(0, 3).every((l) => l.ivSource === 'mark'));
  });
  it('is zero for an empty book or no spot', () => {
    assert.equal(positionNetGreeks([], SPOT).delta, 0);
    assert.equal(positionNetGreeks(book, 0).perLeg.length, 0);
  });
});

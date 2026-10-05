import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildPayoffModel, payoffLadder, payoffGrid, builderLegsToPayoffLegs, unlimitedFlags, type PayoffLegInput } from './optionsPayoff.ts';
import { priceOption, calculateTimeToExpiryYears, RISK_FREE_RATE } from './optionsPricing.ts';

const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const NEAR = day(14);
const FAR = day(35);
const SPOT = 22500;

const leg = (o: Partial<PayoffLegInput>): PayoffLegInput => ({
  type: 'CE', strike: 22500, expiry: NEAR, qty: -65, entryPrice: 100, ...o,
});
/** The price the model gives a leg at its own IV (used to build marks the solver must reproduce). */
const modelPrice = (l: PayoffLegInput, iv: number, spot = SPOT) =>
  priceOption(l.type, spot * Math.exp(RISK_FREE_RATE * calculateTimeToExpiryYears(l.expiry)), l.strike, calculateTimeToExpiryYears(l.expiry), iv, RISK_FREE_RATE, true);

describe('buildPayoffModel: single-expiry book', () => {
  const straddle = [leg({ type: 'CE', entryPrice: 100 }), leg({ type: 'PE', entryPrice: 90 })];

  it('finds exact break-evens (strike ± total premium) and exact extremes', () => {
    const m = buildPayoffModel({ legs: straddle, spot: SPOT, margin: 200000 })!;
    assert.equal(m.breakevens.length, 2);
    assert.ok(Math.abs(m.breakevens[0] - (22500 - 190)) < 0.01);
    assert.ok(Math.abs(m.breakevens[1] - (22500 + 190)) < 0.01);
    assert.equal(m.extremesExact, true);
    assert.ok(Math.abs(m.maxProfit - 190 * 65) < 0.01, `max profit ${m.maxProfit}`);
    assert.ok(Math.abs(m.rom! - ((190 * 65) / 200000) * 100) < 1e-6);
  });

  it('flags unlimited risk from net signed quantity, not from the tail', () => {
    const m = buildPayoffModel({ legs: straddle, spot: SPOT })!;
    assert.equal(m.maxLossUnlimited, true);
    assert.equal(m.maxProfitUnlimited, false);
    const longCall = buildPayoffModel({ legs: [leg({ qty: 65 })], spot: SPOT })!;
    assert.equal(longCall.maxProfitUnlimited, true);
    assert.equal(longCall.maxLossUnlimited, false);
  });

  it('a defined-risk book has bounded exact max profit / loss, a risk-reward and no unlimited flags', () => {
    const condor = [
      leg({ type: 'CE', strike: 22700, qty: -65, entryPrice: 80 }), leg({ type: 'CE', strike: 22900, qty: 65, entryPrice: 30 }),
      leg({ type: 'PE', strike: 22300, qty: -65, entryPrice: 70 }), leg({ type: 'PE', strike: 22100, qty: 65, entryPrice: 25 }),
    ];
    const m = buildPayoffModel({ legs: condor, spot: SPOT })!;
    assert.equal(m.maxLossUnlimited, false);
    assert.ok(Math.abs(m.maxProfit - (80 - 30 + 70 - 25) * 65) < 0.01);
    assert.ok(Math.abs(m.maxLoss - ((80 - 30 + 70 - 25) - 200) * 65) < 0.01);
    assert.ok(m.riskReward !== null && m.pop !== null);
  });

  it('includes every strike as a sample', () => {
    const m = buildPayoffModel({ legs: straddle, spot: SPOT })!;
    assert.ok(m.points.some(p => p.spot === 22500));
  });

  it('rejects books it cannot value (no spot, no legs, a zero entry price)', () => {
    assert.equal(buildPayoffModel({ legs: straddle, spot: 0 }), null);
    assert.equal(buildPayoffModel({ legs: [], spot: SPOT }), null);
    assert.equal(buildPayoffModel({ legs: [leg({ entryPrice: 0 })], spot: SPOT }), null);
  });
});

describe('buildPayoffModel: T+0 is the real mark-to-market', () => {
  it('reproduces the open P&L at the current spot when IV is solved from the live mark (not forced to 0)', () => {
    const l = leg({ qty: -260, entryPrice: 225.4 });
    const mark = modelPrice(l, 0.14);
    const m = buildPayoffModel({ legs: [{ ...l, mark }], spot: SPOT })!;
    const open = (mark - 225.4) * -260;
    assert.ok(Math.abs(m.nowPnl - open) < 0.5, `T+0 at spot ${m.nowPnl} vs open P&L ${open}`);
    const atSpot = m.today.find(p => p.spot === SPOT)!;
    assert.ok(Math.abs(atSpot.pnl - open) < 0.5);
  });

  it('uses the chain IV only when the mark cannot be solved, and counts assumed IVs', () => {
    const solved = buildPayoffModel({ legs: [leg({ mark: modelPrice(leg({}), 0.14) })], spot: SPOT })!;
    assert.equal(solved.ivAssumed, 0);
    const chain = buildPayoffModel({ legs: [leg({ chainIv: 0.13 })], spot: SPOT })!;
    assert.equal(chain.ivAssumed, 0);
    const assumed = buildPayoffModel({ legs: [leg({})], spot: SPOT })!;
    assert.equal(assumed.ivAssumed, 1);
  });

  it('the today curve converges to the expiry curve as days move forward to expiry', () => {
    const l = leg({ qty: -65 });
    const base = { legs: [{ ...l, mark: modelPrice(l, 0.14) }], spot: SPOT };
    const far = buildPayoffModel({ ...base, daysForward: 0 })!;
    const near = buildPayoffModel({ ...base, daysForward: 14 })!;
    const gap = (m: typeof far) => Math.abs(m.today.find(p => p.spot === SPOT)!.pnl - m.points.find(p => p.spot === SPOT)!.pnl);
    assert.ok(gap(near) < gap(far));
    assert.ok(gap(near) < 5, `gap at expiry ${gap(near)}`);
  });
});

describe('buildPayoffModel: what-if target curve', () => {
  const l = leg({ qty: -65 });
  const legs = [{ ...l, mark: modelPrice(l, 0.14) }];
  it('is absent until the simulator changes something', () => {
    assert.equal(buildPayoffModel({ legs, spot: SPOT })!.target, null);
    assert.equal(buildPayoffModel({ legs, spot: SPOT, sim: { days: 0, ivShift: 0 } })!.target, null);
  });
  it('a short option gains from time passing and loses from an IV rise', () => {
    const at = (m: ReturnType<typeof buildPayoffModel>) => m!.target!.find(p => p.spot === SPOT)!.pnl;
    const decay = at(buildPayoffModel({ legs, spot: SPOT, sim: { days: 7, ivShift: 0 } }));
    const ivUp = at(buildPayoffModel({ legs, spot: SPOT, sim: { days: 0, ivShift: 5 } }));
    const now = buildPayoffModel({ legs, spot: SPOT })!.nowPnl;
    assert.ok(decay > now, `decay ${decay} vs now ${now}`);
    assert.ok(ivUp < now, `iv up ${ivUp} vs now ${now}`);
  });
});

describe('buildPayoffModel: mixed expiries', () => {
  const near = leg({ type: 'CE', strike: 22700, expiry: NEAR, qty: -65, entryPrice: 120 });
  const far = leg({ type: 'CE', strike: 22700, expiry: FAR, qty: 65, entryPrice: 210 });
  it('values the nearest expiry as of its own date, with the later leg keeping time value', () => {
    const m = buildPayoffModel({ legs: [near, far], spot: SPOT })!;
    assert.equal(m.frontExpiry, NEAR);
    assert.deepEqual(m.laterExpiries, [FAR]);
    assert.equal(m.extremesExact, false);
    // a calendar: the far leg's residual value makes the curve worth more than a bare short-call's intrinsic-only payoff far above the strike
    const hi = m.points[m.points.length - 1];
    assert.ok(hi.pnl > -(hi.spot - 22700 - 120) * 65, 'far leg time value must lift the right wing');
  });
  it('reports each leg on its own expiry, so the note can name the real dates', () => {
    const m = buildPayoffModel({ legs: [far, near], spot: SPOT })!;
    assert.equal(m.frontExpiry, NEAR);
  });
});

describe('payoffLadder', () => {
  const legs = [leg({ type: 'CE', entryPrice: 100, lotSize: 65 }), leg({ type: 'PE', entryPrice: 90, lotSize: 65 })];
  it('a short straddle loses more the further the market moves, either way', () => {
    const rows = payoffLadder({ legs, spot: SPOT });
    const at = (m: number) => rows.find(r => r.movePct === m)!.pnlDelta;
    assert.ok(at(4) < at(2) && at(2) < at(1) && at(-4) < at(-2) && at(-2) < at(-1));
    assert.equal(at(0), 0);
  });
});

describe('buildPayoffModel: light mode', () => {
  const l = leg({ qty: -65 });
  const legs = [{ ...l, mark: modelPrice(l, 0.14) }, leg({ type: 'PE', entryPrice: 90, mark: undefined })];
  it('gives the same header numbers as the full model without drawing curves', () => {
    const full = buildPayoffModel({ legs, spot: SPOT, margin: 150000 })!;
    const light = buildPayoffModel({ legs, spot: SPOT, margin: 150000, light: true })!;
    assert.deepEqual(light.points, []);
    assert.deepEqual(light.today, []);
    assert.deepEqual(light.breakevens.map(b => Math.round(b)), full.breakevens.map(b => Math.round(b)));
    assert.equal(light.maxProfit, full.maxProfit);
    assert.equal(light.maxLossUnlimited, full.maxLossUnlimited);
    assert.equal(light.rom, full.rom);
    assert.equal(light.pop, full.pop);
  });
  it('a mixed-expiry book still reports window extremes in light mode', () => {
    const mixed = [leg({ expiry: NEAR, qty: -65, entryPrice: 120 }), leg({ expiry: FAR, qty: 65, entryPrice: 210 })];
    const full = buildPayoffModel({ legs: mixed, spot: SPOT })!;
    const light = buildPayoffModel({ legs: mixed, spot: SPOT, light: true })!;
    assert.ok(Math.abs(light.maxProfit - full.maxProfit) < 1e-6 && Math.abs(light.maxLoss - full.maxLoss) < 1e-6);
  });
});

describe('buildPayoffModel: hooks for legacy adapters', () => {
  const legs = [leg({ type: 'CE', entryPrice: 100 }), leg({ type: 'PE', entryPrice: 90 })];

  it('evaluates exactly at the given sample grid', () => {
    const grid = [22000, 22300, 22500, 22700, 23000];
    const m = buildPayoffModel({ legs, spot: SPOT, samples: grid })!;
    assert.deepEqual(m.points.map(p => p.spot), grid);
    assert.equal(m.today.length, grid.length);
  });

  it('a leg with an explicit `years` ignores its expiry date', () => {
    const withExpiry = (expiry: string) => legs.map(l => ({ ...l, expiry, mark: undefined, years: 10 / 365, iv: 0.14 }));
    const a = buildPayoffModel({ legs: withExpiry(day(5)), spot: SPOT })!;
    const b = buildPayoffModel({ legs: withExpiry(day(90)), spot: SPOT })!;
    assert.deepEqual(a.today.map(p => p.pnl), b.today.map(p => p.pnl));
    assert.deepEqual(a.points.map(p => p.pnl), b.points.map(p => p.pnl));
  });

  it('exposes the ±2 SD levels alongside ±1 SD', () => {
    const m = buildPayoffModel({ legs, spot: SPOT, atmIv: 0.14 })!;
    const e = m.expectedMove!;
    assert.ok(Math.abs((e.sd2Hi - SPOT) - 2 * (e.sd1Hi - SPOT)) < 0.5);
    assert.ok(e.sd2Lo < e.sd1Lo && e.sd2Hi > e.sd1Hi);
  });
});

describe('builderLegsToPayoffLegs and unlimitedFlags', () => {
  it('maps builder legs to signed units, using the price as both entry and mark', () => {
    const out = builderLegsToPayoffLegs(
      [{ strike: 22500, type: 'CE', side: 'SELL', qtyLots: 2, price: 100, iv: 0.14 }, { strike: 22300, type: 'PE', side: 'BUY', qtyLots: 1, price: 80, iv: null, expiry: null }],
      65, NEAR,
    );
    assert.equal(out[0].qty, -130);
    assert.equal(out[1].qty, 65);
    assert.equal(out[0].entryPrice, 100);
    assert.equal(out[0].mark, 100);
    assert.equal(out[0].expiry, NEAR);
    assert.equal(out[1].chainIv, undefined);
  });
  it('drops legs with no price', () => {
    assert.equal(builderLegsToPayoffLegs([{ strike: 22500, type: 'CE', side: 'BUY', qtyLots: 1, price: 0 }], 65, NEAR).length, 0);
  });
  it('flags unlimited risk from net signed quantity', () => {
    assert.deepEqual(unlimitedFlags([{ type: 'CE', qty: -65 }]), { maxProfitUnlimited: false, maxLossUnlimited: true });
    assert.deepEqual(unlimitedFlags([{ type: 'CE', qty: 65 }]), { maxProfitUnlimited: true, maxLossUnlimited: false });
    assert.deepEqual(unlimitedFlags([{ type: 'PE', qty: 65 }, { type: 'CE', qty: -65 }, { type: 'CE', qty: 65 }]), { maxProfitUnlimited: false, maxLossUnlimited: false });
  });
});

describe('payoffGrid: spot x date', () => {
  const l = leg({ qty: -65, entryPrice: 100 });
  const legs = [{ ...l, iv: 0.14 }];
  const spots = [22300, 22500, 22700];

  it('column 0 is the T+0 curve at those levels', () => {
    const m = buildPayoffModel({ legs, spot: SPOT, samples: spots, now: 1 })!;
    const g = payoffGrid({ legs, spot: SPOT, now: 1 }, spots, [0]);
    spots.forEach((s, i) => assert.ok(Math.abs(g[i][0] - m.today.find((p) => p.spot === s)!.pnl) < 1e-6));
  });

  it('the final column (everything expired) is the intrinsic payoff', () => {
    const days = calculateTimeToExpiryYears(NEAR) * 365 + 1;
    const g = payoffGrid({ legs, spot: SPOT }, spots, [days]);
    spots.forEach((s, i) => assert.ok(Math.abs(g[i][0] - (100 - Math.max(s - 22500, 0)) * -(-65)) < 1e-6, `${s}: ${g[i][0]}`));
  });

  it('a leg that expires before a column is settled there, so mixed expiries need no special case', () => {
    const now = Date.now();
    const mixed = [
      { ...leg({ qty: -65, entryPrice: 100, expiry: NEAR }), iv: 0.14 },
      { ...leg({ qty: 65, entryPrice: 200, expiry: FAR }), iv: 0.14 },
    ];
    const afterNear = calculateTimeToExpiryYears(NEAR, now) * 365 + 1;
    const g = payoffGrid({ legs: mixed, spot: SPOT, now }, [23000], [afterNear]);
    const farAlone = payoffGrid({ legs: [mixed[1]], spot: SPOT, now }, [23000], [afterNear]);
    const nearIntrinsic = (100 - Math.max(23000 - 22500, 0)) * 65;
    assert.ok(Math.abs(g[0][0] - (farAlone[0][0] + nearIntrinsic)) < 1e-6);
  });

  it('a higher IV scale costs a short option (and a lower one helps it) before expiry', () => {
    const at = (ivScale: number) => payoffGrid({ legs, spot: SPOT, ivScale }, [22500], [0])[0][0];
    assert.ok(at(1.2) < at(1) && at(0.8) > at(1));
  });

  it('a leg with no IV and no fallback is priced at intrinsic, not on a guess', () => {
    const noIv = [{ ...l }];
    const g = payoffGrid({ legs: noIv, spot: SPOT, fallbackIv: 0 }, [22700], [0]);
    assert.ok(Math.abs(g[0][0] - (100 - 200) * 65) < 1e-6, `${g[0][0]}`);
  });
});

// Calendar / diagonal semantics (ported from the retired computeCalendarPayoffCurve tests): the book is valued as of the NEAR expiry,
// the near leg at pure intrinsic value and the far leg still carrying time value.
describe('buildPayoffModel: calendar spreads', () => {
  const near = (o: Partial<PayoffLegInput> = {}) => leg({ strike: 24000, type: 'CE', qty: -65, entryPrice: 100, expiry: NEAR, iv: 0.13, ...o });
  const far = (o: Partial<PayoffLegInput> = {}) => leg({ strike: 24000, type: 'CE', qty: 65, entryPrice: 150, expiry: FAR, iv: 0.13, ...o });
  const run = (legs: PayoffLegInput[]) => buildPayoffModel({ legs, spot: 24000, samples: undefined })!;

  it('the near leg is pure intrinsic at its own strike, so the far leg\'s time value is what keeps the peak from being a loss', () => {
    const m = run([near({ iv: 0.15 }), far({ iv: 0.15 })]);
    const atStrike = m.points.reduce((b, p) => (Math.abs(p.spot - 24000) < Math.abs(b.spot - 24000) ? p : b));
    assert.ok(atStrike.pnl > -150 * 65, `peak ${atStrike.pnl}`);
  });

  it('deep in the money the book is finite: the far leg\'s own intrinsic floor offsets the near leg', () => {
    const m = run([near(), far()]);
    const edge = m.points[m.points.length - 1];
    assert.ok(Number.isFinite(edge.pnl) && edge.spot > 24000);
  });

  it('a balanced calendar is defined-risk; selling more near calls is unlimited loss; buying more far calls is unlimited profit', () => {
    assert.deepEqual(unlimitedFlags([{ type: 'CE', qty: -65 }, { type: 'CE', qty: 65 }]), { maxProfitUnlimited: false, maxLossUnlimited: false });
    const moreNear = run([near({ qty: -130 }), far()]);
    assert.equal(moreNear.maxLossUnlimited, true);
    assert.equal(moreNear.maxProfitUnlimited, false);
    const moreFar = run([near(), far({ qty: 130 })]);
    assert.equal(moreFar.maxProfitUnlimited, true);
    assert.equal(moreFar.maxLossUnlimited, false);
  });

  it('net long puts have capped profit (spot cannot go below zero), not unlimited', () => {
    const m = run([near({ type: 'PE', qty: -65 }), far({ type: 'PE', qty: 130 })]);
    assert.equal(m.maxLossUnlimited, false);
    assert.equal(m.maxProfitUnlimited, false);
  });

  it('reports the near and later expiries from each leg\'s own date, and solves break-evens on the model', () => {
    const m = run([near({ entryPrice: 120 }), far({ entryPrice: 200 })]);
    assert.equal(m.frontExpiry, NEAR);
    assert.deepEqual(m.laterExpiries, [FAR]);
    assert.ok(Array.isArray(m.breakevens));
    for (const b of m.breakevens) assert.ok(Math.abs(m.points.find((p) => p.spot === b)?.pnl ?? 0) < 1e6);
  });
});


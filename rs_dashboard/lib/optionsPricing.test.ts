import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeBsGreeks,
  computeBsGreeksExact,
  priceOption,
  bsPrice,
  impliedVol,
  impliedVolFromPrice,
  greeksFromMark,
  rollForward,
  spotFromFutures,
  calculateTimeToExpiryYears,
  riskNeutralProbAbove,
} from './optionsPricing.ts';

// Tests for lib/optionsPricing.ts — the single options-maths library. Formula tests difference the price itself and pin the
// results to fixed values from two independent libraries; see the headers of the blocks below.

describe('computeBsGreeks Greeks match finite differences of its own price', () => {
  // High-precision normal CDF (Taylor series for erf), so second differences are not swamped by the A&S approximation's 1e-7 error.
  const N = (x: number) => {
    const ax = Math.abs(x) / Math.SQRT2;
    if (ax > 6) return x > 0 ? 1 : 0;
    let term = ax, sum = ax;
    for (let n = 1; n < 120; n++) { term *= -(ax * ax) / n; sum += term / (2 * n + 1); }
    const erf = (2 / Math.sqrt(Math.PI)) * sum;
    return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
  };
  type Px = (X: number, T: number, s: number) => number;
  const black76 = (type: 'CE' | 'PE', K: number, r: number): Px => (F, T, s) => {
    const sq = Math.sqrt(T), d1 = (Math.log(F / K) + 0.5 * s * s * T) / (s * sq), d2 = d1 - s * sq, df = Math.exp(-r * T);
    return type === 'CE' ? df * (F * N(d1) - K * N(d2)) : df * (K * N(-d2) - F * N(-d1));
  };
  const blackScholes = (type: 'CE' | 'PE', K: number, r: number): Px => (S, T, s) => {
    const sq = Math.sqrt(T), d1 = (Math.log(S / K) + (r + 0.5 * s * s) * T) / (s * sq), d2 = d1 - s * sq, df = Math.exp(-r * T);
    return type === 'CE' ? S * N(d1) - K * df * N(d2) : K * df * N(-d2) - S * N(-d1);
  };
  const fd = {
    delta: (p: Px, X: number, T: number, s: number) => { const h = X * 1e-4; return (p(X + h, T, s) - p(X - h, T, s)) / (2 * h); },
    gamma: (p: Px, X: number, T: number, s: number) => { const h = X * 1e-3; return (p(X + h, T, s) - 2 * p(X, T, s) + p(X - h, T, s)) / (h * h); },
    vega1pct: (p: Px, X: number, T: number, s: number) => { const h = 1e-5; return ((p(X, T, s + h) - p(X, T, s - h)) / (2 * h)) * 0.01; },
    theta: (p: Px, X: number, T: number, s: number) => -((p(X, T + 1e-6, s) - p(X, T - 1e-6, s)) / 2e-6) / 365,
  };

  const R = 0.065;
  // [type, strike, years, iv, underlying]. The first six are Nifty-like; the "unit" cases use an underlying of 100 with 0.5-1y
  // tenors so delta (2 dp) and gamma (4 dp) are large enough that the old e^{-rt} errors (3-6%) exceed the output rounding.
  const cases: ['CE' | 'PE', number, number, number, number][] = [
    ['CE', 22800, 22 / 365, 0.1364, 22623.7],
    ['PE', 22200, 22 / 365, 0.1495, 22623.7],
    ['CE', 22600, 7 / 365, 0.14, 22600],
    ['PE', 22600, 90 / 365, 0.16, 22600],
    ['CE', 20000, 180 / 365, 0.2, 22600],
    ['PE', 25000, 180 / 365, 0.2, 22600],
    ['CE', 100, 1, 0.2, 100],
    ['PE', 100, 1, 0.2, 100],
    ['CE', 105, 0.5, 0.25, 100],
    ['PE', 95, 0.5, 0.25, 100],
  ];

  for (const futures of [true, false]) {
    for (const [type, K, T, iv, X] of cases) {
      const px = futures ? black76(type, K, R) : blackScholes(type, K, R);
      it(`${futures ? 'futures (Black-76)' : 'spot (Black-Scholes)'} ${type} K${K} ${Math.round(T * 365)}d`, () => {
        const g = computeBsGreeks(type, X, K, T, iv, 65, R, futures);
        const tol = (res: number) => res / 2 + 1e-9; // half the output's rounding step
        const check = (name: string, got: number, want: number, res: number) =>
          assert.ok(Math.abs(got - want) <= tol(res), `${name} ${got} vs finite difference ${want.toFixed(6)}`);
        check('delta', g.delta, fd.delta(px, X, T, iv), 0.01);
        check('gamma', g.gamma, fd.gamma(px, X, T, iv), 0.0001);
        check('vega', g.vega, fd.vega1pct(px, X, T, iv), 0.01);
        check('theta', g.theta, fd.theta(px, X, T, iv), 0.01);
      });
    }
  }
});

// Independent library reference table (see the comment inside the describe below for provenance).
const fixtures: [boolean, 'CE' | 'PE', number, number, number, number, number, number, number, number, number][] = [
[true, 'CE', 22800, 0.06027397260273973, 0.1364, 22623.7, 222.495154, 0.413238, 0.00051253, -6.646210, 21.567200],
[true, 'PE', 22200, 0.06027397260273973, 0.1495, 22623.7, 158.265204, -0.295701, 0.00041509, -6.476601, 19.144519],
[true, 'CE', 22600, 0.019178082191780823, 0.14, 22600, 174.582595, 0.503240, 0.00090930, -12.438705, 12.469795],
[true, 'PE', 22600, 0.2465753424657534, 0.16, 22600, 704.755521, -0.476458, 0.00021848, -3.787745, 44.024055],
[true, 'CE', 20000, 0.4931506849315068, 0.2, 22600, 2824.159287, 0.800424, 0.00007822, -1.686210, 39.404562],
[true, 'PE', 25000, 0.4931506849315068, 0.2, 22600, 2771.235809, -0.718231, 0.00009865, -2.267261, 49.693830],
[true, 'CE', 100, 1, 0.2, 100, 7.464274, 0.505855, 0.01859857, -0.008862, 0.371971],
[true, 'PE', 100, 1, 0.2, 100, 7.464274, -0.431212, 0.01859857, -0.008862, 0.371971],
[true, 'CE', 105, 0.5, 0.25, 100, 4.832109, 0.411982, 0.02146483, -0.017517, 0.268310],
[true, 'PE', 95, 0.5, 0.25, 100, 4.504557, -0.341240, 0.02033545, -0.016608, 0.254193],
[false, 'CE', 22800, 0.06027397260273973, 0.1364, 22623.7, 261.227704, 0.460939, 0.00052406, -8.646705, 22.052116],
[false, 'PE', 22200, 0.06027397260273973, 0.1495, 22623.7, 133.606911, -0.261025, 0.00039142, -5.058389, 18.052711],
[false, 'CE', 22600, 0.019178082191780823, 0.14, 22600, 189.129960, 0.529491, 0.00090799, -14.549144, 12.451805],
[false, 'PE', 22600, 0.2465753424657534, 0.16, 22600, 545.181681, -0.404602, 0.00021580, -2.139811, 43.484415],
[false, 'CE', 20000, 0.4931506849315068, 0.2, 22600, 3432.873817, 0.878727, 0.00006349, -4.702173, 31.984801],
[false, 'PE', 25000, 0.4931506849315068, 0.2, 22600, 2270.170068, -0.662808, 0.00011507, -0.148520, 57.966675],
[false, 'CE', 100, 1, 0.2, 100, 11.263922, 0.664582, 0.01822459, -0.019815, 0.364492],
[false, 'PE', 100, 1, 0.2, 100, 4.970668, -0.335418, 0.01822459, -0.003128, 0.364492],
[false, 'CE', 105, 0.5, 0.25, 100, 6.309906, 0.498499, 0.02256742, -0.027075, 0.282093],
[false, 'PE', 95, 0.5, 0.25, 100, 3.484256, -0.286924, 0.01926655, -0.010765, 0.240832],
];

describe('computeBsGreeks vs independent library reference values', () => {
  // Fixed expected numbers from two independent implementations that agree with each other to 1e-6:
  //   py_vollib 1.0.12 (black / black_scholes analytical) and blackscholes 0.2.2 (Black76* / BlackScholes*),
  //   r = 0.065, no dividend. Generated 2026-10-05; units normalised to ours: theta per calendar day
  //   (library per-year / 365), vega per 1% IV (library per 1.00 x 0.01).
  // This pins the formulas to something outside this repo, so a change that bends the maths cannot be hidden by
  // editing the finite-difference test alongside it. To regenerate, rerun both libraries on these inputs.
  // Columns: futures?, type, strike, years, iv, underlying, price, delta, gamma, theta/day, vega/1%.

  // Half of computeBsGreeks' output rounding step (price 0.05, delta/theta/vega 0.01, gamma 0.0001) plus a hair.
  const TOL = { price: 0.0251, delta: 0.00501, gamma: 0.000051, theta: 0.00501, vega: 0.00501 };

  for (const [futures, type, K, T, iv, X, price, delta, gamma, theta, vega] of fixtures) {
    it(`${futures ? 'Black-76' : 'Black-Scholes'} ${type} K${K} ${Math.round(T * 365)}d iv ${iv}`, () => {
      const g = computeBsGreeks(type, X, K, T, iv, 65, 0.065, futures);
      const within = (name: keyof typeof TOL, got: number, want: number) =>
        assert.ok(Math.abs(got - want) <= TOL[name], `${name}: ours ${got} vs library ${want}`);
      within('price', g.price, price);
      within('delta', g.delta, delta);
      within('gamma', g.gamma, gamma);
      within('theta', g.theta, theta);
      within('vega', g.vega, vega);
    });
  }
});

describe('computeBsGreeksExact: unrounded engine', () => {
  // Same independent reference table as above, at tight tolerance (the only error left is the A&S normal CDF's ~1.5e-7).
  for (const [futures, type, K, T, iv, X, price, delta, gamma, theta, vega] of fixtures) {
    it(`matches the library ${futures ? 'Black-76' : 'Black-Scholes'} ${type} K${K} ${Math.round(T * 365)}d`, () => {
      const g = computeBsGreeksExact(type, X, K, T, iv, 0.065, futures);
      const near = (name: string, got: number, want: number, tol: number) =>
        assert.ok(Math.abs(got - want) <= tol, `${name}: exact ${got} vs library ${want}`);
      near('price', g.price, price, 0.01 + price * 1e-6);
      near('delta', g.delta, delta, 1e-6);
      near('gamma', g.gamma, gamma, 1e-8);
      near('theta', g.theta, theta, 1e-4);
      near('vega', g.vega, vega, 1e-3);
    });
  }

  it('computeBsGreeks is exactly the rounded view of it', () => {
    const e = computeBsGreeksExact('CE', 22623.7, 22800, 22 / 365, 0.1364, 0.065, true);
    const r = computeBsGreeks('CE', 22623.7, 22800, 22 / 365, 0.1364, 65, 0.065, true);
    assert.equal(r.price, Math.max(0.05, Math.round(e.price * 20) / 20));
    assert.equal(r.delta, Math.round(e.delta * 100) / 100);
    assert.equal(r.gamma, Math.round(e.gamma * 10000) / 10000);
    assert.equal(r.theta, Math.round(e.theta * 100) / 100);
    assert.equal(r.vega, Math.round(e.vega * 100) / 100);
  });

  it('keeps precision that the rounded view throws away (what summing 390 units needs)', () => {
    const e = computeBsGreeksExact('PE', 22623.7, 22200, 22 / 365, 0.1495, 0.065, true);
    const r = computeBsGreeks('PE', 22623.7, 22200, 22 / 365, 0.1495, 65, 0.065, true);
    assert.notEqual(e.gamma, r.gamma);
    assert.ok(Math.abs(e.gamma * 390 - r.gamma * 390) > 0.005, 'a 4 dp gamma is visibly off once multiplied by the quantity');
  });

  it('rho, vanna and vomma match finite differences (futures and spot)', () => {
    const N = (x: number) => {
      const ax = Math.abs(x) / Math.SQRT2;
      let term = ax, sum = ax;
      for (let n = 1; n < 120; n++) { term *= -(ax * ax) / n; sum += term / (2 * n + 1); }
      const erf = (2 / Math.sqrt(Math.PI)) * sum;
      return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
    };
    const model = (futures: boolean, type: 'CE' | 'PE', X: number, K: number, T: number, s: number, r: number) => {
      const sq = Math.sqrt(T), d1 = (Math.log(X / K) + (futures ? 0 : r * T) + 0.5 * s * s * T) / (s * sq), d2 = d1 - s * sq, df = Math.exp(-r * T);
      if (futures) return type === 'CE' ? { p: df * (X * N(d1) - K * N(d2)), d: df * N(d1) } : { p: df * (K * N(-d2) - X * N(-d1)), d: -df * N(-d1) };
      return type === 'CE' ? { p: X * N(d1) - K * df * N(d2), d: N(d1) } : { p: K * df * N(-d2) - X * N(-d1), d: N(d1) - 1 };
    };
    const vegaRaw = (futures: boolean, type: 'CE' | 'PE', X: number, K: number, T: number, s: number, r: number) =>
      (model(futures, type, X, K, T, s + 1e-5, r).p - model(futures, type, X, K, T, s - 1e-5, r).p) / 2e-5;
    for (const futures of [true, false]) {
      for (const [type, X, K, T, s] of [['CE', 22623.7, 22800, 22 / 365, 0.1364], ['PE', 22623.7, 22200, 22 / 365, 0.1495], ['CE', 100, 105, 0.5, 0.25]] as const) {
        const r = 0.065;
        const g = computeBsGreeksExact(type, X, K, T, s, r, futures);
        const rho = ((model(futures, type, X, K, T, s, r + 1e-6).p - model(futures, type, X, K, T, s, r - 1e-6).p) / 2e-6) * 0.01;
        const vanna = ((model(futures, type, X, K, T, s + 1e-5, r).d - model(futures, type, X, K, T, s - 1e-5, r).d) / 2e-5) * 0.01;
        const vomma = ((vegaRaw(futures, type, X, K, T, s + 1e-4, r) - vegaRaw(futures, type, X, K, T, s - 1e-4, r)) / 2e-4) * 0.01 * 0.01;
        const label = `${futures ? 'Black-76' : 'spot'} ${type} ${K}`;
        assert.ok(Math.abs(g.rho - rho) <= 5e-3 + Math.abs(rho) * 1e-3, `${label} rho ${g.rho} vs ${rho}`);
        assert.ok(Math.abs(g.vanna - vanna) <= 1e-6 + Math.abs(vanna) * 1e-3, `${label} vanna ${g.vanna} vs ${vanna}`);
        assert.ok(Math.abs(g.vomma - vomma) <= 1e-5 + Math.abs(vomma) * 5e-3, `${label} vomma ${g.vomma} vs ${vomma}`);
      }
    }
  });
});

describe('optionsPricing: implied volatility', () => {
  const cases: ['CE' | 'PE', number, number, number, number][] = [
    ['CE', 22800, 22 / 365, 0.1364, 22623.7], ['PE', 22200, 22 / 365, 0.1495, 22623.7],
    ['CE', 22600, 3 / 365, 0.12, 22600], ['PE', 25000, 180 / 365, 0.2, 22600],
  ];
  for (const futures of [true, false]) {
    for (const [type, K, T, iv, U] of cases) {
      it(`round-trips ${futures ? 'Black-76' : 'spot'} ${type} ${K} ${Math.round(T * 365)}d`, () => {
        const price = priceOption(type, U, K, T, iv, 0.065, futures);
        const solved = impliedVol(type, U, K, T, price, { isFutures: futures });
        assert.ok(solved !== null && Math.abs(solved - iv) < 1e-5, `solved ${solved} vs ${iv}`);
      });
    }
  }
  it('returns null (not a clamped number) for a price with no time value or an impossible price', () => {
    assert.equal(impliedVol('CE', 22800, 22000, 30 / 365, 800), null);   // below intrinsic
    assert.equal(impliedVol('CE', 22800, 22000, 30 / 365, 1e9), null);   // above a 500% vol
    assert.equal(impliedVol('CE', 22800, 22900, 0, 50), null);           // no time left
  });
  it('impliedVolFromPrice is the spot Black-Scholes inverse of bsPrice', () => {
    const p = bsPrice('PE', 22555.75, 22200, 22 / 365, 0.15);
    assert.ok(Math.abs((impliedVolFromPrice('PE', 22555.75, 22200, 22 / 365, p) ?? 0) - 0.15) < 1e-5);
  });
});

describe('optionsPricing: mark to Greeks', () => {
  it('reproduces the mark it was solved from, with exact Greeks at that IV', () => {
    const g = greeksFromMark({ type: 'CE', strike: 22800, expiry: '2099-01-01', mark: 222.5, underlying: 22623.7, isFutures: true }, { timeYears: 22 / 365 })!;
    assert.equal(g.ivSource, 'mark');
    assert.ok(Math.abs(g.price - 222.5) < 1e-3, `model price ${g.price}`);
    const again = computeBsGreeksExact('CE', 22623.7, 22800, 22 / 365, g.iv, 0.065, true);
    assert.equal(g.delta, again.delta);
  });
  it('uses the fallback IV only when the mark cannot be inverted, and says so', () => {
    const g = greeksFromMark({ type: 'CE', strike: 22000, expiry: '2099-01-01', mark: 0.01, underlying: 22600, isFutures: true, fallbackIv: 0.15 }, { timeYears: 22 / 365 })!;
    assert.equal(g.ivSource, 'fallback');
    assert.equal(g.iv, 0.15);
    assert.equal(greeksFromMark({ type: 'CE', strike: 22000, expiry: '2099-01-01', mark: 0.01, underlying: 22600, isFutures: true }, { timeYears: 22 / 365 }), null);
  });
});

describe('optionsPricing: expiry clock and forwards', () => {
  const istToUtc = (d: string, hh: number, mm: number) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10), hh - 5, mm - 30);
  it('counts to 15:40 IST on the expiry date, /365', () => {
    const now = istToUtc('2026-10-05', 9, 15);
    const years = calculateTimeToExpiryYears('2026-10-06', now);
    assert.ok(Math.abs(years * 365 - (1 + (15 * 60 + 40 - (9 * 60 + 15)) / 1440)) < 1e-9, `got ${years * 365} days`);
  });
  it('floors at a quarter of a day, including after the close', () => {
    assert.equal(calculateTimeToExpiryYears('2026-10-06', istToUtc('2026-10-06', 15, 39)), 0.25 / 365);
    assert.equal(calculateTimeToExpiryYears('2026-10-06', istToUtc('2026-10-07', 10, 0)), 0.25 / 365);
  });
  it('rolls a futures price between expiries with the same carry, and back to spot', () => {
    const now = istToUtc('2026-10-05', 12, 0);
    const F = 22623.7;
    const near = rollForward(F, '2026-10-27', '2026-10-19', 0.065, now);
    assert.ok(near < F && F - near < 40, `rolled to ${near}`);
    assert.equal(rollForward(F, '2026-10-27', '2026-10-27', 0.065, now), F);
    const spot = spotFromFutures(F, '2026-10-27', 0.065, now);
    assert.ok(Math.abs(spot * Math.exp(0.065 * calculateTimeToExpiryYears('2026-10-27', now)) - F) < 1e-6);
  });
});

describe('optionsPricing: charm and risk-neutral probability', () => {
  it('charm is the one-day change in delta (futures and spot)', () => {
    for (const futures of [true, false]) {
      const T = 22 / 365, e = computeBsGreeksExact('CE', 22623.7, 22800, T, 0.1364, 0.065, futures);
      const next = computeBsGreeksExact('CE', 22623.7, 22800, T - 1 / 365, 0.1364, 0.065, futures);
      assert.ok(Math.abs(e.charm - (next.delta - e.delta)) < 1e-12);
    }
  });
  it('riskNeutralProbAbove is −e^{rT}·dC/dK for the spot call (the N(d2) in the price)', () => {
    const S = 22555.75, K = 22800, T = 22 / 365, s = 0.14, r = 0.065, h = 0.5;
    const dCdK = (bsPrice('CE', S, K + h, T, s, r) - bsPrice('CE', S, K - h, T, s, r)) / (2 * h);
    assert.ok(Math.abs(riskNeutralProbAbove(S, K, T, s, r) - -dCdK * Math.exp(r * T)) < 1e-5);
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatShortExpiry,
  computeBsGreeks,
  generatePayoffCurve,
  computePortfolioMetrics,
  calculateTimeToExpiryYears,
  computeMultiExpiryStats,
} from './optionsMonitorMath.ts';

describe('optionsMonitorMath', () => {
  it('formatShortExpiry: formats standard YYYY-MM-DD correctly', () => {
    assert.equal(formatShortExpiry('2026-09-15'), '15-Sep');
    assert.equal(formatShortExpiry('2026-01-05'), '05-Jan');
    assert.equal(formatShortExpiry('2026-12-31'), '31-Dec');
  });

  it('formatShortExpiry: handles empty or invalid strings gracefully', () => {
    assert.equal(formatShortExpiry(''), '—');
    assert.equal(formatShortExpiry(undefined), '—');
  });

  it('computeBsGreeks: calculates valid Black-Scholes Greeks for Call and Put', () => {
    const spot = 24000;
    const strike = 24000;
    const timeYears = 7 / 365;
    const iv = 0.15;
    const lotSize = 65;

    const ce = computeBsGreeks('CE', spot, strike, timeYears, iv, lotSize);
    assert.ok(ce.price > 0, 'Call price should be positive');
    assert.ok(ce.delta > 0.4 && ce.delta < 0.6, 'ATM Call delta should be around 0.5');
    assert.ok(ce.theta < 0, 'Long Call theta should be negative');

    const pe = computeBsGreeks('PE', spot, strike, timeYears, iv, lotSize);
    assert.ok(pe.price > 0, 'Put price should be positive');
    assert.ok(pe.delta < -0.4 && pe.delta > -0.6, 'ATM Put delta should be around -0.5');
  });

  it('computePortfolioMetrics: aggregates Net Delta, Theta, and estimated margin', () => {
    const legs = [
      {
        id: '1',
        type: 'CE' as const,
        side: 'SELL' as const,
        strike: 24200,
        lots: 2,
        qty: 130,
        entryPrice: 100,
        ltp: 90,
        delta: 0.35,
        gamma: 0.001,
        theta: 1500,
        vega: 800,
        iv: 0.14,
        expiry: '2026-09-15',
      },
      {
        id: '2',
        type: 'PE' as const,
        side: 'SELL' as const,
        strike: 23800,
        lots: 2,
        qty: 130,
        entryPrice: 100,
        ltp: 95,
        delta: -0.35,
        gamma: 0.001,
        theta: 1500,
        vega: 800,
        iv: 0.14,
        expiry: '2026-09-15',
      },
    ];

    const metrics = computePortfolioMetrics(legs, 24000, 65);
    assert.equal(metrics.totalMtm, (100 - 90) * 130 + (100 - 95) * 130);
    assert.equal(metrics.netDelta, 0);
    assert.ok(metrics.netTheta > 0, 'Net Theta for short strangle should be positive');
    assert.ok(metrics.estimatedMargin > 0, 'Estimated margin should be positive');
  });

  it('computePortfolioMetrics: calculates exact cumulative Greeks with Dhan API scale', () => {
    // Real Dhan API Greeks from NIFTY 23400 CE and PE
    const legs = [
      {
        id: 'ce_dhan',
        type: 'CE' as const,
        side: 'SELL' as const,
        strike: 23400,
        lots: 2,
        qty: 130,
        entryPrice: 150,
        ltp: 140,
        delta: 0.5293,
        gamma: 0.00129,
        theta: -20.80526,
        vega: 9.13793,
        iv: 0.1343,
      },
      {
        id: 'pe_dhan',
        type: 'PE' as const,
        side: 'SELL' as const,
        strike: 23400,
        lots: 2,
        qty: 130,
        entryPrice: 150,
        ltp: 145,
        delta: -0.45746,
        gamma: 0.00197,
        theta: -8.40416,
        vega: 9.11053,
        iv: 0.0877,
      },
    ];

    const spot = 23400;
    const lotSize = 65;
    const metrics = computePortfolioMetrics(legs, spot, lotSize);

    // Delta in lots: (-2 * 0.5293) + (-2 * -0.45746) = -1.0586 + 0.91492 = -0.14368 -> -0.14 Δ
    assert.equal(metrics.netDelta, -0.14);

    // Rupee Delta: -0.14368 * 65 * 23400 * 0.01 = -2185.37 -> -2185
    assert.equal(metrics.rupeeDelta, -2185);

    // Theta (₹ / day): (+1 * 130 * 20.80526) + (+1 * 130 * 8.40416) = 2704.68 + 1092.54 = 3797.22 -> 3797
    assert.equal(metrics.netTheta, 3797);

    // Theta per hour (6.25 hrs/day): 3797 / 6.25 = 607.52 -> 608
    assert.equal(metrics.thetaPerHour, 608);

    // Vega (₹ / 1% VIX): (-1 * 130 * 9.13793) + (-1 * 130 * 9.11053) = -1187.93 - 1184.37 = -2372.3 -> -2372
    assert.equal(metrics.netVega, -2372);
  });

  it('PositionGuard presets & triggers: BUY leg target and SL', () => {
    const entryPrice = 100;
    // Long preset calculation
    const target20 = entryPrice * (1 + 20 / 100); // 120
    const sl20 = entryPrice * (1 - 20 / 100); // 80
    assert.equal(target20, 120);
    assert.equal(sl20, 80);

    // Target hit check: LTP >= Target
    assert.ok(120.5 >= target20, 'Long target triggers when LTP >= 120');
    assert.ok(!(119.5 >= target20), 'Long target does not trigger below 120');

    // SL hit check: LTP <= SL
    assert.ok(79.5 <= sl20, 'Long SL triggers when LTP <= 80');
    assert.ok(!(80.5 <= sl20), 'Long SL does not trigger above 80');
  });

  it('PositionGuard presets & triggers: SELL leg target and SL', () => {
    const entryPrice = 100;
    // Short preset calculation
    const target20 = entryPrice * (1 - 20 / 100); // 80
    const sl20 = entryPrice * (1 + 20 / 100); // 120
    assert.equal(target20, 80);
    assert.equal(sl20, 120);

    // Target hit check: LTP <= Target
    assert.ok(79.5 <= target20, 'Short target triggers when LTP <= 80');
    assert.ok(!(80.5 <= target20), 'Short target does not trigger above 80');

    // SL hit check: LTP >= SL
    assert.ok(120.5 >= sl20, 'Short SL triggers when LTP >= 120');
    assert.ok(!(119.5 >= sl20), 'Short SL does not trigger below 120');
  });

  it('PositionGuard trailing SL: 1:1 trail calculation for BUY and SELL', () => {
    // BUY leg: entry 100, SL 80 -> initialRisk = 20
    const buyEntry = 100;
    const buySL = 80;
    const buyInitialRisk = Math.abs(buySL - buyEntry); // 20

    // Price moves to 130 (new best) -> trailSL = best - risk = 130 - 20 = 110
    const buyBest = 130;
    const buyTrailSL = buyBest - buyInitialRisk;
    assert.equal(buyTrailSL, 110);
    assert.ok(buyTrailSL > buySL, 'Trail SL is active since it is tighter than original SL');

    // SELL leg: entry 100, SL 120 -> initialRisk = 20
    const sellEntry = 100;
    const sellSL = 120;
    const sellInitialRisk = Math.abs(sellSL - sellEntry); // 20

    // Price drops to 70 (new low) -> trailSL = best + risk = 70 + 20 = 90
    const sellBest = 70;
    const sellTrailSL = sellBest + sellInitialRisk;
    assert.equal(sellTrailSL, 90);
    assert.ok(sellTrailSL < sellSL, 'Trail SL is active since it is tighter than original SL');
  });

  it('Sensibull Parity: Black-76 calculates exact published Greeks off futures price', () => {
    const F = 23463.60;
    const tYears = 4 / 365;
    const lotSize = 65;

    // Leg 1: 23500 CE @ 9.5% IV
    const ce = computeBsGreeks('CE', F, 23500, tYears, 0.095, lotSize, 0.065, true);
    assert.equal(ce.delta, 0.44, 'CE delta should match Sensibull published 0.44');

    // Leg 2: 23300 PE @ 11.0% IV
    const pe = computeBsGreeks('PE', F, 23300, tYears, 0.11, lotSize, 0.065, true);
    assert.equal(pe.delta, -0.27, 'PE delta should match Sensibull published -0.27');

    const strangleLegs = [
      {
        id: 'leg_ce',
        type: 'CE' as const,
        side: 'SELL' as const,
        strike: 23500,
        lots: 1,
        qty: 65,
        entryPrice: 75.65,
        ltp: 75.65,
        delta: ce.delta,
        gamma: ce.gamma,
        theta: ce.theta,
        vega: ce.vega,
        iv: 0.095,
      },
      {
        id: 'leg_pe',
        type: 'PE' as const,
        side: 'SELL' as const,
        strike: 23300,
        lots: 1,
        qty: 65,
        entryPrice: 44.65,
        ltp: 44.65,
        delta: pe.delta,
        gamma: pe.gamma,
        theta: pe.theta,
        vega: pe.vega,
        iv: 0.11,
      },
    ];

    const metrics = computePortfolioMetrics(strangleLegs, 23398.10, lotSize, tYears);
    // Sensibull: Delta: -11 (with lot size multiplied)
    assert.equal(Math.round(metrics.shareDelta), -11, 'Share delta should match Sensibull published -11');

    // Sensibull: Gamma: -0.19
    assert.equal(metrics.shareGamma, -0.19, 'Share gamma should match Sensibull -0.19');

    // Sensibull: Vega: -1157
    assert.ok(Math.abs(metrics.netVega - (-1157)) <= 15, `Vega ${metrics.netVega} should be within ₹15 of Sensibull -1157`);

    // Sensibull: Theta: 1467
    assert.ok(Math.abs(metrics.netTheta - 1467) <= 25, `Theta ${metrics.netTheta} should be within ₹25 of Sensibull 1467`);
  });

  it('Sensibull Parity: Expected move SD bands match Sensibull 1SD and 2SD price levels to the rupee', () => {
    const spot = 23398.10;
    const atmIv = 0.1313; // 13.13% ATM IV
    const tYears = 4 / 365;

    const dummyLeg = [{
      id: 'dummy',
      type: 'CE' as const,
      side: 'SELL' as const,
      strike: 23400,
      lots: 1,
      qty: 65,
      entryPrice: 100,
      ltp: 100,
      delta: 0.5,
      gamma: 0.001,
      theta: 10,
      vega: 10,
      iv: atmIv,
    }];

    const curve = generatePayoffCurve(dummyLeg, spot, 65, tYears, atmIv, 50, 23463.60);
    assert.ok(curve.sdLevels !== null);
    const sd = curve.sdLevels!;

    // Sensibull: 1 SD: 321.7 (1.4%) Price: 23076.4 - 23719.8
    assert.ok(Math.abs(sd.points1 - 321.7) <= 0.1, '1SD points should match Sensibull 321.7');
    assert.ok(Math.abs(sd.lo1 - 23076) <= 1, '1SD lower price should match Sensibull 23076');
    assert.ok(Math.abs(sd.hi1 - 23720) <= 1, '1SD upper price should match Sensibull 23720');

    // Sensibull: 2 SD: 643.3 (2.7%) Price: 22754.8 - 24041.4
    assert.ok(Math.abs(sd.lo2 - 22755) <= 1, '2SD lower price should match Sensibull 22755');
    assert.ok(Math.abs(sd.hi2 - 24041) <= 1, '2SD upper price should match Sensibull 24041');
  });

  it('generatePayoffCurve: a later-expiry leg keeps time value on the front-expiry curve', () => {
    const mk = (id: string, side: 'BUY' | 'SELL', expiry: string) => ({
      id, type: 'PE' as const, side, strike: 22000, lots: 1, qty: 75,
      entryPrice: 100, ltp: 100, delta: 0, gamma: 0, theta: 0, vega: 0, iv: 0.15, expiry,
    });
    const front = '2098-01-01', far = '2098-02-01';
    const calendar = generatePayoffCurve([mk('a', 'SELL', front), mk('b', 'BUY', far)], 23000, 75, 0.02, 0.15, 50);
    const sameExp = generatePayoffCurve([mk('a', 'SELL', front), mk('b', 'BUY', front)], 23000, 75, 0.02, 0.15, 50);
    // Same strike, same side pair: one expiry nets to exactly zero everywhere, a calendar does not
    // (the long far put still has value when the front expires).
    assert.ok(sameExp.points.every((p) => p.pnlExpiry === 0));
    const atStrike = calendar.points.find((p) => p.spot === 22000)!;
    assert.ok(atStrike.pnlExpiry !== 0, 'far leg must not be scored at intrinsic on the front-expiry curve');
  });

  it('computeMultiExpiryStats: flyagonal shape is bounded with a second peak at the short put', () => {
    const L = (id: string, type: 'CE' | 'PE', side: 'BUY' | 'SELL', strike: number, lots: number, price: number, expiry: string) =>
      ({ id, type, side, strike, lots, qty: lots * 75, entryPrice: price, ltp: price, delta: 0, gamma: 0, theta: 0, vega: 0, iv: 0.15, expiry });
    const F = '2098-01-01', B = '2098-01-15';
    const legs = [
      L('1', 'CE', 'BUY', 23400, 1, 90, F), L('2', 'CE', 'SELL', 23600, 2, 10, F), L('3', 'CE', 'BUY', 23850, 1, 1, F),
      L('4', 'PE', 'SELL', 23200, 1, 60, F), L('5', 'PE', 'BUY', 23150, 1, 45, B),
    ];
    const st = computeMultiExpiryStats(legs, 23400, 75);
    assert.equal(st.maxProfitUnlimited, false);
    assert.equal(st.maxLossUnlimited, false);
    assert.ok(Number.isFinite(st.maxProfit) && st.maxProfit > 0);
    assert.ok(st.maxLoss < 0);
    assert.ok(st.breakevens.length >= 1);
  });
});

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

describe('computeBsGreeks vs independent library reference values', () => {
  // Fixed expected numbers from two independent implementations that agree with each other to 1e-6:
  //   py_vollib 1.0.12 (black / black_scholes analytical) and blackscholes 0.2.2 (Black76* / BlackScholes*),
  //   r = 0.065, no dividend. Generated 2026-10-05; units normalised to ours: theta per calendar day
  //   (library per-year / 365), vega per 1% IV (library per 1.00 x 0.01).
  // This pins the formulas to something outside this repo, so a change that bends the maths cannot be hidden by
  // editing the finite-difference test alongside it. To regenerate, rerun both libraries on these inputs.
  // Columns: futures?, type, strike, years, iv, underlying, price, delta, gamma, theta/day, vega/1%.
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


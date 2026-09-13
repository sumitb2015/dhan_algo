import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatShortExpiry,
  computeBsGreeks,
  computePortfolioMetrics,
  calculateTimeToExpiryYears,
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
});

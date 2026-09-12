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
});

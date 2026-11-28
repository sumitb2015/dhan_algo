import test from 'node:test';
import assert from 'node:assert/strict';
import {
  indexBaselineBlock,
  sessionHoursForMarket,
  calculateDailyAtr,
  calculateAutoBlockSize,
  snapToTick,
} from './renkoAutoBrick.ts';
import type { Bar } from './straddlePnf.ts';

test('indexBaselineBlock: provides accurate 30m baseline blocks for key indices and commodities', () => {
  assert.equal(indexBaselineBlock('NIFTY'), 8.35);
  assert.equal(indexBaselineBlock('nifty'), 8.35);
  assert.equal(indexBaselineBlock('BANKNIFTY'), 30.0);
  assert.equal(indexBaselineBlock('SENSEX'), 29.2);
  assert.equal(indexBaselineBlock('FINNIFTY'), 10.0);
  assert.equal(indexBaselineBlock('MIDCPNIFTY'), 6.7);
  assert.equal(indexBaselineBlock('CRUDEOIL'), 16.0);
  assert.equal(indexBaselineBlock('CRUDEOILM'), 16.0);
  assert.equal(indexBaselineBlock('CRUDEOILM26DEC'), 16.0);
  assert.equal(indexBaselineBlock('UNKNOWN_STOCK'), 10.0);
});

test('sessionHoursForMarket: distinguishes NSE (6h), MCX (14h), and Crypto (24h)', () => {
  assert.equal(sessionHoursForMarket('NSE', 'NIFTY'), 6);
  assert.equal(sessionHoursForMarket('BSE', 'SENSEX'), 6);
  assert.equal(sessionHoursForMarket('MCX', 'CRUDEOILM'), 14);
  assert.equal(sessionHoursForMarket('MCX_COMM', 'GOLD'), 14);
  assert.equal(sessionHoursForMarket('NSE', 'CRUDEOILM'), 14); // commodity symbol override
  assert.equal(sessionHoursForMarket('CRYPTO', 'BTCUSDT'), 24);
});

test('snapToTick: snaps accurately to instrument tick', () => {
  assert.equal(snapToTick(8.333, 0.05), 8.35);
  assert.equal(snapToTick(29.166, 0.05), 29.15);
  assert.equal(snapToTick(16.32, 1.0), 16.0);
});

test('calculateDailyAtr: groups bars into sessions and calculates True Range', () => {
  const bars: Bar[] = [];
  // Day 1 (1700000000): Range 24000 to 24100 (100 pts)
  for (let m = 0; m < 100; m++) {
    const t = 1700000000 + m * 60;
    bars.push({ t, ce: 0, pe: 0, straddle: 24050, vol: 10, h: 24100, l: 24000 });
  }
  // Day 2 (1700000000 + 86400): Range 24080 to 24200 (120 pts)
  for (let m = 0; m < 100; m++) {
    const t = 1700000000 + 86400 + m * 60;
    bars.push({ t, ce: 0, pe: 0, straddle: 24150, vol: 10, h: 24200, l: 24080 });
  }

  const res = calculateDailyAtr(bars, 5);
  assert.ok(res !== null);
  assert.equal(res!.sessionsCount, 2);
  assert.ok(res!.atr >= 100);
});

test('calculateAutoBlockSize: baseline fallback when no bars provided', () => {
  const res = calculateAutoBlockSize({ symbol: 'NIFTY', targetMinutes: 30 });
  assert.equal(res.source, 'baseline');
  assert.equal(res.boxPts, 8.35);
  assert.equal(res.blocks, 12);

  const sx = calculateAutoBlockSize({ symbol: 'SENSEX', targetMinutes: 30 });
  assert.equal(sx.boxPts, 29.2);
  assert.equal(sx.blocks, 12);

  const crude = calculateAutoBlockSize({ symbol: 'CRUDEOILM', market: 'MCX', targetMinutes: 30 });
  assert.equal(crude.boxPts, 16.0);
  assert.equal(crude.blocks, 28);
});

test('calculateAutoBlockSize: uses live ATR when >= 2 sessions available', () => {
  const bars: Bar[] = [];
  // Day 1: 100 pt range
  for (let m = 0; m < 60; m++) {
    bars.push({ t: 1700000000 + m * 60, ce: 0, pe: 0, straddle: 24050, vol: 1, h: 24100, l: 24000 });
  }
  // Day 2: 100 pt range
  for (let m = 0; m < 60; m++) {
    bars.push({ t: 1700000000 + 86400 + m * 60, ce: 0, pe: 0, straddle: 24050, vol: 1, h: 24100, l: 24000 });
  }

  const res = calculateAutoBlockSize({ symbol: 'NIFTY', bars, targetMinutes: 30, boxTick: 0.05 });
  assert.equal(res.source, 'atr');
  // 100 ATR / 12 blocks = 8.33 -> 8.35
  assert.equal(res.boxPts, 8.35);
  assert.equal(res.blocks, 12);
  assert.ok(res.formula.includes('100 ATR (2d) / 12 blocks = 8.35 pts'));

  // Test with realistic higher ATR (e.g. 360 pt ATR -> 30.0 pt box)
  const highAtrBars: Bar[] = [];
  for (let m = 0; m < 60; m++) {
    highAtrBars.push({ t: 1700000000 + m * 60, ce: 0, pe: 0, straddle: 25000, vol: 1, h: 25360, l: 25000 });
  }
  for (let m = 0; m < 60; m++) {
    highAtrBars.push({ t: 1700000000 + 86400 + m * 60, ce: 0, pe: 0, straddle: 25000, vol: 1, h: 25360, l: 25000 });
  }
  const highRes = calculateAutoBlockSize({ symbol: 'NIFTY', bars: highAtrBars, targetMinutes: 30, boxTick: 0.05 });
  assert.equal(highRes.source, 'atr');
  assert.equal(highRes.boxPts, 30.0);
  assert.equal(highRes.blocks, 12);
});

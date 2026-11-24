import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { displayLotUnits, INSTRUMENTS } from './indexScalperInstrument.ts';

describe('indexScalper bracket calculations (TP & SL)', () => {
  it('calculates CRUDEOILM Long TP profit and SL loss exactly as in the reference screenshot', () => {
    // Reference screenshot values:
    // Entry = 7476.33, Long position
    // TP = 7550.00
    // SL = 7437.00
    // 6 lots = 60 barrels
    const entry = 7476.33;
    const tpPrice = 7550.00;
    const slPrice = 7437.00;
    const lots = 6;
    const multiplier = 10; // 10 barrels per lot
    const totalUnits = lots * multiplier; // 60 barrels

    // Target Profit calculations
    const tpPts = tpPrice - entry; // +73.67
    const tpPct = (tpPts / entry) * 100;
    const tpPnl = Math.round(tpPts * totalUnits);

    assert.equal(tpPts.toFixed(2), '73.67');
    assert.equal(tpPct.toFixed(2), '0.99');
    assert.equal(tpPnl, 4420); // Exactly +4,420 INR!

    // Stop Loss calculations
    const slPts = slPrice - entry; // -39.33
    const slPct = (slPts / entry) * 100;
    const slPnl = Math.round(slPts * totalUnits);

    assert.equal(slPts.toFixed(2), '-39.33');
    assert.equal(slPct.toFixed(2), '-0.53');
    assert.equal(slPnl, -2360); // Exactly -2,360 INR!

    // Entry line unrealized P&L:
    // Current price = 7493.00, 3 lots = 30 barrels
    const currentSpot = 7493.00;
    const curLots = 3;
    const curUnits = curLots * multiplier;
    const curPts = currentSpot - entry; // +16.67
    const curPct = (curPts / entry) * 100;
    const curPnl = Math.round(curPts * curUnits);

    assert.equal(curPts.toFixed(2), '16.67');
    assert.equal(curPct.toFixed(2), '0.22');
    assert.equal(curPnl, 500); // Exactly +500 INR!
  });

  it('calculates Short position TP and SL correctly (inverted price direction)', () => {
    // Short entry at 24,000, 2 lots of NIFTY (130 units)
    const entry = 24000;
    const tpPrice = 23900; // lower price is profit for short
    const slPrice = 24050; // higher price is loss for short
    const lots = 2;
    const lotSize = displayLotUnits('NIFTY', 65);
    const totalUnits = lots * lotSize; // 130 units

    // Short TP
    const tpPts = entry - tpPrice; // +100 pts
    const tpPct = (tpPts / entry) * 100;
    const tpPnl = Math.round(tpPts * totalUnits); // 100 * 130 = +13,000

    assert.equal(tpPts, 100);
    assert.equal(tpPct.toFixed(2), '0.42');
    assert.equal(tpPnl, 13000);

    // Short SL
    const slPts = entry - slPrice; // -50 pts
    const slPct = (slPts / entry) * 100;
    const slPnl = Math.round(slPts * totalUnits); // -50 * 130 = -6,500

    assert.equal(slPts, -50);
    assert.equal(slPct.toFixed(2), '-0.21');
    assert.equal(slPnl, -6500);
  });

  it('snaps TP and SL prices to valid tick sizes', () => {
    const niftyTick = INSTRUMENTS.NIFTY.futTick; // 0.05
    const crudeTick = INSTRUMENTS.CRUDEOILM.futTick; // 1.0

    const rawNifty = 24051.234;
    const snappedNifty = Math.round(rawNifty / niftyTick) * niftyTick;
    assert.equal(snappedNifty.toFixed(2), '24051.25');

    const rawCrude = 7482.68;
    const snappedCrude = Math.round(rawCrude / crudeTick) * crudeTick;
    assert.equal(snappedCrude.toFixed(2), '7483.00');
  });
});

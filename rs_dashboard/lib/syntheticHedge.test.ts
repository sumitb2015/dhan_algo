import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_HEDGE,
  buildHedgeWings,
  isFullyProtected,
  sameHedgeConfig,
  soldWingExitQty,
  unprotectedShortLots,
  sanitizeHedgeConfig,
  uncoveredShortLots,
  wingLots,
  wingOffsetsFor,
  type HedgeConfig,
} from './syntheticHedge.ts';

const cfg = (over: Partial<HedgeConfig>): HedgeConfig => ({ ...DEFAULT_HEDGE, ...over });

test('protective: LONG buys OTM PE, SHORT buys OTM CE (unchanged default)', () => {
  assert.deepEqual(buildHedgeWings('LONG', 25000, 2, DEFAULT_HEDGE), [
    { role: 'HEDGE', optionType: 'PE', strike: 24800, side: 'BUY', lots: 2 },
  ]);
  assert.deepEqual(buildHedgeWings('SHORT', 25000, 2, DEFAULT_HEDGE), [
    { role: 'HEDGE', optionType: 'CE', strike: 25200, side: 'BUY', lots: 2 },
  ]);
});

test('covered: LONG sells OTM CE, SHORT sells OTM PE', () => {
  const c = cfg({ mode: 'COVERED', sellOffset: 300 });
  assert.deepEqual(buildHedgeWings('LONG', 25000, 1, c), [
    { role: 'HEDGE_SELL', optionType: 'CE', strike: 25300, side: 'SELL', lots: 1 },
  ]);
  assert.deepEqual(buildHedgeWings('SHORT', 25000, 1, c), [
    { role: 'HEDGE_SELL', optionType: 'PE', strike: 24700, side: 'SELL', lots: 1 },
  ]);
});

test('collar: both wings with separate offsets and ratios', () => {
  const c = cfg({ mode: 'COLLAR', buyOffset: 200, sellOffset: 400, buyRatio: 1, sellRatio: 0.5 });
  assert.deepEqual(buildHedgeWings('LONG', 25000, 4, c), [
    { role: 'HEDGE', optionType: 'PE', strike: 24800, side: 'BUY', lots: 4 },
    { role: 'HEDGE_SELL', optionType: 'CE', strike: 25400, side: 'SELL', lots: 2 },
  ]);
});

test('disabled hedge places no wings', () => {
  assert.deepEqual(buildHedgeWings('LONG', 25000, 1, cfg({ enabled: false, mode: 'COLLAR' })), []);
});

test('wingLots floors to whole lots with a one-lot minimum', () => {
  assert.equal(wingLots(1, 0.5), 1);
  assert.equal(wingLots(3, 0.5), 1);
  assert.equal(wingLots(3, 1.5), 4);
  assert.equal(wingLots(2, 3), 6);
});

test('uncoveredShortLots counts sold-wing lots above the long ATM option', () => {
  assert.equal(uncoveredShortLots('LONG', 2, cfg({ mode: 'COVERED', sellRatio: 1 })), 0);
  assert.equal(uncoveredShortLots('LONG', 2, cfg({ mode: 'COVERED', sellRatio: 2 })), 2);
  assert.equal(uncoveredShortLots('SHORT', 2, cfg({ mode: 'COLLAR', sellRatio: 1.5 })), 1);
  assert.equal(uncoveredShortLots('LONG', 2, cfg({ mode: 'PROTECTIVE', sellRatio: 3 })), 0);
  assert.equal(uncoveredShortLots('LONG', 2, cfg({ enabled: false, mode: 'COVERED', sellRatio: 3 })), 0);
});

test('unprotectedShortLots / isFullyProtected: a buy wing under x1 is not a full hedge', () => {
  assert.equal(unprotectedShortLots(4, cfg({ buyRatio: 0.5 })), 2);
  assert.equal(isFullyProtected(4, cfg({ buyRatio: 0.5 })), false);
  assert.equal(isFullyProtected(4, cfg({ buyRatio: 1 })), true);
  assert.equal(isFullyProtected(4, cfg({ buyRatio: 1.5 })), true);
  // Covered-only and disabled leave every short lot unprotected.
  assert.equal(unprotectedShortLots(3, cfg({ mode: 'COVERED' })), 3);
  assert.equal(unprotectedShortLots(3, cfg({ enabled: false })), 3);
  assert.equal(isFullyProtected(2, cfg({ mode: 'COLLAR' })), true);
});

test('soldWingExitQty never leaves the sold wing larger than the remaining long', () => {
  // Normal pro-rata close.
  assert.equal(soldWingExitQty(150, 75, 75), 75);
  // Long already clamped to 75 and fully closed: the whole wing must go.
  assert.equal(soldWingExitQty(150, 75, 0), 150);
  // Long remains larger than the wing: pro rata is enough.
  assert.equal(soldWingExitQty(75, 0, 150), 0);
  assert.equal(soldWingExitQty(75, 0, -10), 75);
});

test('sanitizeHedgeConfig rejects bad fields field by field', () => {
  const offsets = wingOffsetsFor('NIFTY');
  assert.deepEqual(sanitizeHedgeConfig(null, offsets), DEFAULT_HEDGE);
  assert.deepEqual(
    sanitizeHedgeConfig({ enabled: false, mode: 'COLLAR', buyOffset: 150, sellOffset: 999, buyRatio: 7, sellRatio: 2 }, offsets),
    { enabled: false, mode: 'COLLAR', buyOffset: 150, sellOffset: 200, buyRatio: 1, sellRatio: 2 },
  );
  assert.equal(sanitizeHedgeConfig({ mode: 'NAKED' }, offsets).mode, 'PROTECTIVE');
  // 150 is a NIFTY-only offset; a SENSEX config falls back to 200.
  assert.equal(sanitizeHedgeConfig({ buyOffset: 150 }, wingOffsetsFor('SENSEX')).buyOffset, 200);
});

test('sameHedgeConfig ignores the settings of a wing the mode does not use', () => {
  assert.ok(sameHedgeConfig(cfg({ sellOffset: 400 }), cfg({ sellOffset: 100 })));
  assert.ok(!sameHedgeConfig(cfg({ buyOffset: 300 }), DEFAULT_HEDGE));
  assert.ok(sameHedgeConfig(cfg({ enabled: false }), cfg({ enabled: false, mode: 'COLLAR' })));
  assert.ok(!sameHedgeConfig(undefined, DEFAULT_HEDGE));
});

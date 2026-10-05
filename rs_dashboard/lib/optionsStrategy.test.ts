import { test } from 'node:test';
import assert from 'node:assert';
import {
  computePayoffStats, bsPrice, impliedVolFromPrice, daysBetweenDates,
  DEFAULT_SPAN_PCT, STRATEGY_TEMPLATES, buildHeatmapGrid,
  type ResolvedLeg,
} from './optionsStrategy.ts';

const SENSEX_STEP = 100;
const SPOT = 78_009.25;
const EXPIRY = '2026-08-20';

/** Quantities are absolute contracts and lotSize is 1 — the positions-page convention. */
const leg = (over: Partial<ResolvedLeg>): ResolvedLeg => ({
  strike: 78_000, type: 'PE', side: 'SELL', qtyLots: 20, price: 347.27,
  delta: null, iv: 0.12, vega: null, securityId: null, expiry: EXPIRY,
  ...over,
});

/** The short strangle from the screenshot: sell 78000 PE + sell 78500 CE. */
const STRANGLE: ResolvedLeg[] = [
  leg({ strike: 78_000, type: 'PE', side: 'SELL', qtyLots: 20, price: 300 }),
  leg({ strike: 78_500, type: 'CE', side: 'SELL', qtyLots: 20, price: 200 }),
];

// ── expiry payoff ─────────────────────────────────────────────────────────────

test('short strangle: max profit is the full credit, between the strikes', () => {
  const stats = computePayoffStats(STRANGLE, SPOT, 1, EXPIRY, SENSEX_STEP);
  const credit = (300 + 200) * 20;
  assert.strictEqual(stats.netPremium, credit);
  assert.ok(Math.abs(stats.maxProfit as number - credit) < 1e-6);
});

test('short strangle breakevens sit one credit outside each strike', () => {
  const stats = computePayoffStats(STRANGLE, SPOT, 1, EXPIRY, SENSEX_STEP, 0.05);
  const be = [...stats.breakevensExpiry].sort((a, b) => a - b);
  assert.strictEqual(be.length, 2);
  // Credit per contract is 500, so the wings are 78000-500 and 78500+500.
  assert.ok(Math.abs(be[0] - 77_500) < 1, `lower BE ${be[0]}`);
  assert.ok(Math.abs(be[1] - 79_000) < 1, `upper BE ${be[1]}`);
});

test('a naked short book reports Unlimited, and its in-range loss is annotated', () => {
  const stats = computePayoffStats(STRANGLE, SPOT, 1, EXPIRY, SENSEX_STEP, 0.05);
  assert.strictEqual(stats.maxLoss, 'Unlimited');
  assert.strictEqual(stats.rewardRisk, null);
  // The number a UI would show instead must come with the window it belongs to,
  // and must actually be a loss reached inside that window.
  assert.ok(stats.maxLossInRange < 0);
  assert.ok(stats.rangeLo < SPOT && stats.rangeHi > SPOT);
  assert.ok(stats.maxLossAtSpot >= stats.rangeLo && stats.maxLossAtSpot <= stats.rangeHi);
});

test('a naked long call reports Unlimited max profit, and its in-range profit is annotated', () => {
  const longCall: ResolvedLeg[] = [
    leg({ strike: 78_500, type: 'CE', side: 'BUY', qtyLots: 20, price: 200 }),
  ];
  const stats = computePayoffStats(longCall, SPOT, 1, EXPIRY, SENSEX_STEP, 0.05);
  assert.strictEqual(stats.maxProfit, 'Unlimited');
  assert.strictEqual(stats.rewardRisk, null);
  assert.ok(stats.maxProfitInRange > 0);
  assert.ok(stats.maxProfitAtSpot >= stats.rangeLo && stats.maxProfitAtSpot <= stats.rangeHi);
  // The defined-risk side must stay a real number — only the long call's
  // upside is unbounded, the debit paid still caps the downside.
  assert.notStrictEqual(stats.maxLoss, 'Unlimited');
});

test('a naked long put has bounded max profit (spot cannot go below zero)', () => {
  const longPut: ResolvedLeg[] = [
    leg({ strike: 78_000, type: 'PE', side: 'BUY', qtyLots: 20, price: 300 }),
  ];
  const stats = computePayoffStats(longPut, SPOT, 1, EXPIRY, SENSEX_STEP, 0.05);
  assert.notStrictEqual(stats.maxProfit, 'Unlimited');
});

test('widening the span deepens the reported in-range loss on an unlimited book', () => {
  const narrow = computePayoffStats(STRANGLE, SPOT, 1, EXPIRY, SENSEX_STEP, 0.02);
  const wide = computePayoffStats(STRANGLE, SPOT, 1, EXPIRY, SENSEX_STEP, 0.08);
  assert.ok(wide.maxLossInRange < narrow.maxLossInRange,
    'a wider window must reveal a deeper loss — otherwise the figure is being clamped');
  assert.ok(wide.rangeHi > narrow.rangeHi);
});

test('a defined-risk spread reports a real max loss and a reward:risk ratio', () => {
  const spread: ResolvedLeg[] = [
    leg({ strike: 78_000, type: 'PE', side: 'SELL', qtyLots: 20, price: 300 }),
    leg({ strike: 77_500, type: 'PE', side: 'BUY', qtyLots: 20, price: 150 }),
  ];
  const stats = computePayoffStats(spread, SPOT, 1, EXPIRY, SENSEX_STEP, 0.05);
  const credit = (300 - 150) * 20;
  assert.ok(Math.abs(stats.maxProfit as number - credit) < 1e-6);
  // Width 500 minus the 150 credit, per contract.
  assert.ok(Math.abs((stats.maxLoss as number) + (500 - 150) * 20) < 1e-6);
  assert.ok(stats.rewardRisk !== null && stats.rewardRisk > 0);
});

test('quantities are exact in contracts — a partial close is not rounded away', () => {
  // 15 contracts of a 20-lot SENSEX option. Lot-based math would floor this to 0.
  const partial = [leg({ qtyLots: 15, price: 300, type: 'PE', side: 'SELL' })];
  const stats = computePayoffStats(partial, SPOT, 1, EXPIRY, SENSEX_STEP);
  assert.strictEqual(stats.netPremium, 300 * 15);
});

test('daysBetweenDates counts whole days and floors at zero', () => {
  assert.strictEqual(daysBetweenDates('2026-08-16', '2026-08-20'), 4);
  assert.strictEqual(daysBetweenDates('2026-08-20', '2026-08-20'), 0);
  assert.strictEqual(daysBetweenDates('2026-08-25', '2026-08-20'), 0); // past → 0, never negative
});

test('impliedVolFromPrice inverts bsPrice to within a basis point', () => {
  for (const [type, K, iv] of [['CE', 78_000, 0.12], ['PE', 77_000, 0.185], ['CE', 79_500, 0.31]] as const) {
    const t = 4 / 365;
    const price = bsPrice(type, SPOT, K, t, iv);
    const solved = impliedVolFromPrice(type, SPOT, K, t, price);
    assert.ok(solved !== null, `${type} ${K} returned null`);
    assert.ok(Math.abs(solved - iv) < 1e-4, `${type} ${K}: got ${solved}, want ${iv}`);
  }
});

test('impliedVolFromPrice returns null instead of a clamped bound on impossible input', () => {
  const t = 4 / 365;
  // At or below intrinsic there is no positive-vol solution.
  const intrinsic = SPOT - 70_000;
  assert.strictEqual(impliedVolFromPrice('CE', SPOT, 70_000, t, intrinsic), null);
  assert.strictEqual(impliedVolFromPrice('CE', SPOT, 70_000, t, intrinsic - 10), null);
  assert.strictEqual(impliedVolFromPrice('CE', SPOT, 78_000, t, 0), null);
  assert.strictEqual(impliedVolFromPrice('CE', SPOT, 78_000, 0, 300), null);
  // Absurdly rich mark — beyond 500% vol.
  assert.strictEqual(impliedVolFromPrice('CE', SPOT, 78_000, t, SPOT * 0.95), null);
});

// ── target-date curve ─────────────────────────────────────────────────────────

test('STRATEGY_TEMPLATES: batman template generates 4 legs with 1:2 ratio and undefined risk', () => {
  const batman = STRATEGY_TEMPLATES.find(t => t.id === 'batman');
  assert.ok(batman, 'batman template should exist');
  assert.strictEqual(batman.undefinedRisk, true);

  const legs = batman.legs({ N: 2, W: 2 });
  assert.strictEqual(legs.length, 4);
  assert.deepStrictEqual(legs, [
    { offsetStrikes: 2, type: 'CE', side: 'BUY', qtyRatio: 1 },
    { offsetStrikes: 4, type: 'CE', side: 'SELL', qtyRatio: 2 },
    { offsetStrikes: -2, type: 'PE', side: 'BUY', qtyRatio: 1 },
    { offsetStrikes: -4, type: 'PE', side: 'SELL', qtyRatio: 2 },
  ]);
});

// ── exact expiry profile: breakevens / bounded extremes independent of the drawn window ──
// Fixtures are the NISM Series VIII workbook examples (April 2014), one lot, lot size 1.

const nism = (type: 'CE' | 'PE', side: 'BUY' | 'SELL', strike: number, price: number): ResolvedLeg => ({
  strike, type, side, qtyLots: 1, price, delta: null, iv: null, vega: null, securityId: null,
});

test('wide long strangle: breakevens outside the default window are still found', () => {
  const legs = [nism('CE', 'BUY', 6200, 145), nism('PE', 'BUY', 6000, 140)];
  const stats = computePayoffStats(legs, 6100, 1, EXPIRY, 50);
  assert.deepStrictEqual(stats.breakevensExpiry, [5715, 6485]);
  assert.strictEqual(stats.maxLoss, -285);
  // ...and the drawn range now covers them, so the chart shows what the stats claim.
  assert.ok(stats.rangeLo < 5715 && stats.rangeHi > 6485, `${stats.rangeLo}-${stats.rangeHi}`);
});

test('wide long straddle: strike -/+ total premium', () => {
  const legs = [nism('CE', 'BUY', 6000, 257), nism('PE', 'BUY', 6000, 136)];
  const stats = computePayoffStats(legs, 6000, 1, EXPIRY, 50);
  assert.deepStrictEqual(stats.breakevensExpiry, [5607, 6393]);
  assert.strictEqual(stats.maxLoss, -393);
  assert.strictEqual(stats.maxProfit, 'Unlimited');
});

test('a long put reports its true bounded max profit (strike - premium at spot 0), not a window value', () => {
  const stats = computePayoffStats([nism('PE', 'BUY', 6200, 141.5)], 6143.4, 1, EXPIRY, 50);
  assert.strictEqual(stats.maxProfit, 6058.5);
  assert.strictEqual(stats.maxLoss, -141.5);
  assert.deepStrictEqual(stats.breakevensExpiry, [6058.5]);
  assert.ok(stats.maxProfitInRange < 6058.5, 'the in-range figure stays a window value');
});

test('NISM defined-risk structures: exact max profit, max loss and breakevens', () => {
  const bull = computePayoffStats([nism('CE', 'BUY', 5800, 300), nism('CE', 'SELL', 6200, 145)], 6000, 1, EXPIRY, 50);
  assert.deepStrictEqual([bull.maxProfit, bull.maxLoss, bull.breakevensExpiry], [245, -155, [5955]]);
  const fly = computePayoffStats([
    nism('CE', 'BUY', 6000, 230), nism('CE', 'SELL', 6100, 150), nism('CE', 'BUY', 6200, 100), nism('CE', 'SELL', 6100, 150),
  ], 6100, 1, EXPIRY, 50);
  assert.deepStrictEqual([fly.maxProfit, fly.maxLoss, fly.breakevensExpiry], [70, -30, [6030, 6170]]);
});

test('buildHeatmapGrid: last column settles every leg at intrinsic value; IV scale moves earlier columns only', () => {
  const exp = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
  const legs: ResolvedLeg[] = [
    { strike: 22500, type: 'CE', side: 'SELL', qtyLots: 65, price: 100, delta: null, iv: 0.14, vega: null, securityId: null, expiry: exp },
    { strike: 22300, type: 'PE', side: 'SELL', qtyLots: 65, price: 90, delta: null, iv: 0.15, vega: null, securityId: null, expiry: exp },
  ];
  const g1 = buildHeatmapGrid(legs, 22500, 1, exp, 0.02, 1, 50);
  const g2 = buildHeatmapGrid(legs, 22500, 1, exp, 0.02, 1.2, 50);
  const last = g1.dates.length - 1;
  g1.rows.forEach((s, r) => {
    const intrinsic = (100 - Math.max(s - 22500, 0)) * 65 + (90 - Math.max(22300 - s, 0)) * 65;
    assert.ok(Math.abs(g1.cells[r][last] - intrinsic) < 1e-6, `${s}: ${g1.cells[r][last]} vs ${intrinsic}`);
    assert.ok(Math.abs(g2.cells[r][last] - g1.cells[r][last]) < 1e-6);   // IV scale cannot change settlement
  });
  const mid = g1.rows.indexOf(22500);
  assert.ok(g2.cells[mid][0] < g1.cells[mid][0]);                        // higher IV hurts a short book before expiry
});

test('buildHeatmapGrid: a book with legs on two expiries settles the earlier one when its date has passed', () => {
  const near = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
  const far = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
  const mk = (expiry: string, side: 'BUY' | 'SELL', price: number): ResolvedLeg =>
    ({ strike: 22500, type: 'CE', side, qtyLots: 65, price, delta: null, iv: 0.14, vega: null, securityId: null, expiry });
  const g = buildHeatmapGrid([mk(near, 'SELL', 100), mk(far, 'BUY', 200)], 22500, 1, far, 0.02, 1, 50);
  const row = g.rows.indexOf(22700);
  const lastCol = g.dates.length - 1;
  // at the final date both are intrinsic: (100 - 200) + (200 - 100)... = short call settles at 200, long call at 200 -> net -100*65 + 100*65... compute directly
  const expected = (100 - 200) * 65 + (200 - 200) * 65;
  assert.ok(Math.abs(g.cells[row][lastCol] - expected) < 1e-6, `${g.cells[row][lastCol]} vs ${expected}`);
});


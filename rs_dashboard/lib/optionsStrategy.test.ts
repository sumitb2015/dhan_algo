import { test } from 'node:test';
import assert from 'node:assert';
import {
  buildPayoffCurve, buildMultiExpiryCurve, buildTargetPayoffCurve,
  computePayoffStats, bsPrice, impliedVolFromPrice, daysBetweenDates,
  legsMissingIv, findBreakevens, DEFAULT_SPAN_PCT,
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

test('DEFAULT_SPAN_PCT keeps the pre-existing callers byte-identical', () => {
  const a = buildPayoffCurve(STRANGLE, SPOT, 1, SENSEX_STEP);
  const b = buildPayoffCurve(STRANGLE, SPOT, 1, SENSEX_STEP, DEFAULT_SPAN_PCT);
  assert.deepStrictEqual(a, b);
});

// ── multi-expiry ──────────────────────────────────────────────────────────────

test('daysBetweenDates counts whole days and floors at zero', () => {
  assert.strictEqual(daysBetweenDates('2026-08-16', '2026-08-20'), 4);
  assert.strictEqual(daysBetweenDates('2026-08-20', '2026-08-20'), 0);
  assert.strictEqual(daysBetweenDates('2026-08-25', '2026-08-20'), 0); // past → 0, never negative
});

test('single-expiry book at its own expiry reproduces buildPayoffCurve exactly', () => {
  const multi = buildMultiExpiryCurve(STRANGLE, SPOT, 1, EXPIRY, SENSEX_STEP);
  const plain = buildPayoffCurve(STRANGLE, SPOT, 1, SENSEX_STEP);
  assert.deepStrictEqual(multi, plain);
});

test('legs with no expiry are treated as expiring on the target date', () => {
  const noExpiry = STRANGLE.map((l) => ({ ...l, expiry: null }));
  assert.deepStrictEqual(
    buildMultiExpiryCurve(noExpiry, SPOT, 1, EXPIRY, SENSEX_STEP),
    buildPayoffCurve(noExpiry, SPOT, 1, SENSEX_STEP),
  );
});

test('a far-dated leg still carries time value at the near expiry', () => {
  const book: ResolvedLeg[] = [
    leg({ strike: 78_000, type: 'PE', side: 'SELL', qtyLots: 20, price: 300, expiry: '2026-08-20' }),
    leg({ strike: 78_000, type: 'PE', side: 'BUY', qtyLots: 20, price: 500, expiry: '2026-09-24' }),
  ];
  const atNear = buildMultiExpiryCurve(book, SPOT, 1, '2026-08-20', SENSEX_STEP, 0.05);
  const bothIntrinsic = buildPayoffCurve(book, SPOT, 1, SENSEX_STEP, 0.05);
  // If the September leg were wrongly settled at the August date, the two curves
  // would coincide. They must not.
  assert.notDeepStrictEqual(atNear, bothIntrinsic);

  // Deep OTM for both legs: the near put is worthless, the far put still has value,
  // so the calendar is worth more than the pure-intrinsic reading.
  const far = atNear[atNear.length - 1];
  const farFlat = bothIntrinsic[bothIntrinsic.length - 1];
  assert.ok(far.pnl > farFlat.pnl);
});

test('legsMissingIv flags only legs that still have time to run but no IV', () => {
  const book: ResolvedLeg[] = [
    leg({ strike: 78_000, expiry: '2026-08-20', iv: null }), // settles at target → intrinsic is correct
    leg({ strike: 78_500, expiry: '2026-09-24', iv: null }), // still running, no IV → must be flagged
    leg({ strike: 79_000, expiry: '2026-09-24', iv: 0.13 }),
  ];
  const flagged = legsMissingIv(book, '2026-08-20');
  assert.strictEqual(flagged.length, 1);
  assert.strictEqual(flagged[0].strike, 78_500);
});

// ── implied volatility ────────────────────────────────────────────────────────

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

test('target-date curve converges on the expiry curve as days go to zero', () => {
  const atExpiry = buildPayoffCurve(STRANGLE, SPOT, 1, SENSEX_STEP);
  const atZeroDays = buildTargetPayoffCurve(STRANGLE, SPOT, 1, 0, SENSEX_STEP);
  assert.deepStrictEqual(atZeroDays, atExpiry);
});

test('with time left, a short strangle is worth less than at expiry near the peak', () => {
  const atExpiry = buildPayoffCurve(STRANGLE, SPOT, 1, SENSEX_STEP);
  const inFour = buildTargetPayoffCurve(STRANGLE, SPOT, 1, 4, SENSEX_STEP);
  const mid = Math.floor(atExpiry.length / 2);
  assert.ok(inFour[mid].pnl < atExpiry[mid].pnl,
    'undecayed short options must be worth less to the seller than fully decayed ones');
});

// ── breakeven finder ──────────────────────────────────────────────────────────

test('findBreakevens interpolates zero crossings and ignores non-crossings', () => {
  assert.deepStrictEqual(findBreakevens([{ spot: 10, pnl: -10 }, { spot: 20, pnl: 10 }]), [15]);
  assert.deepStrictEqual(findBreakevens([{ spot: 10, pnl: 5 }, { spot: 20, pnl: 10 }]), []);
});

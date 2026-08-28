import { test } from 'node:test';
import assert from 'node:assert';
import {
  normalizeExpiry, normalizeOptType, parseTradingSymbol,
  buildPositionLegs, buildInstrumentIndex, computeExposure, kellyFraction,
  legExpiries, symbolMatchesUnderlying,
} from './positionLegs.ts';
import type { ScalperPosition } from './zerodhaShape.ts';

const pos = (over: Partial<ScalperPosition>): ScalperPosition => ({
  tradingSymbol: 'SENSEX20AUG2678000PE',
  securityId: '855223',
  exchange: 'BSE_FNO',
  netQty: -300,
  buyQty: 0,
  sellQty: 300,
  buyAvg: 0,
  sellAvg: 347.27,
  lastTradedPrice: 327.15,
  realizedProfit: 0,
  unrealizedProfit: 6036,
  productType: 'MARGIN',
  ...over,
});

// ── field normalization ───────────────────────────────────────────────────────

test('normalizeExpiry handles both Dhan date shapes and rejects junk', () => {
  assert.strictEqual(normalizeExpiry('2026-08-20'), '2026-08-20');
  assert.strictEqual(normalizeExpiry('2026-08-20T14:30:00'), '2026-08-20');
  assert.strictEqual(normalizeExpiry('2026-08-20 14:30:00'), '2026-08-20');
  assert.strictEqual(normalizeExpiry('20-08-2026'), '2026-08-20');
  assert.strictEqual(normalizeExpiry('20/08/2026'), '2026-08-20');
  assert.strictEqual(normalizeExpiry('20-Aug-2026'), '2026-08-20');
  assert.strictEqual(normalizeExpiry('20-AUG-2026'), '2026-08-20');
  assert.strictEqual(normalizeExpiry('NA'), null);
  assert.strictEqual(normalizeExpiry(''), null);
  assert.strictEqual(normalizeExpiry(null), null);
  assert.strictEqual(normalizeExpiry('not-a-date'), null);
});

test('normalizeOptType accepts every observed spelling, refuses futures', () => {
  for (const v of ['CALL', 'CE', 'c']) assert.strictEqual(normalizeOptType(v), 'CE');
  for (const v of ['PUT', 'PE', 'p']) assert.strictEqual(normalizeOptType(v), 'PE');
  assert.strictEqual(normalizeOptType('FUT'), null);
  assert.strictEqual(normalizeOptType('NA'), null);
  assert.strictEqual(normalizeOptType(undefined), null);
});

test('parseTradingSymbol reads the Dhan hyphenated form, without inventing a day', () => {
  assert.deepStrictEqual(parseTradingSymbol('NIFTY-Aug2026-25000-CE'), {
    underlying: 'NIFTY', strike: 25000, type: 'CE', expiry: null,
  });
  // A weekly leg's day is genuinely absent from this form — guessing it would
  // misprice the target-date curve, so expiry must stay null.
  assert.strictEqual(parseTradingSymbol('NIFTY-Jul2026-24400-PE')!.expiry, null);
});

test('parseTradingSymbol reads the compact exchange form with a full expiry', () => {
  assert.deepStrictEqual(parseTradingSymbol('CRUDEOILM17AUG264150CE'), {
    underlying: 'CRUDEOILM', strike: 4150, type: 'CE', expiry: '2026-08-17',
  });
  assert.deepStrictEqual(parseTradingSymbol('SENSEX20AUG2678000PE'), {
    underlying: 'SENSEX', strike: 78000, type: 'PE', expiry: '2026-08-20',
  });
});

test('parseTradingSymbol returns null rather than guessing', () => {
  assert.strictEqual(parseTradingSymbol('RELIANCE'), null);
  assert.strictEqual(parseTradingSymbol('NIFTY-Aug2026-25000-XX'), null);
  assert.strictEqual(parseTradingSymbol('NIFTY20ZZZ2625000CE'), null); // bad month
  assert.strictEqual(parseTradingSymbol(''), null);
});

// ── leg construction ──────────────────────────────────────────────────────────

test("Dhan's native drv* fields win over symbol parsing", () => {
  const { legs, unparseable } = buildPositionLegs(
    [pos({ tradingSymbol: 'SENSEX-Aug2026-78000-PE' })],
    { raw: [{ drvStrikePrice: 78000, drvOptionType: 'PUT', drvExpiryDate: '2026-08-20' }] },
  );
  assert.strictEqual(unparseable.length, 0);
  assert.strictEqual(legs.length, 1);
  assert.strictEqual(legs[0].strike, 78000);
  assert.strictEqual(legs[0].type, 'PE');
  assert.strictEqual(legs[0].expiry, '2026-08-20'); // symbol form could not supply this
});

test('instrument cache resolves a Kotak row that carries no drv* fields', () => {
  const instruments = buildInstrumentIndex([
    { tradingsymbol: 'SENSEX20AUG2678000PE', strike: 78000, expiry: '2026-08-20', instrument_type: 'PE', lot_size: 20 },
  ]);
  const { legs, unparseable } = buildPositionLegs([pos({})], { instruments });
  assert.strictEqual(unparseable.length, 0);
  assert.strictEqual(legs[0].strike, 78000);
  assert.strictEqual(legs[0].expiry, '2026-08-20');
});

test('an unresolvable row is reported, never silently dropped', () => {
  const { legs, unparseable } = buildPositionLegs([pos({ tradingSymbol: 'SENSEXFUT' })]);
  assert.strictEqual(legs.length, 0);
  assert.strictEqual(unparseable.length, 1);
  assert.strictEqual(unparseable[0].tradingSymbol, 'SENSEXFUT');
  assert.match(unparseable[0].reason, /could not resolve/);
});

test('a leg with no entry average is reported, not priced at zero', () => {
  const { legs, unparseable } = buildPositionLegs([pos({ sellAvg: 0 })]);
  assert.strictEqual(legs.length, 0);
  assert.match(unparseable[0].reason, /no sell average/);
});

test('a carry-forward leg with sellAvg 0 resolves entry price from costPrice', () => {
  const { legs, unparseable } = buildPositionLegs(
    [pos({ sellAvg: 0 })],
    { raw: [{ costPrice: 45.8, drvStrikePrice: 78000, drvOptionType: 'PUT', drvExpiryDate: '2026-08-20' }] },
  );
  assert.strictEqual(unparseable.length, 0);
  assert.strictEqual(legs.length, 1);
  assert.strictEqual(legs[0].price, 45.8);
});

test('flat rows are skipped and other underlyings are filtered without flagging', () => {
  const rows = [
    pos({ netQty: 0 }),
    pos({ tradingSymbol: 'NIFTY18AUG2624400CE', netQty: -65, sellAvg: 100 }),
  ];
  const { legs, unparseable } = buildPositionLegs(rows, { underlying: 'SENSEX' });
  assert.strictEqual(legs.length, 0);
  assert.strictEqual(unparseable.length, 0); // the NIFTY row is not this page's problem
});

test('symbolMatchesUnderlying requires a digit/hyphen boundary, not a bare prefix', () => {
  assert.strictEqual(symbolMatchesUnderlying('NIFTY-Aug2026-25000-CE', 'NIFTY'), true);
  assert.strictEqual(symbolMatchesUnderlying('NIFTY18AUG2624400CE', 'NIFTY'), true);
  // NIFTYNXT50 is a different instrument entirely — a plain startsWith('NIFTY')
  // would file its legs into the NIFTY book, evaluated against the wrong spot,
  // with no unparseable warning to catch it.
  assert.strictEqual(symbolMatchesUnderlying('NIFTYNXT5030AUG2612000CE', 'NIFTY'), false);
  assert.strictEqual(symbolMatchesUnderlying('BANKNIFTY-Aug2026-50000-CE', 'NIFTY'), false);
});

test('the underlying filter uses the same boundary check, not a bare prefix', () => {
  const rows = [
    pos({ tradingSymbol: 'NIFTYNXT5030AUG2612000CE', netQty: -75, sellAvg: 50 }),
  ];
  const { legs, unparseable } = buildPositionLegs(rows, { underlying: 'NIFTY' });
  assert.strictEqual(legs.length, 0);
  assert.strictEqual(unparseable.length, 0); // filtered out, not misfiled into NIFTY
});

test('quantity stays in contracts and price is the entry average, not the LTP', () => {
  // 15 contracts of a 20-lot SENSEX option: a partial close. Dividing by the lot
  // size would round this to 0 lots and erase the leg entirely.
  const { legs } = buildPositionLegs([pos({ netQty: -15, sellQty: 15 })]);
  assert.strictEqual(legs[0].qtyLots, 15);
  assert.strictEqual(legs[0].side, 'SELL');
  assert.strictEqual(legs[0].price, 347.27);       // sellAvg
  assert.strictEqual(legs[0].display.ltp, 327.15); // LTP kept for display only
});

test('a long leg prices off buyAvg', () => {
  const { legs } = buildPositionLegs([pos({ netQty: 300, buyQty: 300, buyAvg: 120.5, sellQty: 0, sellAvg: 0 })]);
  assert.strictEqual(legs[0].side, 'BUY');
  assert.strictEqual(legs[0].price, 120.5);
});

test('an unknown Kotak LTP surfaces as null, not as zero', () => {
  const { legs } = buildPositionLegs([pos({ lastTradedPrice: 0 })]);
  assert.strictEqual(legs[0].display.ltp, null);
});

test('a chain last_price of exactly 0 falls back to null, not a fabricated real price', () => {
  // A deep ITM/OTM contract with no trade yet today can sit at last_price=0 in
  // the chain while still holding real intrinsic value. Letting that 0 through
  // as a real LTP (a bare `?? null`, which only catches null/undefined) would
  // report a short sold at 300 as instantly +100% profitable.
  const oc = {
    '78000.000000': { pe: { last_price: 0, security_id: 855223 } },
  };
  const { legs } = buildPositionLegs([pos({ lastTradedPrice: 0 })], { oc });
  assert.strictEqual(legs[0].display.ltp, null);
});

test('greeks and IV are joined from the chain, with IV converted from percent', () => {
  const oc = {
    '78000.000000': {
      pe: {
        last_price: 327.15,
        implied_volatility: 12.325377609077785,
        security_id: 855223,
        greeks: { delta: -0.45, gamma: 0.00037, theta: -58.42, vega: 34.42 },
      },
    },
  };
  const { legs } = buildPositionLegs([pos({})], { oc });
  assert.ok(Math.abs(legs[0].iv! - 0.12325377609077785) < 1e-12);
  assert.strictEqual(legs[0].delta, -0.45);
  assert.strictEqual(legs[0].gamma, 0.00037);
  assert.strictEqual(legs[0].theta, -58.42);
  assert.strictEqual(legs[0].vega, 34.42);
});

test('legExpiries returns sorted distinct known expiries', () => {
  const { legs } = buildPositionLegs([
    pos({ tradingSymbol: 'SENSEX27AUG2678000PE' }),
    pos({ tradingSymbol: 'SENSEX20AUG2678500CE', netQty: -300, sellAvg: 180 }),
    pos({ tradingSymbol: 'SENSEX20AUG2679000CE', netQty: -300, sellAvg: 90 }),
  ]);
  assert.deepStrictEqual(legExpiries(legs), ['2026-08-20', '2026-08-27']);
});

// ── exposure / Kelly ──────────────────────────────────────────────────────────

test('assignment exposure counts short legs only', () => {
  const { legs } = buildPositionLegs([
    pos({ tradingSymbol: 'SENSEX20AUG2678000PE', netQty: -300, sellAvg: 347.27 }),
    // Long wing: a right, not an obligation — it must not net down the requirement.
    pos({ tradingSymbol: 'SENSEX20AUG2670000PE', netQty: 300, buyQty: 300, buyAvg: 5, sellQty: 0, sellAvg: 0 }),
  ]);
  const e = computeExposure(legs, { capital: 4_000_000, nav: 40_000_000 });
  assert.strictEqual(e.assignmentExposure, 78000 * 300);
  assert.ok(Math.abs(e.premiumCollected - (347.27 * 300 - 5 * 300)) < 1e-6);
});

test('managed stop risk is the 2x-premium convention and reports as % of NAV', () => {
  const { legs } = buildPositionLegs([pos({ netQty: -300, sellAvg: 100 })]);
  const e = computeExposure(legs, { capital: 1_000_000, nav: 6_000_000 });
  assert.strictEqual(e.premiumCollected, 30_000);
  assert.strictEqual(e.managedStopRisk, 60_000);
  assert.strictEqual(e.stopRiskPctOfNav, 1);
});

test('over-allocation fires past the threshold, and percentages are null without capital', () => {
  const { legs } = buildPositionLegs([pos({ netQty: -300, sellAvg: 100 })]);
  assert.strictEqual(computeExposure(legs, { capital: 100_000_000, nav: null }).overAllocated, false);
  assert.strictEqual(computeExposure(legs, { capital: 1_000_000, nav: null }).overAllocated, true);

  const none = computeExposure(legs, { capital: null, nav: null });
  assert.strictEqual(none.exposurePctOfCapital, null);
  assert.strictEqual(none.stopRiskPctOfNav, null);
  assert.strictEqual(none.overAllocated, false);
});

test('a net-debit book reports negative premium and zero managed stop risk', () => {
  const { legs } = buildPositionLegs([
    pos({ tradingSymbol: 'SENSEX20AUG2678000PE', netQty: 300, buyQty: 300, buyAvg: 50, sellQty: 0, sellAvg: 0 }),
  ]);
  const e = computeExposure(legs, { capital: 1_000_000, nav: 1_000_000 });
  assert.strictEqual(e.assignmentExposure, 0);
  assert.strictEqual(e.premiumCollected, -15_000);
  assert.strictEqual(e.managedStopRisk, 0);
});

test('kellyFraction returns the raw value, including a negative edge', () => {
  assert.ok(Math.abs(kellyFraction(0.6, 2)! - 0.4) < 1e-12);
  // A losing edge must be reported as negative, not clamped to 0 — clamping
  // would present "do not trade this" as "size it at zero", which reads as neutral.
  assert.ok(kellyFraction(0.3, 1)! < 0);
  assert.strictEqual(kellyFraction(null, 2), null);
  assert.strictEqual(kellyFraction(0.6, null), null);
  assert.strictEqual(kellyFraction(0.6, 0), null);
  assert.strictEqual(kellyFraction(1.4, 2), null);
});
